# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A pi package — an extension for the pi coding agent (`@earendil-works/pi-coding-agent`) — that adds text-to-image: a `generate_image` tool the model can call, and an `/image` command for manual use. The backend is any OpenAI-compatible images API. README.md documents the config fields and the credential sources.

## Commands

```bash
npm test                              # all three suites
node test/client.test.mjs             # one suite; every test file is a standalone script
PI_PACKAGE_DIR=/path/to/pi npm test   # when `which pi` cannot find the pi install

# Load the real package in pi without spending a model call:
pi -e . -p "/image config" --no-session --no-tools --mode json
```

There is no build step and no installed dependencies: pi loads `.ts` through jiti, and `test/pi-runtime.mjs` borrows pi's own jiti plus a gitignored `node_modules` symlink pointing into pi's install — that symlink is also what lets editors resolve `typebox` and `@earendil-works/*`.

`pi -e .` occasionally hangs for a minute on a version check against an unreachable npm registry; rerunning it works.

## Architecture

`generateImages()` in `src/images.ts` dispatches to three backends: the `openai` provider (HTTP to an OpenAI-compatible images API), and the `codex` provider in either `src/codex-api.ts` (mode `api`, the default — a Responses call to the Codex backend carrying an `image_generation` tool, authenticated with the tokens `codex login` stored) or `src/codex-backend.ts` (mode `cli` — runs `codex exec` and picks up what Codex wrote under `$CODEX_HOME/generated_images`). The codex provider exists because Codex's preferred image path is a **server-side built-in image tool** that needs no API key and bills the ChatGPT plan; its ChatGPT OAuth token cannot call the public images API at all (403, missing scopes).

Both codex modes were verified against the real service: `api` ≈ 40s per image, `cli` ≈ 70s.

`extensions/text2image.ts` is the only file pi loads (the `pi.extensions` glob in package.json). It exports the default `(pi: ExtensionAPI) => void` factory and holds everything pi-specific: the tool, the command, and the two entry renderers. `src/config.ts` and `src/images.ts` import nothing from pi, which is what lets the tests exercise them directly.

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
- **Proxies are ours to handle.** Node's `fetch` cannot be pointed at one without undici's ProxyAgent, and the proxy is configured in `$CODEX_HOME/.env`, which pi's process never reads. `src/proxy-env.ts` resolves it and `src/http.ts` does CONNECT tunnelling; that is why nothing in this package calls `fetch`.
- **The codex cli mode identifies its output by mtime**, not by parsing the agent's prose: files under `$CODEX_HOME/generated_images` newer than the run's start, newest `n` wins, with reported paths as a fallback. Do not ask the agent to copy or rename files — it has no dependable tooling for that, and the mtime scan is what makes the backend deterministic.
- The kitty image protocol only accepts PNG; `canPreview()` mirrors pi's own check so previews degrade to plain paths elsewhere.

## Conventions

- English everywhere: comments, docs, user-facing strings, test output.
- Text the model reads (`description`, `promptSnippet`, `promptGuidelines`, tool result text) is prompt engineering rather than UI copy. `promptGuidelines` bullets are appended flat to the system prompt with no tool-name prefix, so each bullet names `generate_image` explicitly.
- Tests use no framework: plain `node:assert` scripts driving a fake HTTP images service (`startFakeImagesApi`) and a fake `ExtensionAPI`. New behaviour gets a case in the matching file.

## pi API reference

The installed pi ships its own documentation; `extensions.md` is the authoritative reference for events, tool definitions, renderers and packaging:

```bash
ls "$(dirname "$(realpath "$(which pi)")")/../../docs"
```
