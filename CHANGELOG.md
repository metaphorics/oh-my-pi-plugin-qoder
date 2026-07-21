# Changelog

## 0.2.2 - 2026-07-22

- Made marketplace loading self-contained by resolving runtime AI modules from the omp host instead of an undeclared catalog package.

## 0.2.1 - 2026-07-22

- Added an omp marketplace catalog for installing the provider from this repository.
- Documented the authenticated browser-login and streamed-chat paths that were exercised against a real Qoder account.

## 0.2.0 - 2026-07-21

- Expanded the model surface to the full authenticated catalog: 15 base models (Auto, Ultimate, Performance, Efficient, Lite, Cantus, Qwen3.8-Max-Preview, Qwen3.7-Max, Qwen3.7-Plus, Kimi-K3, Kimi-K2.7-Code, GLM-5.2, DeepSeek-V4-Pro, DeepSeek-V4-Flash, MiniMax-M3) with evidence-backed vision, reasoning, effort ladders, 32k output, and context windows.
- Added 22 long-context aliases (`-400k` and `-1m`) for the 11 multi-window models; aliases route the base wire key via `requestModelId` and send a top-level `context_length` matching the alias window.
- Added a stream adapter behind a custom `qoder-completions` API that delegates to the stock openai-completions stream: repairs Qoder's folded SSE usage events (including folds split across network chunks) without touching other providers' streams.
- Added scoped `/fast` support: priority tier on `qoder/kmodel` merges `metadata.business.feature_switches.highspeed="true"` into the request body; OpenAI `service_tier` is never sent and no other model is affected.
- Hardened privacy posture: no per-request tracing ids (`X-Request-ID`/`X-Session-ID`), no `user`/`store`/telemetry fields. Qoder's account-side Privacy Mode remains controlled in Qoder account settings; the plugin does not fabricate a privacy request field (documented in the README).
- Fixed login polling to retry transient network failures while browser authorization is still pending instead of aborting the flow; HTTP error responses still fail fast.
- Bumped the required omp packages to `>=17.0.6`.

## 0.1.0 - 2026-07-21

- Added Qoder browser PKCE login and token refresh.
- Added the `qoder/auto` model router with Qoder request headers.
- Added native-provider collision handling for omp versions that bundle Qoder.
