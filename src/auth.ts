// Access control: every MCP request must carry the MCP_AUTH_TOKEN secret,
// either as `Authorization: Bearer <token>` on /mcp or as the secret path
// /mcp/<token> for clients that cannot send custom headers.

export const MCP_PATH = "/mcp";
export const MIN_TOKEN_LENGTH = 16;

export type AuthResult =
	| { ok: true }
	| { ok: false; status: 401 | 404 | 500; message: string };

export async function authorize(
	request: Request,
	expected: string | undefined,
): Promise<AuthResult> {
	if (!expected || expected.length < MIN_TOKEN_LENGTH) {
		// Fail closed: a missing or weak secret must never expose the account.
		return {
			ok: false,
			status: 500,
			message: `Server misconfigured: set the MCP_AUTH_TOKEN secret (at least ${MIN_TOKEN_LENGTH} characters).`,
		};
	}
	const { pathname } = new URL(request.url);
	let presented: string | null = null;
	if (pathname === MCP_PATH) {
		const header = request.headers.get("Authorization") ?? "";
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		presented = match?.[1]?.trim() ?? null;
	} else if (pathname.startsWith(`${MCP_PATH}/`)) {
		const segment = pathname.slice(MCP_PATH.length + 1).replace(/\/$/, "");
		if (segment && !segment.includes("/")) {
			try {
				presented = decodeURIComponent(segment);
			} catch {
				presented = null;
			}
		}
		// Unknown or wrong secret paths look like any other missing route.
		if (presented === null || !(await safeEqual(presented, expected)))
			return { ok: false, status: 404, message: "Not found" };
		return { ok: true };
	} else {
		return { ok: false, status: 404, message: "Not found" };
	}
	if (presented === null || !(await safeEqual(presented, expected)))
		return { ok: false, status: 401, message: "Unauthorized" };
	return { ok: true };
}

/** Constant-time comparison of two strings via their SHA-256 digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [left, right] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	const x = new Uint8Array(left);
	const y = new Uint8Array(right);
	let diff = 0;
	for (let index = 0; index < x.length; index += 1)
		diff |= (x[index] ?? 0) ^ (y[index] ?? 0);
	return diff === 0;
}
