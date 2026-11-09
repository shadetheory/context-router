# /lookup

`/lookup` plans an ask and returns one bounded summary.

Repository: [https://github.com/shadetheory/context-router](https://github.com/shadetheory/context-router)

## Usage

```
/lookup what panes are open
/lookup who is online
/lookup list files in project
/lookup find decisions about NAS
/lookup check PR status for lex
```

## What it does

1. The planner in `src/planner.ts` builds a tool plan. Keywords and local embeddings handle obvious asks. A caller-supplied local model runs only when the ask is ambiguous.
2. The gatherer in `src/gatherer.ts` runs the selected reads with `Promise.allSettled`, a timeout per read, and partial-failure handling.
3. Hits are deduped, ranked, and packed into one summary. The summary length is at most the output budget (default 4000 characters).

Live agent, pane, session, and workspace reads are not cached. `herdr_agent_list` calls the host's agent method, not `bus_sessions`. `herdr_pane_list` lists panes, not files.

## Examples

`/lookup who is online` plans `bus_sessions` only.

`/lookup find decisions about NAS` plans `vector_search` and `knowledge_retrieve` with object params. The query text is the ask itself.

`/lookup list files in project` plans `workspace_map`.

`/lookup check PR status for lex` plans no tools. The summary says there is no live pull-request tool and does not query stored memory as a substitute.

`/lookup where is gather defined in shadetheory/context-router` plans `repo_spatial` for that repository. The gatherer calls the opt-in index hook from issue #1. If that repo is not enabled, or the index is stale, it uses direct file search when a fallback is configured. It does not invent an index and it does not return stale snippets as current source.

The entrypoint is `index.ts`. Routing and gathering can also be called on their own through `handler-context-router.ts` and `handler-context-gatherer.ts`.

## Not included

Misroute logs and a retrain loop are not part of this command. A code indexer is not included; only the `repo_spatial` hook is.
