#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import open from "open";

const program = new Command();

program
  .name("codestate")
  .description("Start the Codestate local AI coding-agent web app in the current project.")
  .option("-p, --port <port>", "Port to bind", "3717")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--project <path>", "Project directory for Codestate to operate on")
  .option("--no-open", "Do not open the browser")
  .option("--model <model>", "Cloud model name")
  .option("--base-url <url>", "OpenAI-compatible base URL")
  .parse(process.argv);

const options = program.opts<{
  port: string;
  host: string;
  project?: string;
  open: boolean;
  model?: string;
  baseUrl?: string;
}>();

const codestateRoot = resolveCodestateRoot();
const dataDir = path.join(codestateRoot, ".codestate");
loadDotenv({ path: path.join(codestateRoot, ".env.local"), override: false });
const projectRoot = resolveProjectRoot(options.project);
const port = await findAvailablePort(Number(options.port));
const url = `http://${options.host}:${port}`;
const serverCommand = resolveServerCommand();
const webDist = resolveWebDist();

const child = spawn(process.execPath, serverCommand, {
  stdio: "inherit",
  env: {
    ...process.env,
    CODESTATE_PROJECT_ROOT: projectRoot,
    CODESTATE_PORT: String(port),
    CODESTATE_HOST: options.host,
    CODESTATE_WEB_DIST: webDist,
    CODESTATE_DATA_DIR: dataDir,
    CODESTATE_MODEL: options.model ?? process.env.CODESTATE_MODEL,
    CODESTATE_BASE_URL: options.baseUrl ?? process.env.CODESTATE_BASE_URL
  }
});

console.log(`Codestate project: ${projectRoot}`);
console.log(`Codestate URL: ${url}`);

if (options.open) {
  setTimeout(() => void open(url), 700);
}

process.on("SIGINT", () => {
  child.kill("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
  process.exit(0);
});

child.on("exit", (code) => process.exit(code ?? 0));

function resolveServerCommand() {
  const devEntry = path.join(codestateRoot, "apps/server/src/index.ts");
  const builtEntry = path.join(codestateRoot, "apps/server/dist/index.js");
  if (existsSync(builtEntry)) return [builtEntry];

  const require = createRequire(import.meta.url);
  return ["--import", require.resolve("tsx"), devEntry];
}

function resolveWebDist() {
  return path.join(codestateRoot, "apps/web/dist");
}

function resolveCodestateRoot() {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../../..");
}

function resolveProjectRoot(project?: string) {
  return path.resolve(project || process.env.CODESTATE_PROJECT_ROOT || process.env.INIT_CWD || process.cwd());
}

async function findAvailablePort(preferredPort: number) {
  for (let port = preferredPort; port < preferredPort + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No available port found near ${preferredPort}`);
}

function canListen(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}
