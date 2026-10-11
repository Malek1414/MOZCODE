import { afterEach, describe, expect, it, vi } from "vitest";

// Drive the PostgreSQL snapshot path without a server: a fake pg Client answers
// the four catalog queries in the order inspectPostgres issues them.
const catalog = {
  tables: [
    { table_schema: "public", table_name: "users", table_type: "BASE TABLE" },
    { table_schema: "audit", table_name: "users", table_type: "BASE TABLE" },
    { table_schema: "public", table_name: "wide", table_type: "BASE TABLE" },
  ],
  columns: [
    { table_schema: "public", table_name: "users", ordinal_position: 1, column_name: "id", udt_name: "int4", is_nullable: "NO", is_primary: true },
    { table_schema: "public", table_name: "users", ordinal_position: 2, column_name: "email", udt_name: "text", is_nullable: "YES", is_primary: false },
    { table_schema: "audit", table_name: "users", ordinal_position: 1, column_name: "changed_at", udt_name: "timestamptz", is_nullable: "NO", is_primary: false },
    ...Array.from({ length: 5000 }, (_, i) => ({
      table_schema: "public", table_name: "wide", ordinal_position: i + 1, column_name: `c${i}`, udt_name: "int4", is_nullable: "YES", is_primary: false,
    })),
  ],
  fks: [],
  indexes: [
    { table_schema: "public", table_name: "users", index_name: "users_email_key", indexdef: "CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)", is_unique: true },
  ],
};

vi.mock("pg", () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string) {
      if (/information_schema\.tables/.test(sql)) return { rows: catalog.tables };
      if (/information_schema\.columns/.test(sql)) return { rows: catalog.columns };
      if (/pg_constraint/.test(sql)) return { rows: catalog.fks };
      if (/pg_indexes/.test(sql)) return { rows: catalog.indexes };
      return { rows: [] };
    }
  },
}));

afterEach(() => {
  delete process.env.MOZCODE_TEST_FAKE_PG;
});

describe("db_schema PostgreSQL snapshot", () => {
  it("groups columns and indexes per schema-qualified table", async () => {
    const { dbSchema, clearDbSchemaCache } = await import("../src/db/schema.js");
    clearDbSchemaCache();
    process.env.MOZCODE_TEST_FAKE_PG = "postgres://u:p@localhost/db";
    const r = await dbSchema("/tmp", { connectionEnv: "MOZCODE_TEST_FAKE_PG", refresh: true, query: "users" });
    expect(r.text).toContain("public.users(id int4 PK!, email text) idx[U:users_email_key(email)]");
    expect(r.text).toContain("audit.users(changed_at timestamptz!)");
    const wide = await dbSchema("/tmp", { connectionEnv: "MOZCODE_TEST_FAKE_PG", query: "c4999" });
    expect(wide.text).toContain("public.wide(c0 int4, c1 int4");
    expect(wide.text).toContain("c4999 int4)");
  });
});
