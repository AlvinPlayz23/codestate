import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { resolveInsideRoot } from "../security/path.js";

export type ToolContext = {
  projectRoot: string;
};

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  "target"
]);

export function createTools(context: ToolContext) {
  return {
    read: async ({ path: requestedPath }: { path: string }) => {
      const file = resolveInsideRoot(context.projectRoot, requestedPath);
      const content = await readFile(file.absolute, "utf8");
      return { path: file.relative, content };
    },

    list: async ({ path: requestedPath = "." }: { path?: string }) => {
      const dir = resolveInsideRoot(context.projectRoot, requestedPath);
      const entries = await readdir(dir.absolute, { withFileTypes: true });
      return {
        path: dir.relative,
        entries: entries
          .filter((entry) => !ignoredDirectories.has(entry.name))
          .map((entry) => ({
            name: entry.name,
            path: path.posix.join(dir.relative === "." ? "" : dir.relative.replaceAll("\\", "/"), entry.name),
            type: entry.isDirectory() ? "directory" : "file"
          }))
          .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
      };
    },

    findFiles: async ({ query = "", limit = 25 }: { query?: string; limit?: number }) => {
      const normalized = query.trim().toLowerCase().replaceAll("\\", "/");
      const matches: Array<{ path: string; name: string }> = [];
      await collectFiles(context.projectRoot, context.projectRoot, normalized, Math.min(Math.max(limit, 1), 50), matches);
      return { query, files: matches };
    },

    search: async ({ query, path: requestedPath = "." }: { query: string; path?: string }) => {
      const dir = resolveInsideRoot(context.projectRoot, requestedPath);
      try {
        const result = await execa("rg", ["--line-number", "--hidden", "--glob", "!.git", query, dir.absolute], {
          cwd: context.projectRoot,
          reject: false
        });
        return { query, output: result.stdout || result.stderr || "No matches." };
      } catch {
        const matches = await searchDirectory(dir.absolute, query, context.projectRoot);
        return { query, output: matches.length ? matches.join("\n") : "No matches." };
      }
    },

    write: async ({ path: requestedPath, content }: { path: string; content: string }) => {
      const file = resolveInsideRoot(context.projectRoot, requestedPath);
      await writeFile(file.absolute, content, "utf8");
      return { path: file.relative, output: `Wrote ${file.relative}` };
    },

    apply: async ({ path: requestedPath, find, replace }: { path: string; find: string; replace: string }) => {
      const file = resolveInsideRoot(context.projectRoot, requestedPath);
      const content = await readFile(file.absolute, "utf8");
      if (!content.includes(find)) throw new Error(`Could not find target text in ${file.relative}`);
      const next = content.replace(find, replace);
      await writeFile(file.absolute, next, "utf8");
      return { path: file.relative, output: `Applied edit to ${file.relative}` };
    },

    run: async ({ command }: { command: string }) => {
      const result = await execa(command, { cwd: context.projectRoot, shell: true, reject: false, all: true });
      return { exitCode: result.exitCode, output: result.all ?? "" };
    }
  };
}

async function collectFiles(
  directory: string,
  root: string,
  query: string,
  limit: number,
  matches: Array<{ path: string; name: string }>
): Promise<void> {
  if (matches.length >= limit) return;
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (matches.length >= limit) return;
    if (ignoredDirectories.has(entry.name)) continue;

    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolute, root, query, limit, matches);
      continue;
    }

    if (!entry.isFile()) continue;
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (query && !relative.toLowerCase().includes(query)) continue;
    matches.push({ path: relative, name: entry.name });
  }
}

async function searchDirectory(directory: string, query: string, root: string): Promise<string[]> {
  const matches: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await searchDirectory(absolute, query, root)));
      continue;
    }

    const info = await stat(absolute);
    if (info.size > 500_000) continue;

    try {
      const content = await readFile(absolute, "utf8");
      content.split(/\r?\n/).forEach((line, index) => {
        if (line.includes(query)) matches.push(`${path.relative(root, absolute)}:${index + 1}: ${line}`);
      });
    } catch {
      // Binary or unreadable files are skipped.
    }
  }

  return matches;
}

export type CodestateTools = ReturnType<typeof createTools>;
