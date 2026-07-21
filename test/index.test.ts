import { expect, test } from "bun:test";

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
  supportsStore: config?.models?.[0]?.compat?.supportsStore,
  headers: config?.headers,
  handlerIdentitiesMatch,
  apiKey,
  collisionRegistrationCount,
  collisionLogs,
}));
`;

test("registers the Qoder contract and skips a native-provider collision", async () => {
	const child = Bun.spawn([process.execPath, "--eval", childScript], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const result = JSON.parse(stdout) as ChildResult;
	expect(result.initialCollision).toBe(false);
	expect(result.registrationCount).toBe(1);
	expect(result.registeredProvider).toBe("qoder");
	expect(result.baseUrl).toBe("https://api2-v2.qoder.sh/model/v1");
	expect(result.api).toBe("qoder-completions");
	expect(result.authHeader).toBe(true);
	expect(result.hasStreamSimple).toBe(true);
	expect(result.modelCount).toBe(19);
	expect(result.modelId).toBe("auto");
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
