import { promises as fs } from "node:fs";
import * as path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".venv", "__pycache__", ".mozcode",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi",
]);

/** Recursively list candidate source files under root, skipping vendored/output dirs. */
export async function listSourceFiles(root: string, limit = 5000): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= limit) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

/** Translate a glob ("*", "**", "?") into an anchored regex over "/"-separated paths. */
function globToRegex(glob: string): RegExp {
  let rx = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more whole directories; a bare "**" matches anything.
        if (glob[i + 2] === "/") {
          rx += "(?:.*/)?";
          i += 2;
        } else {
          rx += ".*";
          i += 1;
        }
      } else {
        rx += "[^/]*";
      }
    } else if (c === "?") {
      rx += "[^/]";
    } else {
      rx += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + rx + "$");
}

/**
 * Glob matcher for project-relative paths: supports "*", "**" and "?".
 * A glob without a "/" (e.g. "*.ts") matches against the file's basename, so it
 * applies at any depth; a wildcard-free glob also matches everything under that
 * directory (e.g. "src/tools"). Pass paths relative to the project root.
 */
export function matchesGlob(filePath: string, glob: string): boolean {
  const normalized = filePath.split(path.sep).join("/").replace(/^\.\//, "");
  const pattern = glob.split(path.sep).join("/").replace(/^\.\//, "");
  if (!/[*?]/.test(pattern)) {
    const dir = pattern.replace(/\/+$/, "");
    if (normalized.startsWith(dir + "/")) return true;
  }
  const rx = globToRegex(pattern);
  if (!pattern.includes("/")) return rx.test(path.posix.basename(normalized));
  return rx.test(normalized);
}
