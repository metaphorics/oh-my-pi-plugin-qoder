# Qoder provider for oh-my-pi

An unofficial [oh-my-pi](https://github.com/can1357/oh-my-pi) extension that adds Qoder browser login and the Qoder model catalog: up to 15 base models plus 22 long-context aliases (37 rows). Six api3-only families register only when the installed Qoder CLI's auth WASM is available; without it the plugin degrades to the 19 legacy rows.

## Install

Install through the repository's omp marketplace:

```text
/marketplace add metaphorics/oh-my-pi-plugin-qoder
/marketplace install oh-my-pi-plugin-qoder@qoder-plugins
```

Restart omp after installation.

This compatibility provider supports omp 17.x starting with 17.0.6. Hosts in that line that bundle Qoder load the extension inert instead of overriding the native provider.

Direct Git installation is also supported:

```sh
omp plugin install https://github.com/metaphorics/oh-my-pi-plugin-qoder
```

## Use

1. Start `omp`.
2. Run `/login` and choose **Qoder**.
3. Complete authorization in the browser.
4. Pick a `qoder/*` model from the model picker (`qoder/auto` is the server-side router and a safe default).

For headless use with an existing Qoder device token:

```sh
export QODER_OAUTH_TOKEN="your-device-token"
omp --model qoder/auto
```

`QODER_PERSONAL_ACCESS_TOKEN` is not accepted as a bearer token. Qoder's CLI exchanges personal access tokens through a separate job-token endpoint; this plugin does not implement that flow.

## Requirements

The nine legacy models work with just a Qoder login; nothing else needs to be installed.

The six api3 models additionally require Qoder's CLI (`qodercli` 1.1.2), installed either at `~/.qoder/bin/qodercli` or as `@qoder-ai/qodercli` under `node_modules`. The plugin locates the CLI's auth WASM at runtime, extracts it, verifies it against a known-good SHA-256 digest, and caches the verified module under the plugin cache directory; the WASM is never bundled with or redistributed by this plugin. If the WASM cannot be found or instantiated, the six api3 models and their aliases are not registered and the plugin serves the 19 legacy rows. `QODER_WASM_PATH` (a direct `.wasm` path) and `QODER_HOME` (the install root) override the search.

## Models

The catalog is a static seed reverse-engineered from an authenticated `qodercli --list-models`, overlaid at runtime with the server's model list (fetched through the same WASM-signed transport) when the auth WASM is available; the overlay refines reasoning-effort ladders and context windows and never downgrades the static defaults. The nine legacy models stream through Qoder's OpenAI-compatible api2-v2 endpoint; the six api3 families stream through Qoder's WASM-signed api3 transport. Every model allows 32k output tokens.

The nine legacy base models are always registered. The six families pruned in 0.2.4 — Cantus (`cmodel`), Qwen3.8-Max-Preview (`qmodel_preview`), Qwen3.7-Max (`qmodel_latest`), Kimi-K3 (`kmodel_latest`), GLM-5.2 (`gm51model`), and DeepSeek-V4-Flash (`dfmodel`) — are served only by Qoder's WASM-signed api3 transport (the legacy endpoint accepts their requests but returns empty completions). The plugin registers these six, with their 12 context aliases, only when it can locate and run the auth WASM from your installed `qodercli` (see Requirements). When the WASM is unavailable, the plugin degrades to the 19 legacy rows (9 bases + 10 aliases) and the six api3 families stay hidden rather than silently failing.

| Model | Wire key | Context | Reasoning | Notes |
|---|---|---|---:|---|
| Qoder (Auto) | `auto` | 180k | no | Server-side router; default pick |
| Ultimate | `ultimate` | 200k | yes | Efforts low–max, default high |
| Performance | `performance` | 272k | no | |
| Efficient | `efficient` | 180k | no | |
| Lite | `lite` | 180k | no | Text only (no vision) |
| Qwen3.7-Plus | `qmodel` | 200k | no | |
| Kimi-K2.7-Code | `kmodel` | 256k | no | Only model with the high-speed switch |
| DeepSeek-V4-Pro | `dmodel` | 200k | yes | Efforts high/max, default max |
| MiniMax-M3 | `mmodel` | 200k | no | |
| Cantus | `cmodel` | 200k | yes | api3; efforts low–max, default high |
| Qwen3.8-Max-Preview | `qmodel_preview` | 200k | yes | api3; effort high (required) |
| Qwen3.7-Max | `qmodel_latest` | 200k | no | api3 |
| Kimi-K3 | `kmodel_latest` | 200k | no | api3 |
| GLM-5.2 | `gm51model` | 200k | yes | api3; efforts high/max, default max |
| DeepSeek-V4-Flash | `dfmodel` | 200k | yes | api3; efforts high/max, default max |

### Context aliases

Every multi-window model (all of the above except `auto`, `efficient`, `lite`, and `kmodel`) also comes in two long-context variants:

- `<wire-key>-400k` — 400,000-token context window
- `<wire-key>-1m` — 1,000,000-token context window

An alias routes the **base** wire key with the context window matching its suffix. On the legacy transport it sends the base key as the request `model` plus a top-level `context_length` (e.g. `qoder/ultimate-1m` sends `"model": "ultimate", "context_length": 1000000`); on the api3 transport the base key rides in `model_config.key` and the window in `parameters.context_length`. Aliases inherit the base model's reasoning, vision, and effort metadata.

## Fast mode (`/fast`)

Qoder's high-speed serving switch exists only on `kmodel` (Kimi-K2.7-Code). When `/fast` (priority service tier) is active for `qoder/kmodel`, the plugin merges Qoder's switch into the request body:

```json
"metadata": { "business": { "feature_switches": { "highspeed": "true" } } }
```

OpenAI's `service_tier` field is never sent to Qoder. `/fast` on any other Qoder model is a no-op. Toggling `/fast` itself requires an omp build that classifies the Qoder service-tier family (see the upstream Qoder provider PR); on older omp the plugin still streams and repairs correctly, but no high-speed metadata is injected because no priority tier is ever passed down.

## Privacy

**Client behavior (what this plugin controls):** Privacy Mode is enforced per request on both transports. The plugin attaches `Cosy-Data-Policy: disagree` — the official Qoder client's opt-out wire value — to every request it sends; enforcement is unconditional and not configurable. It never blocks a request either: the value is written while the request is built, so there is no privacy check a request can fail or be held up by. On the api3 transport the same value is emitted inside the WASM-signed `Cosy-*` header set (the signing context is built with `data_policy_agreed:false`); the api3 request body carries no separate data-policy field. Legacy requests otherwise carry only `Authorization: Bearer`, the JSON/event-stream negotiation headers, and Qoder's three `Cosy-*` client-attribution headers (`Cosy-ClientType`, `Cosy-Version`, `Cosy-MachineOS`); api3 requests carry the WASM-signed `Cosy-*` auth set. The plugin deliberately omits the Qoder CLI's per-request tracing ids (`X-Request-ID`, `X-Session-ID`) and sends no `user`, `store`, telemetry, or session-metadata fields. High-speed metadata is sent only while `/fast` is active on `qoder/kmodel`, as documented above.

**Account policy (what this plugin cannot control):** the per-request `Cosy-Data-Policy: disagree` header is a client-side opt-out signal, not Qoder's account-side Privacy Mode flag (`data_policy_agreed`). That account flag is guarded by a request-signed settings endpoint; this plugin does not read or change it, so it stays managed in your Qoder account's privacy settings. Signaling the opt-out on every request does not flip your server-side policy.

## Behavior

- Uses Qoder's browser PKCE device flow and refresh endpoint, retrying transient network errors while authorization is pending.
- Sends the Qoder `Cosy-*` client headers required by the model gateway.
- Repairs Qoder's folded SSE framing (a final usage event split across a bare newline) before parsing, so token accounting survives; other providers' streams are untouched.
- Registers up to 37 models: 15 base rows + 22 context aliases wired through `requestModelId` and `context_length`; degrades to the 19 legacy rows (9 bases + 10 aliases) when the qodercli auth WASM is unavailable.
- Omits OpenAI's unsupported `store` request field.
- Becomes inert when omp already provides native Qoder support, including marketplace installs.

## Verification status

Mocked network tests cover PKCE construction, pending polling, transient retry, token parsing, refresh requests, provider registration and collision handling, the legacy 19-row model surface and alias metadata, folded-SSE usage recovery (including folds split across network chunks), alias wire routing with `context_length`, scoped high-speed injection, and the no-telemetry request posture. Package type checking is also exercised.

Browser authorization and real-account streamed chat were validated with `qoder/auto`, a long-context alias, and `/fast` on `qoder/kmodel`. The WASM bridge (runtime locate, extract, SHA-256 verify, instantiate) and the WASM-signed api3 transport were validated live against a real account with the installed `qodercli` 1.1.2 WASM: all fifteen base models and spot-checked aliases (`ultimate-400k`, `qmodel_preview-400k`, `cmodel-1m`) streamed through compiled omp, including the six api3-only families; `Cosy-Data-Policy: disagree` was confirmed on every WASM-prepared request. The new api3/WASM/privacy paths are covered by mocked unit tests (body contract, identity chain, SSE-envelope mapping, error envelopes, folded-SSE repair, bridge-missing degradation). Token refresh has not been validated end to end. Qoder can change these undocumented endpoints without notice.

## Scope and affiliation

This project is not affiliated with or endorsed by Qoder. The integration was derived from the public `@qoder-ai/qodercli` package, with the current catalog validated against version 1.1.2. Review Qoder's terms before using an unofficial client with your account.

## License

MIT
