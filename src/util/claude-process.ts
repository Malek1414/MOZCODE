import { execFile } from "node:child_process";

/**
 * Find the Claude Code process a MOZCODE process runs under.
 *
 * The MCP server and the statusline are both children (or grandchildren, via a
 * shell) of the same Claude Code process, so its pid identifies "this window"
 * on both sides. Claude's own session id can't be used for that: it changes on
 * /clear, while the MCP server keeps running with the id it was started under.
 */

export interface ProcessInfo {
  ppid: number;
  command: string;
}

export type PsLookup = (pid: number) => Promise<ProcessInfo | undefined>;

/** `claude ...`, `/path/to/claude`, `claude.exe`, or `node .../@anthropic-ai/claude-code/...`. */
const CLAUDE_COMMAND = /(^|\/)claude(\.exe)?(\s|$)|@anthropic-ai\/claude-code\//;

/** Parent pid and command line of one process, via `ps`. Undefined on Windows or failure. */
export const psLookup: PsLookup = (pid) =>
  new Promise((resolve) => {
    if (process.platform === "win32") return resolve(undefined);
    execFile("ps", ["-o", "ppid=,command=", "-p", String(pid)], { timeout: 500 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = /^\s*(\d+)\s+(.*)$/.exec(stdout.split("\n")[0] ?? "");
      resolve(m ? { ppid: Number(m[1]), command: m[2] } : undefined);
    });
  });

/** Walk up from `start` to the nearest Claude Code process, or undefined if none is found. */
export async function claudeAncestor(start: number, lookup: PsLookup = psLookup, maxDepth = 6): Promise<number | undefined> {
  let pid = start;
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    const info = await lookup(pid);
    if (!info) return undefined;
    if (CLAUDE_COMMAND.test(info.command)) return pid;
    pid = info.ppid;
  }
  return undefined;
}
