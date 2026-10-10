# Codestate — Comprehensive Codebase Report

## 1. What is Codestate?

**Codestate** is a *local AI coding agent* that lives in your terminal and browser. You run `codestate` inside any project directory, and it starts a local server that powers a ChatGPT-like web interface connected to that project. From the browser you can ask the agent to read files, search code, explain architecture, write new code, edit existing files, and run shell commands — all scoped to the directory you launched it from.

Key characteristics:
- Runs **locally** (server binds to `127.0.0.1`, default port 3717).
- The agent uses an **OpenAI-compatible cloud API** — your prompt and file contents are sent to the model; nothing else is.
- Six agent **tools**: `read`, `list`, `search`, `write`, `apply`, `run`.
- **Three dangerous tools** (`write`, `apply`, `run`) require **explicit user approval** through the browser UI before anything touches the filesystem or runs in the shell. `read`, `list`, `search` run automatically.
- It appears to be a fork/adaptation of the **OpenCode** project (a `.opencode` dir with traces is present, and `mock.html` references "Recode / Tools for the Terminal").

## 2. Architecture

```
packages/shared/    # Types only (shared between server and web)
packages/cli/       # CLI entry point — spawns server + opens browser
apps/server/        # Hono backend — agent loop, tools, model adapter, SSE
apps/web/           # React + Vite chat UI
```

### The CLI (`packages/cli/src/index.ts`)
- `Command`-based CLI with flags: `--port`, `--host`, `--project`, `--no-open`, `--model`, `--base-url`.
- Resolves the Codestate repo root (relative to itself, i.e. `../../..`).
- Loads **`.env.local` from the Codestate root only** (`dotenv`).
- Resolves project root: `--project` → `CODESTATE_PROJECT_ROOT` → `INIT_CWD` → `process.cwd()`.
- Finds an available port near 3717 (tries 50 ports).
- Spawns the server as a **child process**, forwarding env vars:
  - `CODESTATE_PROJECT_ROOT`, `CODESTATE_PORT`, `CODESTATE_HOST`, `CODESTATE_WEB_DIST`, `CODESTATE_DATA_DIR`, `CODESTATE_MODEL`, `CODESTATE_BASE_URL`
- Opens the browser automatically (unless `--no-open`).
- Handles SIGINT/SIGTERM by killing the child.
- Dev mode: if `apps/server/dist/index.js` isn't built, runs `tsx src/index.ts`; otherwise runs the built output.

### The Server (`apps/server/src/server.ts`)
- **Hono** app. Routes:
  - `GET /` / `GET /assets/*` / `GET /*` — serve the React app (from `apps/web/dist`) or a fallback dev shell that hot-reloads from `localhost:5173`.
  - `GET /api/health` — health check.
  - `GET /api/session` — current project root + model.
  - `GET /api/sessions` / `GET /api/sessions/:sessionId` / `POST /api/sessions` / `DELETE /api/sessions/:sessionId` — session CRUD.
  - `GET /api/events/:sessionId` — **SSE stream** (`streamSSE`) pushing `ServerEvent`s to the UI.
  - `POST /api/chat` — starts an agent turn (`agent.run`).
  - `POST /api/stop` — aborts the agent loop.
  - `POST /api/approval/respond` — records user approval/deny.
  - `GET /api/files/tree`, `search`, `read` — file browsing (also used by the @-mention autocomplete).
- Per-request middleware: waits for the session store to initialize.
- Global `cors()` for the dev proxy.

### The Agent (`apps/server/src/agent/`)
- **`agent.ts`** — owns per-session runtime state: `AbortController` map, pending approvals. Exposes `run(sessionId, userMessage, yolo, displayMessage)`, `abort()`, `resolveApproval()`.
- **`loop.ts`** — the turn loop (`runTurn`). For each turn: append user message → loop `model call → tool calls` until the model returns no tools, step cap hit (constant `MAX_TOOL_STEPS = 450`), signal aborted, or error. History is persisted after every checkpoint (user message, assistant reply, each tool result), which enables **resume-on-interrupt**: on the next turn `buildHistory` rebuilds from stored `modelHistory` and `backfillPendingToolResults` repairs dangling tool calls with a placeholder, so interrupted turns can be safely resumed.
- **`types.ts`** — `AgentOptions` (projectRoot, model, events, tools, store).
- **`approvals.ts`** — `ApprovalManager`: tracks pending approvals as promises; resolves to `false` on abort; emits `approval.requested` / `approval.resolved`.
- **`dispatch.ts`** — `executeTool`: gates mutating tools (set `APPROVAL_REQUIRED = {write, apply, run}`) behind the approval flow unless `yolo` is set; converts model `ToolCall`s into typed tool invocations; returns **failed `ToolResult` on error** (never throws) so the loop can keep going; builds approval previews (plain for write/run, a `git-style diff hunk` for `apply`).
- **`history.ts`** — `buildHistory`, `normalizeAssistantMessage` (normalizes assistant `content: null` → `""` because OpenAI-compatible providers reject tool-call turns with null content on the following request), `backfillPendingToolResults`.

### The Tools (`apps/server/src/tools/tools.ts`)
- **`read(path)`** — UTF-8 text file read.
- **`list(path)`** — directory listing, filtering ignored dirs (`.git`, `node_modules`, `dist`, `build`, `.next`, `.nuxt`, `.turbo`, `.cache`, `coverage`, `vendor`, `target`).
- **`search(query, path)`** — uses ripgrep (`rg`) if available (with hidden files, excluding .git), falls back to a plain Node walk.
- **`write(path, content)`** — create/replace a file.
- **`apply(path, find, replace)`** — exact single-occurrence search-and-replace; throws if not found or found multiple times.
- **`run(command)`** — `execa` with `shell: true`, cwd = project root.
- **`findFiles(query, limit=25)`** — for @-mention autocomplete.
- All file paths are validated via **`resolveInsideRoot`** (`security/path.ts`) to prevent directory-traversal outside the project root.

### The Model Adapter (`apps/server/src/model/openai.ts`)
- Plain `fetch` to an OpenAI-compatible `/chat/completions` endpoint.
- Config: `CODESTATE_API_KEY` (or `OPENAI_API_KEY` fallback) → header; `CODESTATE_BASE_URL` (default `https://api.openai.com/v1`); `CODESTATE_MODEL` (default `gpt-4.1`).
- Sends the system prompt + full message history with **6 function definitions** (`read/list/search/write/apply/run`) and `tool_choice: "auto"`.
- `completeWithTools` parses choices → content + typed `ToolCall[]`.
- System prompt instructs the agent to inspect before editing, prefer `apply` for targeted edits, never fake a `get_project_info` tool, and explain work concisely after tool use.

### Sessions & Events (`apps/server/src/sessions/store.ts`, `events.ts`)
- **`JsonSessionStore`** — stores all sessions in `<dataDir>/sessions.json`. Per-op methods (`create`, `get`, `list`, `updateTitle`, `appendTimeline`, `updateTimelineItem`, `saveModelHistory`, `delete`). Writes are **atomic** (write to `.tmp` + `rename`, with a `EPERM` fallback) guarded by a `writeLock` chain to avoid races. Data dir defaults to `.codestate` under the Codestate repo root.
- **`EventBus`** — simple per-session listener map; SSE clients subscribe and get events emitted for their session.

### The Web App (`apps/web/src/App.tsx`)
- A single large React component (Vite + React 19, Tailwind + `clsx`).
- **`EventSource("/api/events/:sessionId")`** listening to all server event types, keeping the UI in sync live (streaming assistant text, tool chips, approval cards).
- **@-mention file autocomplete**: typing `@path` triggers `/api/files/search`, arrow-key / Tab select.
- **Approval flow**: an `ApprovalCard` is injected into the timeline; `Approve`/`Reject` calls `/api/approval/respond`; `apply` requests show a rendered diff preview; resolved state is shown.
- **Session sidebar**: new conversation, session list, delete, palette search (`⌘K`).
- **Prompt box**: enter to send / Shift+Enter newline, Stop button when busy, model chip, "AY" toggle (**yolo mode** — bypasses approvals), draft persistence across turns.
- **Design system**: "Claymorphism" CSS in `styles.css` with 8 themes (recode, orchid, solar, glacier, forest, synth, obsidian, coral) + light/dark mode. The design was informed by the `mock.html` upstream "Recode" mock.

### Shared Types (`packages/shared/src/index.ts`)
- `Role`, `ToolName`, `ChatMessage`, `ToolCall`, `ToolResult`, `ApprovalRequest`, `TimelineItem`, `SessionSummary`, `StoredSession`, `ServerEvent` (union of 8 event types), `ChatRequest`, `ChatResponse`. The only thing in this package — everything is `.d.ts`-compiled.

## 3. Key Files and Responsibilities

| File | Responsibility |
|---|---|
| `packages/cli/src/index.ts` | CLI entry: argv, env loading, port finding, server spawn, browser open |
| `apps/server/src/server.ts` | Hono app, all routes, SSE streaming, asset serving |
| `apps/server/src/agent/agent.ts` | Per-session runtime state (abort controllers, approvals); run/abort/resolveApproval |
| `apps/server/src/agent/loop.ts` | Core agent turn loop; MAX_TOOL_STEPS=450; checkpointed history persistence; stop-on-interrupt with repair |
| `apps/server/src/agent/types.ts` | `AgentOptions` type |
| `apps/server/src/agent/approvals.ts` | ApprovalManager: pending-approval promise map |
| `apps/server/src/agent/dispatch.ts` | `executeTool`, approval gating, tool dispatch, approval preview + diff hunk builder |
| `apps/server/src/agent/history.ts` | `buildHistory`, `normalizeAssistantMessage`, `backfillPendingToolResults` |
| `apps/server/src/tools/tools.ts` | The six tools; ignored-directories list; `findFiles` |
| `apps/server/src/model/openai.ts` | `completeWithTools`; fetch to OpenAI-compatible API; system prompt + tool defs |
| `apps/server/src/events.ts` | `EventBus` |
| `apps/server/src/sessions/store.ts` | `JsonSessionStore` (atomic writes, per-session history & timeline) |
| `apps/server/src/security/path.ts` | `resolveInsideRoot` — path-traversal protection |
| `apps/server/src/index.ts` | Server binary: reads `CODESTATE_*` env vars, starts Hono on configured host/port |
| `packages/shared/src/index.ts` | All TS types used by server + web |
| `apps/web/src/App.tsx` | Entire chat UI: SSE client, approvals, @-mention autocomplete, sessions, settings |
| `apps/web/src/main.tsx` | React 19 `createRoot` entry |
| `apps/web/src/styles.css` | Claymorphism design system, themes, animations |
| `apps/web/vite.config.ts` | Dev server (5173) with `/api` proxy to the Hono server |
| `apps/web/package.json` | React + Vite + Tailwind deps |
| `apps/server/package.json` | Hono + execa deps |
| `packages/cli/package.json` | commander + dotenv + open deps |
| `packages/shared/package.json` | Types-only package |
| `root package.json` | pnpm workspace scripts (`install`, `build`, `check`, `codestate`, `dev`) |
| `AGENTS.md` / `README.md` | Docs: commands, architecture, env, project resolution, gotchas |
| `mock.html` | Upstream "Recode" design mock (UI inspiration) |

## 4. How to Run / Build

```bash
pnpm install        # install all workspace deps
pnpm build          # build shared → cli → server → web
pnpm check          # typecheck all packages (tsc --noEmit)
pnpm codestate      # "pnpm --dir packages/cli start" — spawns server + opens browser
pnpm dev            # dev mode via tsx (no build needed)
```

After `pnpm codestate`, the server loads built assets from `apps/web/dist` — so rebuild after web changes.

**Environment** (in `.env.local` at the Codestate repo root):
```env
CODESTATE_API_KEY=your-key
CODESTATE_MODEL=gpt-4.1
CODESTATE_BASE_URL=https://api.openai.com/v1
```
Shell env vars and CLI flags (`--model`, `--base-url`) take precedence. The repo's own `.env.local` is configured for a custom provider (`mimo-v2.5-free` at `opencode.ai/zen/v1`).

**Project root resolution order**: `--project` → `CODESTATE_PROJECT_ROOT` → `INIT_CWD` → `process.cwd()`.

**Running on a different project from outside the repo**:
```bash
pnpm --dir C:/Users/bijim/codestate codestate --project $PWD
```

## 5. Notable Features & Design Decisions

1. **Approval gating as a first-class primitive** — `write`/`apply`/`run` never run without a UI decision (unless `yolo`). The approval request carries a preview, and `apply` renders a real git-style diff hunk before approval.

2. **Resumable turns / interrupt recovery** — the full `modelHistory` (not just the UI timeline) is persisted after every checkpoint. `backfillPendingToolResults` fills in placeholders for tool calls that were outstanding when a turn was interrupted, so a resumed turn is always a valid request.

3. **Hard stop cap** — `MAX_TOOL_STEPS = 450` per prompt prevents runaway loops (emits a `session.error` event when hit).

4. **Provider-compatibility hygiene** — `normalizeAssistantMessage` coerces assistant `content: null` → `""` so OpenAI-compatible providers don't reject the following call. Error responses from tools are returned as failed `ToolResult` objects instead of thrown, letting the loop stay in context.

5. **Security** — `resolveInsideRoot` resolves every requested path and rejects anything escaping the project root; the agent runs with `cwd = projectRoot`, so `run` cannot escape the sandbox by default.

6. **SSE over WebSockets** — a lightweight `EventBus` + Hono `streamSSE` gives real-time streaming of `message.delta`, `tool.started/output`, `approval.requested/resolved`, `session.error`.

7. **Atomic session storage** — JSON store uses write-to-tmp + rename plus a `writeLock` promise chain, so sessions survive crashes without corruption.

8. **Scoped search** — tools ignore heavy/irrelevant directories by default; search has an 500 KB per-file size limit and graceful binary-file skipping.

9. **Developer ergonomics** — dev shell (fallback HTML) hot-reloads the app from Vite's dev server; the CLI picks a free port; `--no-open`, per-run `--model`/`--base-url` overrides.

10. **UI polish** — 8 CSS variable-driven themes + light/dark mode; @file mention autocomplete with keyboard navigation; a `⌘K` session palette; status chips (READY / ACTIVE / AWAITING); an "AY" one-switch to toggle yolo; smooth scrolling to the latest message.

11. **Monorepo design** — `packages/shared` compiled to `.d.ts` + `.js` and consumed by both server and web; everything builds with plain TypeScript (no esbuild/swc in the pipeline).
