# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A pi package — an extension for the pi coding agent (`@earendil-works/pi-coding-agent`) — that adds text-to-image and text-to-video: `generate_image` / `generate_video` tools the model can call, and `/image` / `/video` commands for manual use. Images come from any OpenAI-compatible images API (or an existing Codex login); clips from any OpenAI-compatible videos API. README.md documents the config fields and the credential sources.

## Commands

```bash
npm test                              # all test suites
node test/client.test.mjs             # one suite; every test file is a standalone script
PI_PACKAGE_DIR=/path/to/pi npm test   # when `which pi` cannot find the pi install

# Load the real package in pi without spending a model call:
pi -e . -p "/image config" --no-session --no-tools --mode json
```

There is no build step and no installed dependencies: pi loads `.ts` through jiti, and `test/pi-runtime.mjs` borrows pi's own jiti plus a gitignored `node_modules` symlink pointing into pi's install — that symlink is also what lets editors resolve `typebox` and `@earendil-works/*`.

`pi -e .` occasionally hangs for a minute on a version check against an unreachable npm registry; rerunning it works.

## Architecture

Provider implementations live in `src/image/provider/` and `src/video/provider/`. The public generation and saving entry points remain `src/images.ts` and `src/videos.ts`; media format helpers and result types live beside each provider directory.

`generateImages()` in `src/images.ts` dispatches to three backends: the `openai` provider (HTTP to an OpenAI-compatible images API), and the `codex` provider in either `src/image/provider/codex-api.ts` (mode `api`, the default — a Responses call to the Codex backend carrying an `image_generation` tool, authenticated with the tokens `codex login` stored) or `src/image/provider/codex-cli.ts` (mode `cli` — runs `codex exec` and picks up what Codex wrote under `$CODEX_HOME/generated_images`). The codex provider exists because Codex's preferred image path is a **server-side built-in image tool** that needs no API key and bills the ChatGPT plan; its ChatGPT OAuth token cannot call the public images API at all (403, missing scopes).

Both codex modes were verified against the real service: `api` ≈ 40s per image, `cli` ≈ 70s.

`generateVideos()` also dispatches `provider: "minimax"` to `src/video/provider/minimax.ts`: H3 uses `/v2/video_generation`, a `content` array, integer `duration`, named resolution tiers and `/v2/query/video_generation/{task_id}`. Its `MINIMAX_API_KEY` credentials never fall back to OpenAI/Codex and are never forwarded to the signed download URL. `test/minimax-video.test.mjs` covers the full job and failure paths.

`generateVideos()` in `src/videos.ts` is the other half: an OpenAI-compatible videos API is asynchronous, so it submits `POST {baseUrl}/videos`, polls `GET {baseUrl}/videos/{id}` (or whatever `status_url` the reply named) until the status is terminal, then downloads `GET {baseUrl}/videos/{id}/content` — or the `url`/`b64_json` the payload carries, which covers gateways that answer synchronously. Video has no codex path: Codex's built-in tool only draws images. Its config is entirely separate — `text2video.json` and `PI_TEXT2VIDEO_*`, loaded by `loadVideoConfig()` — so one service can serve images and another clips; only the credential fallback (`resolveApiKey`) is shared, parameterized with the API and config names it should mention in hints.

`extensions/text2image.ts` and `extensions/text2video.ts` are the files pi loads (the `pi.extensions` glob `extensions/*.ts` in package.json; `extensions/lib/ui.ts` sits in a subdirectory, so it is shared code rather than a second factory). Each exports the default `(pi: ExtensionAPI) => void` and holds everything pi-specific for its medium: the tool, the command and the entry renderers; the shared config-card renderer and error formatting live in `extensions/lib/ui.ts`. `src/config.ts`, `src/images.ts`, `src/videos.ts` and `src/files.ts` import nothing from pi, which is what lets the tests exercise them directly.

Invariants that are easy to break:

- **The two entry points are deliberately asymmetric.** `generate_image` results enter the LLM context; `/image` results go through `pi.appendEntry` and never reach the model. That is the whole point of `/image` — not spending context on a picture.
- **Files first, context second.** Images are always written to disk. base64 is inlined into the tool result only when `ctx.model.input` includes `"image"`, capped by `MAX_INLINE_IMAGES` / `MAX_INLINE_BYTES`. `details.inlined` records that decision and `renderResult` draws previews only when it is false: pi's built-in tool renderer already draws image blocks present in `content`, so drawing them again renders each image twice.
- **Tool failure is signalled by throwing.** Returning an `isError` field does nothing in pi.
- **`response_format` is not sent unless configured** — gpt-image-1 returns 400 when it sees the field. Response parsing accepts `data[]`, `images[]` and `output.results`, with base64 or url items; new vendor shapes belong in `collectItems`/`pickBase64`/`pickUrl`, not at the call sites.
- **An empty string in config means "do not send this field"** (today only `size`), while `undefined` means "use the default". `pickRaw()` exists to keep those distinguishable.
- **Credential precedence**: this extension's config/env → `OPENAI_API_KEY` → an existing codex login at `$CODEX_HOME/auth.json`. Only codex's API-key login mode yields a usable key; a ChatGPT OAuth login is scoped to the Codex backend, so it is reported through `codexHint`, which `describeConfig()` prints and `assertOk()` attaches to 401/403 responses.
- **`codexMode: "api"` speaks a private protocol.** No compatibility promise, and the request carries the Codex CLI's own `originator`. `cli` mode is the fallback when it breaks. Tokens are read from `auth.json` at call time, sent only to the Codex backend, never written or logged; a refreshed token lives in memory for the session.
- **`codexApiModel` must be a model the account may use with Codex.** A ChatGPT plan accepts `gpt-6-astra` and rejects every `gpt-5.x` name with "model is not supported when using Codex with a ChatGPT account". `/image config import codex` (`src/codex-import.ts`) finds one by probing.
- **Only a 400 that says the model is unsupported rules a model out.** The backend answers 400 for unrelated reasons too — sending `max_output_tokens` is one — and treating those as "unsupported model" is what once made the import rule out a model that in fact works. Anything else is inconclusive: keep the model, warn, stop probing.
- **The same image arrives twice in the SSE stream** — once as `response.output_item.done`, once inside `response.completed` — so `requestOneImage` dedupes by item id (or payload) before counting.
- **Proxies are ours to handle.** Node's `fetch` cannot be pointed at one without undici's ProxyAgent, and the Codex CLI's proxy is configured in `$CODEX_HOME/.env`, which pi's process never reads. `src/proxy-env.ts` resolves it and `src/http.ts` does CONNECT tunnelling; that is why nothing in this package calls `fetch`. That file is Codex's, so **only the codex provider reads it** (`resolveProxySettings()` default); every other provider goes through `mediaProxySettings()`, which takes the extension's own `httpProxy`/`httpsProxy`/`noProxy` fields and the process environment, and otherwise connects directly — inheriting the Codex proxy is what once sent a domestic video endpoint through a tunnel it had no business using.
- **The codex cli mode identifies its output by mtime**, not by parsing the agent's prose: files under `$CODEX_HOME/generated_images` newer than the run's start, newest `n` wins, with reported paths as a fallback. Do not ask the agent to copy or rename files — it has no dependable tooling for that, and the mtime scan is what makes the backend deterministic.
- The kitty image protocol only accepts PNG; `canPreview()` mirrors pi's own check so previews degrade to plain paths elsewhere.
- **Video is a job, not a request.** Statuses are matched by vocabulary (`RUNNING`/`DONE`/`FAILED`), an unrecognised one is polled anyway rather than rejected, and only `pollTimeoutMs` gives up. `mediaItems`/`pickUrl`/`pickBase64` hold the vendor-shape leniency, exactly as their image counterparts do — new shapes belong there, not at the call sites.
- **A clip is never inlined.** pi has no video content block and a clip dwarfs the context, so `generate_video` returns a path and nothing else; `saveVideos()` writes `.pi/videos/` with the container sniffed from the bytes.
- **The video config is its own file and prefix** (`text2video.json`, `PI_TEXT2VIDEO_*`) and must not read the image config: the two APIs usually need different keys and endpoints. `/video config set` writes it, but only for keys in `VIDEO_CONFIG_FIELDS`, coerced by `coerceVideoConfigValue` — an empty string keeps meaning "do not send this field", headers/extraBody must be JSON objects.
- `src/files.ts` holds `slugify`/`timestamp`/`uniquePath`/`formatBytes` for both writers; `src/images.ts` re-exports `formatBytes` so its existing importers keep working.

## Conventions

- English everywhere: comments, docs, user-facing strings, test output.
- Text the model reads (`description`, `promptSnippet`, `promptGuidelines`, tool result text) is prompt engineering rather than UI copy. `promptGuidelines` bullets are appended flat to the system prompt with no tool-name prefix, so each bullet names `generate_image` explicitly.
- Tests use no framework: plain `node:assert` scripts driving a fake HTTP images service (`startFakeImagesApi`) and a fake ExtensionAPI. Video uses `startFakeVideosApi`, which runs a real submit → poll → content job. New behaviour gets a case in the matching file — `test/client.test.mjs` for image config/client, `test/video.test.mjs` for video config/client, `test/image-extension.test.mjs` / `test/video-extension.test.mjs` for the pi-facing side. `npm test` is `node --test test/*.test.mjs`, so a new suite is picked up by its name.

## pi API reference

The installed pi ships its own documentation; `extensions.md` is the authoritative reference for events, tool definitions, renderers and packaging:

```bash
ls "$(dirname "$(realpath "$(which pi)")")/../../docs"
```
