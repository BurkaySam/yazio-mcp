// Minimal client for YAZIO's private mobile API (https://yzapi.yazio.com).
// The API is unofficial and undocumented; endpoints and payloads follow the
// community projects listed in the README and can change without notice.

// The OAuth client of the YAZIO mobile app. It identifies the app, not the
// user, and is shipped in every install; see the community API specification.
const CLIENT_ID = "1_4hiybetvfksgw40o0sog4s884kwc840wwso8go4k8c04goo4c";
const CLIENT_SECRET = "6rok2m65xuskgkgogw40wkkk8sw0osg84s8cggsc4woos4s8o";

const DEFAULT_BASE_URL = "https://yzapi.yazio.com";
const DEFAULT_API_VERSION = "v18";
// Renew a little early so a token never expires between check and request.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
// KV entries outlive the 48 h access token so the refresh token stays usable.
const KV_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface YazioToken {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

/** Persists tokens beyond one isolate (Workers KV in production). */
export interface TokenStore {
	get(key: string): Promise<YazioToken | null>;
	put(key: string, token: YazioToken): Promise<void>;
}

export function kvTokenStore(kv: KVNamespace): TokenStore {
	return {
		async get(key) {
			const value = await kv.get<YazioToken>(key, "json");
			return value &&
				typeof value.accessToken === "string" &&
				typeof value.refreshToken === "string" &&
				typeof value.expiresAt === "number"
				? value
				: null;
		},
		async put(key, token) {
			await kv.put(key, JSON.stringify(token), {
				expirationTtl: KV_TTL_SECONDS,
			});
		},
	};
}

export interface YazioClientOptions {
	email: string;
	password: string;
	apiVersion?: string;
	userAgent?: string;
	baseUrl?: string;
	tokenStore?: TokenStore;
	fetch?: typeof fetch;
	now?: () => number;
}

type Query = Record<string, string | number | undefined>;

export class YazioError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "YazioError";
	}
}

export class YazioClient {
	private token: YazioToken | null = null;
	private renewing: Promise<YazioToken> | null = null;
	private storeKey: Promise<string> | null = null;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;

	constructor(private readonly options: YazioClientOptions) {
		const version = options.apiVersion?.trim() || DEFAULT_API_VERSION;
		this.baseUrl = `${options.baseUrl ?? DEFAULT_BASE_URL}/${version}`;
		this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
		this.now = options.now ?? Date.now;
	}

	get<T>(path: string, query?: Query): Promise<T> {
		return this.request<T>("GET", path, { query });
	}

	post<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>("POST", path, { body });
	}

	delete<T>(path: string, body: unknown): Promise<T> {
		return this.request<T>("DELETE", path, { body });
	}

	async request<T>(
		method: string,
		path: string,
		init: { query?: Query; body?: unknown } = {},
	): Promise<T> {
		const url = new URL(this.baseUrl + path);
		for (const [key, value] of Object.entries(init.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		const send = (token: YazioToken) =>
			this.fetchImpl(url, {
				method,
				headers: this.headers({
					Authorization: `Bearer ${token.accessToken}`,
					...(init.body === undefined
						? {}
						: { "Content-Type": "application/json" }),
				}),
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			});

		const token = await this.getToken();
		let response = await send(token);
		if (response.status === 401) {
			// The token was revoked or expired early. A 401 means the request was
			// not executed, so renewing and sending it once more is safe.
			response = await send(await this.renew(token));
		}
		return parseResponse<T>(response, `${method} ${path}`);
	}

	/** Returns a valid access token, renewing it when needed. */
	async getToken(): Promise<YazioToken> {
		if (this.token && this.isFresh(this.token)) return this.token;
		const stored = await this.loadStored();
		if (stored && this.isFresh(stored)) return (this.token = stored);
		return this.renew(stored ?? this.token);
	}

	private renew(stale: YazioToken | null): Promise<YazioToken> {
		// Share one renewal between concurrent requests of this isolate.
		this.renewing ??= this.authenticate(stale).finally(() => {
			this.renewing = null;
		});
		return this.renewing;
	}

	private async authenticate(stale: YazioToken | null): Promise<YazioToken> {
		let token: YazioToken | null = null;
		const refreshToken = stale?.refreshToken ?? this.token?.refreshToken;
		if (refreshToken) {
			try {
				token = await this.grant({
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				});
			} catch {
				// Refresh token expired or was rotated elsewhere: log in again.
			}
		}
		token ??= await this.grant({
			grant_type: "password",
			username: this.options.email,
			password: this.options.password,
		});
		this.token = token;
		await this.saveStored(token);
		return token;
	}

	private async grant(params: Record<string, string>): Promise<YazioToken> {
		const response = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				...params,
			}),
		});
		if (
			params.grant_type === "password" &&
			(response.status === 400 || response.status === 401)
		) {
			throw new YazioError(
				"YAZIO login failed: check the YAZIO_EMAIL and YAZIO_PASSWORD secrets",
				response.status,
			);
		}
		const data = await parseResponse<{
			access_token?: unknown;
			refresh_token?: unknown;
			expires_in?: unknown;
		}>(response, "POST /oauth/token");
		if (
			typeof data?.access_token !== "string" ||
			typeof data.refresh_token !== "string" ||
			typeof data.expires_in !== "number"
		) {
			throw new YazioError("YAZIO returned an unexpected token response", 502);
		}
		// YAZIO rotates both tokens on every grant.
		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresAt: this.now() + data.expires_in * 1000,
		};
	}

	private isFresh(token: YazioToken): boolean {
		return token.expiresAt - EXPIRY_MARGIN_MS > this.now();
	}

	private headers(extra: Record<string, string>): Record<string, string> {
		return {
			Accept: "application/json",
			...(this.options.userAgent
				? { "User-Agent": this.options.userAgent }
				: {}),
			...extra,
		};
	}

	private async loadStored(): Promise<YazioToken | null> {
		const store = this.options.tokenStore;
		if (!store) return null;
		try {
			return await store.get(await this.getStoreKey());
		} catch {
			return null;
		}
	}

	private async saveStored(token: YazioToken): Promise<void> {
		const store = this.options.tokenStore;
		if (!store) return;
		try {
			await store.put(await this.getStoreKey(), token);
		} catch {
			// The in-memory token still works; persistence is best effort.
		}
	}

	/** Key per account, so changing YAZIO_EMAIL never reuses a foreign token. */
	private getStoreKey(): Promise<string> {
		this.storeKey ??= sha256Hex(this.options.email.trim().toLowerCase()).then(
			(hash) => `yazio-token:${hash}`,
		);
		return this.storeKey;
	}
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function parseResponse<T>(response: Response, label: string): Promise<T> {
	const text = await response.text();
	let body: unknown = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	if (response.ok) return body as T;
	throw new YazioError(
		`${label} failed: ${describeError(response.status, body)}`,
		response.status,
	);
}

export function describeError(status: number, body: unknown): string {
	// Validation errors arrive as a Symfony array, other errors as objects.
	if (Array.isArray(body) && body.length > 0) {
		return body
			.map((entry: { property_path?: unknown; message?: unknown }) => {
				const path =
					typeof entry?.property_path === "string" ? entry.property_path : "?";
				const message =
					typeof entry?.message === "string" ? entry.message : "invalid";
				return `${path}: ${message}`;
			})
			.join("; ");
	}
	if (
		body &&
		typeof body === "object" &&
		(body as { error?: unknown }).error === "version_blocked"
	) {
		return "YAZIO blocked this API version (403 version_blocked). Use YAZIO_API_VERSION v15–v19 or set YAZIO_USER_AGENT.";
	}
	if (status === 404) return "not found (404)";
	if (status === 405) return "not found (405, usually an invalid id)";
	if (status === 410) return "API version removed by YAZIO (410)";
	return `HTTP ${status}`;
}
