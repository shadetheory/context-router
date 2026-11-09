# Context Router

Deterministic planner and bounded gatherer for context lookups.

Repository: [github.com/shadetheory/context-router](https://github.com/shadetheory/context-router)

An ask is planned without a model when the wording is obvious. Independent reads then run together, and the main model receives one summary that cannot exceed a hard output budget. Parallel reads cut latency. They do not raise that budget.

```
ask → planner (keywords, else embeddings, else a small local model)
    → parallel reads (timeouts, partial failure, dedupe, rank)
    → one summary clipped to the output budget
```

## Tools

| Tool | Read |
| --- | --- |
| `vector_search` | Semantic memory |
| `knowledge_retrieve` | Hybrid knowledge search. Params are always an object. |
| `smart_recall` | Session memory |
| `herdr_agent_list` | Agent roster. Not an alias of `bus_sessions`. |
| `herdr_pane_list` | Open panes. Not a file listing. |
| `bus_sessions` | Who is connected |
| `workspace_map` | Project files and workspace structure |
| `repo_spatial` | Opt-in code-index hook. See issue #1. |

Live agent, pane, session, and workspace reads skip the cache. Memory reads may be reused for five minutes. `repo_spatial` is never cached, because a stale index is not current source.

The built-in tools are reads. A write-capable tool runs only when that call passes an explicit approval.

## Examples

| Ask | Plan |
| --- | --- |
| who is online | `bus_sessions` |
| what panes are open | `herdr_pane_list` |
| list files in project | `workspace_map` |
| find decisions about NAS | `vector_search` and `knowledge_retrieve` |
| what do you know about asgard | those memory tools, and no invented repository |
| check PR status for lex | no tools. Gap: there is no live pull-request status tool |
| where is gather defined in shadetheory/context-router | `repo_spatial` for that repository |

"are the panes open now" is not a stored phrase. A local token embedding maps it to `herdr_pane_list` without calling a model. A vague ask such as "status" calls `LocalModel.complete` once, and only if a model was provided. With no model, an ambiguous ask selects nothing.

## Code index

`repo_spatial` is a host-supplied interface: enabled repositories, snippet retrieval, and a direct file/search fallback. This repository does not index code. Nothing is indexed unless the host lists that repo. Secret and generated paths are dropped. If the index is missing or stale, the gatherer uses direct search and does not present stale snippets as current source. The output budget still applies.

## Develop

Node.js 22.18 or newer.

```bash
npm test
npm run typecheck
```

`SPEC.md` is the behavior this package ships. `LOOKUP_COMMAND.md` describes `/lookup`.
