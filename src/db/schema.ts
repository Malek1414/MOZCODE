import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Client } from "pg";
import { estimateTokens } from "../util/tokens.js";
import { makeMeta, type ToolResult } from "../tools/types.js";

type DbDialect = "sqlite" | "postgres";
type DbObjectKind = "table" | "view";

interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

interface DbForeignKey {
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
}

interface DbIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

interface DbObject {
  schema?: string;
  name: string;
  kind: DbObjectKind;
  columns: DbColumn[];
  foreignKeys: DbForeignKey[];
  indexes: DbIndex[];
}

interface DbSnapshot {
  dialect: DbDialect;
  source: string;
  objects: DbObject[];
}

export interface DbSchemaOptions {
  /** SQLite database path, absolute or relative to the project. Omit for PostgreSQL. */
  path?: string;
  /** Environment variable containing a PostgreSQL URL. Defaults to DATABASE_URL. */
  connectionEnv?: string;
  /** Filter by table, view, column, index, or referenced-table name. */
  query?: string;
  /** Bypass the schema cache. */
  refresh?: boolean;
}

interface SqliteCacheEntry {
  mtimeMs: number;
  size: number;
  snapshot: Promise<DbSnapshot>;
}

interface PostgresCacheEntry {
  expiresAt: number;
  connectionFingerprint: string;
  snapshot: Promise<DbSnapshot>;
}

const sqliteCache = new Map<string, SqliteCacheEntry>();
const postgresCache = new Map<string, PostgresCacheEntry>();
const execFileAsync = promisify(execFile);
const POSTGRES_CACHE_MS = 30_000;

const SQLITE_TABLES_SQL = `
  SELECT name, type
  FROM sqlite_schema
  WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
  ORDER BY type, name`;
const SQLITE_COLUMNS_SQL = `
  SELECT m.name AS table_name, p.cid, p.name, p.type, p."notnull" AS "notnull", p.pk
  FROM sqlite_schema AS m
  JOIN pragma_table_xinfo(m.name) AS p
  WHERE m.type IN ('table', 'view')
  ORDER BY m.name, p.cid`;
const SQLITE_FKS_SQL = `
  SELECT m.name AS table_name, f.id, f.seq, f."table" AS ref_table,
         f."from" AS from_column, f."to" AS to_column
  FROM sqlite_schema AS m
  JOIN pragma_foreign_key_list(m.name) AS f
  WHERE m.type = 'table'
  ORDER BY m.name, f.id, f.seq`;
const SQLITE_INDEXES_SQL = `
  SELECT m.name AS table_name, il.name AS index_name, il."unique" AS is_unique,
         ii.seqno, ii.name AS column_name
  FROM sqlite_schema AS m
  JOIN pragma_index_list(m.name) AS il
  JOIN pragma_index_info(il.name) AS ii
  WHERE m.type = 'table' AND il.origin = 'c'
  ORDER BY m.name, il.name, ii.seqno`;

type Row = Record<string, unknown>;

function asText(value: unknown): string {
  return value == null ? "" : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function groupRows(rows: Row[], key: string): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const name = asText(row[key]);
    const values = grouped.get(name) ?? [];
    values.push(row);
    grouped.set(name, values);
  }
  return grouped;
}

function sqliteSnapshot(source: string, tables: Row[], columns: Row[], fks: Row[], indexes: Row[]): DbSnapshot {
  const columnsByTable = groupRows(columns, "table_name");
  const fksByTable = groupRows(fks, "table_name");
  const indexesByTable = groupRows(indexes, "table_name");

  const objects: DbObject[] = tables.map((table) => {
    const name = asText(table.name);
    const foreignKeys = new Map<string, DbForeignKey>();
    for (const row of fksByTable.get(name) ?? []) {
      const id = asText(row.id);
      const fk = foreignKeys.get(id) ?? {
        columns: [],
        refTable: asText(row.ref_table),
        refColumns: [],
      };
      fk.columns.push(asText(row.from_column));
      fk.refColumns.push(asText(row.to_column));
      foreignKeys.set(id, fk);
    }

    const dbIndexes = new Map<string, DbIndex>();
    for (const row of indexesByTable.get(name) ?? []) {
      const indexName = asText(row.index_name);
      const index = dbIndexes.get(indexName) ?? {
        name: indexName,
        columns: [],
        unique: Boolean(asNumber(row.is_unique)),
      };
      index.columns.push(asText(row.column_name));
      dbIndexes.set(indexName, index);
    }

    return {
      schema: "main",
      name,
      kind: asText(table.type) === "view" ? "view" : "table",
      columns: (columnsByTable.get(name) ?? []).map((column) => ({
        name: asText(column.name),
        type: asText(column.type) || "ANY",
        nullable: !Boolean(asNumber(column.notnull)),
        primaryKey: Boolean(asNumber(column.pk)),
      })),
      foreignKeys: [...foreignKeys.values()],
      indexes: [...dbIndexes.values()],
    };
  });
  return { dialect: "sqlite", source, objects };
}

async function querySqliteNative(filePath: string): Promise<[Row[], Row[], Row[], Row[]]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(filePath, {
    readOnly: true,
    enableForeignKeyConstraints: false,
    allowExtension: false,
  });
  try {
    const all = (sql: string) => db.prepare(sql).all() as Row[];
    return [all(SQLITE_TABLES_SQL), all(SQLITE_COLUMNS_SQL), all(SQLITE_FKS_SQL), all(SQLITE_INDEXES_SQL)];
  } finally {
    db.close();
  }
}

async function querySqliteCli(filePath: string, sql: string): Promise<Row[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", filePath, sql], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim() ? JSON.parse(stdout) as Row[] : [];
}

async function inspectSqlite(filePath: string): Promise<DbSnapshot> {
  let rows: [Row[], Row[], Row[], Row[]];
  try {
    rows = await querySqliteNative(filePath);
  } catch (nativeError) {
    try {
      rows = await Promise.all([
        querySqliteCli(filePath, SQLITE_TABLES_SQL),
        querySqliteCli(filePath, SQLITE_COLUMNS_SQL),
        querySqliteCli(filePath, SQLITE_FKS_SQL),
        querySqliteCli(filePath, SQLITE_INDEXES_SQL),
      ]);
    } catch (cliError) {
      const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError);
      const cliMessage = cliError instanceof Error ? cliError.message : String(cliError);
      throw new Error(`SQLite introspection needs Node 22.12+ or the sqlite3 CLI. Native: ${nativeMessage}; CLI: ${cliMessage}`);
    }
  }
  return sqliteSnapshot(filePath, ...rows);
}

async function cachedSqlite(filePath: string, refresh: boolean): Promise<DbSnapshot> {
  const stat = await fs.stat(filePath);
  const cached = sqliteCache.get(filePath);
  if (!refresh && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.snapshot;
  }
  const entry: SqliteCacheEntry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    snapshot: inspectSqlite(filePath),
  };
  sqliteCache.set(filePath, entry);
  try {
    return await entry.snapshot;
  } catch (error) {
    if (sqliteCache.get(filePath) === entry) sqliteCache.delete(filePath);
    throw error;
  }
}

const POSTGRES_TABLES_SQL = `
  SELECT table_schema, table_name, table_type
  FROM information_schema.tables
  WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
  ORDER BY table_schema, table_name`;
const POSTGRES_COLUMNS_SQL = `
  SELECT c.table_schema, c.table_name, c.ordinal_position, c.column_name, c.udt_name,
         c.is_nullable,
         EXISTS (
           SELECT 1
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_catalog = tc.constraint_catalog
            AND kcu.constraint_schema = tc.constraint_schema
            AND kcu.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND kcu.table_schema = c.table_schema
             AND kcu.table_name = c.table_name
             AND kcu.column_name = c.column_name
         ) AS is_primary
  FROM information_schema.columns c
  WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
  ORDER BY c.table_schema, c.table_name, c.ordinal_position`;
const POSTGRES_FKS_SQL = `
  SELECT src_ns.nspname AS table_schema, src.relname AS table_name,
         src_col.attname AS from_column, ref_ns.nspname AS ref_schema,
         ref.relname AS ref_table, ref_col.attname AS to_column,
         key_cols.ordinality AS position, con.conname AS constraint_name
  FROM pg_constraint con
  JOIN pg_class src ON src.oid = con.conrelid
  JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
  JOIN pg_class ref ON ref.oid = con.confrelid
  JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_cols(attnum, ordinality) ON true
  JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS ref_cols(attnum, ordinality)
    ON ref_cols.ordinality = key_cols.ordinality
  JOIN pg_attribute src_col ON src_col.attrelid = src.oid AND src_col.attnum = key_cols.attnum
  JOIN pg_attribute ref_col ON ref_col.attrelid = ref.oid AND ref_col.attnum = ref_cols.attnum
  WHERE con.contype = 'f' AND src_ns.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY src_ns.nspname, src.relname, con.conname, key_cols.ordinality`;
const POSTGRES_INDEXES_SQL = `
  SELECT schemaname AS table_schema, tablename AS table_name, indexname AS index_name,
         indexdef, indexdef LIKE 'CREATE UNIQUE INDEX%' AS is_unique
  FROM pg_indexes
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY schemaname, tablename, indexname`;

function pgKey(schema: unknown, table: unknown): string {
  return `${asText(schema)}.${asText(table)}`;
}

function indexColumns(definition: string): string[] {
  const match = definition.match(/\(([^)]+)\)/);
  return match ? match[1].split(",").map((column) => column.trim().replace(/^"|"$/g, "")) : [];
}

function postgresSnapshot(source: string, tables: Row[], columns: Row[], fks: Row[], indexes: Row[]): DbSnapshot {
  const columnsByTable = new Map<string, Row[]>();
  const fksByTable = new Map<string, Row[]>();
  const indexesByTable = new Map<string, Row[]>();
  for (const row of columns) {
    const key = pgKey(row.table_schema, row.table_name);
    columnsByTable.set(key, [...(columnsByTable.get(key) ?? []), row]);
  }
  for (const row of fks) {
    const key = pgKey(row.table_schema, row.table_name);
    fksByTable.set(key, [...(fksByTable.get(key) ?? []), row]);
  }
  for (const row of indexes) {
    const key = pgKey(row.table_schema, row.table_name);
    indexesByTable.set(key, [...(indexesByTable.get(key) ?? []), row]);
  }

  const objects: DbObject[] = tables.map((table) => {
    const schema = asText(table.table_schema);
    const name = asText(table.table_name);
    const key = pgKey(schema, name);
    const foreignKeys = new Map<string, DbForeignKey>();
    for (const row of fksByTable.get(key) ?? []) {
      const constraint = asText(row.constraint_name);
      const fk = foreignKeys.get(constraint) ?? {
        columns: [],
        refSchema: asText(row.ref_schema),
        refTable: asText(row.ref_table),
        refColumns: [],
      };
      fk.columns.push(asText(row.from_column));
      fk.refColumns.push(asText(row.to_column));
      foreignKeys.set(constraint, fk);
    }
    return {
      schema,
      name,
      kind: asText(table.table_type) === "VIEW" ? "view" : "table",
      columns: (columnsByTable.get(key) ?? []).map((column) => ({
        name: asText(column.column_name),
        type: asText(column.udt_name),
        nullable: asText(column.is_nullable) === "YES",
        primaryKey: column.is_primary === true || asText(column.is_primary) === "true",
      })),
      foreignKeys: [...foreignKeys.values()],
      indexes: (indexesByTable.get(key) ?? []).map((index) => ({
        name: asText(index.index_name),
        columns: indexColumns(asText(index.indexdef)),
        unique: index.is_unique === true || asText(index.is_unique) === "true",
      })),
    };
  });
  return { dialect: "postgres", source, objects };
}

async function inspectPostgres(connectionString: string, source: string): Promise<DbSnapshot> {
  const client = new Client({
    connectionString,
    application_name: "mozcode",
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });
  await client.connect();
  try {
    const tables = await client.query(POSTGRES_TABLES_SQL);
    const columns = await client.query(POSTGRES_COLUMNS_SQL);
    const fks = await client.query(POSTGRES_FKS_SQL);
    const indexes = await client.query(POSTGRES_INDEXES_SQL);
    return postgresSnapshot(source, tables.rows, columns.rows, fks.rows, indexes.rows);
  } finally {
    await client.end();
  }
}

async function cachedPostgres(connectionEnv: string, refresh: boolean): Promise<DbSnapshot> {
  const connectionString = process.env[connectionEnv];
  if (!connectionString) {
    throw new Error(`PostgreSQL connection environment variable ${connectionEnv} is not set.`);
  }
  const now = Date.now();
  const connectionFingerprint = createHash("sha256").update(connectionString).digest("hex");
  const cached = postgresCache.get(connectionEnv);
  if (!refresh && cached && cached.connectionFingerprint === connectionFingerprint && cached.expiresAt > now) {
    return cached.snapshot;
  }

  const entry: PostgresCacheEntry = {
    expiresAt: now + POSTGRES_CACHE_MS,
    connectionFingerprint,
    snapshot: inspectPostgres(connectionString, `${connectionEnv} (credentials hidden)`),
  };
  postgresCache.set(connectionEnv, entry);
  try {
    return await entry.snapshot;
  } catch (error) {
    if (postgresCache.get(connectionEnv) === entry) postgresCache.delete(connectionEnv);
    throw error;
  }
}

function qualifiedName(object: DbObject): string {
  if (!object.schema || object.schema === "main") return object.name;
  return `${object.schema}.${object.name}`;
}

function objectSearchText(object: DbObject): string {
  return [
    qualifiedName(object),
    ...object.columns.flatMap((column) => [column.name, column.type]),
    ...object.foreignKeys.flatMap((fk) => [...fk.columns, fk.refSchema ?? "", fk.refTable, ...fk.refColumns]),
    ...object.indexes.flatMap((index) => [index.name, ...index.columns]),
  ].join(" ").toLowerCase();
}

function renderObject(object: DbObject): string {
  const foreignColumn = new Map<string, string>();
  for (const fk of object.foreignKeys) {
    const target = `${fk.refSchema && fk.refSchema !== "main" ? `${fk.refSchema}.` : ""}${fk.refTable}`;
    fk.columns.forEach((column, index) => {
      foreignColumn.set(column, `${target}.${fk.refColumns[index] ?? "?"}`);
    });
  }
  const columns = object.columns.map((column) => {
    const flags = `${column.primaryKey ? " PK" : ""}${column.nullable ? "" : "!"}`;
    const reference = foreignColumn.get(column.name);
    return `${column.name} ${column.type}${flags}${reference ? `→${reference}` : ""}`;
  });
  const indexes = object.indexes.length
    ? ` idx[${object.indexes.map((index) => `${index.unique ? "U:" : ""}${index.name}(${index.columns.join(",")})`).join("; ")}]`
    : "";
  return `${object.kind === "view" ? "view " : ""}${qualifiedName(object)}(${columns.join(", ")})${indexes}`;
}

function renderSnapshot(snapshot: DbSnapshot, query?: string): { text: string; objects: DbObject[] } {
  const needle = query?.trim().toLowerCase();
  const objects = needle
    ? snapshot.objects.filter((object) => objectSearchText(object).includes(needle))
    : snapshot.objects;
  const tableCount = snapshot.objects.filter((object) => object.kind === "table").length;
  const viewCount = snapshot.objects.length - tableCount;
  const columnCount = snapshot.objects.reduce((sum, object) => sum + object.columns.length, 0);
  const scope = needle ? `; ${objects.length} objects match "${query}"` : "";
  const header = `${snapshot.source} — ${snapshot.dialect} schema: ${tableCount} tables, ${viewCount} views, ${columnCount} columns${scope}`;
  if (objects.length === 0) return { text: `${header}\n(no matching schema objects)`, objects };
  return { text: `${header}\n${objects.map(renderObject).join("\n")}`, objects };
}

/**
 * Introspect structural metadata only. This never selects application rows and
 * PostgreSQL credentials are read from an environment variable, not tool input.
 */
export async function dbSchema(projectRoot: string, opts: DbSchemaOptions = {}): Promise<ToolResult> {
  let snapshot: DbSnapshot;
  let metaPath: string | undefined;
  if (opts.path) {
    const filePath = path.isAbsolute(opts.path) ? opts.path : path.resolve(projectRoot, opts.path);
    snapshot = await cachedSqlite(filePath, opts.refresh === true);
    snapshot = { ...snapshot, source: path.relative(projectRoot, filePath) || path.basename(filePath) };
    metaPath = snapshot.source;
  } else {
    const connectionEnv = opts.connectionEnv || "DATABASE_URL";
    snapshot = await cachedPostgres(connectionEnv, opts.refresh === true);
  }

  const rendered = renderSnapshot(snapshot, opts.query);
  // Counterfactual: raw metadata rows/objects returned by exploratory introspection.
  const baseline = estimateTokens(JSON.stringify(rendered.objects)) || 1;
  return {
    text: rendered.text,
    degraded: false,
    meta: makeMeta("db_schema", metaPath, baseline, estimateTokens(rendered.text)),
  };
}

export function clearDbSchemaCache(): void {
  sqliteCache.clear();
  postgresCache.clear();
}
