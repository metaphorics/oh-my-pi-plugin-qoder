import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@oh-my-pi/pi-ai/oauth";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type {
	ExtensionAPI,
	ProviderModelConfig,
} from "@oh-my-pi/pi-coding-agent";

export const PROVIDER_ID = "qoder";
export const CLI_VERSION = "1.1.1";
export const CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
export const WEB_BASE =
	process.env.QODER_WEB_BASE?.trim() || "https://qoder.com";
export const OPENAPI_BASE =
	process.env.QODER_OPENAPI_BASE?.trim() || "https://openapi.qoder.sh";
export const MODEL_BASE = process.env.QODER_MODEL_SERVER_HOST
	? `https://${process.env.QODER_MODEL_SERVER_HOST.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/model/v1`
	: "https://api2-v2.qoder.sh/model/v1";
/**
 * Custom API id for the provider's stream adapter. omp reserves built-in API
 * names, so the adapter registers under its own id and delegates to the
 * stock openai-completions stream with a Qoder-shaped model and fetch.
 */
export const QODER_API_ID = "qoder-completions";
const OAUTH_TOKEN = process.env.QODER_OAUTH_TOKEN?.trim();
const SKEW_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;
const QODER_MAX_OUTPUT_TOKENS = 32_768;

// ---------------------------------------------------------------------------
// Model catalog
//
// Static seed reverse-engineered from an authenticated `qodercli --list-models`
// (the account catalog endpoint is wasm-signed, so dynamic discovery is out of
// scope), pruned to the nine base wire keys the legacy api2-v2 transport
// actually serves: live probing returns empty completions for the six
// api3-only families (Cantus, Qwen3.8-Max-Preview, Qwen3.7-Max, Kimi-K3,
// GLM-5.2, DeepSeek-V4-Flash), which require Qoder's WASM-signed transport.
// The five multi-window models also get `-400k`/`-1m` local aliases that pin
// `requestModelId` to the base wire key and send a top-level `context_length`
// matching the alias window. `auto`, `efficient`, and `lite` are 180k-only;
// `kmodel` is 256k-only — no aliases.
// ---------------------------------------------------------------------------

/** ProviderModelConfig plus the alias wire-key carrier (added to omp's extension contract). */
export interface QoderModelConfig extends ProviderModelConfig {
	/** Base wire key for local context aliases; absent on base rows. */
	requestModelId?: string;
}

type QoderThinking = NonNullable<ProviderModelConfig["thinking"]>;

const EFFORT_LADDER_LOW_TO_MAX = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LADDER_HIGH_TO_MAX = ["high", "max"];

/** Effort values are plain strings on the wire; omp's `Effort` const enum is type-only here. */
function effortThinking(
	efforts: readonly string[],
	defaultLevel: string,
	requiresEffort?: boolean,
): QoderThinking {
	return {
		mode: "effort",
		efforts: efforts as QoderThinking["efforts"],
		defaultLevel: defaultLevel as QoderThinking["defaultLevel"],
		...(requiresEffort === true ? { requiresEffort: true } : {}),
	};
}

interface QoderBaseSpec {
	id: string;
	name: string;
	contextWindow: number;
	reasoning?: boolean;
	thinking?: QoderThinking;
	/** Defaults to true; `lite` is the only text-only model. */
	vision?: boolean;
	/** Multi-window models get `-400k` and `-1m` context aliases. */
	multiWindow?: boolean;
}

const QODER_BASE_SPECS: readonly QoderBaseSpec[] = [
	{ id: "auto", name: "Qoder (Auto)", contextWindow: 180_000 },
	{
		id: "ultimate",
		name: "Ultimate",
		contextWindow: 200_000,
		reasoning: true,
		thinking: effortThinking(EFFORT_LADDER_LOW_TO_MAX, "high"),
		multiWindow: true,
	},
	{
		id: "performance",
		name: "Performance",
		contextWindow: 272_000,
		multiWindow: true,
	},
	{ id: "efficient", name: "Efficient", contextWindow: 180_000 },
	{ id: "lite", name: "Lite", contextWindow: 180_000, vision: false },
	{
		id: "qmodel",
		name: "Qwen3.7-Plus",
		contextWindow: 200_000,
		multiWindow: true,
	},
	// Sole model with Qoder's `highspeed` feature switch (drives /fast); 256k-only.
	{ id: "kmodel", name: "Kimi-K2.7-Code", contextWindow: 262_144 },
	{
		id: "dmodel",
		name: "DeepSeek-V4-Pro",
		contextWindow: 200_000,
		reasoning: true,
		thinking: effortThinking(EFFORT_LADDER_HIGH_TO_MAX, "max"),
		multiWindow: true,
	},
	{
		id: "mmodel",
		name: "MiniMax-M3",
		contextWindow: 200_000,
		multiWindow: true,
	},
];

const CONTEXT_ALIAS_WINDOWS = [
	{ suffix: "400k", label: "400K", contextWindow: 400_000 },
	{ suffix: "1m", label: "1M", contextWindow: 1_000_000 },
] as const;

function buildQoderModels(): QoderModelConfig[] {
	const models: QoderModelConfig[] = [];
	for (const spec of QODER_BASE_SPECS) {
		const base: QoderModelConfig = {
			id: spec.id,
			name: spec.name,
			reasoning: spec.reasoning ?? false,
			...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
			input: spec.vision === false ? ["text"] : ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsStore: false },
			contextWindow: spec.contextWindow,
			maxTokens: QODER_MAX_OUTPUT_TOKENS,
		};
		models.push(base);
		if (spec.multiWindow !== true) continue;
		for (const window of CONTEXT_ALIAS_WINDOWS) {
			models.push({
				...base,
				id: `${spec.id}-${window.suffix}`,
				name: `${spec.name} (${window.label})`,
				requestModelId: spec.id,
				compat: {
					...base.compat,
					extraBody: { context_length: window.contextWindow },
				},
				contextWindow: window.contextWindow,
			});
		}
	}
	return models;
}

/** All 19 registered rows: 9 base models + 10 context aliases. */
export const QODER_MODELS: readonly QoderModelConfig[] = buildQoderModels();

const QODER_MODEL_INDEX: Record<string, QoderModelConfig> = Object.fromEntries(
	QODER_MODELS.map((model) => [model.id, model]),
);

/** Qoder's high-speed switch exists only on `kmodel` (Kimi-K2.7-Code). */
export function isQoderFastModel(id: string): boolean {
	return id === "kmodel";
}

// ---------------------------------------------------------------------------
// Stream adapter: folded-SSE repair + scoped highspeed injection
// ---------------------------------------------------------------------------

/**
 * Rejoin SSE events whose JSON payload Qoder folded across a physical newline
 * without a `data:` prefix. A bare continuation line (including a leading
 * `:` split from its JSON property name) is appended to the preceding data
 * line; real `event:`/`id:`/`retry:` fields remain separate.
 * Buffered state spans chunks, so a fold split across network packets still repairs.
 */
function isCompleteQoderDataLine(line: string): boolean {
	const payload = line.slice(line.indexOf(":") + 1).trimStart();
	if (payload === "[DONE]") return true;
	try {
		JSON.parse(payload);
		return true;
	} catch {
		return false;
	}
}

export function repairQoderSseBody(
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffered = "";
	let eventLines: string[] = [];
	const flushEvent = (
		controller: TransformStreamDefaultController<Uint8Array>,
	): void => {
		if (eventLines.length === 0) return;
		const repaired: string[] = [];
		let dataLine = -1;
		for (const eventLine of eventLines) {
			if (/^data(?::|$)/.test(eventLine)) {
				dataLine = repaired.push(eventLine) - 1;
			} else if (
				dataLine !== -1 &&
				!/^(?:event|id|retry)(?::|$)/.test(eventLine) &&
				!isCompleteQoderDataLine(repaired[dataLine] ?? "")
			) {
				repaired[dataLine] += eventLine;
			} else {
				repaired.push(eventLine);
			}
		}
		controller.enqueue(encoder.encode(`${repaired.join("\n")}\n\n`));
		eventLines = [];
	};

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffered += decoder.decode(chunk, { stream: true });
				for (
					let newline = buffered.indexOf("\n");
					newline !== -1;
					newline = buffered.indexOf("\n")
				) {
					const line = buffered.slice(0, newline).replace(/\r$/, "");
					buffered = buffered.slice(newline + 1);
					if (line !== "") {
						eventLines.push(line);
						continue;
					}
					flushEvent(controller);
				}
			},
			flush(controller) {
				buffered += decoder.decode();
				if (buffered !== "") eventLines.push(buffered.replace(/\r$/, ""));
				flushEvent(controller);
			},
		}),
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge Qoder's high-speed switch into the request body, preserving any
 * existing metadata. Matches the CLI's serialization: the string "true",
 * nested under `metadata.business.feature_switches.highspeed`.
 */
function injectQoderHighspeed(
	init: RequestInit | undefined,
): RequestInit | undefined {
	if (init === undefined || typeof init.body !== "string") return init;
	let parsed: unknown;
	try {
		parsed = JSON.parse(init.body);
	} catch {
		return init;
	}
	if (!isPlainObject(parsed)) return init;
	const metadata = isPlainObject(parsed.metadata) ? parsed.metadata : {};
	const business = isPlainObject(metadata.business) ? metadata.business : {};
	const featureSwitches = isPlainObject(business.feature_switches)
		? business.feature_switches
		: {};
	parsed.metadata = {
		...metadata,
		business: {
			...business,
			feature_switches: { ...featureSwitches, highspeed: "true" },
		},
	};
	return { ...init, body: JSON.stringify(parsed) };
}

export interface QoderFetchOptions {
	/** Merge `metadata.business.feature_switches.highspeed="true"` into the request body. */
	highspeed?: boolean;
}

/**
 * Qoder fetch shim: optionally shapes the request body, then repairs folded
 * SSE responses. Only `text/event-stream` successes are transformed; every
 * other response passes through untouched.
 */
export function wrapQoderFetch(
	fetchImpl: FetchImpl = fetch,
	options: QoderFetchOptions = {},
): FetchImpl {
	return async (input, init) => {
		const response = await fetchImpl(
			input,
			options.highspeed ? injectQoderHighspeed(init) : init,
		);
		if (
			!response.ok ||
			!response.body ||
			!response.headers.get("content-type")?.includes("text/event-stream")
		) {
			return response;
		}
		return new Response(repairQoderSseBody(response.body), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

export const QODER_OPENAI_COMPAT: Model<"openai-completions">["compat"] = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsMultipleSystemMessages: false,
	supportsReasoningEffort: true,
	supportsReasoningParams: true,
	supportsSamplingParams: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	enableGeminiThinkingLoopGuard: false,
	alwaysSendMaxTokens: false,
	disableReasoningOnForcedToolChoice: false,
	disableReasoningOnToolChoice: false,
	supportsToolChoice: true,
	supportsForcedToolChoice: true,
	supportsNamedToolChoice: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	thinkingFormat: "openai",
	reasoningDisableMode: "lowest-effort",
	omitReasoningEffort: false,
	includeEncryptedReasoning: true,
	filterReasoningHistory: false,
	reasoningContentField: "reasoning_content",
	requiresReasoningContentForToolCalls: false,
	requiresReasoningContentForAllAssistantTurns: false,
	allowsSyntheticReasoningContentForToolCalls: true,
	replayReasoningContent: false,
	qwenPreserveThinking: false,
	requiresAssistantContentForToolCalls: false,
	isOpenRouterHost: false,
	wireModelIdMode: "raw",
	isVercelGatewayHost: false,
	supportsStrictMode: false,
	toolStrictMode: "mixed",
	stripDeepseekSpecialTokens: false,
	streamMarkupHealingPattern: "thinking",
	reasoningDeltasMayBeCumulative: false,
	emptyLengthFinishIsContextError: false,
	usesOpenAIToolCallIdLimit: false,
	dropThinkingWhenReasoningEffort: false,
};
type QoderOpenAICompatConfig = Partial<
	Pick<
		Model<"openai-completions">["compat"],
		| "allowsSyntheticReasoningContentForToolCalls"
		| "disableReasoningOnToolChoice"
		| "extraBody"
		| "requiresReasoningContentForAllAssistantTurns"
		| "requiresReasoningContentForToolCalls"
		| "supportsMultipleSystemMessages"
		| "supportsStore"
	>
>;
const QODER_OPENAI_COMPAT_OVERRIDES: Readonly<
	Record<string, QoderOpenAICompatConfig>
> = {
	dmodel: {
		supportsMultipleSystemMessages: true,
		disableReasoningOnToolChoice: true,
		requiresReasoningContentForToolCalls: true,
		requiresReasoningContentForAllAssistantTurns: true,
		allowsSyntheticReasoningContentForToolCalls: false,
	},
};

export function resolveQoderOpenAICompat(
	wireModelId: string,
	config: QoderOpenAICompatConfig | undefined,
): Model<"openai-completions">["compat"] {
	return {
		...QODER_OPENAI_COMPAT,
		...QODER_OPENAI_COMPAT_OVERRIDES[wireModelId],
		...config,
	};
}

/**
 * Rebuild the extension-registered model as a stock openai-completions model.
 * omp finalizes custom-API models without a resolved compat record and (on
 * versions before the extension contract carried it) drops `requestModelId`,
 * so the adapter re-attaches both from the plugin's own catalog before
 * delegating. The resolved compat defaults are local because marketplace
 * packages cannot resolve pi-catalog from the host.
 */
function toOpenAICompletionsModel(
	model: Model<Api>,
	requestModelId: string | undefined,
): Model<"openai-completions"> {
	const compatConfig = model.compatConfig as
		| QoderOpenAICompatConfig
		| undefined;
	return {
		...model,
		api: "openai-completions",
		...(requestModelId !== undefined ? { requestModelId } : {}),
		compat: resolveQoderOpenAICompat(requestModelId ?? model.id, compatConfig),
	} as Model<"openai-completions">;
}

/**
 * Stream adapter behind the provider's custom API id: delegates to the stock
 * openai-completions stream with a Qoder-shaped fetch. The highspeed body
 * switch is injected only when the caller asked for priority service AND the
 * resolved wire model is `kmodel`; OpenAI's `service_tier` is never emitted
 * for Qoder regardless.
 */
export function streamQoderSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const requestModelId =
		model.requestModelId ?? QODER_MODEL_INDEX[model.id]?.requestModelId;
	const highspeed =
		options?.serviceTier === "priority" &&
		isQoderFastModel(requestModelId ?? model.id);
	return streamOpenAICompletions(
		toOpenAICompletionsModel(model, requestModelId),
		context,
		{
			...options,
			// omp resolves an ApiKeyResolver to a plain string before per-provider dispatch.
			apiKey: options?.apiKey as string | undefined,
			fetch: wrapQoderFetch(options?.fetch, { highspeed }),
		},
	);
}

// ---------------------------------------------------------------------------
// OAuth: browser PKCE device-poll login + token refresh
// ---------------------------------------------------------------------------

type TokenResponse = {
	token?: unknown;
	refresh_token?: unknown;
	expires_at?: unknown;
};

function b64url(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function machineOs(): string {
	const arch =
		process.arch === "arm64"
			? "aarch64"
			: process.arch === "x64"
				? "x86_64"
				: process.arch;
	return `${arch}_${process.platform}`;
}

function parseExpires(value: unknown): number {
	if (typeof value === "number")
		return (value < 1e12 ? value * 1000 : value) - SKEW_MS;
	if (typeof value === "string") {
		const numeric = Number(value);
		const milliseconds = Number.isFinite(numeric)
			? numeric < 1e12
				? numeric * 1000
				: numeric
			: Date.parse(value);
		if (Number.isFinite(milliseconds)) return milliseconds - SKEW_MS;
	}
	return Date.now() + 29 * 60_000;
}

function credentialsFromTokenResponse(
	body: TokenResponse,
	refresh: string,
): OAuthCredentials | undefined {
	if (typeof body.token !== "string" || body.token.trim() === "")
		return undefined;
	return {
		access: body.token,
		refresh:
			typeof body.refresh_token === "string" ? body.refresh_token : refresh,
		expires: parseExpires(body.expires_at),
	};
}

export async function loginQoder(
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const verifier = b64url(randomBytes(64));
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	const nonce = randomUUID();
	const authUrl =
		`${WEB_BASE}/device/selectAccounts?challenge=${encodeURIComponent(challenge)}` +
		`&challenge_method=S256&nonce=${encodeURIComponent(nonce)}` +
		`&machine_id=${encodeURIComponent(randomUUID())}&client_id=${CLIENT_ID}`;
	callbacks.onAuth?.({
		url: authUrl,
		instructions: "Sign in to Qoder in your browser to authorize omp.",
	});
	callbacks.onProgress?.("Waiting for Qoder browser sign-in…");
	const pollUrl = `${OPENAPI_BASE}/api/v1/deviceToken/poll?${new URLSearchParams(
		{
			nonce,
			verifier,
			challenge_method: "S256",
		},
	)}`;
	const request = callbacks.fetch ?? fetch;
	const deadline = Date.now() + 300_000;

	while (Date.now() < deadline) {
		if (callbacks.signal?.aborted) throw new AIError.LoginCancelledError();
		let response: Response;
		try {
			const timeoutSignal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
			response = await request(pollUrl, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: callbacks.signal
					? AbortSignal.any([callbacks.signal, timeoutSignal])
					: timeoutSignal,
			});
		} catch (cause) {
			if (callbacks.signal?.aborted) throw new AIError.LoginCancelledError();
			// A transport failure (connection reset, per-request timeout) while the
			// user is still authorizing means "pending", not "failed" — keep
			// polling until the deadline, mirroring the 404 path.
			void cause;
			callbacks.onProgress?.(
				"Qoder sign-in pending; retrying after a network error…",
			);
			await Bun.sleep(2_000);
			continue;
		}
		if (response.status === 404) {
			await Bun.sleep(2_000);
			continue;
		}
		if (!response.ok) {
			throw new AIError.OAuthError(`Qoder login failed (${response.status})`, {
				kind: "polling",
				provider: PROVIDER_ID,
				status: response.status,
			});
		}

		let body: TokenResponse;
		try {
			body = (await response.json()) as TokenResponse;
		} catch (cause) {
			throw new AIError.OAuthError("Qoder login returned invalid JSON", {
				kind: "validation",
				provider: PROVIDER_ID,
				cause,
			});
		}
		const credentials = credentialsFromTokenResponse(body, "");
		if (credentials) return credentials;
		await Bun.sleep(2_000);
	}

	throw new AIError.OAuthError("Qoder login timed out", {
		kind: "timeout",
		provider: PROVIDER_ID,
	});
}

export async function refreshQoderToken(
	credentials: OAuthCredentials,
	fetchOverride?: FetchImpl,
): Promise<OAuthCredentials> {
	if (!credentials.refresh.trim()) {
		throw new AIError.OAuthError("Qoder sign in again: missing refresh_token", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	let response: Response;
	try {
		response = await (fetchOverride ?? fetch)(
			`${OPENAPI_BASE}/api/v1/deviceToken/refresh`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"User-Agent": `qoder/${CLI_VERSION}`,
				},
				body: JSON.stringify({ refresh_token: credentials.refresh }),
				signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
			},
		);
	} catch (cause) {
		throw new AIError.OAuthError("Qoder token refresh failed", {
			kind: "token-refresh",
			provider: PROVIDER_ID,
			cause,
		});
	}
	if (!response.ok) {
		throw new AIError.OAuthError(
			`Qoder token refresh failed (${response.status})`,
			{
				kind: "token-refresh",
				provider: PROVIDER_ID,
				status: response.status,
			},
		);
	}
	let body: TokenResponse;
	try {
		body = (await response.json()) as TokenResponse;
	} catch (cause) {
		throw new AIError.OAuthError("Qoder token refresh returned invalid JSON", {
			kind: "validation",
			provider: PROVIDER_ID,
			cause,
		});
	}
	const next = credentialsFromTokenResponse(body, credentials.refresh);
	if (!next) {
		throw new AIError.OAuthError("Qoder token refresh returned no token", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	return next;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function registerQoder(pi: ExtensionAPI): void {
	if (getOAuthProviders().some((provider) => provider.id === PROVIDER_ID)) {
		pi.logger.info(
			"Qoder provider is already available in omp; plugin registration skipped",
		);
		return;
	}
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: MODEL_BASE,
		api: QODER_API_ID,
		streamSimple: streamQoderSimple,
		...(OAUTH_TOKEN ? { apiKey: OAUTH_TOKEN } : {}),
		authHeader: true,
		// Client-attribution headers the Qoder gateway expects from its CLI. No
		// per-request tracing ids (X-Request-ID/X-Session-ID) and no telemetry or
		// session metadata are sent — see README "Privacy".
		headers: {
			"Cosy-ClientType": "5",
			"Cosy-Version": CLI_VERSION,
			"Cosy-MachineOS": machineOs(),
		},
		models: [...QODER_MODELS],
		oauth: {
			name: "Qoder",
			login: loginQoder,
			refreshToken: refreshQoderToken,
			getApiKey: (credentials) => credentials.access,
		},
	});
}
