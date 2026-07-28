#!/usr/bin/env node
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { codeOutline } from "./tools/outline.js";
import { codeRead } from "./tools/read.js";
import { codeSearch } from "./tools/search.js";
import { codeEdit } from "./tools/edit.js";
import { dbSchema } from "./db/schema.js";
import { record, loadEntries, summarize, mozcodeHome, writeCurrentSession } from "./metering/store.js";
import { SUPPORTED_LANGUAGES } from "./ast/languages.js";
import { VERSION } from "./version.js";
import type { ToolResult } from "./tools/types.js";
import { generateDashboard, openInBrowser } from "./dashboard/generate.js";

const SESSION = crypto.randomUUID();

/**
 * Where MOZCODE thinks "your project" is. Everything downstream depends on it:
 * relative tool paths resolve against it, code_search and db_schema use it as
 * their root, and metering is filed under it.
 *
 * Claude launches plugin MCP servers in the user's workspace. Codex resolves a
 * plugin-relative MCP cwd against the installed plugin root instead. That makes
 * the bundle discoverable, but it leaves no workspace path in the MCP
 * initialize request or roots list. Refuse project-relative work in that state
 * rather than silently reading and editing MOZCODE's own installed source.
 *
 * scripts/install-codex.mjs registers the same bundle by absolute path without
 * forcing cwd, so Codex starts it in the user's workspace. MOZCODE_PROJECT is
 * also available as an explicit host override.
 */
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function resolveProject(): { project: string; unresolved: boolean } {
  const override = process.env.MOZCODE_PROJECT;
  if (override) return { project: path.resolve(override), unresolved: false };

  const cwd = process.cwd();
  const hostConfirmedCwd = process.env.MOZCODE_TRUST_CWD === "1";
  return {
    project: cwd,
    unresolved: !hostConfirmedCwd && path.resolve(cwd) === path.resolve(PLUGIN_ROOT),
  };
}

const { project: PROJECT, unresolved: PROJECT_UNRESOLVED } = resolveProject();

const UNRESOLVED_MESSAGE =
  `MOZCODE could not determine which project to work on: it was launched inside its own ` +
  `plugin directory (${PLUGIN_ROOT}), so every relative path would resolve against MOZCODE's ` +
  `installed source instead of your code.\n\n` +
  `Register the bundle with Codex using an absolute path:\n` +
  `  node "${PLUGIN_ROOT}/scripts/install-codex.mjs"\n\n` +
  `Then restart Codex. Alternatively, set MOZCODE_PROJECT to the absolute project path.`;

function resolvePaths(p: string): { abs: string; rel: string } {
  const abs = path.isAbsolute(p) ? p : path.resolve(PROJECT, p);
  const rel = PROJECT_UNRESOLVED
    ? path.basename(abs)
    : path.relative(PROJECT, abs) || path.basename(abs);
  return { abs, rel };
}

async function meter(result: ToolResult): Promise<ToolResult> {
  await record(PROJECT, SESSION, result.meta);
  return result;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

const TOOLS = [
  {
    name: "code_read",
    description:
      "Read source code by SYMBOL instead of whole file — returns just the requested function/class/method (with a few context lines), or a collapsed outline when no symbol is given. Prefer this over the built-in Read for code files: it returns far fewer tokens. Falls back to a plain read for unsupported languages.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or relative to the project root)." },
        symbol: { type: "string", description: "Symbol to extract, e.g. \"add\" or \"Account.deposit\". Omit for a whole-file outline." },
        context_lines: { type: "number", description: "Extra lines of context around the symbol (default 3)." },
      },
      required: ["path"],
    },
  },
  {
    name: "code_outline",
    description:
      "Return the structural skeleton of a file — every top-level and member symbol with its signature and line span, bodies omitted. The map you read before drilling into a symbol with code_read.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path (absolute or relative to the project root)." } },
      required: ["path"],
    },
  },
  {
    name: "code_search",
    description:
      "Search the codebase and return matches GROUPED BY their enclosing qualified symbol and locations, not raw lines. Prefer this over the built-in Grep for code: it collapses many line hits into the handful of functions/classes that contain them.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Regex or literal to search for." },
        path_glob: { type: "string", description: "Optional path glob to restrict the search, e.g. \"src/**/*.ts\"." },
      },
      required: ["query"],
    },
  },
  {
    name: "code_edit",
    description:
      "Replace a whole symbol (function/class/method) in place, anchored to its AST span — no line numbers, no re-read afterward. Validates the file still parses before writing. Use for whole-symbol rewrites; use the built-in Edit for small in-line tweaks.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or relative to the project root)." },
        symbol: { type: "string", description: "Symbol to replace, e.g. \"add\" or \"Account.deposit\"." },
        new_source: { type: "string", description: "The full new source for the symbol, including its signature." },
      },
      required: ["path", "symbol", "new_source"],
    },
  },
  {
    name: "db_schema",
    description:
      "Introspect an entire SQLite or PostgreSQL schema in one compact call instead of discovering it through sequential queries. Returns tables/views, columns, primary/foreign keys, and indexes only — never application rows. For SQLite pass path. For PostgreSQL set DATABASE_URL (or another environment variable) and pass connection_env; never put credentials in tool arguments.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "SQLite database path, absolute or relative to the project. Omit for PostgreSQL.",
        },
        connection_env: {
          type: "string",
          description: "Environment variable containing a PostgreSQL URL (default DATABASE_URL).",
        },
        query: {
          type: "string",
          description: "Optional filter matching table, view, column, index, or referenced-table names.",
        },
        refresh: {
          type: "boolean",
          description: "Bypass the schema cache when the database schema has just changed.",
        },
      },
    },
  },
  {
    name: "moz_savings",
    description: "Report estimated token savings for this session and all-time.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "moz_status",
    description: "Report MOZCODE server status: supported languages and metering store location.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "moz_dashboard",
    description: "Regenerate the local HTML savings dashboard from metering data and open it in the browser.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", properties: { open: { type: "boolean", description: "Open in the default browser (default true)." } } },
  },
];

const server = new Server(
  { name: "mozcode", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  // Keep moz_status available so the problem is diagnosable. Absolute paths do
  // not depend on PROJECT and remain safe to use.
  if (PROJECT_UNRESOLVED && name !== "moz_status") {
    const suppliedPath = args.path;
    const needsProject = typeof suppliedPath !== "string" || !path.isAbsolute(suppliedPath);
    if (needsProject) return textResult(UNRESOLVED_MESSAGE, true);
  }

  try {
    switch (name) {
      case "code_read": {
        const { abs, rel } = resolvePaths(String(args.path));
        const r = await meter(await codeRead(abs, rel, { symbol: args.symbol as string | undefined, contextLines: args.context_lines as number | undefined }));
        return textResult(r.text);
      }
      case "code_outline": {
        const { abs, rel } = resolvePaths(String(args.path));
        const r = await meter(await codeOutline(abs, rel));
        return textResult(r.text);
      }
      case "code_search": {
        const r = await meter(await codeSearch(PROJECT, String(args.query), args.path_glob as string | undefined));
        return textResult(r.text);
      }
      case "code_edit": {
        const { abs, rel } = resolvePaths(String(args.path));
        const r = await meter(await codeEdit(abs, rel, String(args.symbol), String(args.new_source)));
        return textResult(r.text, r.degraded && r.text.includes("rejected"));
      }
      case "db_schema": {
        const r = await meter(await dbSchema(PROJECT, {
          path: args.path as string | undefined,
          connectionEnv: args.connection_env as string | undefined,
          query: args.query as string | undefined,
          refresh: args.refresh as boolean | undefined,
        }));
        return textResult(r.text);
      }
      case "moz_savings": {
        const all = summarize(await loadEntries());
        const session = summarize((await loadEntries()).filter((e) => e.session === SESSION));
        return textResult(
          `MOZCODE estimated savings (illustrative, not a billing figure):\n` +
            `• This session: ${session.totalSaved.toLocaleString()} tokens saved across ${session.calls} calls (${session.avgReductionPct.toFixed(0)}% avg reduction).\n` +
            `• All-time: ${all.totalSaved.toLocaleString()} tokens saved across ${all.calls} calls, ${all.projects} project(s).\n` +
            `Run moz_dashboard for the full breakdown.`,
        );
      }
      case "moz_status": {
        return textResult(
          `MOZCODE v${VERSION} — active.\n` +
            `• Supported languages (AST): ${SUPPORTED_LANGUAGES.join(", ")} (others fall back to plain reads).\n` +
            `• Database schema introspection: SQLite + PostgreSQL metadata (db_schema).\n` +
            `• Session: ${SESSION}\n` +
            (PROJECT_UNRESOLVED
              ? `• Project: UNRESOLVED — project-relative tools are disabled.\n\n${UNRESOLVED_MESSAGE}\n`
              : `• Project: ${PROJECT}\n`) +
            `• Metering store: ${mozcodeHome()}/metering/`,
        );
      }
      case "moz_dashboard": {
        const { path: out, totalSaved, calls } = await generateDashboard();
        if (args.open !== false) openInBrowser(out);
        return textResult(`Dashboard written to ${out} (${totalSaved.toLocaleString()} est. tokens saved over ${calls} calls). Opening in your browser.`);
      }
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`MOZCODE ${name} failed: ${msg}`, true);
  }
});

async function main(): Promise<void> {
  // Publish the active session for this project so the statusline can attribute
  // "this session" savings exactly (SESSION is per-process, not Claude's id).
  await writeCurrentSession(PROJECT, SESSION);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`[mozcode] MCP server ready (session ${SESSION.slice(0, 8)})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[mozcode] fatal:", err);
  process.exit(1);
});
