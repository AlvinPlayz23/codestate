# Codestate

Codestate is a local AI coding-agent tool that lives in your terminal and browser. You run `codestate` inside any project directory, and it starts a local server that powers a ChatGPT-like web interface connected to your project. From the browser you can ask the agent to read files, search code, explain architecture, write new code, edit existing files, and run shell commands — all scoped to the directory you launched it from. The agent uses a cloud AI model (OpenAI-compatible API) and has six tools: `read`, `list`, `search`, `write`, `apply`, and `run`. Dangerous tools (`write`, `apply`, `run`) require explicit user approval through the UI before anything touches your filesystem or runs in your shell. Nothing is sent to a remote service except the prompts and file contents the model needs to reason about your code.

## Commands

```bash
pnpm install        # install all deps
pnpm build          # build all packages (shared, cli, server, web)
pnpm check          # typecheck all packages
pnpm codestate      # start codestate in current directory
pnpm dev            # start CLI via tsx (dev mode, no build needed)
```

After `pnpm codestate`, the server loads built assets from `apps/web/dist`. Always `pnpm build` before running if you changed web code.

## Workspace structure

```txt
packages/shared/    # types shared between server and web (ServerEvent, ToolCall, etc.)
packages/cli/       # codestate CLI entry point — spawns server + opens browser
apps/server/        # Hono backend — agent loop, tools, model adapter, SSE
apps/web/           # React + Vite chat UI
```

`packages/shared` is referenced by both `apps/server` and `apps/web`. If you change shared types, rebuild or both packages will lag.

## Key architecture

- **CLI** (`packages/cli/src/index.ts`) resolves project root, loads `.env.local` from Codestate root (not the target project), finds a port, spawns the server, opens browser.
- **Server** (`apps/server/src/server.ts`) serves the web app and exposes SSE at `/api/events/:sessionId`. The agent loop runs in `agent.ts`, tools in `tools/tools.ts`, model calls in `model/openai.ts`.
- **Agent tools**: `read`, `list`, `search` run automatically. `write`, `apply`, `run` require user approval via the browser UI before execution.
- **Model**: OpenAI-compatible API. Config via env: `CODESTATE_API_KEY`, `CODESTATE_MODEL`, `CODESTATE_BASE_URL`.
- The server binds to `127.0.0.1` by default (local only).

## Env loading

`.env.local` is loaded from the Codestate repo root only, not the target project. Shell env vars and CLI flags (`--model`, `--base-url`) take precedence.

## Project root resolution order

1. `--project <path>`
2. `CODESTATE_PROJECT_ROOT` env
3. `INIT_CWD` (set by pnpm/npm)
4. `process.cwd()`

## Gotchas

- `pnpm codestate` runs `pnpm --dir packages/cli start`. The CLI's `process.cwd()` is `packages/cli`, so `.env.local` and `--project` matter.
- The agent loop caps at 450 tool steps per prompt to prevent runaway loops.
- `pnpm --dir <codestate-root> codestate --project <other-dir>` is how you run Codestate on a different project from outside the repo.
- After approval, assistant messages with `tool_calls` must have `content` normalized to `""` (not `null`) or OpenAI-compatible providers may reject the next call.
