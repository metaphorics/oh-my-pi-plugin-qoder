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
	"cmodel",
	"qmodel_preview",
	"qmodel_latest",
	"kmodel_latest",
	"gm51model",
	"dfmodel",
] as const;

const ALIASED_IDS = [
	"ultimate",
	"performance",
	"qmodel",
	"dmodel",
	"mmodel",
	"cmodel",
	"qmodel_preview",
	"qmodel_latest",
	"kmodel_latest",
	"gm51model",
	"dfmodel",
] as const;

/** Base wire IDs served exclusively by the WASM-signed api3 transport. */
const API3_IDS = [
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
	it("registers 15 base models and 22 context aliases with unique ids", () => {
		expect(QODER_MODELS).toHaveLength(37);
		expect(new Set(QODER_MODELS.map((model) => model.id)).size).toBe(37);
		expect(
			QODER_MODELS.filter((model) => model.requestModelId === undefined).map(
				(model) => model.id,
			),
		).toEqual([...BASE_IDS]);
		expect(
			QODER_MODELS.filter((model) => model.requestModelId !== undefined),
		).toHaveLength(22);
	});

	it("flags the six api3-only families with their static effort ladders", () => {
		const ladders: Record<
			(typeof API3_IDS)[number],
			{
				efforts: string[];
				defaultLevel: string;
				requiresEffort?: boolean;
			} | null
		> = {
			cmodel: {
				efforts: ["low", "medium", "high", "xhigh", "max"],
				defaultLevel: "high",
			},
			qmodel_preview: {
				efforts: ["high"],
				defaultLevel: "high",
				requiresEffort: true,
			},
			qmodel_latest: null,
			kmodel_latest: null,
			gm51model: { efforts: ["high", "max"], defaultLevel: "max" },
			dfmodel: { efforts: ["high", "max"], defaultLevel: "max" },
		};
		for (const id of API3_IDS) {
			const base = byId(id);
			expect(base.api3, id).toBe(true);
			expect(base.requestModelId, id).toBeUndefined();
			const ladder = ladders[id];
			if (ladder === null) {
				expect(base.reasoning, id).toBe(false);
				expect(base.thinking, id).toBeUndefined();
			} else {
				expect(base.reasoning, id).toBe(true);
				expect(base.thinking, id).toMatchObject({
					mode: "effort",
					efforts: ladder.efforts,
					defaultLevel: ladder.defaultLevel,
					...(ladder.requiresEffort === true ? { requiresEffort: true } : {}),
				});
			}
			for (const suffix of ["400k", "1m"] as const) {
				const alias = byId(`${id}-${suffix}`);
				expect(alias.api3, alias.id).toBe(true);
				expect(alias.requestModelId, alias.id).toBe(id);
				expect(alias.reasoning, alias.id).toBe(base.reasoning);
				expect(alias.thinking, alias.id).toEqual(base.thinking);
			}
		}
		// Exactly the six families and their twelve aliases carry the api3 flag;
		// the nine legacy families never do.
		const expectedApi3Ids = API3_IDS.flatMap((id) => [
			id,
			`${id}-400k`,
			`${id}-1m`,
		]);
		expect(
			QODER_MODELS.filter((model) => model.api3 === true).map(
				(model) => model.id,
			),
		).toEqual(expectedApi3Ids);
		for (const model of QODER_MODELS) {
			if (!expectedApi3Ids.includes(model.id)) {
				expect(model.api3, model.id).toBeUndefined();
			}
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
			cmodel: {
				name: "Cantus",
				contextWindow: 200_000,
				reasoning: true,
				vision: true,
			},
			qmodel_preview: {
				name: "Qwen3.8-Max-Preview",
				contextWindow: 200_000,
				reasoning: true,
				vision: true,
			},
			qmodel_latest: {
				name: "Qwen3.7-Max",
				contextWindow: 200_000,
				reasoning: false,
				vision: true,
			},
			kmodel_latest: {
				name: "Kimi-K3",
				contextWindow: 200_000,
				reasoning: false,
				vision: true,
			},
			gm51model: {
				name: "GLM-5.2",
				contextWindow: 200_000,
				reasoning: true,
				vision: true,
			},
			dfmodel: {
				name: "DeepSeek-V4-Flash",
				contextWindow: 200_000,
				reasoning: true,
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
		expect(byId("cmodel").thinking).toMatchObject({
			mode: "effort",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			defaultLevel: "high",
		});
		expect(byId("qmodel_preview").thinking).toMatchObject({
			mode: "effort",
			efforts: ["high"],
			defaultLevel: "high",
			requiresEffort: true,
		});
		expect(byId("gm51model").thinking).toMatchObject({
			mode: "effort",
			efforts: ["high", "max"],
			defaultLevel: "max",
		});
		expect(byId("dfmodel").thinking).toMatchObject({
			mode: "effort",
			efforts: ["high", "max"],
			defaultLevel: "max",
		});
		for (const model of QODER_MODELS) {
			if (!model.reasoning) expect(model.thinking, model.id).toBeUndefined();
		}
	});

	it("derives -400k and -1m aliases for exactly the 11 multi-window models", () => {
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
