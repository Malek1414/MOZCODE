import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const statuslinePath = join(here, "..", "dist", "statusline.js");

interface Run {
  stdout: string;
  /** ms from spawn until the first byte of output arrived. */
  firstByteMs: number;
  /** ms from spawn until the process actually exited. */
  exitMs: number;
}

/**
 * Run the statusline exactly the way Claude Code does: spawn it, write the
 * update JSON on stdin, close stdin, and read stdout until the process exits.
 */
function runStatusline(home: string, cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let stdout = "";
    let firstByteMs = -1;
    const child = spawn("node", ["--no-warnings", statuslinePath], {
      env: { ...process.env, MOZCODE_HOME: home },
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      if (firstByteMs < 0) firstByteMs = Date.now() - t0;
      stdout += c;
    });
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, firstByteMs, exitMs: Date.now() - t0 }));
    child.stdin.end(JSON.stringify({ session_id: "test", cwd, workspace: { current_dir: cwd } }));
  });
}

/** Strip ANSI colour so assertions read against plain text. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function appendEntry(home: string, project: string, session: string, saved: number) {
  const dir = join(home, "metering");
  await fs.mkdir(dir, { recursive: true });
  // Mirror store.ts's projectFile() naming so loadEntries() picks it up.
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha1").update(project).digest("hex").slice(0, 12);
  const base = project.split("/").pop()!.replace(/[^a-zA-Z0-9_-]/g, "_");
  const entry = {
    ts: new Date().toISOString(),
    session,
    project,
    tool: "code_outline",
    path: "a.ts",
    baselineTokens: saved * 2,
    actualTokens: saved,
    savedTokens: saved,
  };
  await fs.appendFile(join(dir, `${base}-${hash}.jsonl`), JSON.stringify(entry) + "\n", "utf8");
}

async function writeSessionPointer(home: string, project: string, session: string) {
  const dir = join(home, "sessions");
  await fs.mkdir(dir, { recursive: true });
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha1").update(project).digest("hex").slice(0, 12);
  await fs.writeFile(join(dir, `${hash}.session`), session, "utf8");
}

describe("statusline", () => {
  let home: string;
  const project = "/proj/statusline-test";
  const session = "sess-current";

  beforeEach(async () => {
    home = await fs.mkdtemp(join(tmpdir(), "mozcode-home-"));
    await writeSessionPointer(home, project, session);
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("exits promptly once its output is written", async () => {
    await appendEntry(home, project, session, 1000);
    const run = await runStatusline(home, project);

    expect(run.stdout).not.toBe("");
    // Regression guard: the stdin safety timer used to keep the event loop alive
    // for a further 500ms after the line was already on stdout, so Claude Code —
    // which reads the statusline until the process exits — rendered a stale line.
    // The process must not linger meaningfully past its own output.
    expect(run.exitMs - run.firstByteMs).toBeLessThan(150);
    expect(run.exitMs).toBeLessThan(400);
  });

  it("reflects entries appended after a previous run (no stale cache)", async () => {
    await appendEntry(home, project, session, 1000);
    const first = plain((await runStatusline(home, project)).stdout);
    expect(first).toContain("1.0k tokens");

    await appendEntry(home, project, session, 4000);
    const second = plain((await runStatusline(home, project)).stdout);
    expect(second).toContain("5.0k tokens");
  });

  it("scopes the session segment to the active session for the project", async () => {
    await appendEntry(home, project, "sess-old", 9000);
    await appendEntry(home, project, session, 2000);
    const out = plain((await runStatusline(home, project)).stdout);

    const [sessionPart, allTimePart] = out.split("│");
    expect(sessionPart).toContain("2.0k tokens");
    expect(allTimePart).toContain("11k tokens");
  });
});
