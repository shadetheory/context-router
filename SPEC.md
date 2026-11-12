# Context Router & Gatherer — Specification

## Vision

Build a self-improving system that automatically gathers exactly the context needed for each task, by dynamically selecting and parallelizing the right tools.

**Goal:** 0 manual context lookups. Every task gets the full context automatically.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                    USER QUERY                                   │
│                                "what do you know..."                            │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           CONTEXT ROUTER (Model)                              │
│  - Input: natural language query                                               │
│  - Output: JSON tool plan (which tools, with what params)                      │
│  - Prompt: 3-shot examples + rules                                             │
│  - Model: qwen3-coder-next:48k (cold ~3s, warm ~0.8s)                          │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          PARALLEL GATHERER (Code)                             │
│  - Fires all tools in parallel (Promise.all)                                  │
│  - Merge, dedupe, rank by recency/relevance                                   │
│  - Return structured context with citations                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            FINAL CONTEXT FEED                                   │
│  - Context blocks: [vector], [history], [live], [repos]                       │
│  - Feed into main prompt                                                       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Tool Plan Schema

Each tool key maps to `true` (call with defaults) or `{params}`.

```json
{
  "vector_search": {"query": "...", "limit": 5},
  "knowledge_retrieve": {"query": "...", "limit": 5},
  "smart_recall": {"query": "...", "scope": "project", "limit": 5},
  "herdr_agent_list": true,
  "herdr_pane_list": true,
  "bus_sessions": true,
  "workspace_map": true,
  "repo_spatial": ["owner/repo1", "owner/repo2"]
}
```

---

## Router Prompt

```
You are a context-router. Turn natural language queries into exact tool call plans.

Output ONLY valid JSON like:
{
  "vector_search": {"query": "...", "limit": 5},
  "knowledge_retrieve": true,
  "smart_recall": {"query": "...", "scope": "project", "limit": 5},
  "herdr_agent_list": true,
  "herdr_pane_list": true,
  "bus_sessions": true,
  "workspace_map": true,
  "repo_spatial": ["owner/repo1", "owner/repo2"]
}

Rules:
- Only include tools you're confident about
- Don't duplicate tools
- Don't invent tools not listed above
- If unsure, omit the tool
- repo_spatial is for GitHub repos only (owner/name or full URL string)

Examples:

Q: "what panes are open"
A: {"herdr_pane_list": true}

Q: "who is online"
A: {"bus_sessions": true}

Q: "find decisions about NAS"
A: {"vector_search": {"query": "NAS decision", "limit": 5}, "knowledge_retrieve": {"query": "NAS decision", "limit": 5}}

Q: "what do you know about asgard"
A: {"vector_search": {"query": "asgard", "limit": 5}, "knowledge_retrieve": {"query": "asgard", "limit": 5}, "repo_spatial": ["shadetheory/asgard"]}

Q: "check PR status for lex"
A: {"vector_search": {"query": "lex PR", "limit": 3}, "knowledge_retrieve": {"query": "lex PR", "limit": 3}}

Q: "list files in project"
A: {"herdr_pane_list": true}

Q: "find patterns about file manipulation"
A: {"vector_search": {"query": "file manipulation pattern", "limit": 5}, "knowledge_retrieve": {"query": "file manipulation pattern", "limit": 3}}
```

---

## Parallel Gatherer Logic

### Steps

1. **Parse plan** → extract tool names + params
2. **Fork parallel calls** using `Promise.all`
3. **Merge results** by source
4. **Dedupe** by content hash
5. **Rank** by:
   - Recency (newer = higher)
   - Relevance score (if available)
   - Freshness (last modified/updated)
6. **Format output** with source tags
7. **Log misfires** to feedback loop

### Feedback Loop

- Log failed guesses to `~/.pi/agent/learning/context-routes.json`
- Weekly retrain on misroutes
- Manual correction → edit JSON → increment `routes_version`

---

## Benefits

| Before | After |
|--------|-------|
| 5-6 sequential lookups (~800ms) | 5-6 parallel calls (~300ms wall) |
| Manual decision on which tools to call | Router auto-selects based on query |
| No learning from mistakes | Misroutes logged for retraining |
| Context scattered across sources | Context merged, deduped, ranked, cited |

---

## Implementation Plan

| Step | File | Status |
|------|------|--------|
| 1. Router prompt | `~/.pi/agent/skills/context-router/SKILL.md` | ✅ Draft |
| 2. Gatherer logic | `~/.pi/agent/skills/context-gatherer/SKILL.md` | ✅ Draft |
| 3. `/lookup` slash command | `~/.pi/agent/skills/context-router/` | 🔜 |
| 4. Feedback logging | `~/.pi/agent/learning/context-routes.json` | 🔜 |
| 5. Git repo | `github.com/shadetheory/context-router` | 🔜 |

---

## Proof of Concept

**Run 10 queries, log misroutes, retrain router.**

**Success criteria:**
- Router correctly selects tools for ≥9/10 queries
- Parallel gatherer finishes in ≤350ms wall time
- No tool calls throw unhandled errors

---

## Success Metrics

- **Latency**: 300ms wall time (vs 800ms sequential)
- **Accuracy**: ≥90% correct tool selection
- **Coverage**: All 8 tools callable
- **Learning**: Misroute count decreases week-over-week

---

## Next Steps

1. Commit spec to git repo
2. Implement router model (prompt + 3-shots)
3. Implement gatherer (parallel calls + merge)
4. Test with 10 real queries
5. Log misroutes, retrain
6. Ship to production
