import { describe, expect, it } from "bun:test";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	SimpleStreamOptions,
	Tool,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import {
	MODEL_BASE,
	PROVIDER_ID,
	QODER_API_ID,
	QODER_MODELS,
	type QoderModelConfig,
	repairQoderSseBody,
	resolveQoderOpenAICompat,
} from "../src/index.js";
import {
	buildQoderApi3Body,
	createQoderApi3Transport,
	QODER_API3_BASE,
	type QoderApi3ModelRoute,
	resolveApi3Effort,
} from "../src/qoder-api3.js";
import {
	QODER_PRIVATE_DATA_POLICY,
	type QoderPreparedRequest,
	type QoderWasmBridge,
	type QoderWasmContext,
} from "../src/qoder-wasm.js";

function byId(id: string): QoderModelConfig {
	const model = QODER_MODELS.find((entry) => entry.id === id);
	if (!model) throw new Error(`missing model row: ${id}`);
	return model;
}

/**
 * Rebuild the api3 route the plugin derives in `buildApi3Route` (not
 * exported): the base wire key drives `model_config.key`, the alias row's
 * window drives `parameters.context_length`, and the base window stays on
 * `model_config.max_input_tokens`.
 */
function api3Route(id: string): QoderApi3ModelRoute {
	const row = byId(id);
	if (row.api3 !== true) throw new Error(`not an api3 row: ${id}`);
	const wireId = row.requestModelId ?? row.id;
	const baseRow = byId(wireId);
	const { requestModelId: _dropped, api3: _flag, ...fields } = row;
	// buildModel takes the sparse marketplace compat (the host registry's
	// input); the route then carries the fully resolved compat, exactly as
	// `toOpenAICompletionsModel` re-resolves it in production.
	const openaiModel = {
		...buildModel({
			...fields,
			api: "openai-completions",
			provider: PROVIDER_ID,
			baseUrl: MODEL_BASE,
			compat: fields.compat as ModelSpec<"openai-completions">["compat"],
		}),
		compat: resolveQoderOpenAICompat(
			wireId,
			row.compat as Parameters<typeof resolveQoderOpenAICompat>[1],
		),
	};
	return {
		wireId,
		displayName: baseRow.name,
		contextWindow: row.contextWindow,
		maxInputTokens: baseRow.contextWindow,
		isReasoning: row.reasoning,
		isVl: row.input.includes("image"),
		efforts: row.thinking?.efforts.map(String) ?? [],
		defaultEffort:
			row.thinking?.defaultLevel !== undefined
				? String(row.thinking.defaultLevel)
				: undefined,
		requiresEffort: row.thinking?.requiresEffort === true,
		openaiModel,
	};
}

const WEATHER_TOOL: Tool = {
	name: "get_weather",
	description: "Get the weather for a city",
	parameters: {
		type: "object",
		properties: { city: { type: "string" } },
		required: ["city"],
	},
};

function userContext(): Context {
	return {
		systemPrompt: ["You are terse."],
		messages: [
			{ role: "user", content: "Reply exactly with OK.", timestamp: 1 },
		],
		tools: [WEATHER_TOOL],
	};
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`expected an object for ${label}`);
	}
	return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fake WASM bridge + fetch
// ---------------------------------------------------------------------------

interface CapturedPrepare {
	endpoint: string;
	bodyJson: string;
	modelKey: string | undefined;
	modelSource: string | undefined;
}

interface FakeBridgeState {
	identities: string[];
	userInfos: string[];
	configs: (string | undefined)[];
	prepares: CapturedPrepare[];
}

/**
 * Deterministic stand-in for the auth WASM: records the identity chain and
 * returns a canned signed request whose body echoes the plaintext it was
 * handed, so tests can assert exactly what would have been encrypted.
 */
function fakeBridge(): { bridge: QoderWasmBridge; state: FakeBridgeState } {
	const state: FakeBridgeState = {
		identities: [],
		userInfos: [],
		configs: [],
		prepares: [],
	};
	const context: QoderWasmContext = {
		prepareInferRequest(endpoint, bodyJson, modelKey, modelSource) {
			state.prepares.push({ endpoint, bodyJson, modelKey, modelSource });
			const prepared: QoderPreparedRequest = {
				url: `${endpoint}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
				headers: {
					Authorization: "COSY fake-signature",
					"Cosy-Data-Policy": QODER_PRIVATE_DATA_POLICY,
					"X-Model-Key": modelKey ?? "",
					"X-Model-Source": modelSource ?? "",
				},
				body: `encrypted(${bodyJson.length}):${bodyJson}`,
			};
			return prepared;
		},
		prepareRequest() {
			throw new Error("management requests are out of scope for these tests");
		},
		decryptServerResponse(encrypted) {
			return encrypted;
		},
		free() {},
	};
	const bridge: QoderWasmBridge = {
		createContext(_machineId, _cosyVersion, userInfoJson, configJson) {
			state.userInfos.push(userInfoJson);
			state.configs.push(configJson);
			return context;
		},
		generateRuntimeAuthFields(identityJson) {
			state.identities.push(identityJson);
			return { encrypt_user_info: "fake-encrypt-user-info", key: "fake-key" };
		},
		decryptServerResponse(encrypted) {
			return encrypted;
		},
	};
	return { bridge, state };
}

interface CapturedRequest {
	url: string;
	headers: Headers;
	body: string;
}

interface FakeFetch {
	fetchImpl: FetchImpl;
	userinfoRequests: CapturedRequest[];
	inferRequests: CapturedRequest[];
}

/** Serves the userinfo identity lookup, then the canned SSE inference stream. */
function fakeApi3Fetch(respond: () => Response): FakeFetch {
	const userinfoRequests: CapturedRequest[] = [];
	const inferRequests: CapturedRequest[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const captured: CapturedRequest = {
			url:
				typeof input === "string"
					? input
					: input instanceof Request
						? input.url
						: input.toString(),
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? init.body : "",
		};
		if (captured.url.includes("/api/v1/userinfo")) {
			userinfoRequests.push(captured);
			return new Response(JSON.stringify({ id: "uid-test-account" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		inferRequests.push(captured);
		return respond();
	};
	return { fetchImpl, userinfoRequests, inferRequests };
}

// ---------------------------------------------------------------------------
// SSE envelope fixtures (the api3 wire shape: JSON envelope per data line,
// whose `body` string is itself a JSON chat.completion.chunk)
// ---------------------------------------------------------------------------

function envelope(body: string): string {
	return JSON.stringify({
		headers: {},
		body,
		statusCode: "OK",
		statusCodeValue: 200,
	});
}

function chunkEnvelope(chunk: Record<string, unknown>): string {
	return envelope(JSON.stringify(chunk));
}

const FINISH_METRICS_FRAME = `event: finish\ndata: ${JSON.stringify({ firstTokenDuration: 3, totalDuration: 9, serverDuration: 8 })}`;

function sseResponse(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** thinking → text → tool call → finish_reason=tool_calls → usage → [DONE]. */
const HAPPY_SSE = [
	`data: ${chunkEnvelope({ choices: [{ delta: { reasoning_content: "checking" }, index: 0 }] })}`,
	`data: ${chunkEnvelope({ choices: [{ delta: { content: "OK" }, index: 0 }] })}`,
	`data: ${chunkEnvelope({
		choices: [
			{
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							function: { name: "get_weather", arguments: '{"city":' },
						},
					],
				},
				index: 0,
			},
		],
	})}`,
	`data: ${chunkEnvelope({
		choices: [
			{
				delta: {
					tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
				},
				index: 0,
			},
		],
	})}`,
	`data: ${chunkEnvelope({ choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] })}`,
	`data: ${chunkEnvelope({
		choices: [],
		usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
	})}`,
	`data: ${envelope("[DONE]")}`,
	FINISH_METRICS_FRAME,
	"",
].join("\n\n");

interface TurnResult {
	events: AssistantMessageEvent[];
	result: AssistantMessage;
	bridgeState: FakeBridgeState;
	fetches: FakeFetch;
}

async function runApi3Turn(
	modelId: string,
	respond: () => Response,
	options?: SimpleStreamOptions,
): Promise<TurnResult> {
	const { bridge, state } = fakeBridge();
	const fetches = fakeApi3Fetch(respond);
	const transport = createQoderApi3Transport({
		bridge,
		machineId: "machine-test",
		openapiBase: "https://openapi.qoder.sh",
		api3Base: QODER_API3_BASE,
		cosyVersion: "1.1.2",
		clientName: "omp",
		repair: repairQoderSseBody,
	});
	// The model the host would hand the transport (custom api id, wire fields
	// dropped the way omp's registry overlay drops them).
	const { requestModelId: _dropped, ...overlayFields } = byId(modelId);
	const model = buildModel({
		api: QODER_API_ID,
		provider: PROVIDER_ID,
		baseUrl: MODEL_BASE,
		...overlayFields,
	});
	const stream = transport.stream(api3Route(modelId), model, userContext(), {
		apiKey: "qoder-test-token",
		fetch: fetches.fetchImpl,
		...options,
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	return { events, result, bridgeState: state, fetches };
}

// ---------------------------------------------------------------------------
// (a) plaintext body contract
// ---------------------------------------------------------------------------

describe("buildQoderApi3Body", () => {
	it("emits the verified router fields and model_config for a context alias", () => {
		const body = buildQoderApi3Body({
			route: api3Route("qmodel_preview-400k"),
			context: userContext(),
			cosyVersion: "1.1.2",
			clientName: "omp",
		});

		expect(body.chat_task).toBe("FREE_INPUT");
		expect(body.agent_id).toBe("agent_common");
		expect(body.session_type).toBe("qodercli");
		expect(body.version).toBe("3");
		expect(body.stream).toBe(true);
		expect(body.is_reply).toBe(true);
		expect(body.is_retry).toBe(false);
		expect(body.source).toBe(1);
		for (const key of [
			"request_id",
			"request_set_id",
			"chat_record_id",
			"session_id",
		]) {
			expect(typeof body[key], key).toBe("string");
		}
		expect(typeof body.task_id).toBe("string");

		// The alias window rides parameters.context_length while model_config
		// keeps the base wire id and the base window (live-capture contract).
		const modelConfig = asRecord(body.model_config, "model_config");
		expect(modelConfig.key).toBe("qmodel_preview");
		expect(modelConfig.source).toBe("system");
		expect(modelConfig.format).toBe("openai");
		expect(modelConfig.display_name).toBe("Qwen3.8-Max-Preview");
		expect(modelConfig.is_reasoning).toBe(true);
		expect(modelConfig.max_input_tokens).toBe(200_000);
		const parameters = asRecord(body.parameters, "parameters");
		expect(parameters.context_length).toBe(400_000);
		expect(parameters.max_tokens).toBe(32_768);

		const business = asRecord(body.business, "business");
		expect(business.product).toBe("cli");
		expect(business.version).toBe("1.1.2");
		expect(business.type).toBe("agent");
		expect(business.stage).toBe("start");
		expect(business.name).toBe("omp");

		const chatContext = asRecord(body.chat_context, "chat_context");
		expect(chatContext.text).toBe("Reply exactly with OK.");
		const extra = asRecord(chatContext.extra, "chat_context.extra");
		expect(extra.originalContent).toBe("Reply exactly with OK.");
		expect(asRecord(extra.modelConfig, "modelConfig").key).toBe(
			"qmodel_preview",
		);
	});

	it("serializes system prompt, messages, and tools the OpenAI way", () => {
		const body = buildQoderApi3Body({
			route: api3Route("cmodel"),
			context: userContext(),
			cosyVersion: "1.1.2",
			clientName: "omp",
		});

		expect(body.system).toBe("You are terse.");
		const messages = body.messages as Record<string, unknown>[];
		expect(Array.isArray(messages)).toBe(true);
		const user = messages.find((message) => message.role === "user");
		expect(user?.content).toBe("Reply exactly with OK.");

		const tools = body.tools as Record<string, unknown>[];
		expect(tools).toHaveLength(1);
		const fn = asRecord(tools[0]?.function, "tools[0].function");
		expect(fn.name).toBe("get_weather");
		expect(JSON.stringify(fn.parameters)).toContain("city");
	});

	it("carries the effort twins and never a privacy field in the body", () => {
		const body = buildQoderApi3Body({
			route: api3Route("qmodel_preview"),
			context: userContext(),
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		const parameters = asRecord(body.parameters, "parameters");
		expect(body.reasoningEffort).toBe("high");
		expect(parameters.reasoning_effort).toBe("high");

		// Privacy Mode is enforced by the WASM-signed Cosy-Data-Policy header;
		// the api3 body itself carries no data_policy/metadata field at all.
		expect(body.metadata).toBeUndefined();
		expect(JSON.stringify(body)).not.toContain("data_policy");
	});

	it("maps reasoning controls onto the wire effort tokens", () => {
		// Requested effort inside the ladder wins.
		const xhigh = buildQoderApi3Body({
			route: api3Route("cmodel"),
			context: userContext(),
			options: {
				reasoning: "xhigh" as SimpleStreamOptions["reasoning"],
			},
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		expect(xhigh.reasoningEffort).toBe("xhigh");
		expect(asRecord(xhigh.parameters, "parameters").reasoning_effort).toBe(
			"xhigh",
		);

		// Disabling reasoning on a ladder model sends none + a zero thinking budget.
		const disabled = buildQoderApi3Body({
			route: api3Route("cmodel"),
			context: userContext(),
			options: { disableReasoning: true },
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		expect(disabled.reasoningEffort).toBe("none");
		const disabledParameters = asRecord(disabled.parameters, "parameters");
		expect(disabledParameters.reasoning_effort).toBe("none");
		expect(disabledParameters.max_thinking_tokens).toBe(0);

		// A requiresEffort model ignores the disable switch.
		const required = buildQoderApi3Body({
			route: api3Route("qmodel_preview"),
			context: userContext(),
			options: { disableReasoning: true },
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		expect(required.reasoningEffort).toBe("high");

		// Non-reasoning families emit no effort fields at all.
		const nonReasoning = buildQoderApi3Body({
			route: api3Route("qmodel_latest"),
			context: userContext(),
			cosyVersion: "1.1.2",
			clientName: "omp",
		});
		expect(nonReasoning.reasoningEffort).toBeUndefined();
		expect(
			asRecord(nonReasoning.parameters, "parameters").reasoning_effort,
		).toBeUndefined();
	});

	it("falls back to the route default for efforts outside the ladder", () => {
		const route = api3Route("qmodel_preview");
		expect(
			resolveApi3Effort(route, {
				reasoning: "xhigh" as SimpleStreamOptions["reasoning"],
			}),
		).toBe("high");
		expect(resolveApi3Effort(route)).toBe("high");
	});
});

// ---------------------------------------------------------------------------
// (b) SSE envelope → legacy event semantics, over the fake bridge
// ---------------------------------------------------------------------------

describe("createQoderApi3Transport", () => {
	it("maps envelope frames into the legacy event semantics", async () => {
		const { events, result, bridgeState, fetches } = await runApi3Turn(
			"qmodel_preview",
			() => sseResponse(HAPPY_SSE),
		);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "checking" },
			{ type: "text", text: "OK" },
			{
				type: "toolCall",
				id: "call_1",
				name: "get_weather",
				arguments: { city: "Paris" },
			},
		]);
		expect(result.usage.input).toBe(12);
		expect(result.usage.output).toBe(7);
		expect(result.usage.totalTokens).toBe(19);

		// Identity chain: uid from userinfo, auth fields over the identity JSON
		// (never the machine id), privacy disagreement on the WASM userInfo.
		expect(fetches.userinfoRequests).toHaveLength(1);
		expect(fetches.userinfoRequests[0]?.headers.get("Authorization")).toBe(
			"Bearer qoder-test-token",
		);
		expect(bridgeState.identities).toHaveLength(1);
		expect(JSON.parse(bridgeState.identities[0] ?? "")).toEqual({
			uid: "uid-test-account",
			organization_id: "",
			organization_tags: [],
			data_policy_agreed: false,
		});
		expect(JSON.parse(bridgeState.userInfos[0] ?? "")).toEqual({
			uid: "uid-test-account",
			encrypt_user_info: "fake-encrypt-user-info",
			key: "fake-key",
			organization_id: "",
			organization_tags: [],
			data_policy_agreed: false,
		});
		expect(JSON.parse(bridgeState.configs[0] ?? "")).toEqual({
			client_type: "5",
			business_product: "cli",
			business_type: "agent",
			scene: "assistant",
		});

		// The WASM prepared exactly one signed request for the base wire id…
		expect(bridgeState.prepares).toHaveLength(1);
		const prepare = bridgeState.prepares[0];
		expect(prepare?.endpoint).toBe("https://api3.qoder.sh");
		expect(prepare?.modelKey).toBe("qmodel_preview");
		expect(prepare?.modelSource).toBe("system");
		const signedBody = asRecord(
			JSON.parse(prepare?.bodyJson ?? ""),
			"prepared body",
		);
		expect(asRecord(signedBody.model_config, "model_config").key).toBe(
			"qmodel_preview",
		);

		// …and the transport POSTed it verbatim, privacy header included.
		expect(fetches.inferRequests).toHaveLength(1);
		const request = fetches.inferRequests[0];
		expect(request?.url).toContain("https://api3.qoder.sh/algo/");
		expect(request?.headers.get("Cosy-Data-Policy")).toBe("disagree");
		expect(request?.headers.get("X-Model-Key")).toBe("qmodel_preview");
		expect(request?.body).toBe(
			`encrypted(${(prepare?.bodyJson ?? "").length}):${prepare?.bodyJson ?? ""}`,
		);
	});

	it("signs alias turns with the base wire id and the alias window", async () => {
		const { bridgeState } = await runApi3Turn("qmodel_preview-400k", () =>
			sseResponse(HAPPY_SSE),
		);
		const prepare = bridgeState.prepares[0];
		expect(prepare?.modelKey).toBe("qmodel_preview");
		const signedBody = asRecord(
			JSON.parse(prepare?.bodyJson ?? ""),
			"prepared body",
		);
		expect(asRecord(signedBody.model_config, "model_config").key).toBe(
			"qmodel_preview",
		);
		expect(asRecord(signedBody.parameters, "parameters").context_length).toBe(
			400_000,
		);
	});

	// (c) error envelope → error stop with the surfaced message
	it("maps an error envelope to an error stop with the surfaced message", async () => {
		const errorSse = [
			`data: ${envelope(JSON.stringify({ code: "101", message: "Signature invalid" }))}`,
			FINISH_METRICS_FRAME,
			"",
		].join("\n\n");
		const { events, result } = await runApi3Turn("qmodel_preview", () =>
			sseResponse(errorSse),
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Qoder api3 error 101: Signature invalid");
		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		const terminal = events[events.length - 1];
		if (terminal?.type === "error") {
			expect(terminal.reason).toBe("error");
			expect(terminal.error.errorMessage).toContain("Signature invalid");
		}
	});

	// (d) folded envelopes survive the repair pass
	it("repairs a folded envelope payload split across lines and network chunks", async () => {
		const textLine = `data: ${chunkEnvelope({ choices: [{ delta: { content: "hello" }, index: 0 }] })}`;
		const tailFrames = [
			`data: ${chunkEnvelope({
				choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			})}`,
			`data: ${envelope("[DONE]")}`,
			FINISH_METRICS_FRAME,
		];
		// Fold the first frame's JSON payload across a physical newline (the
		// continuation line has no data: prefix, like Qoder's folding).
		const cut = textLine.indexOf("hello") + 2;
		const foldedSse = [
			`${textLine.slice(0, cut)}\n${textLine.slice(cut)}`,
			...tailFrames,
			"",
		].join("\n\n");
		// …and split the byte stream mid-fold across two network chunks.
		const splitAt = foldedSse.indexOf("hello") + 1;
		const encoder = new TextEncoder();
		const byteStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(foldedSse.slice(0, splitAt)));
				controller.enqueue(encoder.encode(foldedSse.slice(splitAt)));
				controller.close();
			},
		});
		const { events, result } = await runApi3Turn(
			"qmodel_preview",
			() =>
				new Response(byteStream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);

		expect(result.stopReason).toBe("stop");
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("");
		expect(text).toBe("hello");
		expect(result.usage.input).toBe(1);
		expect(result.usage.output).toBe(1);
		expect(result.usage.totalTokens).toBe(2);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
	});

	// (e) mid-stream failure closes open blocks before the terminal error
	it("closes the open block before the terminal error when the stream fails mid-turn", async () => {
		const encoder = new TextEncoder();
		let pulled = false;
		const failingStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!pulled) {
					pulled = true;
					controller.enqueue(
						encoder.encode(
							`data: ${chunkEnvelope({ choices: [{ delta: { content: "partial" }, index: 0 }] })}\n\n`,
						),
					);
					return;
				}
				controller.error(new Error("socket reset"));
			},
		});
		const { events, result } = await runApi3Turn(
			"qmodel_preview",
			() =>
				new Response(failingStream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("socket reset");
		const types = events.map((event) => event.type);
		const textEnd = types.indexOf("text_end");
		const errorIndex = types.indexOf("error");
		expect(types).toContain("text_start");
		expect(textEnd).toBeGreaterThan(-1);
		expect(errorIndex).toBeGreaterThan(-1);
		// No orphaned text_start: the consumer sees text_end before the error.
		expect(textEnd).toBeLessThan(errorIndex);
	});

	// (f) credential rotation: the newest context lives, stale frees when idle
	it("frees only the superseded credential's context once its turn ends", async () => {
		const freed: string[] = [];
		const bridge: QoderWasmBridge = {
			createContext(_machineId, _cosyVersion, userInfoJson) {
				const parsed: unknown = JSON.parse(userInfoJson);
				const uid = asRecord(parsed, "userInfo").uid;
				if (typeof uid !== "string") throw new Error("userInfo missing uid");
				return {
					prepareInferRequest(endpoint, bodyJson, modelKey, modelSource) {
						const prepared: QoderPreparedRequest = {
							url: `${endpoint}/infer`,
							headers: { "Cosy-Data-Policy": QODER_PRIVATE_DATA_POLICY },
							body: bodyJson,
						};
						void modelKey;
						void modelSource;
						return prepared;
					},
					prepareRequest() {
						throw new Error("out of scope");
					},
					decryptServerResponse(encrypted) {
						return encrypted;
					},
					free() {
						freed.push(uid);
					},
				};
			},
			generateRuntimeAuthFields() {
				return { encrypt_user_info: "e", key: "k" };
			},
			decryptServerResponse(encrypted) {
				return encrypted;
			},
		};
		const transport = createQoderApi3Transport({
			bridge,
			machineId: "machine-test",
			openapiBase: "https://openapi.qoder.sh",
			api3Base: QODER_API3_BASE,
			cosyVersion: "1.1.2",
			clientName: "omp",
			repair: repairQoderSseBody,
		});
		const { requestModelId: _dropped, ...overlayFields } =
			byId("qmodel_preview");
		const model = buildModel({
			api: QODER_API_ID,
			provider: PROVIDER_ID,
			baseUrl: MODEL_BASE,
			...overlayFields,
		});
		const route = api3Route("qmodel_preview");

		// The old credential's userinfo response is gated; the new credential
		// resolves immediately, so the stale resolution lands after rotation.
		const oldUserinfoGate = Promise.withResolvers<void>();
		const oldUserinfoStarted = Promise.withResolvers<void>();
		const fetchImpl: FetchImpl = async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof Request
						? input.url
						: input.toString();
			if (url.includes("/api/v1/userinfo")) {
				const auth = new Headers(init?.headers).get("Authorization") ?? "";
				if (auth.includes("token-old")) {
					oldUserinfoStarted.resolve();
					await oldUserinfoGate.promise;
				}
				const uid = auth.includes("token-old") ? "uid-old" : "uid-new";
				return new Response(JSON.stringify({ id: uid }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return sseResponse(HAPPY_SSE);
		};

		const collect = async (
			apiKey: string,
		): Promise<{ result: AssistantMessage }> => {
			const stream = transport.stream(route, model, userContext(), {
				apiKey,
				fetch: fetchImpl,
			});
			for await (const _event of stream) {
				// drain
			}
			return { result: await stream.result() };
		};

		const oldTurn = collect("token-old");
		// Rotate only after the old turn is provably parked on its userinfo
		// fetch — no wall-clock guessing.
		await oldUserinfoStarted.promise;
		const newTurn = collect("token-new");
		const newResult = await newTurn;
		expect(newResult.result.stopReason).toBe("toolUse");
		oldUserinfoGate.resolve();
		const oldResult = await oldTurn;
		expect(oldResult.result.stopReason).toBe("toolUse");

		// The stale context freed exactly once (after its turn released), the
		// live credential's context was never freed by the late resolution.
		expect(freed).toEqual(["uid-old"]);
	});
});
