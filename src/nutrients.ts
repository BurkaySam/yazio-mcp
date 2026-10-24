// YAZIO nutrient maps use dotted keys. Energy is in kcal, everything else in
// grams. Product nutrients are per 1 g/ml of the base unit, recipe nutrients
// per portion, and quick entries ("simple products") are absolute values.

export type NutrientMap = Record<string, number>;

export interface NutrientSummary {
	kcal?: number;
	protein_g?: number;
	carbs_g?: number;
	fat_g?: number;
	sugar_g?: number;
	fiber_g?: number;
	saturated_fat_g?: number;
	salt_g?: number;
}

const SUMMARY_KEYS: ReadonlyArray<[string, keyof NutrientSummary]> = [
	["energy.energy", "kcal"],
	["nutrient.protein", "protein_g"],
	["nutrient.carb", "carbs_g"],
	["nutrient.fat", "fat_g"],
	["nutrient.sugar", "sugar_g"],
	["nutrient.dietaryfiber", "fiber_g"],
	["nutrient.saturated", "saturated_fat_g"],
	["nutrient.salt", "salt_g"],
];

export const round = (value: number, digits = 2) => {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
};

/** Projects a raw nutrient map to readable keys, scaled by `factor`. */
export function summarize(
	nutrients: NutrientMap | null | undefined,
	factor = 1,
): NutrientSummary {
	const summary: NutrientSummary = {};
	for (const [key, label] of SUMMARY_KEYS) {
		const value = nutrients?.[key];
		if (typeof value === "number" && Number.isFinite(value))
			summary[label] = round(value * factor);
	}
	return summary;
}

/** Adds `part` into `total` in place. */
export function addInto(total: NutrientSummary, part: NutrientSummary): void {
	for (const [, label] of SUMMARY_KEYS) {
		const value = part[label];
		if (value !== undefined) total[label] = round((total[label] ?? 0) + value);
	}
}
