import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { YazioError } from "./yazio-client.js";
import { InputError, MEAL_TYPES, type YazioService } from "./service.js";

const DateArg = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
	.optional()
	.describe("Day in YYYY-MM-DD (server time zone). Defaults to today.");

const EntryId = z
	.string()
	.uuid()
	.describe("Diary entry id (entry_id from get_day or add_meal).");

const READ = {
	readOnlyHint: true,
	idempotentHint: true,
	openWorldHint: true,
} as const;

function json(data: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data) }],
		structuredContent: data as Record<string, unknown>,
	};
}

function failure(error: unknown, ambiguousWrite = false): CallToolResult {
	let message: string;
	if (error instanceof InputError) {
		message = error.message;
	} else if (error instanceof YazioError) {
		message =
			ambiguousWrite && error.status >= 500
				? `${error.message}. The entry may still have been saved; check get_day before retrying.`
				: error.message;
	} else if (ambiguousWrite) {
		// Without an HTTP answer the write may or may not have happened.
		message =
			"YAZIO did not answer; the entry may or may not have been saved. Check get_day before retrying.";
	} else {
		message = "YAZIO request failed. Try again later.";
	}
	return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(
	action: () => Promise<unknown>,
	ambiguousWrite = false,
): Promise<CallToolResult> {
	try {
		return json(await action());
	} catch (error) {
		return failure(error, ambiguousWrite);
	}
}

export function registerTools(server: McpServer, yazio: YazioService): void {
	server.registerTool(
		"search_food",
		{
			title: "Search food",
			description:
				"Search the YAZIO food database by name, brand or barcode (EAN). " +
				"Returns product_id, nutrients per 100 g (or 100 ml) and the default serving. " +
				"Use the product_id with add_meal.",
			inputSchema: z.object({
				query: z.string().min(1).max(200).describe("Food name, brand or EAN"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.default(10)
					.describe("Maximum number of results"),
				country: z
					.string()
					.regex(/^[A-Za-z]{2}$/)
					.optional()
					.describe("ISO country of the food market, e.g. DE, AT, US"),
			}),
			annotations: { title: "Search food", ...READ },
		},
		({ query, limit, country }) =>
			run(() => yazio.searchFood(query, limit, country)),
	);

	server.registerTool(
		"add_meal",
		{
			title: "Add meal entry",
			description:
				"Log a product from search_food in the YAZIO diary. amount_g is in the product's base unit " +
				"(grams, or millilitres for drinks). Returns the new entry_id and its nutrients.",
			inputSchema: z.object({
				product_id: z.string().uuid().describe("product_id from search_food"),
				amount_g: z
					.number()
					.positive()
					.max(10000)
					.describe("Amount in grams (or ml)"),
				meal_type: z.enum(MEAL_TYPES).describe("Meal to log the entry in"),
				date: DateArg,
			}),
			annotations: {
				title: "Add meal entry",
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		(args) => run(() => yazio.addMeal(args), true),
	);

	server.registerTool(
		"get_day",
		{
			title: "Get day",
			description:
				"All diary entries of a day grouped by meal, with nutrients per entry, per meal and for the day, " +
				"plus the day's calorie goal and remaining calories. Entry ids are needed for delete_entry.",
			inputSchema: z.object({ date: DateArg }),
			annotations: { title: "Get day", ...READ },
		},
		({ date }) => run(() => yazio.getDay(date)),
	);

	server.registerTool(
		"delete_entry",
		{
			title: "Delete entry",
			description:
				"Delete a diary entry (product, recipe portion or quick entry) by its entry_id from get_day. " +
				"This is not the product_id.",
			inputSchema: z.object({ entry_id: EntryId }),
			annotations: {
				title: "Delete entry",
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		({ entry_id }) => run(() => yazio.deleteEntry(entry_id)),
	);

	server.registerTool(
		"get_goals",
		{
			title: "Get goals",
			description:
				"Current daily goals: calories, protein/carbs/fat (g), macro distribution (%), " +
				"calorie distribution per meal, water (ml), steps and target weight (kg). " +
				"energy_kcal_including_activity adds burned activity calories.",
			inputSchema: z.object({ date: DateArg }),
			annotations: { title: "Get goals", ...READ },
		},
		({ date }) => run(() => yazio.getGoals(date)),
	);
}
