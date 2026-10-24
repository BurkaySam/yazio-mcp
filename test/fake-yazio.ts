// A deterministic stand-in for the YAZIO API. Credentials and data are fake.

export const PRODUCT_ID = "8a1f6b3e-2c4d-4e5f-9a0b-1c2d3e4f5a6b";
export const RECIPE_ID = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
export const ENTRY_ID = "1e2d3c4b-5a69-4788-9a0b-c1d2e3f4a5b6";

export interface RecordedCall {
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
	headers: Headers;
}

export interface FakeYazioOptions {
	expiresIn?: number;
	rejectPassword?: boolean;
	rejectRefresh?: boolean;
	/** Answer the next N authenticated API calls with 401. */
	unauthorizedCalls?: number;
}

export function createFakeYazio(options: FakeYazioOptions = {}) {
	const calls: RecordedCall[] = [];
	let tokenCount = 0;
	let unauthorized = options.unauthorizedCalls ?? 0;

	const json = (data: unknown, status = 200) =>
		new Response(data === undefined ? null : JSON.stringify(data), {
			status,
			headers: { "Content-Type": "application/json" },
		});

	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const text = await request.text();
		const body = text ? JSON.parse(text) : undefined;
		const path = url.pathname.replace(/^\/v\d+/, "");
		calls.push({
			method: request.method,
			path,
			query: Object.fromEntries(url.searchParams),
			body,
			headers: request.headers,
		});

		if (path === "/oauth/token") {
			if (body.grant_type === "password" && options.rejectPassword)
				return json({ error: "invalid_grant" }, 400);
			if (body.grant_type === "refresh_token" && options.rejectRefresh)
				return json({ error: "invalid_grant" }, 400);
			tokenCount += 1;
			return json({
				access_token: `access-${tokenCount}`,
				refresh_token: `refresh-${tokenCount}`,
				expires_in: options.expiresIn ?? 172800,
				token_type: "bearer",
			});
		}

		if (!request.headers.get("Authorization")?.startsWith("Bearer access-"))
			return json({ error: "unauthorized" }, 401);
		if (unauthorized > 0) {
			unauthorized -= 1;
			return json({ error: "unauthorized" }, 401);
		}

		const route = `${request.method} ${path}`;
		switch (route) {
			case "GET /user":
				return json({
					sex: "female",
					language: "de",
					food_database_country: "DE",
					email: "user@example.com",
					diet: {
						name: "balanced",
						carb_percentage: 50,
						protein_percentage: 20,
						fat_percentage: 30,
					},
				});
			case "GET /products/search":
				return json([
					{
						score: 1,
						product_id: PRODUCT_ID,
						name: "Magerquark",
						producer: "Molkerei",
						is_verified: true,
						base_unit: "g",
						serving: "cup",
						serving_quantity: 1,
						amount: 250,
						nutrients: {
							"energy.energy": 0.67,
							"nutrient.protein": 0.12,
							"nutrient.carb": 0.04,
							"nutrient.fat": 0.002,
						},
					},
				]);
			case `GET /products/${PRODUCT_ID}`:
				return json({
					name: "Magerquark",
					producer: "Molkerei",
					base_unit: "g",
					nutrients: {
						"energy.energy": 0.67,
						"nutrient.protein": 0.12,
						"nutrient.carb": 0.04,
						"nutrient.fat": 0.002,
					},
					servings: [{ serving: "cup", amount: 250 }],
				});
			case `GET /recipes/${RECIPE_ID}`:
				return json({
					name: "Porridge",
					nutrients: { "energy.energy": 300, "nutrient.protein": 10 },
				});
			case "POST /user/consumed-items":
			case "DELETE /user/consumed-items":
				return new Response(null, { status: 204 });
			case "GET /user/consumed-items":
				return json({
					products: [
						{
							id: ENTRY_ID,
							date: `${url.searchParams.get("date")} 08:15:00`,
							daytime: "breakfast",
							type: "product",
							product_id: PRODUCT_ID,
							amount: 200,
							serving: null,
							serving_quantity: null,
						},
					],
					recipe_portions: [
						{
							id: "2e2d3c4b-5a69-4788-9a0b-c1d2e3f4a5b6",
							date: `${url.searchParams.get("date")} 12:30:00`,
							daytime: "lunch",
							type: "recipe_portion",
							recipe_id: RECIPE_ID,
							portion_count: 2,
						},
					],
					simple_products: [
						{
							id: "3e2d3c4b-5a69-4788-9a0b-c1d2e3f4a5b6",
							date: `${url.searchParams.get("date")} 15:00:00`,
							daytime: "snack",
							type: "simple_product",
							name: "Apfel",
							nutrients: { "energy.energy": 80 },
						},
					],
				});
			case "GET /user/widgets/daily-summary":
				return json({
					activity_energy: 150,
					goals: {
						"energy.energy": 2150,
						"nutrient.protein": 100,
						"nutrient.carb": 250,
						"nutrient.fat": 67,
					},
					meals: {
						breakfast: { energy_goal: 500 },
						lunch: { energy_goal: 700 },
						dinner: { energy_goal: 600 },
						snack: { energy_goal: 200 },
					},
				});
			case "GET /user/goals":
				return json({
					"energy.energy": 2000,
					"nutrient.protein": 100,
					"nutrient.carb": 250,
					"nutrient.fat": 67,
					water: 2500,
					"activity.step": 10000,
					"bodyvalue.weight": 70,
				});
			default:
				return json({ error: "not found" }, 404);
		}
	};

	return { fetch, calls };
}
