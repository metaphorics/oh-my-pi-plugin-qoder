import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getQoderApi3Bridge } from "../src/index.js";

/** Whether this machine has a usable qodercli auth WASM (drives the 37-row test's skip). */
const wasmBridgeAvailable = getQoderApi3Bridge() !== null;

interface ChildResult {
	initialCollision: boolean;
	registrationCount: number;
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
	collisionLogs: string[];
}

const pluginUrl = new URL("../src/index.ts", import.meta.url).href;
const childScript = `
import plugin, {
  loginQoder,
  MODEL_BASE,
  PROVIDER_ID,
  refreshQoderToken,
} from ${JSON.stringify(pluginUrl)};
import { getOAuthProviders, registerOAuthProvider } from "@oh-my-pi/pi-ai/oauth";

const initialCollision = getOAuthProviders().some(provider => provider.id === PROVIDER_ID);
let registrationCount = 0;
let registeredProvider;
let config;
plugin({
  logger: { info() {} },
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
const collisionLogs = [];
plugin({
  logger: { info(message) { collisionLogs.push(message); } },
  registerProvider() { collisionRegistrationCount++; },
});
process.stdout.write(JSON.stringify({
  initialCollision,
  registrationCount,
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
	});
	expect(result.handlerIdentitiesMatch).toBe(true);
	expect(result.apiKey).toBe("access-token");
	expect(result.collisionRegistrationCount).toBe(0);
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
