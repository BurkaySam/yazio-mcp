import { McpServer } from "@modelcontextprotocol/server";
import { DEFAULT_TIMEZONE } from "./dates.js";
import type { Env } from "./env.js";
import { YazioService } from "./service.js";
import { registerTools } from "./tools.js";
import { kvTokenStore, YazioClient } from "./yazio-client.js";

export const SERVER_NAME = "yazio-mcp";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS =
	"Tools for the YAZIO nutrition diary. To log food: search_food, then add_meal with the product_id. " +
	"get_day lists entries with their entry_id for delete_entry. Dates are YYYY-MM-DD and default to today.";

export function createServer(yazio: YazioService): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ instructions: INSTRUCTIONS },
	);
	registerTools(server, yazio);
	return server;
}

// One client and service per isolate keep the token and catalogue caches warm
// across requests. They are rebuilt when the credentials or settings change.
let cached: { key: string; service: YazioService } | null = null;

export function getService(env: Env): YazioService {
	const email = env.YAZIO_EMAIL?.trim() ?? "";
	const password = env.YAZIO_PASSWORD ?? "";
	const key = JSON.stringify([
		email,
		password,
		env.YAZIO_API_VERSION,
		env.YAZIO_USER_AGENT,
		env.YAZIO_TIMEZONE,
		env.YAZIO_COUNTRY,
		env.YAZIO_LOCALE,
	]);
	if (cached?.key === key) return cached.service;
	const client = new YazioClient({
		email,
		password,
		apiVersion: env.YAZIO_API_VERSION,
		userAgent: env.YAZIO_USER_AGENT,
		tokenStore: env.YAZIO_TOKEN_CACHE
			? kvTokenStore(env.YAZIO_TOKEN_CACHE)
			: undefined,
	});
	const service = new YazioService(client, {
		timeZone: env.YAZIO_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
		country: env.YAZIO_COUNTRY?.trim() || undefined,
		locale: env.YAZIO_LOCALE?.trim() || undefined,
	});
	cached = { key, service };
	return service;
}
