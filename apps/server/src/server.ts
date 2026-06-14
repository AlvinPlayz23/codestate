import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatRequest } from "@codestate/shared";
import { createAgent } from "./agent/agent.js";
import { EventBus } from "./events.js";
import { JsonSessionStore } from "./sessions/store.js";
import { createTools } from "./tools/tools.js";

export type ServerOptions = {
  projectRoot: string;
  webDist?: string;
  dataDir?: string;
};

export function createApp(options: ServerOptions) {
  const app = new Hono();
  const events = new EventBus();
  const store = new JsonSessionStore(options.dataDir ?? path.join(process.cwd(), ".codestate"));
  const tools = createTools({ projectRoot: options.projectRoot });
  const model = process.env.CODESTATE_MODEL ?? "gpt-4.1";
  const agent = createAgent({ projectRoot: options.projectRoot, model, events, tools, store });

  void store.init();

  app.use("*", cors());

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/session", (c) => {
    return c.json({ projectRoot: options.projectRoot, model });
  });

  app.get("/api/sessions", async (c) => {
    const sessions = await store.list(options.projectRoot);
    return c.json(sessions);
  });

  app.get("/api/sessions/:sessionId", async (c) => {
    const session = await store.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    const { modelHistory: _mh, ...summary } = session;
    return c.json({ ...summary, timeline: session.timeline });
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json<{ title?: string }>().catch((): { title?: string } => ({}));
    const session = await store.create({
      id: crypto.randomUUID(),
      projectRoot: options.projectRoot,
      model,
      title: body.title
    });
    const { modelHistory: _mh, ...summary } = session;
    return c.json(summary);
  });

  app.delete("/api/sessions/:sessionId", async (c) => {
    const deleted = await store.delete(c.req.param("sessionId"));
    return c.json({ ok: deleted });
  });

  app.get("/api/events/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    return streamSSE(c, async (stream) => {
      const unsubscribe = events.subscribe(sessionId, async (event) => {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });

      await stream.writeSSE({ event: "connected", data: JSON.stringify({ sessionId }) });

      while (!stream.aborted) {
        await stream.sleep(1000);
      }

      unsubscribe();
    });
  });

  app.post("/api/chat", async (c) => {
    const body = await c.req.json<ChatRequest>();
    const sessionId = body.sessionId || crypto.randomUUID();
    void agent.run(sessionId, body.message);
    return c.json({ sessionId });
  });

  app.post("/api/stop", async (c) => {
    const body = await c.req.json<{ sessionId: string }>();
    agent.abort(body.sessionId);
    return c.json({ ok: true });
  });

  app.post("/api/approval/respond", async (c) => {
    const body = await c.req.json<{ approvalId: string; approved: boolean }>();
    const resolved = agent.resolveApproval(body.approvalId, body.approved);
    return c.json({ ok: resolved });
  });

  app.get("/api/files/tree", async (c) => {
    const path = c.req.query("path") ?? ".";
    return c.json(await tools.list({ path }));
  });

  app.get("/api/files/read", async (c) => {
    const path = c.req.query("path") ?? ".";
    return c.json(await tools.read({ path }));
  });

  app.get("/", async (c) => c.html(await renderShell(options.webDist)));
  app.get("/assets/*", async (c) => {
    if (!options.webDist) return c.notFound();
    const requested = c.req.path.replace(/^\/assets\//, "assets/");
    const filePath = path.join(options.webDist, requested);
    if (!existsSync(filePath)) return c.notFound();
    return new Response(await readFile(filePath), { headers: { "Content-Type": contentType(filePath) } });
  });
  app.get("*", async (c) => c.html(await renderShell(options.webDist)));

  return app;
}

async function renderShell(webDist?: string) {
  if (webDist) {
    const indexPath = path.join(webDist, "index.html");
    if (existsSync(indexPath)) return readFile(indexPath, "utf8");
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codestate</title>
    <script type="module" src="http://localhost:5173/src/main.tsx"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;
}

function contentType(filePath: string) {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}
