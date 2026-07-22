/**
 * Qoder api3 auth WASM bridge.
 *
 * Qoder's api3 transport authenticates requests with a WASM signature
 * (`Cosy-Key` = HMAC keyed by a WASM-generated `Cosy-MachineToken`), so no
 * pure-JS client can authenticate. The auth module ships only as an embedded
 * base64 payload inside the user's installed qodercli artifacts (the native
 * `qodercli-*` binary and the npm `qoder-worker-runtime.mjs` bundle) — never
 * as a loose `.wasm` file. This module locates that payload at runtime,
 * hash-verifies it against the known-good set, caches the verified bytes, and
 * instantiates it with a hand-written wasm-bindgen import object.
 *
 * Fail closed: any error at any step (not found, unknown hash, instantiate
 * failure) yields a `null` bridge so the plugin can disable the api3-only
 * models instead of crashing. Nothing here throws past `loadQoderWasmBridge`.
 *
 * Evidence: `local://qoder-wasm-sourcing` (extraction recipe + hash) and
 * `local://qoder-api3-live-contract` (identity chain + header contract), both
 * verified live on 2026-07-22 against CLI 1.1.2.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Privacy Mode value attached to every Qoder request. The WASM emits
 * `Cosy-Data-Policy: disagree` when the identity carries
 * `data_policy_agreed: false` (verified live); the legacy api2-v2 transport
 * sends the same header value directly. Non-overridable.
 */
export const QODER_PRIVATE_DATA_POLICY = "disagree";

/**
 * SHA-256 hashes of auth-WASM payloads this bridge will instantiate. An
 * embedded payload whose hash is not listed is treated as an unsupported
 * qodercli version: never instantiated, api3 disabled. CLI 1.1.2 listed.
 */
export const QODER_WASM_KNOWN_GOOD_SHA256: readonly string[] = [
	"ac37caa95b4b1e01e2bd1b4dd087823fa67cfb2dfb9a3db04446043684ad09c9",
];

/** Prepared HTTP request as returned by the WASM (url + signed headers + encrypted body). */
export interface QoderPreparedRequest {
	url: string;
	headers: Record<string, string>;
	body: string | undefined;
}

/** A live WASM `QoderContext`: prepares signed inference and management requests. */
export interface QoderWasmContext {
	prepareInferRequest(
		endpoint: string,
		bodyJson: string,
		modelKey?: string,
		modelSource?: string,
	): QoderPreparedRequest;
	prepareRequest(
		endpoint: string,
		path: string,
		method: string,
		kind: string,
		body?: string,
		headersJson?: string,
	): QoderPreparedRequest;
	/** Decrypt a management-API response body (free function, exposed per context). */
	decryptServerResponse(encrypted: string): string;
	free(): void;
}

/** Result of `generate_runtime_auth_fields` over the identity JSON (not the machine id). */
export interface QoderRuntimeAuthFields {
	encrypt_user_info: string;
	key: string;
}

/** The instantiated auth module. Methods throw on WASM failure; the loader never does. */
export interface QoderWasmBridge {
	createContext(
		machineId: string,
		cosyVersion: string,
		userInfoJson: string,
		configJson?: string,
	): QoderWasmContext;
	generateRuntimeAuthFields(identityJson: string): QoderRuntimeAuthFields;
	decryptServerResponse(encrypted: string): string;
}

// ---------------------------------------------------------------------------
// Locator + extraction
// ---------------------------------------------------------------------------

/**
 * Generic embedding marker: `="AGFzbQ` — the start of the base64 payload
 * (`AGFzbQ` is base64 for the `\0asm` magic). The minified variable name
 * differs between the npm bundle and the native binary, so the marker, never
 * a variable name, is what we scan for.
 */
const PAYLOAD_MARKER = Buffer.from('="AGFzbQ', "latin1");
/** 8 MiB scan chunks: the native binary is ~133 MB and must never be read whole. */
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
/** Observed payload is 388,608 base64 chars; bound the closing-quote hunt. */
const MAX_PAYLOAD_BASE64_BYTES = 1024 * 1024;
/** Largest plausible auth module; guards the direct `.wasm` override path. */
const MAX_WASM_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasWasmMagic(bytes: Buffer): boolean {
	return (
		bytes.length > 4 &&
		bytes[0] === 0x00 &&
		bytes[1] === 0x61 &&
		bytes[2] === 0x73 &&
		bytes[3] === 0x6d
	);
}

function isKnownGoodWasm(bytes: Buffer): boolean {
	return (
		hasWasmMagic(bytes) &&
		QODER_WASM_KNOWN_GOOD_SHA256.includes(
			createHash("sha256").update(bytes).digest("hex"),
		)
	);
}

/** Plugin-owned cache root for verified WASM bytes and the persisted machine id. */
export function getQoderCacheDir(): string {
	const xdg = process.env.XDG_CACHE_HOME?.trim();
	return join(
		xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".cache"),
		"omp-qoder",
	);
}

/**
 * Read the base64 payload starting at `payloadStart` (just past `="`): bytes
 * up to the next `"`, bounded by MAX_PAYLOAD_BASE64_BYTES. Returns the decoded
 * module or null when the payload is malformed.
 */
function readPayloadAt(fd: number, payloadStart: number): Buffer | null {
	const window = Buffer.allocUnsafe(MAX_PAYLOAD_BASE64_BYTES);
	let total = 0;
	let position = payloadStart;
	while (total < window.length) {
		const bytesRead = readSync(
			fd,
			window,
			total,
			window.length - total,
			position,
		);
		if (bytesRead === 0) break;
		const quote = window.indexOf(0x22, total);
		total += bytesRead;
		position += bytesRead;
		if (quote !== -1) {
			if (quote === 0) return null;
			const decoded = Buffer.from(
				window.toString("latin1", 0, quote),
				"base64",
			);
			return decoded.length > 4 ? decoded : null;
		}
	}
	return null;
}

/**
 * Chunked scan of `filePath` for the embedded payload. Reads 8 MiB windows
 * with marker-length overlap so a split marker is still found; every marker
 * hit is extracted and verified, so a false marker only costs one decode.
 */
function extractWasmPayload(filePath: string): Buffer | null {
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return null;
	}
	try {
		const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
		let position = 0;
		let buffered = 0;
		while (true) {
			const bytesRead = readSync(
				fd,
				chunk,
				buffered,
				chunk.length - buffered,
				position,
			);
			if (bytesRead === 0 && buffered === 0) return null;
			position += bytesRead;
			buffered += bytesRead;
			const window = chunk.subarray(0, buffered);
			let cursor = 0;
			while (true) {
				const markerIndex = window.indexOf(PAYLOAD_MARKER, cursor);
				if (markerIndex === -1) break;
				// The marker includes the first 6 payload chars (`AGFzbQ`); the
				// base64 payload itself starts right after the `="` prefix.
				const absolutePayloadStart = position - buffered + markerIndex + 2;
				const payload = readPayloadAt(fd, absolutePayloadStart);
				if (payload !== null && isKnownGoodWasm(payload)) return payload;
				cursor = markerIndex + 1;
			}
			if (bytesRead === 0) return null;
			const overlap = Math.min(PAYLOAD_MARKER.length - 1, buffered);
			chunk.copyWithin(0, buffered - overlap, buffered);
			buffered = overlap;
		}
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/** Compare `qodercli-X.Y.Z` names numerically by version suffix. */
function compareCliVersions(a: string, b: string): number {
	const parse = (name: string): number[] =>
		name
			.slice("qodercli-".length)
			.split(".")
			.map((part) => {
				const value = Number.parseInt(part, 10);
				return Number.isNaN(value) ? -1 : value;
			});
	const va = parse(a);
	const vb = parse(b);
	for (let i = 0; i < Math.max(va.length, vb.length); i++) {
		const diff = (va[i] ?? 0) - (vb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** `qodercli-*` files under a qodercli bin directory, newest version first. */
function qoderCliCandidates(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.startsWith("qodercli-"))
			.sort((a, b) => compareCliVersions(b, a))
			.map((name) => join(dir, name))
			.filter((path) => {
				try {
					return statSync(path).isFile();
				} catch {
					return false;
				}
			});
	} catch {
		return [];
	}
}

/**
 * Ordered candidate files that may embed the auth WASM:
 * `$QODER_WASM_PATH` (explicit pre-extracted `.wasm` override) → `$QODER_HOME`
 * → `~/.qoder/bin/qodercli/qodercli-*` (newest) →
 * `node_modules/@qoder-ai/qodercli/bundle/qoder-worker-runtime.mjs` under the
 * plugin, cwd, and well-known global npm/bun roots.
 */
function candidateFiles(): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	const pushFile = (path: string): void => {
		if (seen.has(path)) return;
		try {
			if (statSync(path).isFile()) {
				seen.add(path);
				files.push(path);
			}
		} catch {
			// missing candidate: not an error
		}
	};

	const override = process.env.QODER_WASM_PATH?.trim();
	if (override !== undefined && override.length > 0) pushFile(override);

	const qoderHome = process.env.QODER_HOME?.trim();
	if (qoderHome !== undefined && qoderHome.length > 0) {
		pushFile(qoderHome);
		for (const cli of qoderCliCandidates(join(qoderHome, "bin", "qodercli")))
			pushFile(cli);
	}

	for (const cli of qoderCliCandidates(
		join(homedir(), ".qoder", "bin", "qodercli"),
	)) {
		pushFile(cli);
	}

	let root = process.cwd();
	try {
		root = dirname(dirname(fileURLToPath(import.meta.url)));
	} catch {
		// not a file-backed module: cwd is the best available anchor
	}
	const bundleRelative = join(
		"@qoder-ai",
		"qodercli",
		"bundle",
		"qoder-worker-runtime.mjs",
	);
	for (const base of [
		root,
		process.cwd(),
		join(homedir(), ".bun", "install", "global", "node_modules"),
		join(homedir(), ".npm-global", "lib", "node_modules"),
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
	]) {
		pushFile(join(base, bundleRelative));
	}
	return files;
}

interface WasmSourceManifest {
	sourcePath: string;
	size: number;
	mtimeMs: number;
	sha256: string;
}

function parseManifest(raw: unknown): WasmSourceManifest | null {
	if (!isRecord(raw)) return null;
	const { sourcePath, size, mtimeMs, sha256 } = raw;
	if (
		typeof sourcePath !== "string" ||
		typeof size !== "number" ||
		typeof mtimeMs !== "number" ||
		typeof sha256 !== "string"
	) {
		return null;
	}
	return { sourcePath, size, mtimeMs, sha256 };
}

/**
 * Fast path: a prior run recorded which source file the verified payload came
 * from. When that file still exists with the same size+mtime, load the cached
 * bytes and re-verify magic+hash instead of rescanning ~133 MB.
 */
function readCachedWasm(cacheDir: string): Buffer | null {
	try {
		const manifest = parseManifest(
			JSON.parse(readFileSync(join(cacheDir, "wasm-source.json"), "utf8")),
		);
		if (manifest === null) return null;
		const stat = statSync(manifest.sourcePath);
		if (stat.size !== manifest.size || stat.mtimeMs !== manifest.mtimeMs)
			return null;
		const bytes = readFileSync(join(cacheDir, `wasm-${manifest.sha256}.wasm`));
		if (bytes.length > MAX_WASM_BYTES || !isKnownGoodWasm(bytes)) return null;
		return bytes;
	} catch {
		return null;
	}
}

function writeCachedWasm(
	cacheDir: string,
	sourcePath: string,
	sha256: string,
	bytes: Buffer,
): void {
	try {
		const stat = statSync(sourcePath);
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(join(cacheDir, `wasm-${sha256}.wasm`), bytes);
		const manifest: WasmSourceManifest = {
			sourcePath,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			sha256,
		};
		writeFileSync(
			join(cacheDir, "wasm-source.json"),
			`${JSON.stringify(manifest)}\n`,
		);
	} catch {
		// cache is an optimization; never fail the bridge on a write error
	}
}

/**
 * Read a candidate's module bytes: a file starting with the `\0asm` magic is
 * a pre-extracted module (the `$QODER_WASM_PATH` override); anything else is
 * scanned for the embedded payload.
 */
function readCandidateWasm(filePath: string): Buffer | null {
	try {
		const stat = statSync(filePath);
		if (stat.size <= MAX_WASM_BYTES) {
			const bytes = readFileSync(filePath);
			if (hasWasmMagic(bytes)) return bytes;
		}
	} catch {
		return null;
	}
	return extractWasmPayload(filePath);
}

// ---------------------------------------------------------------------------
// wasm-bindgen import object + ABI glue (mirrors the bundle's generated glue;
// verified against the 1.1.2 module under Node and Bun)
// ---------------------------------------------------------------------------

type QoderWasmExports = {
	memory: WebAssembly.Memory;
	qodercontext_new: (
		sp: number,
		p0: number,
		l0: number,
		p1: number,
		l1: number,
		p2: number,
		l2: number,
		p3: number,
		l3: number,
	) => void;
	qodercontext_prepareInferRequest: (
		sp: number,
		ctx: number,
		p0: number,
		l0: number,
		p1: number,
		l1: number,
		p2: number,
		l2: number,
		p3: number,
		l3: number,
	) => void;
	qodercontext_prepareRequest: (
		sp: number,
		ctx: number,
		p0: number,
		l0: number,
		p1: number,
		l1: number,
		p2: number,
		l2: number,
		p3: number,
		l3: number,
		p4: number,
		l4: number,
		p5: number,
		l5: number,
	) => void;
	decrypt_server_response: (sp: number, p: number, l: number) => void;
	generate_runtime_auth_fields: (sp: number, p: number, l: number) => void;
	requestresult_url: (sp: number, ptr: number) => void;
	requestresult_body: (sp: number, ptr: number) => void;
	requestresult_headers: (ptr: number) => number;
	__wbg_qodercontext_free: (ptr: number, flags: number) => void;
	__wbg_requestresult_free: (ptr: number, flags: number) => void;
	__wbindgen_export: (idx: number) => void;
	__wbindgen_export2: (size: number, align: number) => number;
	__wbindgen_export3: (
		ptr: number,
		oldSize: number,
		newSize: number,
		align: number,
	) => number;
	__wbindgen_export4: (ptr: number, size: number, align: number) => void;
	__wbindgen_add_to_stack_pointer: (delta: number) => number;
};

function readExports(instance: WebAssembly.Instance): QoderWasmExports {
	const raw = instance.exports;
	const fn = (name: string): ((...args: number[]) => number | undefined) => {
		const value = raw[name];
		if (typeof value !== "function") {
			throw new Error(`qoder wasm: missing export ${name}`);
		}
		return value as (...args: number[]) => number | undefined;
	};
	const memory = raw.memory;
	if (!(memory instanceof WebAssembly.Memory)) {
		throw new Error("qoder wasm: missing memory export");
	}
	return {
		memory,
		qodercontext_new: fn(
			"qodercontext_new",
		) as QoderWasmExports["qodercontext_new"],
		qodercontext_prepareInferRequest: fn(
			"qodercontext_prepareInferRequest",
		) as QoderWasmExports["qodercontext_prepareInferRequest"],
		qodercontext_prepareRequest: fn(
			"qodercontext_prepareRequest",
		) as QoderWasmExports["qodercontext_prepareRequest"],
		decrypt_server_response: fn(
			"decrypt_server_response",
		) as QoderWasmExports["decrypt_server_response"],
		generate_runtime_auth_fields: fn(
			"generate_runtime_auth_fields",
		) as QoderWasmExports["generate_runtime_auth_fields"],
		requestresult_url: fn(
			"requestresult_url",
		) as QoderWasmExports["requestresult_url"],
		requestresult_body: fn(
			"requestresult_body",
		) as QoderWasmExports["requestresult_body"],
		requestresult_headers: fn(
			"requestresult_headers",
		) as QoderWasmExports["requestresult_headers"],
		__wbg_qodercontext_free: fn(
			"__wbg_qodercontext_free",
		) as QoderWasmExports["__wbg_qodercontext_free"],
		__wbg_requestresult_free: fn(
			"__wbg_requestresult_free",
		) as QoderWasmExports["__wbg_requestresult_free"],
		__wbindgen_export: fn(
			"__wbindgen_export",
		) as QoderWasmExports["__wbindgen_export"],
		__wbindgen_export2: fn(
			"__wbindgen_export2",
		) as QoderWasmExports["__wbindgen_export2"],
		__wbindgen_export3: fn(
			"__wbindgen_export3",
		) as QoderWasmExports["__wbindgen_export3"],
		__wbindgen_export4: fn(
			"__wbindgen_export4",
		) as QoderWasmExports["__wbindgen_export4"],
		__wbindgen_add_to_stack_pointer: fn(
			"__wbindgen_add_to_stack_pointer",
		) as QoderWasmExports["__wbindgen_add_to_stack_pointer"],
	};
}

/**
 * Shared glue state: one heap + memory views used by BOTH the import object
 * and the ABI wrappers (a heap index returned by the WASM, e.g. the headers
 * map or a thrown error, must resolve against the same heap that served the
 * imports). `wasm` is assigned immediately after instantiation; imports that
 * fire during instantiation never touch it (verified against the real module).
 */
interface Glue {
	wasm: QoderWasmExports | null;
	heap: unknown[];
	heapNext: number;
	cachedU8: Uint8Array | null;
	cachedDataView: DataView | null;
}

function createGlue(): Glue {
	const heap: unknown[] = new Array(1024).fill(undefined);
	heap.push(undefined, null, true, false);
	return {
		wasm: null,
		heap,
		heapNext: heap.length,
		cachedU8: null,
		cachedDataView: null,
	};
}

function requireWasm(glue: Glue): QoderWasmExports {
	if (glue.wasm === null)
		throw new Error("qoder wasm: import called before instantiation");
	return glue.wasm;
}

function addHeapObject(glue: Glue, obj: unknown): number {
	if (glue.heapNext === glue.heap.length) glue.heap.push(glue.heap.length + 1);
	const idx = glue.heapNext;
	const next = glue.heap[idx];
	glue.heapNext = typeof next === "number" ? next : glue.heap.length;
	glue.heap[idx] = obj;
	return idx;
}

function getObject(glue: Glue, idx: number): unknown {
	return glue.heap[idx];
}

function dropObject(glue: Glue, idx: number): void {
	if (idx < 1028) return;
	glue.heap[idx] = glue.heapNext;
	glue.heapNext = idx;
}

function takeObject(glue: Glue, idx: number): unknown {
	const ret = getObject(glue, idx);
	dropObject(glue, idx);
	return ret;
}

function getU8(glue: Glue): Uint8Array {
	if (glue.cachedU8 === null || glue.cachedU8.byteLength === 0) {
		glue.cachedU8 = new Uint8Array(requireWasm(glue).memory.buffer);
	}
	return glue.cachedU8;
}

function getDataView(glue: Glue): DataView {
	if (
		glue.cachedDataView === null ||
		glue.cachedDataView.buffer !== requireWasm(glue).memory.buffer
	) {
		glue.cachedDataView = new DataView(requireWasm(glue).memory.buffer);
	}
	return glue.cachedDataView;
}

const glueTextDecoder = new TextDecoder("utf-8", {
	ignoreBOM: true,
	fatal: true,
});
const glueTextEncoder = new TextEncoder();

function getStringFromWasm(glue: Glue, ptr: number, len: number): string {
	return glueTextDecoder.decode(
		getU8(glue).subarray(ptr >>> 0, (ptr >>> 0) + len),
	);
}

function getArrayU8FromWasm(glue: Glue, ptr: number, len: number): Uint8Array {
	return getU8(glue).subarray(ptr >>> 0, (ptr >>> 0) + len);
}

function handleError(
	glue: Glue,
	fn: (...args: number[]) => unknown,
	args: readonly number[],
): unknown {
	try {
		return fn.apply(null, Array.from(args));
	} catch (e) {
		requireWasm(glue).__wbindgen_export(addHeapObject(glue, e));
		return undefined;
	}
}

function createImports(glue: Glue): WebAssembly.Imports {
	return {
		"./qoder_auth_wasm_bg.js": {
			__wbg_Error_2e59b1b37a9a34c3: (a: number, b: number) =>
				addHeapObject(glue, new Error(getStringFromWasm(glue, a, b))),
			__wbg___wbindgen_is_function_49868bde5eb1e745: (a: number) =>
				typeof getObject(glue, a) === "function" ? 1 : 0,
			__wbg___wbindgen_is_object_40c5a80572e8f9d3: (a: number) => {
				const value = getObject(glue, a);
				return typeof value === "object" && value !== null ? 1 : 0;
			},
			__wbg___wbindgen_is_string_b29b5c5a8065ba1a: (a: number) =>
				typeof getObject(glue, a) === "string" ? 1 : 0,
			__wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (a: number) =>
				getObject(glue, a) === undefined ? 1 : 0,
			__wbg___wbindgen_throw_81fc77679af83bc6: (a: number, b: number) => {
				throw new Error(getStringFromWasm(glue, a, b));
			},
			__wbg_call_d578befcc3145dee: (a: number, b: number, c: number) =>
				handleError(
					glue,
					(x, y, z) => {
						const target = getObject(glue, x);
						if (typeof target !== "function") {
							throw new Error("qoder wasm: call target is not a function");
						}
						return addHeapObject(
							glue,
							target.call(getObject(glue, y), getObject(glue, z)),
						);
					},
					[a, b, c],
				),
			__wbg_crypto_38df2bab126b63dc: (a: number) => {
				const value = getObject(glue, a);
				return addHeapObject(glue, isRecord(value) ? value.crypto : undefined);
			},
			__wbg_getRandomValues_c44a50d8cfdaebeb: (a: number, b: number) =>
				handleError(
					glue,
					(x, y) => {
						const target = getObject(glue, x);
						if (
							!isRecord(target) ||
							typeof target.getRandomValues !== "function"
						) {
							throw new Error("qoder wasm: getRandomValues target missing");
						}
						target.getRandomValues(getObject(glue, y));
						return undefined;
					},
					[a, b],
				),
			__wbg_getRandomValues_d49329ff89a07af1: (a: number, b: number) =>
				handleError(
					glue,
					(x, y) =>
						globalThis.crypto.getRandomValues(getArrayU8FromWasm(glue, x, y)),
					[a, b],
				),
			__wbg_length_0c32cb8543c8e4c8: (a: number) => {
				const value = getObject(glue, a);
				return isRecord(value) && typeof value.length === "number"
					? value.length
					: 0;
			},
			__wbg_msCrypto_bd5a034af96bcba6: (a: number) => {
				const value = getObject(glue, a);
				return addHeapObject(
					glue,
					isRecord(value) ? value.msCrypto : undefined,
				);
			},
			__wbg_new_99cabae501c0a8a0: () => addHeapObject(glue, new Map()),
			__wbg_new_with_length_9cedd08484b73942: (a: number) =>
				addHeapObject(glue, new Uint8Array(a >>> 0)),
			__wbg_node_84ea875411254db1: (a: number) => {
				const value = getObject(glue, a);
				return addHeapObject(glue, isRecord(value) ? value.node : undefined);
			},
			__wbg_now_88621c9c9a4f3ffc: () => Date.now(),
			__wbg_process_44c7a14e11e9f69e: (a: number) => {
				const value = getObject(glue, a);
				return addHeapObject(glue, isRecord(value) ? value.process : undefined);
			},
			__wbg_prototypesetcall_3e05eb9545565046: (
				a: number,
				b: number,
				c: number,
			) => {
				const source = getObject(glue, c);
				if (!(source instanceof Uint8Array)) {
					throw new Error("qoder wasm: set source is not a Uint8Array");
				}
				Uint8Array.prototype.set.call(getArrayU8FromWasm(glue, a, b), source);
			},
			__wbg_randomFillSync_6c25eac9869eb53c: (a: number, b: number) =>
				handleError(
					glue,
					(x, y) => {
						const target = getObject(glue, x);
						if (
							!isRecord(target) ||
							typeof target.randomFillSync !== "function"
						) {
							throw new Error("qoder wasm: randomFillSync target missing");
						}
						target.randomFillSync(takeObject(glue, y));
						return undefined;
					},
					[a, b],
				),
			__wbg_require_b4edbdcf3e2a1ef0: () =>
				handleError(glue, () => {
					// The node-require fallback is never taken under Bun/ESM (the
					// crypto.getRandomValues path wins); throwing routes the WASM to
					// its own exception fallback, exactly as an undefined `module` would.
					throw new Error("qoder wasm: require() path unavailable");
				}, []),
			__wbg_set_08463b1df38a7e29: (a: number, b: number, c: number) => {
				const target = getObject(glue, a);
				if (!isRecord(target) || typeof target.set !== "function") {
					throw new Error("qoder wasm: set target missing");
				}
				return addHeapObject(
					glue,
					target.set(getObject(glue, b), getObject(glue, c)),
				);
			},
			__wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () =>
				typeof globalThis === "undefined" ? 0 : addHeapObject(glue, globalThis),
			__wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () =>
				typeof globalThis === "undefined" ? 0 : addHeapObject(glue, globalThis),
			__wbg_static_accessor_SELF_24f78b6d23f286ea: () =>
				typeof globalThis === "undefined" ? 0 : addHeapObject(glue, globalThis),
			__wbg_static_accessor_WINDOW_59fd959c540fe405: () => 0,
			__wbg_subarray_0f98d3fb634508ad: (a: number, b: number, c: number) => {
				const value = getObject(glue, a);
				if (value instanceof Uint8Array) {
					return addHeapObject(glue, value.subarray(b >>> 0, c >>> 0));
				}
				return addHeapObject(glue, undefined);
			},
			__wbg_versions_276b2795b1c6a219: (a: number) => {
				const value = getObject(glue, a);
				return addHeapObject(
					glue,
					isRecord(value) ? value.versions : undefined,
				);
			},
			__wbindgen_cast_0000000000000001: (a: number, b: number) =>
				addHeapObject(glue, getArrayU8FromWasm(glue, a, b)),
			__wbindgen_cast_0000000000000002: (a: number, b: number) =>
				addHeapObject(glue, getStringFromWasm(glue, a, b)),
			__wbindgen_object_clone_ref: (a: number) =>
				addHeapObject(glue, getObject(glue, a)),
			__wbindgen_object_drop_ref: (a: number) => takeObject(glue, a),
		},
	};
}

/** Read a `(ptr, len)` string result off the stack frame and free it. */
function readStackString(glue: Glue, sp: number): string {
	const ptr = getDataView(glue).getInt32(sp + 0, true);
	const len = getDataView(glue).getInt32(sp + 4, true);
	const value = getStringFromWasm(glue, ptr, len);
	requireWasm(glue).__wbindgen_export4(ptr, len, 1);
	return value;
}

/** Context-call error layout: result ptr at sp+0, error heap idx at sp+4, thrown flag at sp+8. */
function throwIfContextCallFailed(glue: Glue, sp: number): void {
	const err = getDataView(glue).getInt32(sp + 4, true);
	const thrown = getDataView(glue).getInt32(sp + 8, true);
	if (thrown === 0) return;
	const value = takeObject(glue, err);
	throw value instanceof Error ? value : new Error(String(value));
}

/** Free-function string-call error layout: result (ptr,len) at sp+0..8, error at sp+8, thrown at sp+12. */
function readStringCallResult(glue: Glue, sp: number): string {
	const dv = getDataView(glue);
	const thrown = dv.getInt32(sp + 12, true);
	if (thrown !== 0) {
		const err = dv.getInt32(sp + 8, true);
		const value = takeObject(glue, err);
		const resultPtr = dv.getInt32(sp + 0, true);
		const resultLen = dv.getInt32(sp + 4, true);
		if (resultPtr !== 0)
			requireWasm(glue).__wbindgen_export4(resultPtr, resultLen, 1);
		throw value instanceof Error ? value : new Error(String(value));
	}
	return readStackString(glue, sp);
}

class RequestResultImpl {
	#glue: Glue;
	#ptr: number;
	constructor(glue: Glue, ptr: number) {
		this.#glue = glue;
		this.#ptr = ptr >>> 0;
	}
	free(): void {
		if (this.#ptr === 0) return;
		requireWasm(this.#glue).__wbg_requestresult_free(this.#ptr, 0);
		this.#ptr = 0;
	}
	get url(): string {
		const wasm = requireWasm(this.#glue);
		const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
		try {
			wasm.requestresult_url(sp, this.#ptr);
			return readStackString(this.#glue, sp);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	get body(): string | undefined {
		const wasm = requireWasm(this.#glue);
		const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
		try {
			wasm.requestresult_body(sp, this.#ptr);
			if (getDataView(this.#glue).getInt32(sp + 0, true) === 0)
				return undefined;
			return readStackString(this.#glue, sp);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	get headers(): Record<string, string> {
		const wasm = requireWasm(this.#glue);
		const out: Record<string, string> = {};
		const value = takeObject(this.#glue, wasm.requestresult_headers(this.#ptr));
		if (value instanceof Map) {
			for (const [key, headerValue] of value) {
				if (typeof key === "string" && typeof headerValue === "string")
					out[key] = headerValue;
			}
		}
		return out;
	}
}

function createBridgeApi(glue: Glue): QoderWasmBridge {
	const wasm = requireWasm(glue);
	const malloc = wasm.__wbindgen_export2;
	const realloc = wasm.__wbindgen_export3;

	const passString = (arg: string): [number, number] => {
		let len = arg.length;
		let ptr = malloc(len, 1) >>> 0;
		const mem = getU8(glue);
		let offset = 0;
		for (; offset < len; offset++) {
			const code = arg.charCodeAt(offset);
			if (code > 127) break;
			mem[ptr + offset] = code;
		}
		if (offset !== len) {
			if (offset !== 0) arg = arg.slice(offset);
			const expandedLen = offset + arg.length * 3;
			ptr = realloc(ptr, len, expandedLen, 1) >>> 0;
			len = expandedLen;
			const view = getU8(glue).subarray(ptr + offset, ptr + len);
			const ret = glueTextEncoder.encodeInto(arg, view);
			offset += ret.written;
			ptr = realloc(ptr, len, offset, 1) >>> 0;
		}
		return [ptr, offset];
	};
	const passOptionalString = (arg: string | undefined): [number, number] =>
		arg === undefined ? [0, 0] : passString(arg);

	const prepareFromStack = (sp: number): QoderPreparedRequest => {
		const ptr = getDataView(glue).getInt32(sp + 0, true);
		throwIfContextCallFailed(glue, sp);
		const result = new RequestResultImpl(glue, ptr);
		try {
			return { url: result.url, headers: result.headers, body: result.body };
		} finally {
			result.free();
		}
	};

	const decryptServerResponse = (encrypted: string): string => {
		const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
		const [p, l] = passString(encrypted);
		try {
			wasm.decrypt_server_response(sp, p, l);
			return readStringCallResult(glue, sp);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	};

	return {
		createContext(machineId, cosyVersion, userInfoJson, configJson) {
			const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
			const [p0, l0] = passString(machineId);
			const [p1, l1] = passString(cosyVersion);
			const [p2, l2] = passString(userInfoJson);
			const [p3, l3] = passOptionalString(configJson);
			try {
				wasm.qodercontext_new(sp, p0, l0, p1, l1, p2, l2, p3, l3);
				const ptr = getDataView(glue).getInt32(sp + 0, true);
				throwIfContextCallFailed(glue, sp);
				let freed = false;
				const context: QoderWasmContext = {
					prepareInferRequest(endpoint, bodyJson, modelKey, modelSource) {
						const reqSp = wasm.__wbindgen_add_to_stack_pointer(-16);
						const [q0, m0] = passString(endpoint);
						const [q1, m1] = passString(bodyJson);
						const [q2, m2] = passOptionalString(modelKey);
						const [q3, m3] = passOptionalString(modelSource);
						try {
							wasm.qodercontext_prepareInferRequest(
								reqSp,
								ptr,
								q0,
								m0,
								q1,
								m1,
								q2,
								m2,
								q3,
								m3,
							);
							return prepareFromStack(reqSp);
						} finally {
							wasm.__wbindgen_add_to_stack_pointer(16);
						}
					},
					prepareRequest(endpoint, path, method, kind, body, headersJson) {
						const reqSp = wasm.__wbindgen_add_to_stack_pointer(-16);
						const [q0, m0] = passString(endpoint);
						const [q1, m1] = passString(path);
						const [q2, m2] = passString(method);
						const [q3, m3] = passString(kind);
						const [q4, m4] = passOptionalString(body);
						const [q5, m5] = passOptionalString(headersJson);
						try {
							wasm.qodercontext_prepareRequest(
								reqSp,
								ptr,
								q0,
								m0,
								q1,
								m1,
								q2,
								m2,
								q3,
								m3,
								q4,
								m4,
								q5,
								m5,
							);
							return prepareFromStack(reqSp);
						} finally {
							wasm.__wbindgen_add_to_stack_pointer(16);
						}
					},
					free() {
						if (freed) return;
						freed = true;
						wasm.__wbg_qodercontext_free(ptr, 0);
					},
					decryptServerResponse,
				};
				return context;
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		},
		generateRuntimeAuthFields(identityJson) {
			const sp = wasm.__wbindgen_add_to_stack_pointer(-16);
			const [p, l] = passString(identityJson);
			try {
				wasm.generate_runtime_auth_fields(sp, p, l);
				const json: unknown = JSON.parse(readStringCallResult(glue, sp));
				if (
					!isRecord(json) ||
					typeof json.encrypt_user_info !== "string" ||
					typeof json.key !== "string"
				) {
					throw new Error("qoder wasm: unexpected runtime auth fields shape");
				}
				return { encrypt_user_info: json.encrypt_user_info, key: json.key };
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		},
		decryptServerResponse,
	};
}

function instantiateBridge(bytes: Buffer): QoderWasmBridge | null {
	try {
		const glue = createGlue();
		const imports = createImports(glue);
		// Fresh copy: TS 5.9 types Buffer as ArrayBufferLike-backed, which
		// WebAssembly.Module (BufferSource over ArrayBuffer) rejects.
		const module = new WebAssembly.Module(new Uint8Array(bytes));
		const instance = new WebAssembly.Instance(module, imports);
		glue.wasm = readExports(instance);
		return createBridgeApi(glue);
	} catch {
		return null;
	}
}

/**
 * Locate, verify, and instantiate the user's Qoder auth WASM. Synchronous
 * (the plugin's registration path is sync). Fail closed: returns null when no
 * candidate yields a known-good, instantiable module — callers disable the
 * api3-only models and behave exactly as the legacy-only plugin.
 */
export function loadQoderWasmBridge(): QoderWasmBridge | null {
	try {
		const cacheDir = getQoderCacheDir();
		const cached = readCachedWasm(cacheDir);
		if (cached !== null) {
			const bridge = instantiateBridge(cached);
			if (bridge !== null) return bridge;
		}
		for (const candidate of candidateFiles()) {
			const bytes = readCandidateWasm(candidate);
			if (bytes === null || !isKnownGoodWasm(bytes)) continue;
			const bridge = instantiateBridge(bytes);
			if (bridge === null) continue;
			writeCachedWasm(
				cacheDir,
				candidate,
				createHash("sha256").update(bytes).digest("hex"),
				bytes,
			);
			return bridge;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Stable per-install machine id carried by `Cosy-MachineId`/`Cosy-MachineToken`.
 * Persisted under the plugin cache dir; created on first use.
 */
export function getQoderMachineId(): string {
	const cacheDir = getQoderCacheDir();
	const idPath = join(cacheDir, "machine-id");
	try {
		const existing = readFileSync(idPath, "utf8").trim();
		if (
			/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
				existing,
			)
		) {
			return existing;
		}
	} catch {
		// first use or unreadable: fall through and mint
	}
	const id = randomUUID();
	try {
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(idPath, `${id}\n`, { mode: 0o600 });
	} catch {
		// an unpersisted id still works for the session; persistence is best-effort
	}
	return id;
}
