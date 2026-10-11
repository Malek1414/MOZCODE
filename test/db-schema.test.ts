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
    const secret = "fake-secret-value-not-a-db-url-0123456789";
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

describe("db_schema output budget", () => {
  it("caps a very large schema and names what it left out", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "mozcode-db-big-"));
    try {
      const file = join(dir, "big.sqlite");
      const db = new DatabaseSync(file);
      const cols = Array.from({ length: 8 }, (_, i) => `column_number_${i} TEXT NOT NULL`).join(", ");
      db.exec("BEGIN");
      for (let t = 0; t < 1500; t++) db.exec(`CREATE TABLE table_${String(t).padStart(4, "0")} (id INTEGER PRIMARY KEY, ${cols})`);
      db.exec("COMMIT");
      db.close();
      clearDbSchemaCache();

      const r = await dbSchema(dir, { path: "big.sqlite" });
      expect(r.text).toContain("1500 tables");
      expect(r.text.length).toBeLessThan(60_000);
      expect(r.text).toContain("more objects not shown");
      expect(r.text).toContain("table_0000(id INTEGER PK");
      expect(r.text).toMatch(/Not shown: table_\d{4}, /);
      expect(r.meta.actualTokens).toBeLessThan(r.meta.baselineTokens);

      // A query narrows the result back under the budget, in full.
      const one = await dbSchema(dir, { path: "big.sqlite", query: "table_1499" });
      expect(one.text).toContain("table_1499(id INTEGER PK");
      expect(one.text).not.toContain("not shown");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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
