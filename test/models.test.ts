import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { QoderModelConfig } from "../src/index.js";
import {
	isQoderFastModel,
	MODEL_BASE,
	PROVIDER_ID,
	QODER_MODELS,
	resolveQoderOpenAICompat,
} from "../src/index.js";

const BASE_IDS = [
	"auto",
	"ultimate",
	"performance",
	"efficient",
	"lite",
	"qmodel",
	"kmodel",
	"dmodel",
	"mmodel",
] as const;

const ALIASED_IDS = [
	"ultimate",
	"performance",
	"qmodel",
	"dmodel",
	"mmodel",
] as const;

/** Base wire IDs the legacy api2-v2 transport fails with empty completions. */
const DROPPED_IDS = [
	"cmodel",
	"qmodel_preview",
	"qmodel_latest",
	"kmodel_latest",
	"gm51model",
	"dfmodel",
] as const;

function byId(id: string): QoderModelConfig {
	const model = QODER_MODELS.find((entry) => entry.id === id);
	if (!model) throw new Error(`missing model row: ${id}`);
	return model;
}

/** Typed view over the OpenAI-flavored sparse compat our rows use. */
function sparseCompat(model: QoderModelConfig): {
	supportsStore?: boolean;
	supportsReasoningEffort?: boolean;
	extraBody?: Record<string, unknown>;
} {
	return (model.compat ?? {}) as {
		supportsStore?: boolean;
		supportsReasoningEffort?: boolean;
		extraBody?: Record<string, unknown>;
	};
}

describe("Qoder model catalog", () => {
	it("registers 9 base models and 10 context aliases with unique ids", () => {
		expect(QODER_MODELS).toHaveLength(19);
		expect(new Set(QODER_MODELS.map((model) => model.id)).size).toBe(19);
		expect(
			QODER_MODELS.filter((model) => model.requestModelId === undefined).map(
				(model) => model.id,
			),
		).toEqual([...BASE_IDS]);
	});

	it("omits the base ids the legacy transport fails and their aliases", () => {
		const ids = new Set(QODER_MODELS.map((model) => model.id));
		for (const id of DROPPED_IDS) {
			expect(ids.has(id), id).toBe(false);
			expect(ids.has(`${id}-400k`), id).toBe(false);
			expect(ids.has(`${id}-1m`), id).toBe(false);
		}
	});

	it("matches the authenticated base-model metadata", () => {
		const expected: Record<
			string,
			{
				name: string;
				contextWindow: number;
				reasoning: boolean;
				vision: boolean;
			}
		> = {
			auto: {
				name: "Qoder (Auto)",
				contextWindow: 180_000,
				reasoning: false,
				vision: true,
			},
			ultimate: {
				name: "Ultimate",
				contextWindow: 200_000,
				reasoning: true,
				vision: true,
			},
			performance: {
				name: "Performance",
				contextWindow: 272_000,
				reasoning: false,
				vision: true,
			},
			efficient: {
				name: "Efficient",
				contextWindow: 180_000,
				reasoning: false,
				vision: true,
			},
			lite: {
				name: "Lite",
				contextWindow: 180_000,
				reasoning: false,
				vision: false,
			},
			qmodel: {
				name: "Qwen3.7-Plus",
				contextWindow: 200_000,
				reasoning: false,
				vision: true,
			},
			kmodel: {
				name: "Kimi-K2.7-Code",
				contextWindow: 262_144,
				reasoning: false,
				vision: true,
			},
			dmodel: {
				name: "DeepSeek-V4-Pro",
				contextWindow: 200_000,
				reasoning: true,
				vision: true,
			},
			mmodel: {
				name: "MiniMax-M3",
				contextWindow: 200_000,
				reasoning: false,
				vision: true,
			},
		};
		for (const [id, want] of Object.entries(expected)) {
			const model = byId(id);
			expect(model.name, id).toBe(want.name);
			expect(model.contextWindow, id).toBe(want.contextWindow);
			expect(model.reasoning, id).toBe(want.reasoning);
			expect(model.input, id).toEqual(
				want.vision ? ["text", "image"] : ["text"],
			);
		}
	});

	it("caps every model at 32k output, zero cost, and no store field", () => {
		for (const model of QODER_MODELS) {
			expect(model.maxTokens, model.id).toBe(32_768);
			expect(model.cost, model.id).toEqual({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			});
			expect(sparseCompat(model).supportsStore, model.id).toBe(false);
		}
	});

	it("carries the evidence effort ladders on reasoning models only", () => {
		expect(byId("ultimate").thinking).toMatchObject({
			mode: "effort",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			defaultLevel: "high",
		});
		expect(byId("dmodel").thinking).toMatchObject({
			mode: "effort",
			efforts: ["high", "max"],
			defaultLevel: "max",
		});
		for (const model of QODER_MODELS) {
			if (!model.reasoning) expect(model.thinking, model.id).toBeUndefined();
		}
	});

	it("derives -400k and -1m aliases for exactly the 5 multi-window models", () => {
		for (const id of ALIASED_IDS) {
			const base = byId(id);
			for (const [suffix, label, contextWindow] of [
				["400k", "400K", 400_000],
				["1m", "1M", 1_000_000],
			] as const) {
				const alias = byId(`${id}-${suffix}`);
				expect(alias.requestModelId, alias.id).toBe(id);
				expect(alias.name, alias.id).toBe(`${base.name} (${label})`);
				expect(alias.contextWindow, alias.id).toBe(contextWindow);
				expect(sparseCompat(alias).extraBody, alias.id).toEqual({
					context_length: contextWindow,
				});
				expect(alias.reasoning, alias.id).toBe(base.reasoning);
				expect(alias.input, alias.id).toEqual(base.input);
				expect(alias.thinking, alias.id).toEqual(base.thinking);
				expect(alias.maxTokens, alias.id).toBe(base.maxTokens);
				expect(alias.cost, alias.id).toEqual(base.cost);
			}
		}
		for (const id of ["auto", "efficient", "lite", "kmodel"]) {
			expect(
				QODER_MODELS.some((model) => model.id === `${id}-400k`),
				id,
			).toBe(false);
			expect(
				QODER_MODELS.some((model) => model.id === `${id}-1m`),
				id,
			).toBe(false);
		}
	});

	it("keeps base rows free of alias wire fields", () => {
		for (const id of BASE_IDS) {
			const base = byId(id);
			expect(base.requestModelId, id).toBeUndefined();
			expect(sparseCompat(base).extraBody, id).toBeUndefined();
		}
	});
	it("pins marketplace compat defaults to the host catalog contract", () => {
		for (const config of QODER_MODELS) {
			const model = buildModel({
				...config,
				api: "openai-completions",
				provider: PROVIDER_ID,
				baseUrl: MODEL_BASE,
				compat: config.compat as ModelSpec<"openai-completions">["compat"],
			});
			const expected = Object.fromEntries(
				Object.entries(model.compat).filter(([, value]) => value !== undefined),
			);
			const actual = Object.fromEntries(
				Object.entries(
					resolveQoderOpenAICompat(
						config.requestModelId ?? config.id,
						config.compat as Parameters<typeof resolveQoderOpenAICompat>[1],
					),
				).filter(([, value]) => value !== undefined),
			);
			expect(actual, config.id).toEqual(expected);
		}
	});
});

describe("isQoderFastModel", () => {
	it("matches only kmodel", () => {
		expect(isQoderFastModel("kmodel")).toBe(true);
		expect(isQoderFastModel("kmodel-256k")).toBe(false);
		expect(isQoderFastModel("auto")).toBe(false);
		expect(isQoderFastModel("ultimate")).toBe(false);
	});
});
