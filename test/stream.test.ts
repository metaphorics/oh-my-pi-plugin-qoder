import { describe, expect, it } from "bun:test";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ServiceTier,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	MODEL_BASE,
	PROVIDER_ID,
	QODER_API_ID,
	QODER_MODELS,
	streamQoderSimple,
	wrapQoderFetch,
} from "../src/index.js";
import { QODER_PRIVATE_DATA_POLICY } from "../src/qoder-wasm.js";

const FOLDED_SSE = [
	'data: {"choices"',
	':[{"delta":{"content":"ok"},"index":0}]}',
	"",
	'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
	": keepalive",
	"",
	'data: {"choices":[],"raw_usage":{"model_context":{"t',
	'ask_mode":"unknown"}},"usage":{"completion_tokens":1,"prompt_tokens":1,"total_tokens":2}}',
	"",
	"data: [DONE]",
	"",
].join("\n");

const WELL_FORMED_SSE = [
	'data: {"choices":[{"delta":{"content":"hello"},"index":0}]}',
	"",
	'data: {"choices":[{"delta":{"content":" world"},"index":0}]}',
	"",
	'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"completion_tokens":4,"prompt_tokens":3,"total_tokens":7}}',
	"",
	"data: [DONE]",
	"",
].join("\n");

function sseResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function chunkedSseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
}

function captureFetch(respond: () => Response): {
	fetchImpl: FetchImpl;
	requests: CapturedRequest[];
} {
	const requests: CapturedRequest[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		requests.push({
			url:
				typeof input === "string"
					? input
					: input instanceof Request
						? input.url
						: input.toString(),
			headers: new Headers(init?.headers),
			body:
				typeof init?.body === "string"
					? (JSON.parse(init.body) as Record<string, unknown>)
					: {},
		});
		return respond();
	};
	return { fetchImpl, requests };
}

/**
 * Finalize a catalog row the way omp's model registry does for extension
 * providers: the overlay builder cherry-picks known fields, so `requestModelId`
 * is dropped on omp versions before the extension contract carries it — the
 * stream adapter's catalog fallback is what routes the wire model.
 */
function runtimeModel(id: string): Model<Api> {
	const config = QODER_MODELS.find((model) => model.id === id);
	if (!config) throw new Error(`unknown model: ${id}`);
	const { requestModelId: _dropped, ...overlayFields } = config;
	return buildModel({
		api: QODER_API_ID,
		provider: PROVIDER_ID,
		baseUrl: MODEL_BASE,
		...overlayFields,
	});
}

function userContext(): Context {
	return {
		systemPrompt: [],
		messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
	};
}

async function runTurn(
	modelId: string,
	respond: () => Response,
	options?: { serviceTier?: ServiceTier },
): Promise<{
	text: string;
	result: AssistantMessage;
	requests: CapturedRequest[];
}> {
	const { fetchImpl, requests } = captureFetch(respond);
	const streamOptions: SimpleStreamOptions = {
		apiKey: "qoder-test-token",
		fetch: fetchImpl,
		...(options?.serviceTier !== undefined
			? { serviceTier: options.serviceTier }
			: {}),
	};
	const stream = streamQoderSimple(
		runtimeModel(modelId),
		userContext(),
		streamOptions,
	);
	let text = "";
	for await (const event of stream) {
		if (event.type === "text_delta") text += event.delta;
	}
	const result = await stream.result();
	return { text, result, requests };
}

describe("Qoder stream adapter", () => {
	it("recovers usage from a folded SSE event and keeps the wire free of identity fields", async () => {
		const { text, result, requests } = await runTurn("auto", () =>
			sseResponse(FOLDED_SSE),
		);

		expect(text).toBe("ok");
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(1);
		expect(result.usage.output).toBe(1);
		expect(result.usage.totalTokens).toBe(2);

		const request = requests[0];
		expect(request?.url).toBe(
			"https://api2-v2.qoder.sh/model/v1/chat/completions",
		);
		expect(request?.headers.get("Authorization")).toBe(
			"Bearer qoder-test-token",
		);
		// Privacy posture: bearer + JSON/event-stream negotiation only — no
		// per-request tracing ids, no identity/store/privacy fields on the body.
		expect(request?.headers.get("X-Request-ID")).toBeNull();
		expect(request?.headers.get("X-Session-ID")).toBeNull();
		expect(request?.body.model).toBe("auto");
		for (const key of [
			"store",
			"user",
			"data_policy_agreed",
			"privacy_mode",
			"service_tier",
			"metadata",
		]) {
			expect(request?.body[key], key).toBeUndefined();
		}
	});

	it("carries the enforced Cosy-Data-Policy privacy header on api2-v2 requests", async () => {
		// The shared privacy constant is what registration puts in the provider
		// headers (pinned against the literal in index.test.ts); omp merges those
		// into each model's `headers` at dispatch, and pi-ai merges model.headers
		// into every request — this turn mirrors that dispatch end to end.
		expect(QODER_PRIVATE_DATA_POLICY).toBe("disagree");

		const model: Model<Api> = {
			...runtimeModel("auto"),
			headers: { "Cosy-Data-Policy": QODER_PRIVATE_DATA_POLICY },
		};
		const { fetchImpl, requests } = captureFetch(() =>
			sseResponse(WELL_FORMED_SSE),
		);
		const events: string[] = [];
		const stream = streamQoderSimple(model, userContext(), {
			apiKey: "qoder-test-token",
			fetch: fetchImpl,
		});
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(events).toContain("done");
		const request = requests[0];
		expect(request?.url).toBe(
			"https://api2-v2.qoder.sh/model/v1/chat/completions",
		);
		expect(request?.headers.get("Cosy-Data-Policy")).toBe("disagree");
		// Enforcement is the header; the legacy body stays free of privacy fields.
		expect(request?.body.data_policy_agreed).toBeUndefined();
		expect(request?.body.privacy_mode).toBeUndefined();
	});

	it("repairs a fold split across network chunks", async () => {
		const foldAt = FOLDED_SSE.indexOf("ask_mode");
		const chunks = [
			FOLDED_SSE.slice(0, foldAt + 3),
			FOLDED_SSE.slice(foldAt + 3),
		];
		const { text, result } = await runTurn("auto", () =>
			chunkedSseResponse(chunks),
		);

		expect(text).toBe("ok");
		expect(result.usage.input).toBe(1);
		expect(result.usage.output).toBe(1);
		expect(result.usage.totalTokens).toBe(2);
	});

	it("passes well-formed streams through unchanged", async () => {
		const { text, result } = await runTurn("auto", () =>
			sseResponse(WELL_FORMED_SSE),
		);

		expect(text).toBe("hello world");
		expect(result.stopReason).toBe("stop");
		expect(result.usage.input).toBe(3);
		expect(result.usage.output).toBe(4);
		expect(result.usage.totalTokens).toBe(7);
	});

	it("routes context aliases to the base wire model with a top-level context_length", async () => {
		const alias400k = await runTurn("ultimate-400k", () =>
			sseResponse(WELL_FORMED_SSE),
		);
		expect(alias400k.requests[0]?.body.model).toBe("ultimate");
		expect(alias400k.requests[0]?.body.context_length).toBe(400_000);

		const alias1m = await runTurn("ultimate-1m", () =>
			sseResponse(WELL_FORMED_SSE),
		);
		expect(alias1m.requests[0]?.body.model).toBe("ultimate");
		expect(alias1m.requests[0]?.body.context_length).toBe(1_000_000);

		const base = await runTurn("ultimate", () => sseResponse(WELL_FORMED_SSE));
		expect(base.requests[0]?.body.model).toBe("ultimate");
		expect("context_length" in (base.requests[0]?.body ?? {})).toBe(false);
	});

	it("injects the highspeed switch only for kmodel priority turns", async () => {
		const fast = await runTurn("kmodel", () => sseResponse(WELL_FORMED_SSE), {
			serviceTier: "priority",
		});
		expect(fast.requests[0]?.body.model).toBe("kmodel");
		expect(fast.requests[0]?.body.metadata).toEqual({
			business: { feature_switches: { highspeed: "true" } },
		});
		expect(fast.requests[0]?.body.service_tier).toBeUndefined();

		const standard = await runTurn("kmodel", () =>
			sseResponse(WELL_FORMED_SSE),
		);
		expect(standard.requests[0]?.body.metadata).toBeUndefined();

		const wrongModel = await runTurn(
			"auto",
			() => sseResponse(WELL_FORMED_SSE),
			{ serviceTier: "priority" },
		);
		expect(wrongModel.requests[0]?.body.metadata).toBeUndefined();
		expect(wrongModel.requests[0]?.body.service_tier).toBeUndefined();

		const otherBase = await runTurn(
			"qmodel",
			() => sseResponse(WELL_FORMED_SSE),
			{ serviceTier: "priority" },
		);
		expect(otherBase.requests[0]?.body.metadata).toBeUndefined();
	});
});

describe("wrapQoderFetch highspeed injection", () => {
	it("merges into existing request metadata without dropping keys", async () => {
		let capturedBody: Record<string, unknown> = {};
		const fetchImpl: FetchImpl = async (_input, init) => {
			capturedBody =
				typeof init?.body === "string"
					? (JSON.parse(init.body) as Record<string, unknown>)
					: {};
			return new Response("ok", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		};
		const wrapped = wrapQoderFetch(fetchImpl, { highspeed: true });
		await wrapped("https://api2-v2.qoder.sh/model/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "kmodel",
				metadata: {
					trace: "abc",
					business: { region: "intl", feature_switches: { other: "1" } },
				},
			}),
		});
		expect(capturedBody.metadata).toEqual({
			trace: "abc",
			business: {
				region: "intl",
				feature_switches: { other: "1", highspeed: "true" },
			},
		});
	});

	it("leaves non-SSE and error responses untouched", async () => {
		const json = new Response('{"ok":true}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		const failed = new Response("nope", { status: 500 });
		const wrapped = wrapQoderFetch(async () => json, {});
		expect(await (await wrapped("https://example.test", {})).text()).toBe(
			'{"ok":true}',
		);
		const wrappedFailed = wrapQoderFetch(async () => failed, {});
		expect((await wrappedFailed("https://example.test", {})).status).toBe(500);
	});
});
