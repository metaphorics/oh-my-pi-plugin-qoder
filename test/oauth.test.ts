import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import {
	CLIENT_ID,
	loginQoder,
	OPENAPI_BASE,
	refreshQoderToken,
	WEB_BASE,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function urlOf(input: string | URL | Request): string {
	return typeof input === "string"
		? input
		: input instanceof Request
			? input.url
			: input.toString();
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Qoder OAuth", () => {
	it("builds PKCE and polls from pending to authenticated", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
		let polls = 0;
		const fetchMock: FetchImpl = async (input, init) => {
			requests.push({ url: urlOf(input), init });
			polls += 1;
			return polls === 1
				? new Response(null, { status: 404 })
				: jsonResponse({
						token: "access-token",
						refresh_token: "refresh-token",
						expires_at: now / 1000 + 3600,
					});
		};
		let authorizationUrl = "";

		const credentials = await loginQoder({
			fetch: fetchMock,
			onPrompt: async () => {
				throw new Error("Qoder browser login must not prompt for pasted input");
			},
			onAuth: (info) => {
				authorizationUrl = info.url;
			},
		});

		const auth = new URL(authorizationUrl);
		expect(auth.origin + auth.pathname).toBe(
			`${WEB_BASE}/device/selectAccounts`,
		);
		expect(auth.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(auth.searchParams.get("challenge_method")).toBe("S256");
		expect(auth.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(auth.searchParams.get("nonce")).toMatch(/^[0-9a-f-]{36}$/i);
		expect(auth.searchParams.get("machine_id")).toMatch(/^[0-9a-f-]{36}$/i);

		const poll = new URL(requests[0]?.url ?? "");
		expect(poll.origin + poll.pathname).toBe(
			`${OPENAPI_BASE}/api/v1/deviceToken/poll`,
		);
		const verifier = poll.searchParams.get("verifier") ?? "";
		expect(auth.searchParams.get("challenge")).toBe(
			createHash("sha256").update(verifier).digest("base64url"),
		);
		expect(requests.map((request) => request.init?.method)).toEqual([
			"GET",
			"GET",
		]);
		expect(
			requests.every((request) => request.init?.signal instanceof AbortSignal),
		).toBe(true);
		expect(credentials).toEqual({
			access: "access-token",
			refresh: "refresh-token",
			expires: now + 3_540_000,
		});
	});

	it("retries transient poll failures while authorization is pending", async () => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		let polls = 0;
		const fetchMock: FetchImpl = async () => {
			polls += 1;
			if (polls === 1) throw new TypeError("temporary network failure");
			return jsonResponse({
				token: "access-token",
				refresh_token: "refresh-token",
			});
		};

		const credentials = await loginQoder({
			fetch: fetchMock,
			onAuth: () => {},
			onPrompt: async () => {
				throw new Error("Qoder browser login must not prompt for pasted input");
			},
		});

		expect(polls).toBe(2);
		expect(credentials.access).toBe("access-token");
	});

	it("fails fast on HTTP errors while authorization is pending", async () => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		let polls = 0;
		const fetchMock: FetchImpl = async () => {
			polls += 1;
			return new Response(null, { status: 500 });
		};

		await expect(
			loginQoder({
				fetch: fetchMock,
				onAuth: () => {},
				onPrompt: async () => {
					throw new Error(
						"Qoder browser login must not prompt for pasted input",
					);
				},
			}),
		).rejects.toMatchObject({
			name: "OAuthError",
			kind: "polling",
			provider: "qoder",
			status: 500,
		});
		expect(polls).toBe(1);
	});

	it("refreshes credentials with the Qoder client contract", async () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			requestUrl = urlOf(input);
			requestInit = init;
			return jsonResponse({
				token: "new-access",
				expires_at: now / 1000 + 3600,
			});
		};

		const credentials = await refreshQoderToken(
			{ access: "old-access", refresh: "old-refresh", expires: 0 },
			fetchMock,
		);

		expect(requestUrl).toBe(`${OPENAPI_BASE}/api/v1/deviceToken/refresh`);
		expect(requestInit?.method).toBe("POST");
		expect(requestInit?.headers).toMatchObject({
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": "qoder/1.1.1",
		});
		expect(requestInit?.body).toBe(
			JSON.stringify({ refresh_token: "old-refresh" }),
		);
		expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
		expect(credentials).toEqual({
			access: "new-access",
			refresh: "old-refresh",
			expires: now + 3_540_000,
		});
	});

	it("rejects empty access tokens at the response boundary", async () => {
		const fetchMock: FetchImpl = async () => jsonResponse({ token: "" });

		await expect(
			refreshQoderToken(
				{ access: "old-access", refresh: "old-refresh", expires: 0 },
				fetchMock,
			),
		).rejects.toMatchObject({
			name: "OAuthError",
			kind: "validation",
			provider: "qoder",
		});
	});
});
