---
name: mozcode
description: Use MOZCODE's local symbol-level MCP tools for codebase exploration, structural search, AST-anchored edits, database schema discovery, and token-savings reporting. Trigger for repository coding, debugging, refactoring, code search, schema inspection, or MOZCODE dashboard requests when the MOZCODE tools are available.
---

# MOZCODE

Use MOZCODE to keep model context small and precise. The server runs locally and
returns the relevant symbol or structure instead of entire source files.

## Code workflow

1. Start unfamiliar code work with `code_outline` to map the target file without
   loading function bodies.
2. Use `code_search` for behavioral or literal searches. Results are grouped by
   enclosing symbol so the model can choose what to inspect next.
3. Use `code_read` with a symbol name to load only the function, class, method, or
   declaration needed for the task.
4. Use `code_edit` when replacing a complete symbol. Preserve the symbol's public
   contract unless the user requested an API change.
5. Use normal filesystem tools for documentation, config, generated files, tiny
   inline changes, or when a MOZCODE tool reports an unsupported language.

Do not read a whole source file after a successful symbol read unless missing
context makes that necessary. Do not claim token savings that the metering tools
did not report.

## Database workflow

Call `db_schema` before database implementation or diagnosis when a SQLite path or
PostgreSQL connection environment variable is available. Prefer its metadata-only
schema map over iterative catalog queries. Never place credentials directly in a
tool argument; pass the name of the environment variable that holds the connection
URL.

## Savings and status

- Use `moz_savings` for measured session and all-time savings.
- Use `moz_status` to confirm languages, server status, and local data paths.
- Use `moz_dashboard` to regenerate the self-contained local dashboard. Set
  `open` to false in headless environments.

Treat cost, time, and avoided-call numbers as modelled estimates. The dashboard
states the assumptions used. MOZCODE does not send source or metering data to an
external service.
