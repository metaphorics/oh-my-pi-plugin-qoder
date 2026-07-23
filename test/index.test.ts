import { expect, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getQoderApi3Bridge,
	runClaimOnce,
	runClaimUltimate,
	triggerLazyClaim,
} from "../src/index.js";

/** Whether this machine has a usable qodercli auth WASM (drives the 37-row test's skip). */
const wasmBridgeAvailable = getQoderApi3Bridge() !== null;

interface ChildResult {
	initialCollision: boolean;
	registrationCount: number;
	automaticClaimRuns: number;
	automaticClaimNotifications: string[];
	sessionStartRegistrationCount: number;
	commandRegistrationCount: number;
	registeredCommandName: string | undefined;
	registeredProvider: string | undefined;
	baseUrl: string | undefined;
	api: string | undefined;
	authHeader: boolean | undefined;
	hasStreamSimple: boolean;
	modelCount: number | undefined;
	modelId: string | undefined;
	modelIds: string[] | undefined;
	api3Ids: string[] | undefined;
	supportsStore: boolean | undefined;
	headers: Record<string, string> | undefined;
	handlerIdentitiesMatch: boolean;
	apiKey: string | undefined;
	collisionRegistrationCount: number;
	collisionSessionStartRegistrationCount: number;
	collisionCommandRegistrationCount: number;
	collisionLogs: string[];
}

const pluginUrl = new URL("../src/index.ts", import.meta.url).href;
const childScript = `
import plugin, {
  loginQoder,
  MODEL_BASE,
  PROVIDER_ID,
  refreshQoderToken,
  startAutomaticClaim,
} from ${JSON.stringify(pluginUrl)};
import { getOAuthProviders, registerOAuthProvider } from "@oh-my-pi/pi-ai/oauth";

const initialCollision = getOAuthProviders().some(provider => provider.id === PROVIDER_ID);
let registrationCount = 0;
let sessionStartRegistrationCount = 0;
let commandRegistrationCount = 0;
let registeredCommandName;
let registeredProvider;
let config;
plugin({
  logger: { info() {}, warn() {} },
  on(event) {
    if (event === "session_start") sessionStartRegistrationCount++;
  },
  registerCommand(name) {
    commandRegistrationCount++;
    registeredCommandName = name;
  },
  registerProvider(provider, value) {
    registrationCount++;
    registeredProvider = provider;
    config = value;
  },
});
const handlerIdentitiesMatch = config !== undefined &&
  config.oauth?.login === loginQoder &&
  config.oauth?.refreshToken === refreshQoderToken;
const apiKey = config?.oauth?.getApiKey({ access: "access-token", refresh: "refresh-token", expires: 1 });

if (!initialCollision) {
  registerOAuthProvider({
    id: PROVIDER_ID,
    name: "collision stub",
    login: async () => "unused",
  });
}
let collisionRegistrationCount = 0;
let collisionSessionStartRegistrationCount = 0;
let collisionCommandRegistrationCount = 0;
const collisionLogs = [];
plugin({
  logger: { info(message) { collisionLogs.push(message); }, warn() {} },
  on(event) { if (event === "session_start") collisionSessionStartRegistrationCount++; },
  registerCommand() { collisionCommandRegistrationCount++; },
  registerProvider() { collisionRegistrationCount++; },
});
const automaticResults = [
  { message: "failed", severity: "error" },
  { message: "claimed", severity: "info" },
];
const automaticClaimNotifications = [];
let automaticClaimRuns = 0;
let notification = Promise.withResolvers();
const runAutomaticClaim = async () => {
  automaticClaimRuns++;
  const result = automaticResults.shift();
  if (!result) throw new Error("unexpected automatic claim");
  return result;
};
const notifyAutomaticClaim = result => {
  automaticClaimNotifications.push(result.message);
  notification.resolve();
};
startAutomaticClaim({ run: runAutomaticClaim, notify: notifyAutomaticClaim });
await notification.promise;
notification = Promise.withResolvers();
startAutomaticClaim({ run: runAutomaticClaim, notify: notifyAutomaticClaim });
await notification.promise;
startAutomaticClaim({ run: runAutomaticClaim, notify: notifyAutomaticClaim });
process.stdout.write(JSON.stringify({
  initialCollision,
  registrationCount,
  automaticClaimRuns,
  automaticClaimNotifications,
  sessionStartRegistrationCount,
  commandRegistrationCount,
  registeredCommandName,
  registeredProvider,
  baseUrl: config?.baseUrl,
  api: config?.api,
  authHeader: config?.authHeader,
  hasStreamSimple: typeof config?.streamSimple === "function",
  modelCount: config?.models?.length,
  modelId: config?.models?.[0]?.id,
  modelIds: config?.models?.map((model) => model.id),
  api3Ids: config?.models?.filter((model) => model.api3 === true).map((model) => model.id),
  supportsStore: config?.models?.[0]?.compat?.supportsStore,
  headers: config?.headers,
  handlerIdentitiesMatch,
  apiKey,
  collisionRegistrationCount,
  collisionSessionStartRegistrationCount,
  collisionCommandRegistrationCount,
  collisionLogs,
}));
`;

async function runChild(env: Record<string, string>): Promise<ChildResult> {
	const child = Bun.spawn([process.execPath, "--eval", childScript], {
		cwd: `${import.meta.dir}/..`,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as ChildResult;
}

/**
 * Environment that makes every WASM candidate unresolvable: an explicit
 * override path that does not exist, a sandboxed HOME (hides the installed
 * `~/.qoder` CLI), and a sandboxed XDG cache (hides the verified-module
 * cache). The loader then fails closed and api3 rows are filtered out.
 * Returns the env plus a cleanup that removes the sandbox.
 */
function bridgeMissingEnv(): {
	env: Record<string, string>;
	cleanup: () => void;
} {
	const sandbox = mkdtempSync(join(tmpdir(), "qoder-no-wasm-"));
	return {
		env: {
			...process.env,
			HOME: sandbox,
			XDG_CACHE_HOME: join(sandbox, "xdg-cache"),
			QODER_HOME: join(sandbox, "qoder-home"),
			QODER_WASM_PATH: join(sandbox, "missing.wasm"),
		} as Record<string, string>,
		cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
	};
}

test("registers the legacy 19-row contract without a WASM bridge and skips a native-provider collision", async () => {
	const { env, cleanup } = bridgeMissingEnv();
	let result: ChildResult;
	try {
		result = await runChild(env);
	} finally {
		cleanup();
	}
	expect(result.initialCollision).toBe(false);
	expect(result.registrationCount).toBe(1);
	expect(result.automaticClaimRuns).toBe(2);
	expect(result.automaticClaimNotifications).toEqual(["failed", "claimed"]);
	expect(result.sessionStartRegistrationCount).toBe(1);
	expect(result.commandRegistrationCount).toBe(1);
	expect(result.registeredCommandName).toBe("claim-ultimate");
	expect(result.registeredProvider).toBe("qoder");
	expect(result.baseUrl).toBe("https://api2-v2.qoder.sh/model/v1");
	expect(result.api).toBe("qoder-completions");
	expect(result.authHeader).toBe(true);
	expect(result.hasStreamSimple).toBe(true);
	expect(result.modelCount).toBe(19);
	expect(result.modelId).toBe("auto");
	expect(result.modelIds).toEqual([
		"auto",
		"ultimate",
		"ultimate-400k",
		"ultimate-1m",
		"performance",
		"performance-400k",
		"performance-1m",
		"efficient",
		"lite",
		"qmodel",
		"qmodel-400k",
		"qmodel-1m",
		"kmodel",
		"dmodel",
		"dmodel-400k",
		"dmodel-1m",
		"mmodel",
		"mmodel-400k",
		"mmodel-1m",
	]);
	expect(result.api3Ids).toEqual([]);
	expect(result.supportsStore).toBe(false);
	expect(result.headers).toMatchObject({
		"Cosy-ClientType": "5",
		"Cosy-Version": "1.1.2",
		"Cosy-Data-Policy": "disagree",
	});
	expect(result.handlerIdentitiesMatch).toBe(true);
	expect(result.apiKey).toBe("access-token");
	expect(result.collisionRegistrationCount).toBe(0);
	expect(result.collisionSessionStartRegistrationCount).toBe(1);
	expect(result.collisionCommandRegistrationCount).toBe(1);
	expect(result.collisionLogs).toEqual([
		"Qoder provider is already available in omp; plugin registration skipped",
	]);
});

test.skipIf(!wasmBridgeAvailable)(
	"registers the full 37-row catalog when the auth WASM bridge is available",
	async () => {
		const result = await runChild({ ...process.env } as Record<string, string>);
		expect(result.registrationCount).toBe(1);
		expect(result.registeredProvider).toBe("qoder");
		expect(result.headers).toMatchObject({
			"Cosy-ClientType": "5",
			"Cosy-Version": "1.1.2",
			"Cosy-Data-Policy": "disagree",
		});
		expect(result.api3Ids?.length).toBe(18);
		expect(result.modelCount).toBe(37);
		expect(result.modelIds?.[0]).toBe("auto");
		for (const id of [
			"cmodel",
			"qmodel_preview",
			"qmodel_latest",
			"kmodel_latest",
			"gm51model",
			"dfmodel",
		]) {
			expect(result.api3Ids, id).toContain(id);
			expect(result.api3Ids, `${id}-400k`).toContain(`${id}-400k`);
			expect(result.api3Ids, `${id}-1m`).toContain(`${id}-1m`);
		}
		expect(result.modelIds).toContain("qmodel_preview-400k");
	},
);

test("claims an eligible Ultimate activity and verifies the postcondition", async () => {
	const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
	const responses = [
		{ code: 0, msg: "ok", data: [{ activityId: "ultimate_200_free_invoke", canClaim: true }] },
		{ code: 0, msg: "ok", data: null },
		{ code: 0, msg: "ok", data: [{ activityId: "ultimate_200_free_invoke", canClaim: false }] },
	];
	const fetchImpl: FetchImpl = async (input, init) => {
		requests.push({
			url: input.toString(),
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? init.body : undefined,
		});
		return Response.json(responses.shift());
	};

	const result = await runClaimUltimate("access-token", fetchImpl);

	expect(requests).toEqual([
		{
			url: "https://openapi.qoder.sh/api/v2/activity/claim/eligibility",
			method: "GET",
			body: undefined,
		},
		{
			url: "https://openapi.qoder.sh/api/v2/activity/claim",
			method: "POST",
			body: '{"activityId":"ultimate_200_free_invoke"}',
		},
		{
			url: "https://openapi.qoder.sh/api/v2/activity/claim/eligibility",
			method: "GET",
			body: undefined,
		},
	]);
	expect(result).toEqual({ message: "Qoder Ultimate free calls claimed", severity: "info" });
});

test("does not post when Ultimate is already claimed or unavailable", async () => {
	let requests = 0;
	const result = await runClaimUltimate("access-token", async () => {
		requests++;
		return Response.json({
			code: 0,
			data: [{ activityId: "ultimate_200_free_invoke", canClaim: false }],
		});
	});

	expect(requests).toBe(1);
	expect(result).toEqual({
		message: "Qoder Ultimate claim is already complete or unavailable",
		severity: "info",
	});
});

test("returns info severity when Ultimate activity is absent from eligibility response", async () => {
	let requests = 0;
	const result = await runClaimUltimate("access-token", async () => {
		requests++;
		return Response.json({
			code: 0,
			data: [{ activityId: "some_other_activity", canClaim: true }],
		});
	});

	expect(requests).toBe(1);
	expect(result).toEqual({
		message: "Qoder Ultimate claim is already complete or unavailable",
		severity: "info",
	});
});

test("fails when the claim endpoint does not clear eligibility", async () => {
	const responses = [
		Response.json({ data: [{ activityId: "ultimate_200_free_invoke", canClaim: true }] }),
		Response.json({ code: 0 }),
		Response.json({ data: [{ activityId: "ultimate_200_free_invoke", canClaim: true }] }),
	];
	const result = await runClaimUltimate("access-token", async () => responses.shift()!);

	expect(result).toEqual({ message: "Qoder Ultimate claim failed", severity: "error" });
});

test("shares one in-flight claim across automatic and manual entry points", async () => {
	const pending = Promise.withResolvers<{
		readonly message: string;
		readonly severity: "info" | "error";
	}>();
	let runs = 0;
	const execute = () => {
		runs++;
		return pending.promise;
	};

	const automatic = runClaimOnce(execute);
	const manual = runClaimOnce(execute);
	expect(automatic).toBe(manual);
	pending.resolve({ message: "claimed", severity: "info" });

	await expect(automatic).resolves.toEqual({ message: "claimed", severity: "info" });
	expect(runs).toBe(1);
});
test("triggerLazyClaim triggers automatic claim asynchronously with provided API key", async () => {
	const requests: string[] = [];
	const fetchImpl: FetchImpl = async (input) => {
		requests.push(input.toString());
		return Response.json({
			code: 0,
			data: [{ activityId: "ultimate_200_free_invoke", canClaim: false }],
		});
	};

	triggerLazyClaim("test-key-lazy", fetchImpl);
	const result = await runClaimOnce(() => runClaimUltimate("test-key-lazy", fetchImpl));
	expect(requests.length).toBeGreaterThan(0);
	expect(requests[0]).toContain("api/v2/activity/claim/eligibility");
	expect(result.message).toBe("Qoder Ultimate claim is already complete or unavailable");
	expect(result.severity).toBe("info");
});
