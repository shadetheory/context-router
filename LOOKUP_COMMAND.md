# /lookup Slash Command

A unified interface for context gathering: `router` (classify query) → `gatherer` (parallel fetch) → formatted output.

## Usage

```markdown
/lookup what do you know about asgard
/lookup who is online
/lookup list all panes
/lookup find decisions about NAS
```

## How It Works

1. **Router**: Parses query → JSON tool plan (local model)
2. **Gatherer**: Fires all tools in parallel → merge results
3. **Format**: Structured markdown with citations

## Files

- `~/.pi/agent/skills/context-router/index.ts` — query → tool plan
- `~/.pi/agent/skills/context-gatherer/index.ts` — tool plan → parallel fetch → merge
- `~/.pi/agent/learning/context-routes.json` — feedback loop (misroutes)
- `~/.pi/agent/learning/context-errors.json` — tool errors

## Example

Input:

```
/lookup what do you know about asgard
```

Router output (intermediate):

```json
{
  "vector_search": {"query": "asgard", "limit": 5},
  "knowledge_retrieve": {"query": "asgard", "limit": 5},
  "repo_spatial": ["shadetheory/asgard"]
}
```

Gatherer parallel calls:

- `vector_search({"query": "asgard", "limit": 5})`
- `knowledge_retrieve({"query": "asgard", "limit": 5})`
- `repo_spatial(["shadetheory/asgard"])`

Final output:

```markdown
## Context from memory
- [vector] "Pi Improvement Loop - 2026-10-20 circuit breaker around /api/embed" (score: 0.88, age: 20d)
- [knowledge_retrieve] "Vector memory sidecar health check" (score: 0.76, age: 4d)

## Repos
- shadetheory/asgard (main, 48 commits latest)
```

## Next Steps

1. Implement `/lookup` wrapper skill (slash command) that chains router → gatherer
2. Test with 5–10 queries, log misroutes
3. Build feedback loop (weekly retrain on misroutes)
4. Add feedback UI (✅/❌ buttons in pi chat)
