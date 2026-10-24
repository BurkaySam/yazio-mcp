import { createMcpHandler } from "@modelcontextprotocol/server";
import { authorize } from "./auth.js";
import type { Env } from "./env.js";
import { createServer, getService } from "./server.js";

// The entry module exports only the handler: workerd treats every named
// export of the main module as an entrypoint.

function text(status: number, body: string): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/" || pathname === "/health")
			return text(200, "ok");

		const auth = await authorize(request, env.MCP_AUTH_TOKEN);
		if (!auth.ok) {
			const response = text(auth.status, auth.message);
			if (auth.status === 401)
				response.headers.set("WWW-Authenticate", 'Bearer realm="yazio-mcp"');
			return response;
		}
		if (!env.YAZIO_EMAIL?.trim() || !env.YAZIO_PASSWORD)
			return text(
				500,
				"Server misconfigured: set the YAZIO_EMAIL and YAZIO_PASSWORD secrets.",
			);

		const service = getService(env);
		const handler = createMcpHandler(() => createServer(service), {
			responseMode: "json",
		});
		return handler.fetch(request);
	},
} satisfies ExportedHandler<Env>;
