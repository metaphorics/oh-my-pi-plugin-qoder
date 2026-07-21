# Qoder provider for oh-my-pi

An unofficial [oh-my-pi](https://github.com/can1357/oh-my-pi) extension that adds Qoder browser login and the full Qoder model catalog: 15 base models plus 22 long-context aliases.

## Install

```sh
omp plugin install https://github.com/metaphorics/oh-my-pi-plugin-qoder
```

Restart omp after installation. This repository uses `package.json#omp.extensions`; do not install it through an omp marketplace catalog, because marketplace bundles do not load manifest-declared extension modules.

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

## Models

The catalog is a static seed reverse-engineered from an authenticated `qodercli --list-models` (Qoder's model-list endpoint is request-signed, so dynamic discovery is not possible). Every model streams through Qoder's OpenAI-compatible endpoint and allows 32k output tokens.

| Model | Wire key | Context | Reasoning | Notes |
|---|---|---|---:|---|
| Qoder (Auto) | `auto` | 180k | no | Server-side router; default pick |
| Ultimate | `ultimate` | 200k | yes | Efforts low–max, default high |
| Performance | `performance` | 272k | no | |
| Efficient | `efficient` | 180k | no | |
| Lite | `lite` | 180k | no | Text only (no vision) |
| Cantus | `cmodel` | 200k | yes | Efforts low–max, default high |
| Qwen3.8-Max-Preview | `qmodel_preview` | 200k | yes | Fixed effort (always on) |
| Qwen3.7-Max | `qmodel_latest` | 200k | no | |
| Qwen3.7-Plus | `qmodel` | 200k | no | |
| Kimi-K3 | `kmodel_latest` | 200k | no | |
| Kimi-K2.7-Code | `kmodel` | 256k | no | Only model with the high-speed switch |
| GLM-5.2 | `gm51model` | 200k | yes | Efforts high/max, default max |
| DeepSeek-V4-Pro | `dmodel` | 200k | yes | Efforts high/max, default max |
| DeepSeek-V4-Flash | `dfmodel` | 200k | yes | Efforts high/max, default max |
| MiniMax-M3 | `mmodel` | 200k | no | |

### Context aliases

Every multi-window model (all of the above except `auto`, `efficient`, `lite`, and `kmodel`) also comes in two long-context variants:

- `<wire-key>-400k` — 400,000-token context window
- `<wire-key>-1m` — 1,000,000-token context window

An alias sends the **base** wire key as the request `model` plus a top-level `context_length` matching the alias window (e.g. `qoder/ultimate-1m` sends `"model": "ultimate", "context_length": 1000000`). Aliases inherit the base model's reasoning, vision, and effort metadata.

## Fast mode (`/fast`)

Qoder's high-speed serving switch exists only on `kmodel` (Kimi-K2.7-Code). When `/fast` (priority service tier) is active for `qoder/kmodel`, the plugin merges Qoder's switch into the request body:

```json
"metadata": { "business": { "feature_switches": { "highspeed": "true" } } }
```

OpenAI's `service_tier` field is never sent to Qoder. `/fast` on any other Qoder model is a no-op. Toggling `/fast` itself requires an omp build that classifies the Qoder service-tier family (see the upstream Qoder provider PR); on older omp the plugin still streams and repairs correctly, but no high-speed metadata is injected because no priority tier is ever passed down.

## Privacy

**Client behavior (what this plugin controls):** requests carry only `Authorization: Bearer`, the JSON/event-stream negotiation headers, and Qoder's three `Cosy-*` client-attribution headers (`Cosy-ClientType`, `Cosy-Version`, `Cosy-MachineOS`). The plugin deliberately omits the Qoder CLI's per-request tracing ids (`X-Request-ID`, `X-Session-ID`) and sends no `user`, `store`, telemetry, or session-metadata fields. High-speed metadata is sent only while `/fast` is active on `qoder/kmodel`, as documented above.

**Account policy (what this plugin cannot control):** Qoder's named Privacy Mode is an account-side setting (`data_policy_agreed`) guarded by a request-signed settings endpoint. There is no field for it on the OpenAI-compatible model endpoint, so this plugin cannot enable or disable it and does not fabricate one. Manage data contribution in your Qoder account's privacy settings; this plugin does not change your server-side policy.

## Behavior

- Uses Qoder's browser PKCE device flow and refresh endpoint, retrying transient network errors while authorization is pending.
- Sends the Qoder `Cosy-*` client headers required by the model gateway.
- Repairs Qoder's folded SSE framing (a final usage event split across a bare newline) before parsing, so token accounting survives; other providers' streams are untouched.
- Registers 37 models: 15 base rows + 22 context aliases wired through `requestModelId` and `context_length`.
- Omits OpenAI's unsupported `store` request field.
- Becomes inert when the installed omp version already provides a native `qoder` provider.

## Verification status

Mocked network tests cover PKCE construction, pending polling, transient retry, token parsing, refresh requests, provider registration and collision handling, the 37-row model surface and alias metadata, folded-SSE usage recovery (including folds split across network chunks), alias wire routing with `context_length`, scoped high-speed injection, and the no-telemetry request posture. Package type checking is also exercised.

Real-account browser authorization, streamed chat, tool calls, and token refresh have not been validated end to end. Qoder can change these undocumented endpoints without notice.

## Scope and affiliation

This project is not affiliated with or endorsed by Qoder. The integration was derived from the public `@qoder-ai/qodercli` package, version 1.1.1. Review Qoder's terms before using an unofficial client with your account.

## License

MIT
