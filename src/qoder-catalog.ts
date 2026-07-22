/**
 * Qoder api3 model-catalog fetch + parse.
 *
 * `GET /api/v2/model/list?Encode=1` (headers WASM-signed via `prepareRequest`)
 * returns the account's live model catalog. The verified response shape is a
 * plaintext JSON object keyed by scene (`chat`, `assistant`, `inline`, …);
 * the CLI reads the `assistant` bucket, an array of model configs carrying
 * `key`, `display_name`, `is_reasoning`, `is_vl`, `max_input_tokens`, the
 * context window set (`context_config` label→`{token_count}` map, or an
 * `available_context_windows` int array), and thinking config
 * (`thinking_config.enabled.efforts` as a name→`{is_default}` map, or one of
 * the documented flat effort keys). If the body is not plaintext JSON it is
 * decrypted with `decrypt_server_response` first.
 *
 * Everything here is fail-soft: any network, decrypt, or shape failure yields
 * `null` and the static catalog stands.
 */
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { QoderWasmContext } from "./qoder-wasm.js";

/** One catalog model, reduced to the fields the overlay consumes. */
export interface QoderCatalogEntry {
	key: string;
	displayName: string | undefined;
	isReasoning: boolean | undefined;
	isVl: boolean | undefined;
	maxInputTokens: number | undefined;
	/** Server-offered context windows, ascending unique (from `context_config`/`available_context_windows`). */
	contextWindows: number[] | undefined;
	/** Normalized effort ladder, ascending intensity; undefined when the server names none. */
	efforts: string[] | undefined;
	/** Server-marked default effort, when present. */
	defaultEffort: string | undefined;
	/** Reasoning is offered but without a discrete ladder (binary enabled). */
	reasoningWithoutLadder: boolean;
}

/** Canonical effort tokens in ascending intensity. */
const EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/** Documented flat ladder keys, in resolver precedence order. */
const EFFORT_KEYS = [
	"efforts",
	"reasoning_efforts",
	"reasoningEfforts",
	"reasoning_effort_levels",
	"reasoningEffortLevels",
	"effort_level",
	"effortLevel",
	"effort_levels",
	"effortLevels",
	"supported_efforts",
	"supportedEfforts",
	"supported_effort_levels",
	"supportedEffortLevels",
	"levels",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize a raw token to a canonical effort, or null when unrecognized. */
function normalizeEffortToken(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const token = raw.trim().toLowerCase();
	return (EFFORT_ORDER as readonly string[]).includes(token) ? token : null;
}

/** Sort + dedupe normalized tokens in canonical order; `none` is dropped (omp disables reasoning separately). */
function orderEfforts(tokens: Iterable<string>): string[] {
	const set = new Set(tokens);
	return EFFORT_ORDER.filter((token) => token !== "none" && set.has(token));
}

interface LadderResult {
	efforts: string[];
	defaultEffort: string | undefined;
}

/**
 * Read a ladder from a raw resolver value: either an array of tokens (or
 * objects carrying a token under effort/level/name/value), or an object map
 * whose keys are tokens (values may carry `is_default`).
 */
function readLadder(value: unknown): LadderResult | null {
	if (Array.isArray(value)) {
		const tokens: string[] = [];
		let defaultEffort: string | undefined;
		for (const item of value) {
			let token = normalizeEffortToken(item);
			if (token === null && isRecord(item)) {
				token =
					normalizeEffortToken(item.effort) ??
					normalizeEffortToken(item.level) ??
					normalizeEffortToken(item.name) ??
					normalizeEffortToken(item.value);
				if (token !== null && item.is_default === true && token !== "none")
					defaultEffort = token;
			}
			if (token !== null) tokens.push(token);
		}
		const efforts = orderEfforts(tokens);
		return efforts.length > 0 ? { efforts, defaultEffort } : null;
	}
	if (isRecord(value)) {
		const tokens: string[] = [];
		let defaultEffort: string | undefined;
		for (const [key, entry] of Object.entries(value)) {
			const token = normalizeEffortToken(key);
			if (token === null) continue;
			tokens.push(token);
			if (isRecord(entry) && entry.is_default === true && token !== "none")
				defaultEffort = token;
		}
		const efforts = orderEfforts(tokens);
		return efforts.length > 0 ? { efforts, defaultEffort } : null;
	}
	return null;
}

/**
 * Resolve the effort ladder per the recovered resolver logic: the first
 * present flat key wins; otherwise the nested `thinking_config.enabled`
 * (or `thinkingConfig.enabledConfig`/`thinkingConfig.enabled`) map.
 * `supports_disabled`/`supportsDisabled` (or an enabled thinking config with
 * no ladder) marks reasoning-without-ladder.
 */
function resolveEffortLadder(model: Record<string, unknown>): {
	efforts: string[] | undefined;
	defaultEffort: string | undefined;
	reasoningWithoutLadder: boolean;
} {
	for (const key of EFFORT_KEYS) {
		if (!(key in model)) continue;
		const ladder = readLadder(model[key]);
		if (ladder !== null) {
			return {
				efforts: ladder.efforts,
				defaultEffort: ladder.defaultEffort,
				reasoningWithoutLadder: false,
			};
		}
	}

	let enabled: unknown;
	const thinkingConfig = isRecord(model.thinking_config)
		? model.thinking_config
		: undefined;
	const thinkingConfigCamel = isRecord(model.thinkingConfig)
		? model.thinkingConfig
		: undefined;
	if (thinkingConfig !== undefined && "enabled" in thinkingConfig) {
		enabled = thinkingConfig.enabled;
	} else if (
		thinkingConfigCamel !== undefined &&
		"enabledConfig" in thinkingConfigCamel
	) {
		enabled = thinkingConfigCamel.enabledConfig;
	} else if (
		thinkingConfigCamel !== undefined &&
		"enabled" in thinkingConfigCamel
	) {
		enabled = thinkingConfigCamel.enabled;
	}
	if (isRecord(enabled)) {
		const ladder = "efforts" in enabled ? readLadder(enabled.efforts) : null;
		if (ladder !== null) {
			return {
				efforts: ladder.efforts,
				defaultEffort: ladder.defaultEffort,
				reasoningWithoutLadder: false,
			};
		}
		return {
			efforts: undefined,
			defaultEffort: undefined,
			reasoningWithoutLadder: true,
		};
	}

	if (model.supports_disabled === true || model.supportsDisabled === true) {
		return {
			efforts: undefined,
			defaultEffort: undefined,
			reasoningWithoutLadder: true,
		};
	}
	return {
		efforts: undefined,
		defaultEffort: undefined,
		reasoningWithoutLadder: false,
	};
}

/** Context windows from `available_context_windows` (int[]) or the `context_config` label map. */
function resolveContextWindows(
	model: Record<string, unknown>,
): number[] | undefined {
	const direct = model.available_context_windows;
	if (Array.isArray(direct)) {
		const windows = direct.filter(
			(item): item is number => typeof item === "number" && item > 0,
		);
		if (windows.length > 0) return [...new Set(windows)].sort((a, b) => a - b);
	}
	const config = isRecord(model.context_config)
		? model.context_config
		: undefined;
	if (config !== undefined) {
		const windows: number[] = [];
		for (const entry of Object.values(config)) {
			if (
				isRecord(entry) &&
				typeof entry.token_count === "number" &&
				entry.token_count > 0
			) {
				windows.push(entry.token_count);
			}
		}
		if (windows.length > 0) return [...new Set(windows)].sort((a, b) => a - b);
	}
	return undefined;
}

function parseModel(raw: unknown): QoderCatalogEntry | null {
	if (!isRecord(raw) || typeof raw.key !== "string" || raw.key.length === 0)
		return null;
	const ladder = resolveEffortLadder(raw);
	return {
		key: raw.key,
		displayName:
			typeof raw.display_name === "string" ? raw.display_name : undefined,
		isReasoning:
			typeof raw.is_reasoning === "boolean" ? raw.is_reasoning : undefined,
		isVl: typeof raw.is_vl === "boolean" ? raw.is_vl : undefined,
		maxInputTokens:
			typeof raw.max_input_tokens === "number" && raw.max_input_tokens > 0
				? raw.max_input_tokens
				: undefined,
		contextWindows: resolveContextWindows(raw),
		efforts: ladder.efforts,
		defaultEffort: ladder.defaultEffort,
		reasoningWithoutLadder: ladder.reasoningWithoutLadder,
	};
}

/**
 * Parse the decrypted catalog payload. Preferred: the `assistant` scene
 * bucket (the CLI's scene). Fallbacks: a bare model array at the root, or the
 * first scene bucket that parses to at least one model.
 */
export function parseQoderCatalog(
	payload: unknown,
): Map<string, QoderCatalogEntry> {
	const entries = new Map<string, QoderCatalogEntry>();
	const absorb = (list: unknown): number => {
		if (!Array.isArray(list)) return 0;
		let added = 0;
		for (const raw of list) {
			const entry = parseModel(raw);
			if (entry !== null && !entries.has(entry.key)) {
				entries.set(entry.key, entry);
				added += 1;
			}
		}
		return added;
	};

	if (Array.isArray(payload)) {
		absorb(payload);
		return entries;
	}
	if (!isRecord(payload)) return entries;
	if (absorb(payload.assistant) > 0) return entries;
	for (const value of Object.values(payload)) {
		if (absorb(value) > 0) return entries;
	}
	return entries;
}

/**
 * Fetch the live catalog through a WASM-signed management GET. Response is
 * plaintext JSON on the verified path; opaque bodies are decrypted via the
 * context before parsing. Returns null on any failure (static catalog stands).
 */
export async function fetchQoderCatalog(
	ctx: QoderWasmContext,
	api3Base: string,
	fetchImpl: FetchImpl = fetch,
): Promise<Map<string, QoderCatalogEntry> | null> {
	try {
		const prepared = ctx.prepareRequest(
			api3Base,
			"/api/v2/model/list?Encode=1",
			"GET",
			"auth",
			undefined,
			undefined,
		);
		const response = await fetchImpl(prepared.url, {
			method: "GET",
			headers: { ...prepared.headers, Accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) return null;
		const text = await response.text();
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			payload = JSON.parse(ctx.decryptServerResponse(text));
		}
		const entries = parseQoderCatalog(payload);
		return entries.size > 0 ? entries : null;
	} catch {
		return null;
	}
}
