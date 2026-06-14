import { serve } from "@hono/node-server";
import { createApp } from "./server.js";

const projectRoot = process.env.CODESTATE_PROJECT_ROOT ?? process.cwd();
const webDist = process.env.CODESTATE_WEB_DIST;
const dataDir = process.env.CODESTATE_DATA_DIR;
const port = Number(process.env.PORT ?? process.env.CODESTATE_PORT ?? 3717);
const host = process.env.CODESTATE_HOST ?? "127.0.0.1";

serve({ fetch: createApp({ projectRoot, webDist, dataDir }).fetch, port, hostname: host }, (info) => {
  console.log(`Codestate server listening on http://${info.address}:${info.port}`);
});
