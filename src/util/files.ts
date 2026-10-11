import { promises as fs } from "node:fs";
import * as path from "node:path";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".venv", "__pycache__", ".mozcode",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi",
]);

export interface SourceFileList {
  files: string[];
  /** True when the walk stopped at the limit and more matching files exist. */
  truncated: boolean;
}

/**
 * Recursively list candidate source files under root, skipping vendored/output
 * dirs. `include` filters files before they count toward `limit`, so a narrow
 * path_glob in a large repo is not cut off by unrelated files walked first.
 */
export async function listSourceFiles(
  root: string,
  opts: { limit?: number; include?: (file: string) => boolean } = {},
): Promise<SourceFileList> {
  const limit = opts.limit ?? 5000;
  const out: string[] = [];
  let truncated = false;
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // readdir order is filesystem-dependent; sort so the limit cuts the same files everywhere.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) {
        if (opts.include && !opts.include(full)) continue;
        if (out.length >= limit) {
          truncated = true;
          return;
        }
        out.push(full);
      }
    }
  }
  await walk(root);
  return { files: out, truncated };
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
