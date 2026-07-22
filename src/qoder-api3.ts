/**
 * Qoder api3 streaming transport.
 *
 * The six api3-only model families (Cantus, Qwen3.8-Max-Preview, Qwen3.7-Max,
 * Kimi-K3, GLM-5.2, DeepSeek-V4-Flash) are served exclusively through
 * `https://api3.qoder.sh`, whose request auth is a WASM signature — this
 * module builds the plaintext body per the verified live contract, signs and
 * encrypts it through the WASM bridge, POSTs it, and maps the plaintext SSE
 * envelope stream onto `AssistantMessageEventStream` events with the same
 * semantics as the legacy `streamQoderSimple` path (start → block
 * start/delta/end → done/error).
 *
 * Identity chain (verified live 2026-07-22): the OAuth device token is NOT a
 * JWT; `uid` comes from `GET /api/v1/userinfo`, the WASM auth fields come
 * from `generate_runtime_auth_fields(identityJson)` over the identity JSON
 * (not the machine id), and the context userInfo carries
 * `data_policy_agreed: false` so every emitted request carries
 * `Cosy-Data-Policy: disagree` (Privacy Mode, non-overridable). The api3 body
 * itself carries no data_policy field.
 */

import { randomUUID } from "node:crypto";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolChoice,
	Usage,
} from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import {
	convertMessages,
	parseChunkUsage,
} from "@oh-my-pi/pi-ai/providers/openai-completions";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import type { QoderWasmBridge, QoderWasmContext } from "./qoder-wasm.js";

/** api3 inference endpoint host (the WASM prepares the full path per request). */
export const QODER_API3_BASE =
	process.env.QODER_API3_BASE?.trim() || "https://api3.qoder.sh";

/** Output cap sent as `parameters.max_tokens` when the caller sets none. */
const API3_DEFAULT_MAX_TOKENS = 32_768;

/** Client-attribution config that reproduces the real CLI's `Cosy-*` header set. */
const QODER_API3_CONFIG_JSON = JSON.stringify({
	client_type: "5",
	business_product: "cli",
	business_type: "agent",
	scene: "assistant",
});

/** Everything the transport needs to shape one model's api3 request. */
export interface QoderApi3ModelRoute {
	/** Base wire key (`model_config.key` / `X-Model-Key`). */
	wireId: string;
	/** Base display name (`model_config.display_name`). */
	displayName: string;
	/** Requested window → `parameters.context_length` (alias window on aliases). */
	contextWindow: number;
	/** Model's effective max input → `model_config.max_input_tokens`. */
	maxInputTokens: number;
	isReasoning: boolean;
	isVl: boolean;
	/** Static or catalog-overlaid effort ladder (empty = reasoning with no ladder). */
	efforts: readonly string[];
	defaultEffort: string | undefined;
	requiresEffort: boolean;
	/** The model reshaped for pi-ai's OpenAI message/usage serialization. */
	openaiModel: Model<"openai-completions">;
}

export interface QoderApi3TransportDeps {
	bridge: QoderWasmBridge;
	machineId: string;
	/** e.g. `https://openapi.qoder.sh` — serves `/api/v1/userinfo`. */
	openapiBase: string;
	/** e.g. `https://api3.qoder.sh` — inference + management endpoint. */
	api3Base: string;
	cosyVersion: string;
	/** `business.name` client attribution (e.g. "omp"). */
	clientName: string;
	/** The plugin's folded-SSE repair, applied before envelope framing. */
	repair: (body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>;
	/** Fired once per newly built WASM context (drives the catalog overlay). */
	onContext?: (ctx: QoderWasmContext, fetchImpl: FetchImpl | undefined) => void;
}

export interface QoderApi3Transport {
	stream(
		route: QoderApi3ModelRoute,
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Last user message's text, for `chat_context.text`/`originalContent`. */
function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

/** OpenAI chat-completions tool array (`[]` when no tools are offered). */
function toOpenAITools(tools: Context["tools"]): Record<string, unknown>[] {
	if (!tools || tools.length === 0) return [];
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description ?? "",
			parameters: toolWireSchema(tool),
		},
	}));
}

function toOpenAIToolChoice(choice: ToolChoice | undefined): unknown {
	if (choice === undefined) return undefined;
	if (choice === "any") return "required";
	if (typeof choice === "string") return choice;
	if ("function" in choice) {
		return { type: "function", function: { name: choice.function.name } };
	}
	return { type: "function", function: { name: choice.name } };
}

/**
 * Resolve the wire effort token. Non-reasoning models send no effort fields;
 * `disableReasoning` maps to `"none"` (+ `max_thinking_tokens: 0`) unless the
 * model requires an effort; a requested effort outside the ladder falls back
 * to the route default, then the ladder top.
 */
export function resolveApi3Effort(
	route: Pick<
		QoderApi3ModelRoute,
		"isReasoning" | "efforts" | "defaultEffort" | "requiresEffort"
	>,
	options?: SimpleStreamOptions,
): string | undefined {
	if (!route.isReasoning) return undefined;
	if (options?.disableReasoning === true && !route.requiresEffort)
		return "none";
	const requested =
		typeof options?.reasoning === "string"
			? String(options.reasoning)
			: undefined;
	if (requested !== undefined && route.efforts.includes(requested))
		return requested;
	if (
		route.defaultEffort !== undefined &&
		(route.efforts.length === 0 || route.efforts.includes(route.defaultEffort))
	) {
		return route.defaultEffort;
	}
	const ladderTop = route.efforts[route.efforts.length - 1];
	return ladderTop ?? "high";
}

export interface QoderApi3BodyArgs {
	route: QoderApi3ModelRoute;
	context: Context;
	options?: SimpleStreamOptions;
	cosyVersion: string;
	clientName: string;
}

/**
 * Build the plaintext api3 body per the live-verified contract (the router
 * 400s when any required field is missing). Twin effort fields:
 * `reasoningEffort` (top-level camelCase) and `parameters.reasoning_effort`.
 */
export function buildQoderApi3Body(
	args: QoderApi3BodyArgs,
): Record<string, unknown> {
	const { route, context, options } = args;
	const messages = convertMessages(
		route.openaiModel,
		context,
		route.openaiModel.compat,
	);
	const system =
		context.systemPrompt !== undefined ? context.systemPrompt.join("\n\n") : "";
	const promptText = lastUserText(context);
	const effort = resolveApi3Effort(route, options);
	const parameters: Record<string, unknown> = {
		max_tokens: options?.maxTokens ?? API3_DEFAULT_MAX_TOKENS,
		context_length: route.contextWindow,
	};
	if (effort !== undefined) {
		parameters.reasoning_effort = effort;
		if (effort === "none") parameters.max_thinking_tokens = 0;
	}
	const body: Record<string, unknown> = {
		request_id: randomUUID(),
		request_set_id: randomUUID(),
		chat_record_id: randomUUID(),
		session_id: randomUUID(),
		stream: true,
		chat_task: "FREE_INPUT",
		chat_context: {
			text: promptText,
			features: [],
			extra: {
				context: [],
				modelConfig: { key: route.wireId, is_reasoning: route.isReasoning },
				originalContent: promptText,
			},
			chatPrompt: "",
			imageUrls: null,
		},
		is_reply: true,
		is_retry: false,
		source: 1,
		version: "3",
		agent_id: "agent_common",
		task_id: randomUUID().slice(0, 6),
		session_type: "qodercli",
		aliyun_user_type: "",
		model_config: {
			key: route.wireId,
			display_name: route.displayName,
			model: "",
			format: "openai",
			is_vl: route.isVl,
			is_reasoning: route.isReasoning,
			api_key: "",
			url: "",
			source: "system",
			max_input_tokens: route.maxInputTokens,
		},
		system,
		messages,
		tools: toOpenAITools(context.tools),
		parameters,
		business: {
			product: "cli",
			version: args.cosyVersion,
			type: "agent",
			id: randomUUID(),
			name: args.clientName,
			begin_at: Date.now(),
			stage: "start",
		},
	};
	if (effort !== undefined) body.reasoningEffort = effort;
	if (options?.temperature !== undefined)
		body.temperature = options.temperature;
	if (options?.topP !== undefined) body.top_p = options.topP;
	if (
		options?.stopSequences !== undefined &&
		options.stopSequences.length > 0
	) {
		body.stop =
			options.stopSequences.length === 1
				? options.stopSequences[0]
				: options.stopSequences;
	}
	const toolChoice = toOpenAIToolChoice(options?.toolChoice);
	if (toolChoice !== undefined) body.tool_choice = toolChoice;
	return body;
}

/** finish_reason → StopReason, mirroring pi-ai's OpenAI-completions mapping. */
function mapFinishReason(reason: string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	switch (reason) {
		case "stop":
		case "end_turn":
			return { stopReason: "stop" };
		case "length":
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_calls":
		case "function_call":
			return { stopReason: "toolUse" };
		case "content_filter":
			return {
				stopReason: "error",
				errorMessage: "Provider finish_reason: content_filter",
			};
		case "network_error":
			return {
				stopReason: "error",
				errorMessage: "Provider finish_reason: network_error",
			};
		case "error":
			return {
				stopReason: "error",
				errorMessage: "Provider returned error finish_reason",
			};
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

/** Format an api3 error body (`{"code":"101","message":"Signature invalid"}` and router 400s). */
function formatApi3Error(chunk: Record<string, unknown>): string {
	const code = typeof chunk.code === "string" ? chunk.code : undefined;
	const message = typeof chunk.message === "string" ? chunk.message : undefined;
	if (code !== undefined && message !== undefined)
		return `Qoder api3 error ${code}: ${message}`;
	if (message !== undefined) return `Qoder api3 error: ${message}`;
	return `Qoder api3 error: ${JSON.stringify(chunk).slice(0, 500)}`;
}

interface ToolBlockState {
	block: ToolCall;
	contentIndex: number;
	argsText: string;
	ended: boolean;
}

interface TurnState {
	output: AssistantMessage;
	openBlock: { kind: "text" | "thinking"; index: number } | null;
	toolBlocks: Map<number, ToolBlockState>;
	toolCallCounter: number;
	stopReason: StopReason;
	errorMessage: string | undefined;
	usage: Usage | undefined;
	sawDone: boolean;
	sawFinishReason: boolean;
}

function parseJsonObject(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Read the response body as repaired SSE events. `repairQoderSseBody` emits
 * one event per `\n\n` frame; each event carries a single `data:` line whose
 * payload is an envelope `{headers, body: "<json-escaped chunk>", statusCode,
 * statusCodeValue}`. Termination: envelope `body:"[DONE]"` (or a bare
 * `data:[DONE]`), then an `event:finish` metrics frame.
 */
async function processApi3Stream(
	body: ReadableStream<Uint8Array>,
	deps: QoderApi3TransportDeps,
	route: QoderApi3ModelRoute,
	state: TurnState,
	stream: AssistantMessageEventStream,
	onFirstToken: () => void,
	signal: AbortSignal | undefined,
): Promise<void> {
	const { output } = state;

	const closeOpenBlock = (): void => {
		const open = state.openBlock;
		if (open === null) return;
		state.openBlock = null;
		const block = output.content[open.index];
		if (open.kind === "text" && block?.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex: open.index,
				content: block.text,
				partial: output,
			});
		} else if (open.kind === "thinking" && block?.type === "thinking") {
			stream.push({
				type: "thinking_end",
				contentIndex: open.index,
				content: block.thinking,
				partial: output,
			});
		}
	};

	const finishToolBlock = (tool: ToolBlockState): void => {
		if (tool.ended) return;
		tool.ended = true;
		tool.block.arguments = parseJsonObject(tool.argsText);
		stream.push({
			type: "toolcall_end",
			contentIndex: tool.contentIndex,
			toolCall: tool.block,
			partial: output,
		});
	};

	const finishPendingToolBlocks = (): void => {
		for (const tool of state.toolBlocks.values()) finishToolBlock(tool);
	};

	const openTextBlock = (kind: "text" | "thinking"): void => {
		closeOpenBlock();
		finishPendingToolBlocks();
		const block: TextContent | ThinkingContent =
			kind === "text"
				? { type: "text", text: "" }
				: { type: "thinking", thinking: "" };
		output.content.push(block);
		const index = output.content.length - 1;
		state.openBlock = { kind, index };
		stream.push(
			kind === "text"
				? { type: "text_start", contentIndex: index, partial: output }
				: { type: "thinking_start", contentIndex: index, partial: output },
		);
	};

	const appendText = (delta: string): void => {
		if (state.openBlock?.kind !== "text") openTextBlock("text");
		const open = state.openBlock;
		if (open === null) return;
		const block = output.content[open.index];
		if (block?.type !== "text") return;
		block.text += delta;
		onFirstToken();
		stream.push({
			type: "text_delta",
			contentIndex: open.index,
			delta,
			partial: output,
		});
	};

	const appendThinking = (delta: string): void => {
		if (state.openBlock?.kind !== "thinking") openTextBlock("thinking");
		const open = state.openBlock;
		if (open === null) return;
		const block = output.content[open.index];
		if (block?.type !== "thinking") return;
		block.thinking += delta;
		onFirstToken();
		stream.push({
			type: "thinking_delta",
			contentIndex: open.index,
			delta,
			partial: output,
		});
	};

	const appendToolCalls = (calls: unknown[]): void => {
		for (const call of calls) {
			if (!isRecord(call)) continue;
			const toolIndex =
				typeof call.index === "number" ? call.index : state.toolBlocks.size;
			let tool = state.toolBlocks.get(toolIndex);
			if (tool === undefined) {
				closeOpenBlock();
				const fn = isRecord(call.function) ? call.function : {};
				state.toolCallCounter += 1;
				const block: ToolCall = {
					type: "toolCall",
					id:
						typeof call.id === "string" && call.id.length > 0
							? call.id
							: `qoder_call_${state.toolCallCounter}`,
					name: typeof fn.name === "string" ? fn.name : "",
					arguments: {},
				};
				output.content.push(block);
				const contentIndex = output.content.length - 1;
				tool = { block, contentIndex, argsText: "", ended: false };
				state.toolBlocks.set(toolIndex, tool);
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
			}
			const fn = isRecord(call.function) ? call.function : undefined;
			if (fn !== undefined) {
				if (typeof fn.name === "string" && tool.block.name.length === 0)
					tool.block.name = fn.name;
				if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
					tool.argsText += fn.arguments;
					onFirstToken();
					stream.push({
						type: "toolcall_delta",
						contentIndex: tool.contentIndex,
						delta: fn.arguments,
						partial: output,
					});
				}
			}
		}
	};

	const handleChunk = (chunk: Record<string, unknown>): void => {
		const choices = Array.isArray(chunk.choices) ? chunk.choices : undefined;
		if (choices === undefined) {
			// No choices at all: an error body, or a bare usage frame.
			if (typeof chunk.code === "string" || typeof chunk.message === "string") {
				state.stopReason = "error";
				state.errorMessage = formatApi3Error(chunk);
				return;
			}
			if (isRecord(chunk.usage)) {
				state.usage = parseChunkUsage(
					chunk.usage,
					route.openaiModel,
					undefined,
				);
			}
			return;
		}
		const choice =
			choices.length > 0 && isRecord(choices[0]) ? choices[0] : undefined;
		if (choice !== undefined) {
			const delta = isRecord(choice.delta) ? choice.delta : undefined;
			if (delta !== undefined) {
				if (
					typeof delta.reasoning_content === "string" &&
					delta.reasoning_content.length > 0
				) {
					appendThinking(delta.reasoning_content);
				}
				if (typeof delta.content === "string" && delta.content.length > 0) {
					appendText(delta.content);
				}
				if (Array.isArray(delta.tool_calls)) appendToolCalls(delta.tool_calls);
			}
			if (
				typeof choice.finish_reason === "string" &&
				choice.finish_reason.length > 0
			) {
				state.sawFinishReason = true;
				const mapped = mapFinishReason(choice.finish_reason);
				state.stopReason = mapped.stopReason;
				if (mapped.errorMessage !== undefined)
					state.errorMessage = mapped.errorMessage;
			}
		}
		if (isRecord(chunk.usage)) {
			state.usage = parseChunkUsage(chunk.usage, route.openaiModel, undefined);
		}
	};

	const handleDataPayload = (payload: string): void => {
		const trimmed = payload.trim();
		if (trimmed === "[DONE]") {
			state.sawDone = true;
			return;
		}
		let envelope: unknown;
		try {
			envelope = JSON.parse(trimmed);
		} catch {
			return;
		}
		if (!isRecord(envelope)) return;
		// Terminal metrics frame ({firstTokenDuration,totalDuration,serverDuration}).
		if (
			typeof envelope.totalDuration === "number" ||
			typeof envelope.firstTokenDuration === "number"
		) {
			return;
		}
		if (typeof envelope.body !== "string") return;
		const bodyText = envelope.body;
		if (bodyText === "[DONE]") {
			state.sawDone = true;
			return;
		}
		let chunk: unknown;
		try {
			chunk = JSON.parse(bodyText);
		} catch {
			state.stopReason = "error";
			state.errorMessage = `Qoder api3 stream error: ${bodyText.slice(0, 500)}`;
			return;
		}
		if (!isRecord(chunk)) return;
		handleChunk(chunk);
		if (
			state.errorMessage === undefined &&
			typeof envelope.statusCodeValue === "number" &&
			envelope.statusCodeValue >= 400 &&
			!Array.isArray(chunk.choices)
		) {
			state.stopReason = "error";
			state.errorMessage = `Qoder api3 request failed (${envelope.statusCodeValue}): ${bodyText.slice(0, 500)}`;
		}
	};

	const reader = deps.repair(body).getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	try {
		while (true) {
			if (signal?.aborted === true)
				throw new DOMException("The operation was aborted.", "AbortError");
			const { done, value } = await reader.read();
			buffered += decoder.decode(value, { stream: !done });
			let frameEnd = buffered.indexOf("\n\n");
			while (frameEnd !== -1) {
				const frame = buffered.slice(0, frameEnd);
				buffered = buffered.slice(frameEnd + 2);
				for (const line of frame.split("\n")) {
					if (line.startsWith("data:")) handleDataPayload(line.slice(5));
				}
				frameEnd = buffered.indexOf("\n\n");
			}
			if (done) break;
		}
		if (buffered.trim().length > 0) {
			for (const line of buffered.split("\n")) {
				if (line.startsWith("data:")) handleDataPayload(line.slice(5));
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/**
 * Create the api3 transport over a live WASM bridge. The per-token identity
 * chain (userinfo uid → runtime auth fields → WASM context) is resolved once
 * and cached; a rejection evicts the entry so the next turn retries.
 */
export function createQoderApi3Transport(
	deps: QoderApi3TransportDeps,
): QoderApi3Transport {
	interface ContextEntry {
		promise: Promise<QoderWasmContext>;
		refs: number;
		stale: boolean;
	}
	const contexts = new Map<string, ContextEntry>();
	// Monotonic credential generation: only the most recently requested
	// credential's context may evict the others once resolved, so a slow stale
	// resolution can never free the live context.
	let latestGeneration = 0;

	const freeWhenIdle = (entry: ContextEntry): void => {
		if (!entry.stale || entry.refs > 0) return;
		void entry.promise.then((ctx) => ctx.free()).catch(() => {});
	};

	/**
	 * Lease the per-credential context. The turn holds a reference until it is
	 * done streaming, so rotation eviction can never free a context a live
	 * turn is mid-flight with; stale contexts free once their last turn ends.
	 */
	const acquireContext = (
		apiKey: string,
		fetchImpl: FetchImpl,
		signal: AbortSignal | undefined,
	): { promise: Promise<QoderWasmContext>; release: () => void } => {
		const cached = contexts.get(apiKey);
		if (cached !== undefined) {
			cached.refs += 1;
			return {
				promise: cached.promise,
				release: () => {
					cached.refs -= 1;
					freeWhenIdle(cached);
				},
			};
		}
		const entry: ContextEntry = {
			promise: (async (): Promise<QoderWasmContext> => {
				const response = await fetchImpl(
					`${deps.openapiBase}/api/v1/userinfo`,
					{
						headers: {
							Authorization: `Bearer ${apiKey}`,
							Accept: "application/json",
						},
						signal: signal ?? null,
					},
				);
				if (!response.ok)
					throw new Error(`Qoder userinfo failed (${response.status})`);
				const info: unknown = await response.json();
				if (
					!isRecord(info) ||
					typeof info.id !== "string" ||
					info.id.length === 0
				) {
					throw new Error("Qoder userinfo returned no account id");
				}
				const uid = info.id;
				const identityJson = JSON.stringify({
					uid,
					organization_id: "",
					organization_tags: [],
					data_policy_agreed: false,
				});
				const authFields = deps.bridge.generateRuntimeAuthFields(identityJson);
				const userInfo = {
					uid,
					encrypt_user_info: authFields.encrypt_user_info,
					key: authFields.key,
					organization_id: "",
					organization_tags: [],
					data_policy_agreed: false,
				};
				return deps.bridge.createContext(
					deps.machineId,
					deps.cosyVersion,
					JSON.stringify(userInfo),
					QODER_API3_CONFIG_JSON,
				);
			})(),
			refs: 1,
			stale: false,
		};
		const generation = ++latestGeneration;
		contexts.set(apiKey, entry);
		// Keep only the latest credential's context: on refresh the access token
		// rotates, and the superseded context's WASM linear memory must not
		// accumulate across refreshes. Eviction marks stale and frees once idle.
		void entry.promise
			.then((created) => {
				if (generation !== latestGeneration) return created;
				for (const [key, other] of contexts) {
					if (key === apiKey) continue;
					contexts.delete(key);
					other.stale = true;
					freeWhenIdle(other);
				}
				return created;
			})
			.catch(() => {});
		entry.promise.catch(() => contexts.delete(apiKey));
		return {
			promise: entry.promise,
			release: () => {
				entry.refs -= 1;
				freeWhenIdle(entry);
			},
		};
	};

	const runTurn = async (
		route: QoderApi3ModelRoute,
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions | undefined,
		stream: AssistantMessageEventStream,
	): Promise<void> => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const onFirstToken = (): void => {
			firstTokenTime ??= performance.now();
		};
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const state: TurnState = {
			output,
			openBlock: null,
			toolBlocks: new Map(),
			toolCallCounter: 0,
			stopReason: "stop",
			errorMessage: undefined,
			usage: undefined,
			sawDone: false,
			sawFinishReason: false,
		};
		const fetchImpl: FetchImpl = options?.fetch ?? fetch;
		const finalize = (): void => {
			output.stopReason = state.stopReason;
			if (state.errorMessage !== undefined)
				output.errorMessage = state.errorMessage;
			if (state.usage !== undefined) output.usage = state.usage;
			output.duration = performance.now() - startTime;
			if (firstTokenTime !== undefined)
				output.ttft = firstTokenTime - startTime;
		};
		// Close open text/thinking blocks and finish pending tool calls so
		// consumers tracking block lifecycles never see orphaned starts —
		// required on both the normal terminal path and the error path
		// (mirrors pi-ai's finishOpenBlocksOnError convention).
		const teardownOpenBlocks = (): void => {
			const open = state.openBlock;
			if (open !== null) {
				state.openBlock = null;
				const block = output.content[open.index];
				if (open.kind === "text" && block?.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: open.index,
						content: block.text,
						partial: output,
					});
				} else if (open.kind === "thinking" && block?.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex: open.index,
						content: block.thinking,
						partial: output,
					});
				}
			}
			for (const tool of state.toolBlocks.values()) {
				if (tool.ended) continue;
				tool.ended = true;
				tool.block.arguments = parseJsonObject(tool.argsText);
				stream.push({
					type: "toolcall_end",
					contentIndex: tool.contentIndex,
					toolCall: tool.block,
					partial: output,
				});
			}
		};
		const emitTerminalError = (
			stopReason: "error" | "aborted",
			message: string,
		): void => {
			state.stopReason = stopReason;
			state.errorMessage = message;
			teardownOpenBlocks();
			finalize();
			stream.push({ type: "error", reason: stopReason, error: output });
			stream.end();
		};

		const apiKey =
			typeof options?.apiKey === "string" ? options.apiKey : undefined;
		if (apiKey === undefined || apiKey.length === 0) {
			emitTerminalError(
				"error",
				"Qoder api3 requires a Qoder OAuth credential",
			);
			return;
		}
		const lease = acquireContext(apiKey, fetchImpl, options?.signal);
		try {
			const ctx = await lease.promise;
			deps.onContext?.(ctx, options?.fetch);

			let body = buildQoderApi3Body({
				route,
				context,
				options,
				cosyVersion: deps.cosyVersion,
				clientName: deps.clientName,
			});
			if (options?.onPayload !== undefined) {
				const mutated = await options.onPayload(body, model);
				if (isRecord(mutated)) body = mutated;
			}
			const prepared = ctx.prepareInferRequest(
				deps.api3Base,
				JSON.stringify(body),
				route.wireId,
				"system",
			);
			const response = await fetchImpl(prepared.url, {
				method: "POST",
				headers: prepared.headers,
				body: prepared.body ?? "",
				signal: options?.signal ?? null,
			});
			if (options?.onResponse !== undefined) {
				const headers: Record<string, string> = {};
				response.headers.forEach((value, key) => {
					headers[key.toLowerCase()] = value;
				});
				await options.onResponse({ status: response.status, headers }, model);
			}
			if (!response.ok || response.body === null) {
				const detail = await response.text().catch(() => "");
				output.errorStatus = response.status;
				emitTerminalError(
					"error",
					`Qoder api3 request failed (${response.status})${detail.length > 0 ? `: ${detail.slice(0, 500)}` : ""}`,
				);
				return;
			}

			stream.push({ type: "start", partial: output });
			await processApi3Stream(
				response.body,
				deps,
				route,
				state,
				stream,
				onFirstToken,
				options?.signal,
			);

			// Terminal: close any open block, finish pending tool calls, then
			// promote a natural stop with tool calls to toolUse (mirrors the
			// OpenAI-completions semantics the legacy path relies on).
			teardownOpenBlocks();
			if (state.stopReason === "stop" && state.toolBlocks.size > 0) {
				state.stopReason = "toolUse";
			}
			// The api3 contract terminates every successful stream with a `[DONE]`
			// envelope after a finish_reason chunk; EOF before either means the
			// stream was truncated, not complete.
			if (
				!state.sawDone &&
				!state.sawFinishReason &&
				state.stopReason !== "error" &&
				state.stopReason !== "aborted"
			) {
				state.stopReason = "error";
				state.errorMessage = "Qoder api3 stream ended before a terminal frame";
			}
			finalize();
			if (state.stopReason === "error" || state.stopReason === "aborted") {
				stream.push({ type: "error", reason: state.stopReason, error: output });
			} else {
				stream.push({
					type: "done",
					reason: state.stopReason,
					message: output,
				});
			}
			stream.end();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted =
				options?.signal?.aborted === true ||
				(error instanceof DOMException && error.name === "AbortError");
			emitTerminalError(aborted ? "aborted" : "error", message);
		} finally {
			lease.release();
		}
	};

	return {
		stream(route, model, context, options) {
			const stream = createAssistantMessageEventStream();
			void runTurn(route, model, context, options, stream);
			return stream;
		},
	};
}
