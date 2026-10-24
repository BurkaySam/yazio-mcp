import { isCalendarDate, today, toApiDateTime } from "./dates.js";
import {
	addInto,
	round,
	summarize,
	type NutrientMap,
	type NutrientSummary,
} from "./nutrients.js";
import { YazioError, type YazioClient } from "./yazio-client.js";

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealType = (typeof MEAL_TYPES)[number];

// Catalogue entries practically never change; keep a bounded per-isolate cache.
const CATALOG_CACHE_LIMIT = 500;
const PROFILE_CACHE_TTL_MS = 60 * 60 * 1000;

// The profile `country` is where the account was registered, which is often
// not the food market, so the app language picks the default market.
const LANGUAGE_COUNTRY: Record<string, string> = {
	de: "DE",
	en: "US",
	fr: "FR",
	es: "ES",
	it: "IT",
	pt: "PT",
	nl: "NL",
	pl: "PL",
	tr: "TR",
	sv: "SE",
	da: "DK",
	nb: "NO",
	fi: "FI",
	cs: "CZ",
};

interface Product {
	name: string;
	producer?: string | null;
	base_unit?: string;
	nutrients?: NutrientMap;
	servings?: { serving: string; amount: number }[];
}

interface Recipe {
	name: string;
	nutrients?: NutrientMap;
}

interface Profile {
	sex?: string;
	language?: string;
	food_database_country?: string | null;
	diet?: {
		name?: string;
		carb_percentage?: number;
		fat_percentage?: number;
		protein_percentage?: number;
	} | null;
}

interface RawDiary {
	products?: {
		id: string;
		date: string;
		daytime: string;
		product_id: string;
		amount: number;
		serving: string | null;
		serving_quantity: number | null;
	}[];
	recipe_portions?: {
		id: string;
		date: string;
		daytime: string;
		recipe_id: string;
		portion_count: number;
	}[];
	simple_products?: {
		id: string;
		date: string;
		daytime: string;
		name: string;
		nutrients?: NutrientMap;
	}[];
}

type Goals = Partial<Record<string, number>>;

interface DailySummary {
	activity_energy?: number;
	goals?: Goals;
	meals?: Partial<Record<MealType, { energy_goal?: number }>>;
}

interface SearchResult {
	product_id: string;
	name: string;
	producer?: string | null;
	is_verified?: boolean;
	base_unit?: string;
	serving?: string | null;
	serving_quantity?: number | null;
	amount?: number | null;
	nutrients?: NutrientMap;
}

export interface DiaryEntry {
	entry_id: string;
	type: "product" | "recipe_portion" | "quick_entry";
	time: string;
	meal_type: string;
	name: string;
	product_id?: string;
	recipe_id?: string;
	amount?: number;
	unit?: string;
	serving?: string;
	serving_quantity?: number;
	portion_count?: number;
	nutrients: NutrientSummary | null;
}

export interface YazioServiceOptions {
	timeZone: string;
	country?: string;
	locale?: string;
	now?: () => Date;
}

/** Thrown for invalid tool input that the schema cannot express. */
export class InputError extends Error {
	override name = "InputError";
}

export class YazioService {
	private readonly products = new Map<string, Promise<Product | null>>();
	private readonly recipes = new Map<string, Promise<Recipe | null>>();
	private profile: { value: Promise<Profile>; at: number } | null = null;

	constructor(
		private readonly client: YazioClient,
		private readonly options: YazioServiceOptions,
	) {}

	async searchFood(query: string, limit: number, country?: string) {
		const market = await this.market(country);
		const results = await this.client.get<SearchResult[]>("/products/search", {
			query,
			countries: market.country,
			locales: market.locale,
			sex: market.sex,
		});
		return {
			query,
			country: market.country,
			results: (Array.isArray(results) ? results : [])
				.slice(0, limit)
				.map((item) => ({
					product_id: item.product_id,
					name: item.name,
					producer: item.producer ?? null,
					verified: item.is_verified ?? false,
					base_unit: item.base_unit ?? "g",
					// Search nutrients are per 1 g/ml of the base unit.
					nutrients_per_100: summarize(item.nutrients, 100),
					default_serving:
						item.serving && item.amount
							? {
									serving: item.serving,
									quantity: item.serving_quantity ?? 1,
									amount: item.amount,
								}
							: null,
				})),
		};
	}

	async addMeal(input: {
		product_id: string;
		amount_g: number;
		meal_type: MealType;
		date?: string;
	}) {
		const date = this.resolveDate(input.date);
		const product = await this.getProduct(input.product_id);
		if (!product)
			throw new InputError(
				`Product ${input.product_id} not found. Use a product_id from search_food.`,
			);
		const entryId = crypto.randomUUID();
		await this.client.post("/user/consumed-items", {
			products: [
				{
					id: entryId,
					product_id: input.product_id,
					date: toApiDateTime(
						date,
						input.meal_type,
						this.options.timeZone,
						this.now(),
					),
					daytime: input.meal_type,
					amount: input.amount_g,
					serving: null,
					serving_quantity: null,
				},
			],
		});
		return {
			entry_id: entryId,
			product_id: input.product_id,
			name: product.name,
			amount: input.amount_g,
			unit: product.base_unit ?? "g",
			meal_type: input.meal_type,
			date,
			nutrients: summarize(product.nutrients, input.amount_g),
		};
	}

	async getDay(inputDate?: string) {
		const date = this.resolveDate(inputDate);
		const [raw, summary] = await Promise.all([
			this.client.get<RawDiary>("/user/consumed-items", { date }),
			this.client.get<DailySummary>("/user/widgets/daily-summary", { date }),
		]);
		const productItems = raw?.products ?? [];
		const recipeItems = raw?.recipe_portions ?? [];
		const [products, recipes] = await Promise.all([
			this.resolveAll(
				productItems.map((item) => item.product_id),
				(id) => this.getProduct(id),
			),
			this.resolveAll(
				recipeItems.map((item) => item.recipe_id),
				(id) => this.getRecipe(id),
			),
		]);

		const entries: DiaryEntry[] = [];
		for (const item of productItems) {
			const product = products.get(item.product_id);
			entries.push({
				entry_id: item.id,
				type: "product",
				time: item.date,
				meal_type: item.daytime,
				name: product?.name ?? "Unknown product",
				product_id: item.product_id,
				amount: item.amount,
				unit: product?.base_unit ?? "g",
				...(item.serving ? { serving: item.serving } : {}),
				...(item.serving_quantity
					? { serving_quantity: item.serving_quantity }
					: {}),
				nutrients: product ? summarize(product.nutrients, item.amount) : null,
			});
		}
		for (const item of recipeItems) {
			const recipe = recipes.get(item.recipe_id);
			entries.push({
				entry_id: item.id,
				type: "recipe_portion",
				time: item.date,
				meal_type: item.daytime,
				name: recipe?.name ?? "Unknown recipe",
				recipe_id: item.recipe_id,
				portion_count: item.portion_count,
				nutrients: recipe
					? summarize(recipe.nutrients, item.portion_count)
					: null,
			});
		}
		for (const item of raw?.simple_products ?? []) {
			entries.push({
				entry_id: item.id,
				type: "quick_entry",
				time: item.date,
				meal_type: item.daytime,
				name: item.name,
				nutrients: summarize(item.nutrients),
			});
		}
		entries.sort((a, b) => a.time.localeCompare(b.time));

		const meals: Record<
			string,
			{
				energy_goal_kcal: number | null;
				totals: NutrientSummary;
				entries: DiaryEntry[];
			}
		> = {};
		for (const meal of MEAL_TYPES)
			meals[meal] = {
				energy_goal_kcal: numberOrNull(summary?.meals?.[meal]?.energy_goal),
				totals: {},
				entries: [],
			};
		const totals: NutrientSummary = {};
		for (const entry of entries) {
			const meal = (meals[entry.meal_type] ??= {
				energy_goal_kcal: null,
				totals: {},
				entries: [],
			});
			meal.entries.push(entry);
			if (entry.nutrients) {
				addInto(meal.totals, entry.nutrients);
				addInto(totals, entry.nutrients);
			}
		}

		const energyGoal = numberOrNull(summary?.goals?.["energy.energy"]);
		return {
			date,
			totals,
			energy_goal_kcal: energyGoal,
			remaining_kcal:
				energyGoal === null ? null : round(energyGoal - (totals.kcal ?? 0)),
			unresolved_entries: entries.filter((entry) => !entry.nutrients).length,
			meals,
		};
	}

	async deleteEntry(entryId: string) {
		// One endpoint removes products, recipe portions and quick entries alike.
		await this.client.delete("/user/consumed-items", [entryId]);
		return { deleted: true, entry_id: entryId };
	}

	async getGoals(inputDate?: string) {
		const date = this.resolveDate(inputDate);
		const [goals, summary, profile] = await Promise.all([
			this.client.get<Goals>("/user/goals", { date }),
			this.client.get<DailySummary>("/user/widgets/daily-summary", { date }),
			this.getProfile(true),
		]);
		const mealGoals = MEAL_TYPES.map(
			(meal) => [meal, numberOrNull(summary?.meals?.[meal]?.energy_goal)] as const,
		);
		const mealTotal = mealGoals.reduce((sum, [, kcal]) => sum + (kcal ?? 0), 0);
		const diet = profile.diet;
		return {
			date,
			energy_kcal: numberOrNull(goals?.["energy.energy"]),
			protein_g: numberOrNull(goals?.["nutrient.protein"]),
			carbs_g: numberOrNull(goals?.["nutrient.carb"]),
			fat_g: numberOrNull(goals?.["nutrient.fat"]),
			water_ml: numberOrNull(goals?.water),
			steps: numberOrNull(goals?.["activity.step"]),
			target_weight_kg: numberOrNull(goals?.["bodyvalue.weight"]),
			// The daily summary's energy goal includes burned activity calories.
			energy_kcal_including_activity: numberOrNull(
				summary?.goals?.["energy.energy"],
			),
			activity_kcal: numberOrNull(summary?.activity_energy),
			macro_distribution_percent: diet
				? {
						carbs: numberOrNull(diet.carb_percentage),
						protein: numberOrNull(diet.protein_percentage),
						fat: numberOrNull(diet.fat_percentage),
					}
				: null,
			diet_name: diet?.name ?? null,
			meal_distribution: Object.fromEntries(
				mealGoals.map(([meal, kcal]) => [
					meal,
					{
						energy_kcal: kcal,
						share_percent:
							kcal === null || mealTotal === 0
								? null
								: round((kcal / mealTotal) * 100, 1),
					},
				]),
			),
		};
	}

	private now(): Date {
		return this.options.now?.() ?? new Date();
	}

	private resolveDate(date: string | undefined): string {
		if (date === undefined) return today(this.options.timeZone, this.now());
		if (!isCalendarDate(date))
			throw new InputError(`Invalid date "${date}". Use YYYY-MM-DD.`);
		return date;
	}

	private async market(country: string | undefined) {
		const profile = await this.getProfile(false);
		const language = (profile.language ?? "de").toLowerCase();
		const market = (
			country ??
			this.options.country ??
			profile.food_database_country ??
			LANGUAGE_COUNTRY[language] ??
			"DE"
		).toUpperCase();
		return {
			country: market,
			locale: this.options.locale ?? `${language}_${market}`,
			sex: profile.sex === "female" ? "female" : "male",
		};
	}

	private getProfile(fresh: boolean): Promise<Profile> {
		const now = Date.now();
		if (
			!fresh &&
			this.profile &&
			now - this.profile.at < PROFILE_CACHE_TTL_MS
		)
			return this.profile.value;
		const value = this.client.get<Profile>("/user").catch((error: unknown) => {
			if (this.profile?.value === value) this.profile = null;
			throw error;
		});
		this.profile = { value, at: now };
		return value;
	}

	private getProduct(id: string): Promise<Product | null> {
		return cached(this.products, id, () =>
			this.client.get<Product>(`/products/${encodeURIComponent(id)}`),
		);
	}

	private getRecipe(id: string): Promise<Recipe | null> {
		return cached(this.recipes, id, () =>
			this.client.get<Recipe>(`/recipes/${encodeURIComponent(id)}`),
		);
	}

	private async resolveAll<T>(
		ids: string[],
		load: (id: string) => Promise<T | null>,
	): Promise<Map<string, T | null>> {
		const unique = [...new Set(ids)];
		const loaded = await Promise.all(
			unique.map(async (id) => {
				try {
					return [id, await load(id)] as const;
				} catch {
					// One unreadable catalogue entry must not hide the whole day.
					return [id, null] as const;
				}
			}),
		);
		return new Map(loaded);
	}
}

function cached<T>(
	cache: Map<string, Promise<T | null>>,
	id: string,
	load: () => Promise<T>,
): Promise<T | null> {
	const hit = cache.get(id);
	if (hit) return hit;
	const value = load().catch((error: unknown) => {
		cache.delete(id);
		if (
			error instanceof YazioError &&
			(error.status === 404 || error.status === 405)
		)
			return null;
		throw error;
	});
	if (cache.size >= CATALOG_CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(id, value);
	return value;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
