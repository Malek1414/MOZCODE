# MOZCODE, explained in plain English

Based on `.repochad/MAP.md` and the area maps in `.repochad/map/`, at commit `b827622`.

## In one sentence

MOZCODE helps an AI coding assistant, like Claude Code or Codex, read and change your code while using fewer words, so each session costs less and finishes sooner.

## The everyday analogy: a reference librarian

Picture an AI assistant as a researcher who pays for every page it photocopies. Without help, it copies whole books just to read one paragraph. MOZCODE is a librarian standing between the researcher and the shelves.

- **The librarian's desk** is the server (`src/server.ts`). Every request comes here. The librarian decides which helper handles it and writes it down.
- **The table-of-contents service** is the code engine (`src/ast/`). It reads a book once and builds an index of every chapter and section. That lets the librarian hand over one section instead of the whole book.
- **The four counter services** are the code tools: show the table of contents (`code_outline`), hand over one section (`code_read`), find a phrase and say which chapter it is in (`code_search`), and swap out one section (`code_edit`).
- **The archive catalogue** is the database tool (`src/db/schema.ts`). Ask once and you get the full list of a database's drawers and labels, instead of opening each drawer one at a time.
- **The receipt book** is the savings ledger (`src/metering/`). After every request, the librarian notes how many pages the researcher did not have to copy.
- **The scoreboard by the door** is the status line and the dashboard (`src/statusline.ts`, `src/dashboard/`). They turn the receipts into dollars, minutes and trips saved.
- **The welcome sign** is the start-of-session note (`hooks/`). It tells the researcher, "Ask the librarian first, don't pull books off the shelf yourself."
- **The packing crew** is the build scripts (`scripts/`). They box everything up ahead of time so the user never assembles anything.
- **The inspectors** are the tests (`test/`), 72 automated checks that all pass today.

This is a clean-room copy of the same idea behind a product called WOZCODE. MOZCODE rebuilt the technique without using WOZCODE's code.

## A walk through one real use

When the assistant wants to look at one function in a large file, here is what happens behind the scenes:

1. The assistant asks MOZCODE for `code_read` on that file and function name.
2. The librarian's desk works out which project you are in. If it can't tell, it refuses most requests instead of guessing.
3. The table-of-contents service checks whether it has already indexed this file. It compares the file's size and "last changed" time. If nothing changed, it reuses the old index instantly.
4. If the file is new or changed, it reads the file and builds a fresh index of every function and class. It keeps roughly 64 MiB worth of file text (with its indexes) in memory; the budget counts file sizes only, so real memory use is higher.
5. It finds the function by name and cuts out just those lines, plus a few lines of surrounding context.
6. It counts the words (tokens) in the whole file and in the piece it is sending back. The difference is the saving.
7. It writes one receipt line into a file under `~/.mozcode` on your computer.
8. It sends back only the function. Every 5 seconds, the scoreboard re-adds all the receipts and shows something like "session: $0.42 · 18k tokens · 3m 0s · 12 roundtrips │ all-time: …".

## The parts, one by one

### The front desk (server and tools)
This one program is started by Claude Code or Codex and talks to it through a text pipe. It offers 8 tools, picks the right one for each request, and records the saving. Four of those tools are the code tools; the others cover the database, savings reports and the dashboard.
**Why it matters to you:** every saving MOZCODE promises passes through this desk. If the desk stalls, the assistant waits.

### The table-of-contents service (code engine)
It uses a well-known code-reading library, tree-sitter, to break a file into its functions and classes. It understands four languages: TypeScript, TSX, JavaScript and Python. It remembers each file's index until that file changes.
**Why it matters to you:** this is what lets the assistant read one function instead of a whole file. For other languages, reading a file hands over the whole file, and asking for its outline returns only the first 40 lines.

### The archive catalogue (database tool)
Point it at a SQLite file or a Postgres database. In one answer, it lists every table and column, one short line each. MOZCODE's own benchmark script uses a made-up 68-table database: one call stands in for 69 separate lookups, and behind the scenes MOZCODE runs only 4 database queries. The "69" and "4" are typed into the script, not counted by it.
**Why it matters to you:** the assistant learns your database's layout in one step instead of a dozen back-and-forths.

### The receipt book (metering)
Each tool call adds one line to a file in `~/.mozcode`. Word counts use the same counting method as a common AI tokenizer (o200k), not a rough guess.
**Why it matters to you:** this is where every savings number on screen comes from. If the receipts are wrong, so is the scoreboard.

### The scoreboard (status line and dashboard)
The status line is a one-line readout at the bottom of Claude Code. The dashboard is a web page with charts. Both turn saved words into money and time using fixed assumptions: $3.00 per million words, 3.5 seconds per avoided back-and-forth, and so on. Those assumptions are printed on the dashboard so you can check them.
**Why it matters to you:** it shows whether the tool is paying for itself. The figures are estimates, not a bill.

### The welcome sign and the plugin wrapping (plugin integration)
When a Claude Code session starts or resumes, a short script tells the assistant to prefer MOZCODE's tools. It also sets up the status line in your Claude settings. Codex needs a one-time setup script so MOZCODE knows which project it is working in.
**Why it matters to you:** the assistant only saves money if it actually uses these tools. The welcome sign is what reminds it to.

### The packing crew (build and benchmarks)
A script bundles everything into two ready-to-run files in `dist/`, so users never build anything. Two benchmark scripts measure word savings on real code and speed on a sample database.
**Why it matters to you:** installing is just "add the plugin". The benchmarks are the evidence behind the README's claims.

### The inspectors (tests)
There are 72 automated checks. Some test the source code directly. Others run the shipped program and talk to it like Claude would. Nothing runs these checks automatically on each change.
**Why it matters to you:** they catch breakage, but only when someone remembers to run them.

## How MOZCODE compares with WOZCODE on speed and savings

MOZCODE copies five of WOZCODE's tricks. Each one works, but each copy has a weak spot:

| WOZCODE trick | MOZCODE's version | Where it falls short |
|---|---|---|
| Show the outline, then hand over one section | Works, and repeat requests are fast | The first read of a big file has no size limit. The whole file is word-counted every time, just to measure the saving. |
| Search grouped by chapter | Works for plain searches | It reads files one by one instead of using a fast search program. The "only these folders" filter is broken. |
| Edit one section without re-reading | Works for simple cases | It can pick the wrong section when two share a name. |
| Remind the assistant to use the tools | Works at session start | The reminder is lost after the conversation is cleared or compressed. |
| Instant savings readout | Refreshes every 5 seconds | Each refresh re-reads every receipt ever written, so it gets slower the longer you use it. |

## What could go wrong today

These are the most important problems in MAP.md, translated.

1. **The "only look in these folders" search filter doesn't work.** Asking to search just `src/**/*.ts` returns nothing, even when matches exist. This was confirmed by running it.
2. **The librarian slowly runs out of desk space.** Each time it indexes a file, it opens a new tool and never puts it away. A long session uses more and more memory, and that memory is never given back.
3. **Tests and benchmarks write fake receipts into your real receipt book.** After running them, your dashboard shows savings you never earned.
4. **The dashboard's printed assumptions are out of date.** It says words are estimated at "about 4 letters each". The real count uses a proper tokenizer.
5. **A badly written search pattern can freeze everything.** The assistant's search pattern runs with no time limit. One very slow pattern blocks every later request.
6. **The front door doesn't check which rooms you go into.** Read, edit and database requests accept paths outside your project folder, such as `../other-folder` or a full path anywhere on disk.
7. **The database tool can be told to use any secret setting.** It reads a connection address from a setting the assistant names. A malicious instruction hidden in a file could point it at a different secret.
8. **An edit can hit the wrong code without saying so.** If two functions share a name, it changes the first one. In `const a = 1, b = 2`, editing `a` can also wipe out `b`.
9. **The scoreboard slows down over time.** It re-reads your entire history every 5 seconds. One damaged line in that history makes it quietly show $0.00.
10. **The first search in a big project is slow.** Files are read one at a time, up to 5,000 files. It stops at 5,000 files or 200 matches without saying anything was cut off. It also ignores your `.gitignore` list of files to skip.
11. **Heavy work blocks the whole desk.** Indexing, word counting and database reads all happen while every other request waits in line.
12. **One hiccup can switch features off until restart.** If loading a language fails once, MOZCODE remembers the failure and never retries until it is restarted. (A failed index of a single file is retried once that file changes.)
13. **Opening the dashboard can crash MOZCODE** on a computer without the usual "open in browser" helper program.
14. **Failed edits are counted as successes.** "Function not found" is reported as fine and counted as a saved round trip, which inflates the savings.
15. **Some answers have no size limit.** For unsupported languages, or a very large database, MOZCODE can send back more words than the assistant's built-in tools would.

One reported problem, that edits misplace text in files with accents or emoji, was tested and **could not be reproduced**. It is not treated as real.

## Glossary

- **Token:** a chunk of text, roughly a word piece, that AI services charge for.
- **MCP server:** a helper program an AI assistant can call for extra tools.
- **Tree-sitter:** a library that breaks code into its parts, such as functions and classes.
- **SQLite / Postgres:** two common kinds of database.
- **Status line:** the one-line readout along the bottom of Claude Code.
- **Hook:** a small script the host runs automatically at a set moment.
- **Round trip:** one back-and-forth between the assistant and a tool.
- **Clean-room rebuild:** recreating a product's idea without copying its code.

## Gaps in understanding

- **Real-world speed numbers.** The map describes where MOZCODE is slow but has no measured timings from real projects. The 3.5-second round-trip figure behind the "time saved" numbers is an assumption, not a measurement.
- **How much WOZCODE itself saves.** The map relies on WOZCODE's published claims and inferences from commit history. It does not have WOZCODE's code or measurements, so the comparison table describes MOZCODE's gaps, not exact differences.
- **How fast the memory leak grows.** The leak is confirmed in the code, but nobody has measured how many megabytes a typical session loses.
- **Postgres behaviour.** The Postgres path has no tests, so its accuracy on complex indexes is known only from reading the code.
- **Whether the model actually uses the cheaper Haiku helper.** The helper itself is set to run on Haiku, but handing work to it is only suggested in a prompt, and the map can't tell how often that suggestion is followed.
