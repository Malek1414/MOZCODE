#!/usr/bin/env node
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { codeOutline } from "./tools/outline.js";
import { codeRead } from "./tools/read.js";
import { codeSearch } from "./tools/search.js";
import { codeEdit } from "./tools/edit.js";
import { record, loadEntries, summarize, terseHome } from "./metering/store.js";
import { SUPPORTED_LANGUAGES } from "./ast/languages.js";
import type { ToolResult } from "./tools/types.js";
import { generateDashboard, openInBrowser } from "./dashboard/generate.js";

const SESSION = crypto.randomUUID();
const PROJECT = process.cwd();

function resolvePaths(p: string): { abs: string; rel: string } {
  const abs = path.isAbsolute(p) ? p : path.resolve(PROJECT, p);
  const rel = path.relative(PROJECT, abs) || path.basename(abs);
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
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path (absolute or relative to the project root)." } },
      required: ["path"],
    },
  },
  {
    name: "code_search",
    description:
      "Search the codebase and return matches GROUPED BY their enclosing symbol (signature + location), not raw lines. Prefer this over the built-in Grep for code: it collapses many line hits into the handful of functions/classes that contain them.",
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
    name: "terse_savings",
    description: "Report estimated token savings for this session and all-time.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "terse_status",
    description: "Report Terse server status: supported languages and metering store location.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "terse_dashboard",
    description: "Regenerate the local HTML savings dashboard from metering data and open it in the browser.",
    inputSchema: { type: "object", properties: { open: { type: "boolean", description: "Open in the default browser (default true)." } } },
  },
];

const server = new Server(
  { name: "terse", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
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
      case "terse_savings": {
        const all = summarize(await loadEntries());
        const session = summarize((await loadEntries()).filter((e) => e.session === SESSION));
        return textResult(
          `Terse estimated savings (illustrative, not a billing figure):\n` +
            `• This session: ${session.totalSaved.toLocaleString()} tokens saved across ${session.calls} calls (${session.avgReductionPct.toFixed(0)}% avg reduction).\n` +
            `• All-time: ${all.totalSaved.toLocaleString()} tokens saved across ${all.calls} calls, ${all.projects} project(s).\n` +
            `Run terse_dashboard for the full breakdown.`,
        );
      }
      case "terse_status": {
        return textResult(
          `Terse v0.1.0 — active.\n` +
            `• Supported languages (AST): ${SUPPORTED_LANGUAGES.join(", ")} (others fall back to plain reads).\n` +
            `• Session: ${SESSION}\n` +
            `• Project: ${PROJECT}\n` +
            `• Metering store: ${terseHome()}/metering/`,
        );
      }
      case "terse_dashboard": {
        const { path: out, totalSaved, calls } = await generateDashboard();
        if (args.open !== false) openInBrowser(out);
        return textResult(`Dashboard written to ${out} (${totalSaved.toLocaleString()} est. tokens saved over ${calls} calls). Opening in your browser.`);
      }
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult(`Terse ${name} failed: ${msg}`, true);
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`[terse] MCP server ready (session ${SESSION.slice(0, 8)})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[terse] fatal:", err);
  process.exit(1);
});
