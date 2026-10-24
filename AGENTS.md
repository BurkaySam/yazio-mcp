# Working in yazio-mcp

A single-package Cloudflare Worker that serves an MCP server (Streamable HTTP)
for the unofficial YAZIO API. `CLAUDE.md` is a symlink to this file.

## Layout

| File                  | Owns                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `src/index.ts`        | Worker entry: routing, access control, MCP handler. Default export only.  |
| `src/auth.ts`         | `MCP_AUTH_TOKEN` check (bearer header or secret path), constant-time.     |
| `src/server.ts`       | `McpServer` construction and the per-isolate service cache.               |
| `src/tools.ts`        | MCP tool definitions (zod input schemas, annotations, error mapping).     |
| `src/service.ts`      | YAZIO domain logic behind the tools, catalogue and profile caches.        |
| `src/yazio-client.ts` | HTTP client, OAuth password/refresh grants, token cache (memory + KV).    |
| `src/dates.ts`        | Time-zone aware "today" and local entry timestamps.                       |
| `test/`               | Vitest suites against a fake YAZIO API (`test/fake-yazio.ts`).            |

## Rules

- The main module (`src/index.ts`) must only have a default export; workerd
  treats named exports as entrypoints and refuses to start.
- Never commit real credentials. Secrets come from `wrangler secret put` or a
  local `.dev.vars` (gitignored). Tests use fake credentials only.
- Never log or return tokens, passwords or the e-mail address. Errors shown to
  MCP clients come from `YazioError`/`InputError` messages only.
- `add_meal` is not idempotent: never retry a POST blindly. Only a `401`
  (request not executed) is renewed and retried.
- Product nutrients from YAZIO are per 1 g/ml of the base unit.
- There is no YAZIO endpoint to write goals; do not invent one.

## Validate

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir .wrangler/dry
```

Use Conventional Commits.
