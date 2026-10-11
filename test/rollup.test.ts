import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRollup, localDay, rollupPath } from "../src/metering/rollup.js";

let home: string;
let ledger: string;

const line = (session: string, saved: number, ts = "2026-10-01T00:00:00.000Z", tool = "code_read") =>
  JSON.stringify({ ts, session, project: "/p", tool, baselineTokens: saved * 2, actualTokens: saved, savedTokens: saved }) + "\n";

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "mozcode-rollup-"));
  process.env.MOZCODE_HOME = home;
  await fs.mkdir(join(home, "metering"));
  ledger = join(home, "metering", "p-000000000000.jsonl");
});

afterEach(async () => {
  delete process.env.MOZCODE_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe("metering rollup", () => {
  it("adds only appended records and keeps per-session totals", async () => {
    await fs.writeFile(ledger, line("a", 10) + line("b", 5, "2026-10-02T00:00:00.000Z"));
    let r = await loadRollup();
    expect(r["/p"].total.saved).toBe(15);
    expect(r["/p"].latestSession).toBe("b");

    await fs.appendFile(ledger, line("a", 100, "2026-10-01T00:00:00.000Z", "code_edit"));
    r = await loadRollup();
    expect(r["/p"].total.saved).toBe(115);
    expect(r["/p"].total.calls).toBe(3);
    expect(r["/p"].sessions.a.saved).toBe(110);
    expect(r["/p"].sessions.a.tools.code_edit).toEqual([1, 1, 100]);
    expect(r["/p"].latestSession).toBe("b");
  });

  it("keeps per-day totals keyed by the local calendar day", async () => {
    const d1 = "2026-10-01T12:00:00.000Z";
    const d2 = "2026-10-02T12:00:00.000Z";
    await fs.writeFile(ledger, line("a", 10, d1) + line("b", 5, d1) + line("b", 7, d2));
    const r = await loadRollup();
    expect(r["/p"].days[localDay(d1)].saved).toBe(15);
    expect(r["/p"].days[localDay(d1)].calls).toBe(2);
    expect(r["/p"].days[localDay(d2)].saved).toBe(7);
  });

  it("rebuilds a rollup written by an older version", async () => {
    await fs.writeFile(ledger, line("a", 10));
    await fs.mkdir(join(home, "cache"), { recursive: true });
    // A v1 rollup claims the whole file is consumed but has no per-day totals.
    const size = (await fs.stat(ledger)).size;
    await fs.writeFile(rollupPath(), JSON.stringify({ version: 1, files: { "p-000000000000.jsonl": { dev: 0, ino: 0, offset: size, projects: {} } } }));
    const r = await loadRollup();
    expect(r["/p"].total.saved).toBe(10);
    expect(Object.keys(r["/p"].days)).toHaveLength(1);
  });

  it("waits for a partially written record instead of losing it", async () => {
    const full = line("a", 7);
    await fs.writeFile(ledger, line("a", 1) + full.slice(0, 20));
    expect((await loadRollup())["/p"].total.saved).toBe(1);
    await fs.appendFile(ledger, full.slice(20));
    expect((await loadRollup())["/p"].total.saved).toBe(8);
  });

  it("recounts a ledger that was truncated or rewritten", async () => {
    await fs.writeFile(ledger, line("a", 10) + line("a", 20));
    expect((await loadRollup())["/p"].total.saved).toBe(30);
    await fs.writeFile(ledger, line("a", 3)); // shorter than what was consumed
    expect((await loadRollup())["/p"].total.saved).toBe(3);
    // Same length or longer, rewritten in place: the consumed prefix no longer ends on a newline.
    await fs.writeFile(ledger, line("a", 4444) + line("a", 5));
    const r = await loadRollup();
    expect(r["/p"].total.saved).toBe(4449);
  });

  it("rebuilds from the ledger when the rollup file is corrupt, and skips bad lines", async () => {
    await fs.writeFile(ledger, line("a", 10) + "not json\nnull\n" + line("a", 1));
    await loadRollup();
    await fs.writeFile(rollupPath(), "{garbage");
    expect((await loadRollup())["/p"].total.saved).toBe(11);
  });

  it("drops a ledger file that was deleted", async () => {
    await fs.writeFile(ledger, line("a", 10));
    await loadRollup();
    await fs.rm(ledger);
    expect(await loadRollup()).toEqual({});
  });
});
