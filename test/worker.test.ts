import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import {
	createFakeYazio,
	ENTRY_ID,
	PRODUCT_ID,
} from "./fake-yazio.js";

const AUTH_TOKEN = "test-token-0123456789abcdef";
let accountCounter = 0;

function makeEnv(overrides: Partial<Env> = {}): Env {
	accountCounter += 1;
	return {
		// A fresh account per test keeps the per-isolate caches independent.
		YAZIO_EMAIL: `user${accountCounter}@example.com`,
		YAZIO_PASSWORD: "fake-password",
		MCP_AUTH_TOKEN: AUTH_TOKEN,
		YAZIO_TIMEZONE: "Europe/Berlin",
		...overrides,
	};
}

function callWorker(env: Env) {
	return (input: RequestInfo | URL, init?: RequestInit) =>
		worker.fetch(new Request(input, init), env);
}

async function connect(env: Env, path = "/mcp", headers: HeadersInit = {}) {
	const transport = new StreamableHTTPClientTransport(
		new URL(`https://yazio-mcp.example.workers.dev${path}`),
		{ fetch: callWorker(env), requestInit: { headers } },
	);
	const client = new Client({ name: "test-client", version: "1.0.0" });
	await client.connect(transport);
	return client;
}

function structured(result: unknown): Record<string, unknown> {
	const value = (result as { structuredContent?: Record<string, unknown> })
		.structuredContent;
	if (!value) throw new Error(`No structured content: ${JSON.stringify(result)}`);
	return value;
}

let fake: ReturnType<typeof createFakeYazio>;

beforeEach(() => {
	fake = createFakeYazio();
	vi.stubGlobal("fetch", fake.fetch);
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-24T10:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("access control", () => {
	const mcpRequest = (path: string, headers: HeadersInit = {}) =>
		new Request(`https://yazio-mcp.example.workers.dev${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...headers,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});

	it("answers health checks without authentication", async () => {
		const response = await worker.fetch(
			new Request("https://yazio-mcp.example.workers.dev/health"),
			makeEnv(),
		);
		expect(response.status).toBe(200);
	});

	it("rejects /mcp without a bearer token", async () => {
		const response = await worker.fetch(mcpRequest("/mcp"), makeEnv());
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
		expect(fake.calls).toEqual([]);
	});

	it("rejects a wrong bearer token", async () => {
		const response = await worker.fetch(
			mcpRequest("/mcp", { Authorization: "Bearer wrong-token-0123456789" }),
			makeEnv(),
		);
		expect(response.status).toBe(401);
	});

	it("hides wrong secret paths", async () => {
		const response = await worker.fetch(
			mcpRequest("/mcp/wrong-token-0123456789"),
			makeEnv(),
		);
		expect(response.status).toBe(404);
	});

	it("fails closed when MCP_AUTH_TOKEN is missing or too short", async () => {
		for (const token of [undefined, "short"]) {
			const response = await worker.fetch(
				mcpRequest("/mcp", { Authorization: `Bearer ${token}` }),
				makeEnv({ MCP_AUTH_TOKEN: token }),
			);
			expect(response.status).toBe(500);
		}
	});

	it("accepts the bearer token", async () => {
		const client = await connect(makeEnv(), "/mcp", {
			Authorization: `Bearer ${AUTH_TOKEN}`,
		});
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"add_meal",
			"delete_entry",
			"get_day",
			"get_goals",
			"search_food",
		]);
		await client.close();
	});

	it("accepts the secret path", async () => {
		const client = await connect(makeEnv(), `/mcp/${AUTH_TOKEN}`);
		const { tools } = await client.listTools();
		expect(tools).toHaveLength(5);
		await client.close();
	});
});

describe("tools", () => {
	async function tools(env = makeEnv()) {
		return connect(env, `/mcp/${AUTH_TOKEN}`);
	}

	it("search_food returns nutrients per 100 g", async () => {
		const client = await tools();
		const result = await client.callTool({
			name: "search_food",
			arguments: { query: "Magerquark" },
		});
		const data = structured(result);
		expect(data.country).toBe("DE");
		expect(data.results).toEqual([
			{
				product_id: PRODUCT_ID,
				name: "Magerquark",
				producer: "Molkerei",
				verified: true,
				base_unit: "g",
				nutrients_per_100: { kcal: 67, protein_g: 12, carbs_g: 4, fat_g: 0.2 },
				default_serving: { serving: "cup", quantity: 1, amount: 250 },
			},
		]);
		const search = fake.calls.find((call) => call.path === "/products/search");
		expect(search?.query).toMatchObject({
			query: "Magerquark",
			countries: "DE",
			locales: "de_DE",
			sex: "female",
		});
		await client.close();
	});

	it("add_meal posts a product entry in local time", async () => {
		const client = await tools();
		const result = await client.callTool({
			name: "add_meal",
			arguments: { product_id: PRODUCT_ID, amount_g: 150, meal_type: "lunch" },
		});
		const data = structured(result);
		expect(data).toMatchObject({
			product_id: PRODUCT_ID,
			name: "Magerquark",
			amount: 150,
			meal_type: "lunch",
			date: "2026-10-24",
			nutrients: { kcal: 100.5, protein_g: 18 },
		});
		const post = fake.calls.find(
			(call) => call.method === "POST" && call.path === "/user/consumed-items",
		);
		expect(post?.body).toEqual({
			products: [
				{
					id: data.entry_id,
					product_id: PRODUCT_ID,
					// 10:00 UTC is 12:00 in Berlin (CEST).
					date: "2026-10-24 12:00:00",
					daytime: "lunch",
					amount: 150,
					serving: null,
					serving_quantity: null,
				},
			],
		});
		await client.close();
	});

	it("add_meal uses the meal's typical time on other days", async () => {
		const client = await tools();
		await client.callTool({
			name: "add_meal",
			arguments: {
				product_id: PRODUCT_ID,
				amount_g: 100,
				meal_type: "dinner",
				date: "2026-10-20",
			},
		});
		const post = fake.calls.find(
			(call) => call.method === "POST" && call.path === "/user/consumed-items",
		);
		expect(
			(post?.body as { products: { date: string }[] }).products[0]?.date,
		).toBe("2026-10-20 19:00:00");
		await client.close();
	});

	it("add_meal rejects invalid meal types and dates", async () => {
		const client = await tools();
		const badMeal = await client.callTool({
			name: "add_meal",
			arguments: { product_id: PRODUCT_ID, amount_g: 100, meal_type: "brunch" },
		});
		expect(badMeal.isError).toBe(true);
		const badDate = await client.callTool({
			name: "add_meal",
			arguments: {
				product_id: PRODUCT_ID,
				amount_g: 100,
				meal_type: "lunch",
				date: "2026-02-30",
			},
		});
		expect(badDate.isError).toBe(true);
		expect(
			fake.calls.some(
				(call) => call.method === "POST" && call.path === "/user/consumed-items",
			),
		).toBe(false);
		await client.close();
	});

	it("get_day returns entries with meal and day totals", async () => {
		const client = await tools();
		const result = await client.callTool({
			name: "get_day",
			arguments: { date: "2026-10-23" },
		});
		const data = structured(result) as {
			totals: Record<string, number>;
			energy_goal_kcal: number;
			remaining_kcal: number;
			meals: Record<
				string,
				{ entries: { entry_id: string; name: string }[]; totals: object }
			>;
		};
		expect(data.totals).toEqual({ kcal: 814, protein_g: 44, carbs_g: 8, fat_g: 0.4 });
		expect(data.energy_goal_kcal).toBe(2150);
		expect(data.remaining_kcal).toBe(1336);
		expect(data.meals.breakfast?.entries[0]).toMatchObject({
			entry_id: ENTRY_ID,
			name: "Magerquark",
		});
		expect(data.meals.lunch?.totals).toEqual({ kcal: 600, protein_g: 20 });
		expect(data.meals.snack?.entries[0]?.name).toBe("Apfel");
		expect(data.meals.dinner?.entries).toEqual([]);
		await client.close();
	});

	it("delete_entry deletes by entry id", async () => {
		const client = await tools();
		const result = await client.callTool({
			name: "delete_entry",
			arguments: { entry_id: ENTRY_ID },
		});
		expect(structured(result)).toEqual({ deleted: true, entry_id: ENTRY_ID });
		const del = fake.calls.find((call) => call.method === "DELETE");
		expect(del?.path).toBe("/user/consumed-items");
		expect(del?.body).toEqual([ENTRY_ID]);
		await client.close();
	});

	it("get_goals combines goals, macro split and meal distribution", async () => {
		const client = await tools();
		const result = await client.callTool({ name: "get_goals", arguments: {} });
		expect(structured(result)).toEqual({
			date: "2026-10-24",
			energy_kcal: 2000,
			protein_g: 100,
			carbs_g: 250,
			fat_g: 67,
			water_ml: 2500,
			steps: 10000,
			target_weight_kg: 70,
			energy_kcal_including_activity: 2150,
			activity_kcal: 150,
			macro_distribution_percent: { carbs: 50, protein: 20, fat: 30 },
			diet_name: "balanced",
			meal_distribution: {
				breakfast: { energy_kcal: 500, share_percent: 25 },
				lunch: { energy_kcal: 700, share_percent: 35 },
				dinner: { energy_kcal: 600, share_percent: 30 },
				snack: { energy_kcal: 200, share_percent: 10 },
			},
		});
		await client.close();
	});

	it("reports a YAZIO login failure as a tool error", async () => {
		fake = createFakeYazio({ rejectPassword: true });
		vi.stubGlobal("fetch", fake.fetch);
		const client = await tools();
		const result = await client.callTool({ name: "get_goals", arguments: {} });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("YAZIO login failed");
		expect(JSON.stringify(result.content)).not.toContain("fake-password");
		await client.close();
	});
});
