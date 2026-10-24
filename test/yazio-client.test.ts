import { describe, expect, it } from "vitest";
import {
	YazioClient,
	YazioError,
	type TokenStore,
	type YazioToken,
} from "../src/yazio-client.js";
import { createFakeYazio, type FakeYazioOptions } from "./fake-yazio.js";

function setup(options: FakeYazioOptions = {}, store?: TokenStore) {
	const fake = createFakeYazio(options);
	let now = 1_000_000;
	const client = new YazioClient({
		email: "user@example.com",
		password: "fake-password",
		fetch: fake.fetch,
		tokenStore: store,
		now: () => now,
	});
	const tokenCalls = () =>
		fake.calls
			.filter((call) => call.path === "/oauth/token")
			.map((call) => (call.body as { grant_type: string }).grant_type);
	return {
		client,
		fake,
		tokenCalls,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function memoryStore() {
	const values = new Map<string, YazioToken>();
	const store: TokenStore = {
		get: async (key) => values.get(key) ?? null,
		put: async (key, token) => {
			values.set(key, token);
		},
	};
	return { store, values };
}

describe("YazioClient", () => {
	it("logs in with the password grant and reuses the cached token", async () => {
		const { client, fake, tokenCalls } = setup();
		await client.get("/user");
		await client.get("/user");
		expect(tokenCalls()).toEqual(["password"]);
		const login = fake.calls[0];
		expect(login?.body).toMatchObject({
			grant_type: "password",
			username: "user@example.com",
			password: "fake-password",
		});
		expect(fake.calls[2]?.headers.get("Authorization")).toBe(
			"Bearer access-1",
		);
	});

	it("shares one login between concurrent requests", async () => {
		const { client, tokenCalls } = setup();
		await Promise.all([client.get("/user"), client.get("/user")]);
		expect(tokenCalls()).toEqual(["password"]);
	});

	it("renews an expired token with the refresh grant", async () => {
		const { client, fake, tokenCalls, advance } = setup({ expiresIn: 3600 });
		await client.get("/user");
		advance(3600 * 1000);
		await client.get("/user");
		expect(tokenCalls()).toEqual(["password", "refresh_token"]);
		const refresh = fake.calls.find(
			(call) =>
				(call.body as { grant_type?: string } | undefined)?.grant_type ===
				"refresh_token",
		);
		expect(refresh?.body).toMatchObject({ refresh_token: "refresh-1" });
	});

	it("falls back to the password grant when refreshing fails", async () => {
		const { client, tokenCalls, advance } = setup({
			expiresIn: 3600,
			rejectRefresh: true,
		});
		await client.get("/user");
		advance(3600 * 1000);
		await client.get("/user");
		expect(tokenCalls()).toEqual(["password", "refresh_token", "password"]);
	});

	it("renews once and retries after a 401", async () => {
		const { client, tokenCalls } = setup({ unauthorizedCalls: 1 });
		await expect(client.get("/user")).resolves.toMatchObject({ sex: "female" });
		expect(tokenCalls()).toEqual(["password", "refresh_token"]);
	});

	it("reports a failed login without exposing credentials", async () => {
		const { client } = setup({ rejectPassword: true });
		const error = await client.get("/user").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(YazioError);
		expect((error as Error).message).toContain("YAZIO login failed");
		expect((error as Error).message).not.toContain("fake-password");
	});

	it("persists tokens in the token store and reuses them in a new isolate", async () => {
		const { store, values } = memoryStore();
		const first = setup({}, store);
		await first.client.get("/user");
		expect(values.size).toBe(1);
		const [key] = values.keys();
		expect(key).toMatch(/^yazio-token:[0-9a-f]{64}$/);
		expect(key).not.toContain("user@example.com");

		const second = setup({}, store);
		await second.client.get("/user");
		expect(second.tokenCalls()).toEqual([]);
	});
});
