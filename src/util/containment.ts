import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Resolve symlinks where the path exists; otherwise fall back to a lexical resolve. */
async function realOrResolved(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * True when `target` is `root` or lies inside it, after resolving `..` segments
 * and symlinks, so neither `../../x` nor a symlink pointing out of the project
 * counts as inside.
 */
export async function isInsideRoot(root: string, target: string): Promise<boolean> {
  const realRoot = await realOrResolved(root);
  const realTarget = await realOrResolved(target);
  const rel = path.relative(realRoot, realTarget);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false; // different drive on Windows
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}
