# WOZCODE (Woz) — Technical Teardown

*Research date: 24 July 2026 · Confidence legend: ✅ confirmed · 🔶 strong inference · ❓ speculation*

> **Disclosure:** WOZCODE is a third-party plugin that modifies the behaviour of Anthropic's Claude Code. This teardown was produced by Anthropic's model. Findings are sourced and labelled so the reader can audit them independently, but readers should weight the assessment accordingly — particularly the sections on benchmark claims and on how much of the value is attributable to the plugin versus the underlying model.

---

## 1. Executive summary

WOZCODE is a plugin for Claude Code that reduces token consumption — the company claims 25–55% cost reduction, 5–10× speedups on database work, and 30–40% on general tasks. ✅ It is built by Woz (YC W25), an eight-person San Francisco company that raised a $6M seed after pivoting away from its original product, an "AI technical cofounder" app-builder for non-technical founders. ✅

The mechanism is not, in any meaningful sense, an AI mechanism. WOZCODE replaces Claude Code's built-in file tools (`Read`, `Grep`, `Glob`, `Edit`) with alternatives served from a **local Node MCP server**, which parse source files into ASTs using bundled tree-sitter grammars and return only the requested symbol rather than the whole file. 🔶 A second lever is plain model routing: a read-only `woz:explore` subagent is pinned to Haiku, so codebase scanning runs on a cheaper model. ✅

This is a well-chosen problem. In an agentic loop, conversation context is re-sent on every turn, so a token wasted on an over-broad file read early in a session is paid for repeatedly until compaction. Attacking bytes-per-tool-call therefore compounds superlinearly with session length — which is why the savings are plausible even though the technique is unglamorous. The company's own framing supports the diagnosis: their launch post describes finding that roughly half their tokens were going to erroneous reads and re-reads after edits. ✅

The most consequential architectural finding is that **nothing proprietary sits in the request path**. The plugin's `.mcp.json` spawns a local `node` process; there is no remote MCP URL, and the company states plainly that no servers receive user code and no proxies intercept LLM calls. ✅ The Woz account gates quota, billing, and a savings dashboard — not compute.

Two claims deserve scrutiny. First, the headline "80% on Terminal-Bench 2.0" is self-reported on a benchmark version whose maintainers subsequently released 2.1 to fix defects in 28 of 89 tasks; the 2.0 leaderboard carries no verified results at all. ✅ Second, independent technical evaluation of WOZCODE is essentially absent — the discourse is company-authored material, testimonials hosted on the company's own site, and AI-generated review-farm content that contradicts the official documentation. That is an evidence gap, not evidence of a problem, but it should be stated plainly.

Biggest unknowns: the exact tool surface exposed by the MCP server, whether any portion of the work is remote, and how the savings figure is computed against a counterfactual baseline that by definition cannot be observed.

---

## 2. Company snapshot

| | |
|---|---|
| **Company** | Woz (WithWoz) |
| **Batch** | Y Combinator W25 ✅ |
| **Founded** | 2024 ✅ |
| **Founders** | Ben Collins (CEO), Brad Eckert (CTO) ✅ |
| **Headcount** | ~8 ✅ |
| **Location** | San Francisco ✅ |
| **Funding** | $500K pre-seed (Mar 2025); $6M seed ✅ |
| **Investors** | Cervin Ventures, Burst Capital, Y Combinator, Untapped Ventures, MGV, the Lacob family ✅ |
| **Product surfaces** | Claude Code plugin (CLI, Claude Desktop, VS Code, Conductor), web dashboard at app.wozcode.com ✅ |

Brad Eckert's background is the more informative signal: MIT EECS, AI master's dropout, co-author on 25+ patents, previously founder/CTO at Cairns Health (YC S17, formerly Totemic) where he led a 30+ person engineering team, with prior work on deep-learning radar in consumer electronics. ✅ Embedded/DSP-adjacent experience is consistent with a team comfortable writing native parsing code rather than reaching for a model.

**The pivot is the key company fact.** Woz originally sold an "AI technical cofounder" — a platform where non-technical founders described an app in plain English and the system designed, coded, tested, deployed, and maintained it. ✅ That product still exists at `withwoz.com` with its own pricing tiers, including a "Human Assistance" plan offering support from human engineers and designers. ✅ WOZCODE is a hard pivot to developer cost-optimisation, and by the company's own account it began as an internal fix after their Claude Code spend crossed $100K in a month. ✅

That origin story matters for a competitive read: the product was dogfooded before it was productised, which usually correlates with the technique being real. It also means the current company has two live products with unrelated audiences — a strategic tension worth watching.

### Pricing ✅

- **Free, no account** — plugin fully functional; two-command install; no signup, no card.
- **Free account (optional)** — savings dashboard, $100/month in free Claude Code savings; $200/month with a corporate email address.
- **Pro / Enterprise** — require an account for billing; a monthly free-plan cap exists, after which a fallback agent (`woz:code-free`) disables the WOZCODE MCP tools and reverts to Claude Code's built-ins until reset or upgrade. ✅

The metered structure is unusual and revealing: they are selling *savings* and capping the amount they will give away, which implies their own cost of serving a session is non-zero — most plausibly telemetry, dashboarding, and the knowledge-base features rather than the local parsing itself. 🔶

---

## 3. What the product does

WOZCODE installs into Claude Code via its plugin marketplace and, once active, transparently substitutes its own tooling for the built-ins. The user changes nothing about their workflow; a `woz:code` badge appears beside the input field to signal the agent is active. ✅

Surface area, as declared in the plugin manifest: ✅

**Three agents**
- `woz:code` — the default main-thread agent. Coding, editing, search, SQL. Delegates automatically.
- `woz:explore` — read-only exploration: file searches, symbol lookups, "where is X defined / called / how does X flow". **Pinned to Haiku.** The manifest's stated rationale is that the cheaper model makes delegation pay for itself on any real scan.
- `woz:code-free` — fallback when the monthly free cap is exhausted; WOZCODE MCP tools are disallowed and built-ins return.

**One MCP server** — `code`, flagged admin-level, requiring one secret.

**Eleven hooks across nine events**, matching all tools — meaning hooks execute on every tool call, not a filtered subset.

**Fifteen skills**, of which the most substantive is `/woz-kb`, a knowledge base backing an automated code reviewer. Its subcommands are unusually telling: `tune` (end-to-end reviewer tuning), `backtest`, `architecture-doc-fetch`, `cross-repo` (cross-repo planning briefs), plus `status`, `query`, `note`, `suppress`, `boost`, `ingest`, `refresh`, `ops`. ✅ `boost` and `suppress` are ranking controls; `backtest` implies evaluating reviewer changes against historical data. This is a retrieval-and-ranking system with a tuning loop, and it is the one component of the product that looks like it could accrete a genuine data advantage. 🔶

**Commands**: `/woz-login`, `/woz-logout`, `/woz-recall` (saved context and preferences), `/woz-savings`, `/woz-settings`, `/woz-status`, `/woz-update`. ✅

**Closest comparables.** Two adjacent open-source plugins appear in the same directory: `claude-code-token-saver` (claiming 45% measured cost reduction via cache-expiry prevention, subtask auto-delegation, and context restoration) and `governor` (context slimming and tool-output filtering for Max users). ✅ Neither has WOZCODE's install base, but their existence establishes that the category is contested and that the core idea is not exclusive.

---

## 4. How it works — the pipeline

### 4.1 Integration path

Claude Code's plugin system supports four extension types: MCP servers, agents, hooks, and skills/commands. WOZCODE uses all four simultaneously, which is what allows it to intercept behaviour rather than merely add to it. 🔶

```
Claude Code session start
   │
   ├─ plugin loads .mcp.json → spawns LOCAL process:
   │     node --no-warnings servers/code-server.js        ✅ (alwaysLoad: true)
   │
   ├─ agent woz:code becomes default main-thread agent    ✅
   │     └─ system prompt steers model to WOZCODE tools over built-ins   🔶
   │
   ├─ 11 hooks register across 9 events, matching all tools ✅
   │     └─ incl. a CWD-injection hook (WOZCODE_MCP_CWD_HOOK_INJECTED=1) ✅
   │
   └─ PostHog analytics client initialised (project token in env)        ✅
```

### 4.2 The core loop — why tokens drop

The claimed mechanism, reconstructed: 🔶

1. **Model requests code context.** Steered by the `woz:code` agent definition, it calls a WOZCODE search tool instead of `Grep`/`Glob`/`Read`.
2. **Server parses, not greps.** `code-server.js` uses bundled tree-sitter grammars — the repo ships a `grammars/` directory and a `build/Release` path indicating a compiled native Node addon — to build an AST of the candidate files. ✅ *(directories confirmed; their use for AST parsing is inference 🔶)*
3. **Returns a symbol, not a file.** Rather than the whole 2,000-line module, the response carries the single function, class, or span requested, plus structural context. This is where the bulk of the input-token reduction comes from. 🔶
4. **Edits are AST-anchored.** Because the edit targets a node rather than a matched string, the model does not need to re-read the file afterwards to re-establish position. This directly addresses the "re-reads after edits" waste the founders describe. 🔶
5. **Exploration is delegated downward.** Anything resembling a broad scan routes to `woz:explore` on Haiku. Read-only work runs at a fraction of the main model's cost. ✅
6. **Savings are metered and surfaced.** Actual usage is diffed against an estimated baseline and reported via `/woz-savings` and the status line. ✅

### 4.3 SQL introspection

The 5–10× speedup claim is specific to database tasks, and the mechanism is likely the same idea in a different domain: introspect the schema once, up front, and hand the model a compact structural summary — instead of letting it discover the schema through a sequence of exploratory queries whose results all land in context. 🔶 The company's own demo runs ten sequential queries against a public clinical-trials database spanning 68 tables. ✅ On a schema that wide, exploratory discovery is exactly where an agent burns its budget, so the benchmark is well-chosen — arguably chosen because it maximally favours the technique.

### 4.4 What runs where

**Locally:** everything in the request path. The MCP server is a local stdio process; the company states no servers receive code and no proxies intercept LLM calls; the plugin is described as 100% JavaScript with zero server-side components. ✅

**Remotely:** authentication and token refresh, savings dashboard, PostHog telemetry, plugin updates, quota accounting, and — probably — some portion of the `/woz-kb` knowledge base. 🔶

The security posture is a genuine differentiator relative to any proxy-based competitor: your code never leaves the machine. It is worth noting alongside this that the plugin runs hooks on every tool call at admin access level, which the community directory flags with a low trust score. ✅ That is a structural property of doing this job at all — you cannot intercept tool calls without intercepting tool calls — but it is a meaningful supply-chain consideration for a closed-source bundle, and users should weigh it consciously.

---

## 5. Tech stack

| Layer | Technology | Confidence | Evidence |
|---|---|---|---|
| Language | JavaScript (100% of repo) | ✅ | GitHub language stats |
| Runtime | Node.js, spawned via `node --no-warnings=ExperimentalWarning` | ✅ | `.mcp.json` |
| Integration | Claude Code plugin API — MCP + agents + hooks + skills | ✅ | plugin manifest |
| Transport | Local stdio MCP (no remote URL) | ✅ | `.mcp.json` |
| Parsing | tree-sitter grammars + compiled native addon | 🔶 | `grammars/`, `build/Release` directories |
| Distribution | Bundled JS in `chunks/`, `node_modules` committed, marketplace + repo in one | ✅ | repo tree |
| Model routing | Haiku for `woz:explore` | ✅ | plugin manifest, README |
| Analytics | PostHog (US region, project token in plugin env) | ✅ | `.mcp.json` |
| Auth | OAuth-style browser flow; access + refresh tokens; headless paste-back path | ✅ | README |
| Settings | `~/.claude/settings.json` under a `wozcode` key | ✅ | README |
| Index | `codex/` directory — purpose undetermined, plausibly a symbol or session index | ❓ | repo tree only |
| Website | wozcode.com; app.wozcode.com; help.withwoz.com | ✅ | direct |

**Evidence trail worth highlighting.** The single most informative artifact is the 15-line `.mcp.json`. It settles the local-versus-remote question outright, exposes the analytics vendor and project token, and reveals a CWD-injection hook via an environment flag. A file most readers would skim past establishes the entire architectural posture. This is the general lesson of teardown work: configuration files are written to be executed, not to persuade.

**Release cadence.** 54+ releases, ~110 commits, v0.3.87 as of 16 July 2026, from a ~March 2026 public debut. ✅ Roughly a release every other day. Combined with a v0.3.x version number, this reads as a young product in rapid iteration, not a settled one. 196 stars, 23 forks. ✅

---

## 6. Efficiency & scale engineering

**The economics they exploit.** In an agentic coding loop, cost is dominated by *input* tokens, because the accumulated conversation is re-sent on every turn. A file read into context at turn 3 is paid for again at turns 4, 5, 6 … until compaction. A saving made early therefore compounds across the remainder of the session. This is why a mundane technique — return less text — can plausibly produce a 25–50% reduction, and why savings should scale with session length. 🔶

Back-of-envelope: if an average built-in `Read` returns a 400-line file where 40 lines were needed, symbol-level extraction cuts roughly 90% of that call's payload, and that reduction repeats on every subsequent turn in the window. Even at modest tool-call frequency, the arithmetic reaches the claimed range without anything clever happening. ❓ *(illustrative, not measured)*

**Their cost structure.** Near-zero marginal cost per session: parsing runs on the user's CPU, inference is billed to the user's own Claude subscription. Woz pays for auth, telemetry, dashboard, and knowledge-base infrastructure only. 🔶 This is an unusually favourable position — a developer tool with no inference bill — and it explains how they can give away $100–200/month of savings per free account.

**Latency.** The 5–10× database and 30–40% general speedups are consistent with round-trip elimination rather than faster inference: fewer tool calls and fewer tokens to generate and transmit. Local tree-sitter parsing costs single-digit milliseconds, far below any network round trip, so the trade is strongly favourable. 🔶

**On the benchmark claim.** The company cites 80% on Terminal-Bench 2.0 (an earlier YC listing cited 68% vs. 58% for Claude Code alone — the claim has moved over time ✅). Three caveats, all documented:

1. Terminal-Bench 2.0 results are self-reported; the tracked leaderboard shows zero verified results across 49 models. ✅
2. Terminal-Bench 2.1 was released specifically to repair 28 of 89 tasks in 2.0, covering stale external dependencies, resource budgets too tight for valid solutions, and instructions that did not match tests. ✅ 2.1 submissions require public trajectories for verification; 2.0 did not.
3. Agent-model pairing dominates these scores — the benchmark's own maintainers report results per model-agent combination precisely because the harness makes a large difference. ✅ A plugin score is therefore inseparable from the model underneath it, and the comparison baseline needs stating to be interpretable.

None of this means the number is wrong. It means it is unverified on a superseded benchmark version, and the cost and latency claims — which are directly measurable by any user via `/woz-savings` or their own billing — are the sturdier ground.

---

## 7. Open questions & unknowns

| # | Question | What would resolve it |
|---|---|---|
| 1 | What is the exact tool surface of the `code` MCP server? | Run the plugin and enumerate tools, or inspect `servers/code-server.js` |
| 2 | Is any work delegated to a remote Woz service, or is it fully local? | Network trace during a session; inspect the bundle's outbound calls |
| 3 | What is `codex/` for — symbol index, session recall store, or bundled model? | Directory listing and file inspection |
| 4 | How is "savings" computed against an unobservable counterfactual baseline? | Company methodology disclosure; independent A/B replication |
| 5 | Which tree-sitter grammars ship, i.e. which languages get AST treatment vs. fallback? | List `grammars/` contents |
| 6 | Is the `/woz-kb` knowledge base per-user, per-repo, or shared across customers? | Docs or observed behaviour on a fresh repo |
| 7 | What does the plugin's "1 secret" and admin-level access actually cover? | Manifest inspection |
| 8 | Does the WOZCODE benchmark appear on any official leaderboard? | tbench.ai submission records |
| 9 | Does the original withwoz.com app-builder share code or infrastructure? | Job postings, shared subdomains, employee commentary |

**Research-quality note.** This teardown rests on unusually strong primary sources — the public plugin repository, its MCP configuration, and the plugin manifest — but unusually weak independent ones. There is essentially no substantive third-party technical evaluation of WOZCODE, and the review content that does surface appears machine-generated and contradicts the official documentation on basic facts such as whether a subscription is required. Claims about *magnitude* of benefit should be treated as unverified pending independent measurement; claims about *mechanism* are well-evidenced.

---

## 8. Sources

**Official / primary**
- github.com/WithWoz/wozcode-plugin — repository, README, release history
- github.com/WithWoz/wozcode-plugin/blob/main/.mcp.json — MCP server configuration (decisive artifact)
- wozcode.com and wozcode.com/docs — product claims, pricing, install
- ycombinator.com/companies/woz — company profile, founder bios, product description
- producthunt.com/products/wozcode — launch post and founder narrative
- help.withwoz.com/Plans-Pricing — original app-builder product pricing

**Directory / manifest**
- claudepluginhub.com/plugins/withwoz-woz — agents, skills, hooks, MCP server, safety signals, version history

**Funding / company**
- crunchbase.com/organization/woz-yc-w25 — funding rounds
- fenomstalent.com — $6M seed coverage, investor list
- linkedin.com/company/withwoz

**Benchmark context**
- llm-stats.com/benchmarks/terminal-bench-2 — leaderboard, self-reported status
- snorkel.ai/leaderboard/terminal-bench-2-1 — 2.1 task-defect disclosure
- epoch.ai/benchmarks/terminal-bench — agent-model pairing methodology
- tbench.ai/leaderboard/terminal-bench/2.0

**Comparables**
- claudepluginhub.com — `claude-code-token-saver`, `governor` listings

**Discounted**
- automateed.com/wozcode-review — apparent machine-generated review content; contradicts official docs on subscription requirement; not relied upon
