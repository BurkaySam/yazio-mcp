export interface Env {
	/** YAZIO account e-mail (secret). */
	YAZIO_EMAIL?: string;
	/** YAZIO account password (secret). */
	YAZIO_PASSWORD?: string;
	/** Shared secret that every MCP request must present (secret). */
	MCP_AUTH_TOKEN?: string;
	/** IANA time zone for "today" and entry timestamps. Default: Europe/Berlin. */
	YAZIO_TIMEZONE?: string;
	/** YAZIO API version path segment. Default: v18. */
	YAZIO_API_VERSION?: string;
	/** Optional app User-Agent; required by YAZIO for API versions v20 and newer. */
	YAZIO_USER_AGENT?: string;
	/** Optional food-database country for search_food, e.g. "DE". */
	YAZIO_COUNTRY?: string;
	/** Optional food-database locale for search_food, e.g. "de_DE". */
	YAZIO_LOCALE?: string;
	/** Optional KV namespace that persists the YAZIO token across isolates. */
	YAZIO_TOKEN_CACHE?: KVNamespace;
}
