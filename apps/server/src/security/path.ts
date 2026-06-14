import path from "node:path";

export function resolveInsideRoot(projectRoot: string, requestedPath: string) {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, requestedPath || ".");
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project root: ${requestedPath}`);
  }

  return { root, absolute: resolved, relative: relative || "." };
}
