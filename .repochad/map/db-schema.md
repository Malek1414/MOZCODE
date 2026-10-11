# Area: Database schema tool (`src/db/schema.ts`)

## Purpose
`src/db/schema.ts` (469 lines) implements the `db_schema` MCP tool. It reads the *structure* of a SQLite file or a PostgreSQL database (tables, views, columns, primary/foreign keys, indexes; never application rows) and returns a one-line-per-object text map. The point is that the model learns the whole schema in one call instead of running many exploratory queries (tool description, src/server.ts:154-156). Added in commit 5df458c ("Add DB schema tooling and speed benchmarks").

- Callers: `src/server.ts:259-266` (MCP dispatch, metered via `meter()` at src/server.ts:68), `scripts/benchmark-performance.ts:174-188`, `test/db-schema.test.ts`, `test/integration.test.ts:96`.
- Downstream of metering: `src/dashboard/metrics.ts:53-58` counts `db_schema` calls as "DB calls avoided"; `src/dashboard/render.ts:17,22` labels it.
- External deps: `pg` `Client` (src/db/schema.ts:6), `node:sqlite` `DatabaseSync` (dynamic import, :174), `sqlite3` CLI fallback through `execFile` (:189), `estimateTokens` (src/util/tokens.ts) and `makeMeta` (src/tools/types.ts:20).

## Data model — src/db/schema.ts:10-69
`DbDialect`, `DbObjectKind`, `DbColumn`, `DbForeignKey`, `DbIndex`, `DbObject`, `DbSnapshot` form the dialect-neutral snapshot both back ends produce. `DbSchemaOptions` (:48) is the public input: `path` (SQLite), `connectionEnv` (env-var *name* holding a Postgres URL), `query` (filter), `refresh` (skip cache). Two module-level caches (:71-72) store a **Promise** of a snapshot, so concurrent callers share one in-flight introspection:
- `sqliteCache`: key is the absolute path, valid while `mtimeMs` and `size` both match.
- `postgresCache`: key is the env-var name, valid for `POSTGRES_CACHE_MS = 30_000` (:74) and only while the sha256 fingerprint of the URL is unchanged.

SQL constants: SQLite (:76-101) uses `sqlite_schema` joined to the `pragma_table_xinfo` / `pragma_foreign_key_list` / `pragma_index_list` + `pragma_index_info` table-valued functions, so it needs four queries for the whole DB, not one per table. Only user-created indexes are included (`il.origin = 'c'`, :100). Postgres (:236-281) uses `information_schema.tables/columns` (PK found through a correlated EXISTS on `table_constraints`/`key_column_usage`), `pg_constraint` with `unnest ... WITH ORDINALITY` to pair composite FK columns, and `pg_indexes`.

## Functions

### `asText(value)` / `asNumber(value)` — src/db/schema.ts:105, :109
- **What:** coerce unknown row cells: null/undefined → `""`, anything else → `String`; numbers kept, everything else goes through `Number()`.
- **Why:** rows come from three drivers (node:sqlite, sqlite3 JSON, pg), each with its own types (inferred).

### `groupRows(rows, key)` — src/db/schema.ts:113
- **What/How:** buckets rows into a `Map<string, Row[]>` keyed by `row[key]`, in one O(n) pass.
- **Used by:** `sqliteSnapshot` only. `postgresSnapshot` re-implements grouping inline (see Risks).

### `sqliteSnapshot(source, tables, columns, fks, indexes)` — src/db/schema.ts:124
- **What:** turns four SQLite result sets into a `DbSnapshot` (`dialect: "sqlite"`, schema `"main"`).
- **How:** groups each set by `table_name`. Composite FKs are merged by pragma `id` (:133-141) and multi-column indexes by index name (:146-153). An empty column type becomes `"ANY"` (:162). `nullable = !notnull` and `primaryKey = pk != 0`.
- **Risks:** none significant. A view's FK and index lists are empty by design (the queries filter on `m.type = 'table'`).

### `querySqliteNative(filePath)` — src/db/schema.ts:173
- **What:** opens the DB with `node:sqlite` read-only (FK enforcement off, extensions disabled) and runs the four queries synchronously. It closes the DB in `finally`.
- **Why:** the fast, dependency-free path. It needs Node 22.12+ (see the error text at :210).
- **Risks:** `DatabaseSync` is **synchronous**, so a large or locked DB blocks the MCP server's event loop during the four queries. A `readOnly` open of a WAL database whose `-shm` is missing or unwritable can fail, which then sends the call to the CLI fallback.

### `querySqliteCli(filePath, sql)` — src/db/schema.ts:188
- **What:** runs `sqlite3 -readonly -json <file> <sql>` through `execFile` (no shell) with a 16 MiB `maxBuffer` and parses the JSON stdout.
- **Risks:** no timeout option, so a locked DB or a hung CLI can stall the tool call indefinitely. Output over 16 MiB throws. `filePath` is always absolute (resolved at :447), so it cannot be mistaken for a CLI flag.

### `inspectSqlite(filePath)` — src/db/schema.ts:195
- **What/How:** tries the native path first. If that throws, it runs the four CLI queries in parallel (`Promise.all`, :201). If both fail, it throws one error that combines the two messages.
- **Used by:** `cachedSqlite`.

### `cachedSqlite(filePath, refresh)` — src/db/schema.ts:216
- **What:** `fs.stat`s the file and returns the cached snapshot promise when `mtimeMs` and `size` are unchanged and `refresh` is false. Otherwise it stores a new promise *before* awaiting it (single-flight). A rejected entry is evicted only if it is still the current entry (:231).
- **Risks:** **stale cache under WAL mode.** Schema changes that are still only in `<db>-wal` (not yet checkpointed) leave the main file's mtime and size unchanged, so the tool keeps returning the old schema until `refresh: true`. The cache is unbounded (one entry per distinct path), but entries are small.

### `pgKey(schema, table)` — src/db/schema.ts:283
`"schema.table"` join key used by the Postgres grouping. The plain `.` separator is ambiguous if a name itself contains a dot (edge case).

### `indexColumns(definition)` — src/db/schema.ts:287
- **What/How:** extracts index columns from `pg_indexes.indexdef` with the regex `/\(([^)]+)\)/` (first parenthesised group), splits on commas and strips surrounding quotes.
- **Risks (correctness bug):** text parsing of DDL. An expression index `USING btree (lower(email))` matches `lower(email` and gives the column `lower(email`. A multi-arg expression like `(coalesce(a, b))` splits into garbage. Opclass/ordering suffixes (`email text_pattern_ops`, `created_at DESC`) are kept verbatim. Quoted names containing commas or parentheses break. `INCLUDE (...)` columns are dropped silently. A robust alternative is `pg_index.indkey` joined to `pg_attribute`, or `pg_get_indexdef(indexrelid, k, true)` per key.

### `postgresSnapshot(source, tables, columns, fks, indexes)` — src/db/schema.ts:292
- **What:** the Postgres counterpart of `sqliteSnapshot`. Composite FKs are merged by `constraint_name` (:315-324) and keep `refSchema`. A table is a `view` when `table_type === "VIEW"`. `type` is `udt_name` (e.g. `int4`, `varchar`, no length). Index uniqueness is `indexdef LIKE 'CREATE UNIQUE INDEX%'`.
- **Risks:** grouping (:296-307) uses `map.set(key, [...(map.get(key) ?? []), row])`, which copies the array on every row. That is **O(k²) per table**, so wide or many-column schemas pay quadratic copying. It also duplicates `groupRows` (:113), which fits here with `pgKey`. FKs are keyed by `constraint_name` alone *within* one table, which is fine because constraint names are unique per table.

### `inspectPostgres(connectionString, source)` — src/db/schema.ts:347
- **What:** opens a `pg.Client` (`application_name: "mozcode"`, 5 s connect timeout, 10 s per-query timeout), runs the four metadata queries **sequentially** and calls `client.end()` in `finally`.
- **Risks:** a cold call takes up to 4 round trips (worst case about 45 s). This is unavoidable on one client, but the four could be combined into one multi-statement round trip or pooled. On large catalogs the correlated `information_schema` PK subquery (:244-255) is slow; `pg_index.indisprimary` is cheaper. `information_schema` hides objects the role has no privileges on, and materialized views and partitioned parents may be missing or misclassified. There is no SSL configuration knob beyond what the URL carries (sslmode etc.).

### `cachedPostgres(connectionEnv, refresh)` — src/db/schema.ts:366
- **What:** reads `process.env[connectionEnv]` and throws if it is unset. Otherwise it fingerprints the URL with sha256, serves a cached promise for 30 s, and uses the same single-flight and evict-on-failure pattern as SQLite. The snapshot's `source` is `"<ENV> (credentials hidden)"` (:381), so the URL never reaches output.
- **Why:** credentials stay out of tool arguments and transcripts (doc comment :439-442, test at test/db-schema.test.ts:62-65).
- **Risks (security, low-medium):** `connectionEnv` is an **arbitrary env-var name chosen by the model** (src/server.ts:262). A prompt-injected call can point it at *any* variable (e.g. `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`) and make the server treat that secret as a Postgres URL. The secret is then fed to `pg`'s connection-string parser and errors may surface through `MOZCODE db_schema failed: ${msg}` (src/server.ts:298-300). A host/user-shaped value would also be sent to the network host it names. An allow-list (e.g. names matching `/DATABASE_URL$|^PG/`) or a URL-shape check before connecting would close this. The cache is keyed by env name, and the 30 s TTL means schema changes can be up to 30 s stale.

### `qualifiedName(object)` — src/db/schema.ts:392
Drops the schema prefix for SQLite `main` (and for a missing schema). Otherwise `schema.name`.

### `objectSearchText(object)` — src/db/schema.ts:397
- **What/How:** lowercased, space-joined haystack of name, column names and types, FK columns and targets, and index names and columns. `renderSnapshot` filters with a substring `includes`.
- **Risks:** substring matching gives false positives (`id` matches nearly everything; `user` matches `user_id` columns of unrelated tables). A query can also match across the joined token boundary (`"users id"`). The behaviour is documented in the test at test/db-schema.test.ts:54-60 (FK-referencing tables are intentionally included).

### `renderObject(object)` — src/db/schema.ts:406
- **What:** compact one-line format, for example `view? schema.table(col TYPE PK!→ref.table.col, ...) idx[U:name(cols); ...]`. Here `!` means NOT NULL, ` PK` means primary key, `→` means FK target and `U:` means unique index (asserted in test/db-schema.test.ts:47-49).
- **How:** builds a column → FK-target map first, so each column is O(1). A missing ref column renders as `?`.

### `renderSnapshot(snapshot, query?)` — src/db/schema.ts:425
- **What:** a header line (source, dialect, table/view/column totals for the *whole* DB, plus a match count when filtered), followed by one line per (filtered) object, or `(no matching schema objects)`.
- **Risks (scale/tokens):** **no output cap or pagination.** A schema with thousands of tables (common in Postgres multi-tenant or partitioned setups) returns the entire map in one tool result, which defeats the tool's token-saving purpose and can overflow the client's context. Other tools in this repo trade completeness for size; this one does not.

### `dbSchema(projectRoot, opts)` — src/db/schema.ts:443 (exported, tool entry)
- **What:** dispatches on `opts.path`. A SQLite path is resolved against `projectRoot` when relative, and the snapshot is copied with `source` rewritten to the project-relative path (:449). Without a path it uses Postgres via `opts.connectionEnv || "DATABASE_URL"`. It renders, then returns `ToolResult` with `degraded: false` and savings metadata.
- **How (metering):** baseline = `estimateTokens(JSON.stringify(rendered.objects)) || 1` (:458), actual = tokens of the rendered text.
- **Why:** exposes schema discovery as a cheap, read-only MCP tool (annotations `readOnlyHint: true`, src/server.ts:157-162).
- **Risks:**
  - **Savings are self-referential (quality).** The "counterfactual" baseline is the JSON of the same filtered objects. That measures compact format vs JSON, not the exploratory queries the tool claims to replace. The dashboard then also credits `dbCallsAvoidedPerSchema` per call (src/dashboard/metrics.ts:58). The numbers are plausible but not grounded in a measurement.
  - **No path confinement (security, low).** An absolute path or a `../` path opens any SQLite file the user can read (schema only). This matches `resolvePaths` for the other tools (src/server.ts:60-66), so it is a repo-wide policy, not a local bug. A non-SQLite file yields a driver error message.
  - `path` and `connectionEnv` are both optional and `path` takes precedence silently. There is no runtime type check on args (src/server.ts:261-264 uses `as` casts), so a non-string `query` would throw at `.trim()`.

### `clearDbSchemaCache()` — src/db/schema.ts:466
Clears both caches. Used by tests and the benchmark to force cold runs.

## Tests
`test/db-schema.test.ts` covers the SQLite happy path (counts, FK arrow, unique index, view), query filtering, and the missing-env-var Postgres error. `test/integration.test.ts:96` exercises it over MCP. **Not covered:** any Postgres introspection (`postgresSnapshot`, `indexColumns`, `inspectPostgres` have no tests and no fixture DB), the sqlite3 CLI fallback, cache invalidation on file change, WAL staleness, composite FKs and multi-column indexes.

## Hot spots (ranked)
1. **security / medium:** `cachedPostgres` (:367) reads any model-chosen env var as a DB URL. A prompt-injected call can send a secret into `pg`'s parser and connection attempt, and possibly echo it in the error path (src/server.ts:299).
2. **quality / medium:** `indexColumns` (:287-290) regex-parses `indexdef`, which gives wrong columns for expression indexes, opclasses, DESC and INCLUDE. Postgres paths are untested.
3. **scale / medium:** `renderSnapshot` (:425) has no size cap or pagination. Huge schemas return everything in one result.
4. **quality / medium:** `cachedSqlite` (:219) mtime/size validation misses uncheckpointed WAL schema changes, so it serves a stale schema.
5. **scale / low-medium:** `querySqliteNative` (:173) uses synchronous `DatabaseSync`, which blocks the event loop. `querySqliteCli` (:189) has no timeout.
6. **scale / low:** `postgresSnapshot` (:296-307) uses quadratic array-spread grouping and duplicates `groupRows`.
7. **quality / low:** the savings baseline at :458 is self-referential (JSON of its own output), so it overstates the evidence for the dashboard.
8. **scale / low:** `inspectPostgres` runs 4 sequential round trips and a correlated `information_schema` PK subquery that is slow on large catalogs.
