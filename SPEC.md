# Context Router & Gatherer

Repository: [https://github.com/shadetheory/context-router](https://github.com/shadetheory/context-router)

This document describes the behavior in this repository. The planner is deterministic code. A local model is optional and is used only when keywords and embeddings are not confident.

## Pipeline

```
ask
  → planQuery
       1. keyword and intent rules
       2. else local token embeddings
       3. else LocalModel, if the caller provided one
       4. constraints (files are not panes, live PR/CI status is not memory,
          repositories must be named, session and agent tools stay distinct)
  → gather
       independent reads via Promise.allSettled
       per-tool timeout
       partial failure
       content-hash dedupe
       rank
       hard output budget
  → one summary string
```

Parallel execution is a latency win. The output budget is what limits context. Fan-in cannot return more than `maxChars`, no matter how many reads succeed.

## Planner

`planQuery(query, options)` returns a `QueryPlan`:

- `tools`: selected reads and their params
- `gaps`: asks this catalog cannot answer
- `ambiguous`: true only when no route was confident and a model did not resolve one
- `usedModel`: true only when step 3 ran
- `selections`: whether each tool came from `keyword`, `embedding`, `model`, or `constraint`

Obvious asks do not call `options.model`. Tests cover that with a model spy.

### Keyword routes

Phrases are matched against the normalized ask (lowercase, punctuation stripped). These are the routes the tests lock in:

| Ask | Tools | Notes |
| --- | --- | --- |
| who is online | `bus_sessions` | Not `herdr_agent_list` |
| which agents are running | `herdr_agent_list` | Not `bus_sessions` |
| who is online and which agents are running | both | Both were named |
| what panes are open | `herdr_pane_list` | |
| list files in project | `workspace_map` | Panes are not files |
| find decisions about NAS | `vector_search`, `knowledge_retrieve` | Object params, query preserved |
| what do you know about asgard | those memory tools | No repository is invented |
| what did we decide this session | `smart_recall` | |
| where is gather defined | `workspace_map` | Code question, no repo named |
| where is gather defined in shadetheory/context-router | `repo_spatial` | Only that slug |
| where is the router defined in asgard | `repo_spatial` | Only when `knownRepos` maps the alias |
| check PR status for lex | none | Gap `live_pr_status`. Memory tools are not a substitute |
| ci status | none | Gap `live_ci_status`, same rule |

`knowledge_retrieve` and `vector_search` are always objects: `{ query, limit, timeout_ms }`. `true` is not a valid planner result. A legacy `true` passed into the gatherer is normalized to an object.

Default timeouts are 5000 ms for memory, 3000 ms for live tools, and 10000 ms for `repo_spatial`. Default retrieval `limit` is 5.

### Embeddings

If no keyword rule matches, the ask is embedded as a bag of tokens (unigrams, plus adjacent tokens at a lower weight) and compared with cosine similarity to a small prototype list. No network and no model.

A tool is selected when its best prototype scores at least 0.8 and leads the next tool by at least 0.05. Otherwise the ask is ambiguous.

"are the panes open now" is the embedding case. It does not contain the contiguous phrase "open panes", and it still selects `herdr_pane_list` without a model.

### Local model

`LocalModel.complete(prompt)` is called only for an ambiguous ask, and only when the caller passed a model. The prompt asks for JSON naming allowed tools. Unknown tools are dropped. The same constraints applied to keyword plans are applied to the model plan, so a model cannot turn a file listing into a pane listing, answer live PR status from memory, or attach a repository the user did not name.

If the model is missing or its reply is not usable, the plan stays empty and says so. The planner does not fan out every tool as a guess.

There is no weekly retrain loop in this milestone. Misroute logs are not written.

## Gatherer

`gather(plan, deps)` runs the selected reads.

- Reads are independent. There is no dependency graph.
- `Promise.allSettled` waits for the batch. One rejection does not drop the others.
- Each read has its own timeout and an `AbortSignal`. A timeout names the tool and leaves sibling results in the summary.
- Two plan keys that share the same executor function and the same params run once. `herdr_agent_list` is not wired to `bus_sessions`. `herdr_pane_list` is not wired to `workspace_map`. If the host did not supply a method, the summary says that tool has no executor.
- Results are split into hits. Relevance comes from `score` when a tool reports it (otherwise 0.5). `age` or `age_days` is content age.
- Dedupe hashes whitespace-collapsed text with SHA-256. The higher-ranked copy is kept and the sources are merged.
- Rank is `0.5 * relevance + 0.3 * recency + 0.2 * freshness`.
  - Recency is how old the content is. Missing timestamps use 0.5. A week of age cuts the recency term roughly in half.
  - Freshness is how recently this process observed the hit. Live reads are fresh. A hit marked stale scores 0.
- The built-in catalog is read-only. If a tool is marked `write`, it runs only when `approval.writeTools` lists it for that call.

### Cache

| Tool | Cache |
| --- | --- |
| `vector_search`, `knowledge_retrieve`, `smart_recall` | In-memory, 5 minutes, keyed by tool and params |
| `herdr_agent_list`, `herdr_pane_list`, `bus_sessions`, `workspace_map` | Never. A seeded entry is not read or written. |
| `repo_spatial` | Never. The index can go stale between calls. |

### Output budget

`Budget.maxChars` is a hard ceiling on the summary string (default 4000). `perItemChars` (default 600) clips a single hit before it competes. `budgetFromTokens(maxTokens)` uses 4 characters per token.

Packing keeps higher-ranked hits and drops the rest. The omission note counts toward the ceiling. `enforceBudget` is the last step, so the returned string length is always `<= maxChars`. A budget of 0 returns an empty string.

Calling more tools does not grant a larger summary. Both reads still run; the text the main model sees stays inside one budget.

### Summary shape

```
## Context
- [source] text

## Gaps
- message

## Errors
- tool failed or timed out

## Notes
- index or exclusion notes
[omitted N lower-ranked items; output budget M chars]
```

Empty sections are omitted.

## repo_spatial

Issue #1 asks for an opt-in per-repository code index. This milestone ships the hook, not the indexer.

```ts
interface RepoSpatialProvider {
  enabledRepos(): readonly string[] | Promise<readonly string[]>;
  retrieve(request: RepoSpatialRequest): Promise<RepoSpatialResponse>;
}

interface RepoSpatialFallback {
  search(request: RepoSpatialRequest): Promise<RepoSpatialSnippet[]>;
}
```

Contract:

- `enabledRepos` is the opt-in list. An empty list means the index is off. The gatherer does not call `retrieve` for a repo that is absent from that list, and it never indexes a repo on its own.
- `retrieve` returns snippets (path, optional symbol and lines, text, optional revisions). The gatherer packs them under the output budget.
- Paths that look like secrets (`.env` and `.env.*`, credential and secret files, `id_rsa`, `*.pem`, `*.key`, `.npmrc`) or generated output (`node_modules`, `dist`, `build`, `coverage`, `vendor`, `.next`, `generated`, minified bundles, source maps) are dropped even if a provider returns them. A source file whose name contains the word "secret" is not dropped for that reason.
- A response with `status: "stale"`, `stale: true`, or a snippet whose `sourceRevision` differs from `currentRevision` is not current source. Those snippets are discarded. Direct search is used when a fallback was provided. If it was not, the summary records `repo_spatial_stale` and does not invent the file contents.
- A disabled or missing index uses the same direct file/search fallback. Direct search is not an index.
- The provider is responsible for indexing symbols, structure, and references, and for refreshing changed files. That work is out of scope here. `unavailableRepoSpatial` is the default: no repos enabled, and `retrieve` reports that nothing is configured.

## Entrypoints

| File | Role |
| --- | --- |
| `src/planner.ts` | `planQuery`, constraints, plan normalization |
| `src/gatherer.ts` | Parallel reads, cache policy, rank, budget |
| `src/repo-spatial.ts` | Index hook and path filter |
| `src/lookup.ts` | Plan then gather |
| `handler-context-router.ts` | `route-context <ask>` → JSON plan |
| `handler-context-gatherer.ts` | Plan JSON → bounded summary |
| `index.ts` | `/lookup <ask>` → bounded summary |

Host tools are passed in. This package does not import a Pi SDK. A host method is bound only to the tool of the same name.

## Tests

```bash
npm test
npm run typecheck
```

Node.js 22.18 or newer. The suite covers planner routes (including the old bad examples), gatherer overlap, timeout, partial failure, dedupe, rank, live-cache bypass, write approval, the output budget, and the `repo_spatial` opt-in, stale, and secret rules.

## Not in this milestone

- A code indexer, file watcher, or automatic indexing of every repository
- Treating a stale index as a stand-in for current source
- Write or merge tools
- Misroute logs and a retrain loop
