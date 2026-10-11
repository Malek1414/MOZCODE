import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clearDbSchemaCache, dbSchema } from "../src/db/schema.js";

describe("db_schema", () => {
  let dir: string;
  let databasePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "mozcode-db-"));
    databasePath = join(dir, "app.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE organizations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id),
        email TEXT NOT NULL
      );
      CREATE UNIQUE INDEX users_email_idx ON users(email);
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        event TEXT NOT NULL
      );
      CREATE VIEW active_users AS SELECT id, email FROM users;
    `);
    db.close();
    clearDbSchemaCache();
  });

  afterEach(async () => {
    clearDbSchemaCache();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns a compact whole-database map with keys and indexes", async () => {
    const result = await dbSchema(dir, { path: "app.sqlite" });
    expect(result.degraded).toBe(false);
    expect(result.text).toContain("sqlite schema: 3 tables, 1 views");
    expect(result.text).toContain("organization_id INTEGER!→organizations.id");
    expect(result.text).toContain("U:users_email_idx(email)");
    expect(result.text).toContain("view active_users");
    expect(result.meta.savedTokens).toBeGreaterThan(0);
  });

  it("filters the cached map by table, column, or relationship name", async () => {
    await dbSchema(dir, { path: "app.sqlite" });
    const result = await dbSchema(dir, { path: "app.sqlite", query: "organizations" });
    expect(result.text).toContain("organizations(");
    expect(result.text).toContain("users(");
    expect(result.text).not.toContain("audit_log(");
  });

  it("sees schema changes still in the WAL file without refresh", async () => {
    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      const before = await dbSchema(dir, { path: "app.sqlite" });
      expect(before.text).not.toContain("invoices(");
      const mainBefore = await fs.stat(databasePath);

      writer.exec("CREATE TABLE invoices (id INTEGER PRIMARY KEY, total REAL);");
      const mainAfter = await fs.stat(databasePath);
      // The change sits in app.sqlite-wal; the main file is untouched.
      expect(mainAfter.mtimeMs).toBe(mainBefore.mtimeMs);
      expect(mainAfter.size).toBe(mainBefore.size);

      const after = await dbSchema(dir, { path: "app.sqlite" });
      expect(after.text).toContain("invoices(");
    } finally {
      writer.close();
    }
  });

  it("does not accept PostgreSQL credentials as tool input", async () => {
    await expect(dbSchema(dir, { connectionEnv: "MOZCODE_TEST_DATABASE_URL" }))
      .rejects.toThrow("environment variable MOZCODE_TEST_DATABASE_URL is not set");
  });

  it("refuses an env var that does not hold a PostgreSQL URL without echoing it", async () => {
    const secret = "sk-ant-not-a-database-0123456789";
    process.env.MOZCODE_TEST_SECRET = secret;
    try {
      const attempt = dbSchema(dir, { connectionEnv: "MOZCODE_TEST_SECRET" });
      await expect(attempt).rejects.toThrow(/does not hold a postgres:\/\/ or postgresql:\/\/ URL/);
      await attempt.catch((err: Error) => expect(err.message).not.toContain(secret));
    } finally {
      delete process.env.MOZCODE_TEST_SECRET;
    }
  });

  it("refuses a connection_env that is not a variable name", async () => {
    await expect(dbSchema(dir, { connectionEnv: "postgres://u:p@h/db" }))
      .rejects.toThrow(/must be an environment variable name/);
  });
});

// Opt-in: point MOZCODE_TEST_POSTGRES_URL at a disposable database to exercise
// the real pg path (read-only transaction with server-side timeouts).
describe.skipIf(!process.env.MOZCODE_TEST_POSTGRES_URL)("db_schema against PostgreSQL", () => {
  it("introspects inside a read-only transaction", async () => {
    clearDbSchemaCache();
    const r = await dbSchema(tmpdir(), { connectionEnv: "MOZCODE_TEST_POSTGRES_URL", refresh: true });
    expect(r.text).toMatch(/postgres schema: \d+ tables/);
    expect(r.text).toContain("(credentials hidden)");
  });
});
