# Context Router

A self-improving system that automatically gathers exactly the context needed for each task by dynamically selecting and parallelizing the right tools.

## Vision

- **Router**: Maps natural language queries → JSON tool plan using local model
- **Gatherer**: Fires all tools in parallel, merges results
- **Goal**: 0 manual context lookups. Every task gets full context automatically.

## Architecture

```
QUERY → Router (local model) → JSON plan → Gatherer (parallel) → Merged context
```

## Tools Supported

- `vector_search` — semantic memory (Qdrant)
- `knowledge_retrieve` — hybrid search (Qdrant + Meilisearch)
- `smart_recall` — session memory
- `herdr_agent_list` — agent bus agents
- `herdr_pane_list` — herdr panes
- `bus_sessions` — agent sessions
- `workspace_map` — project context
- `repo_spatial` — GitHub repos

## Usage

```bash
/lookup what do you know about asgard
```

Output:

```json
{
  "vector_search": {"query": "asgard", "limit": 5},
  "knowledge_retrieve": {"query": "asgard", "limit": 5},
  "repo_spatial": ["jordanpartridge/asgard"]
}
```

## Local Control Tools (Thor + Hyprland + Browser)

### Hyprland

- `hyprctl` — CLI for controlling Hyprland
- `hyprland -d` — debug mode for logging
- Socket interface for client automation

### qutebrowser

- IPC wrapper at `~/.local/bin/qute-ipc.sh`
- Keybindings for automation triggers
- JSON output mode for programmatic control

### AutoPilot Scripts

See `~/.local/bin/autopilot.sh` for scheduled tasks:
- Morning pages (Hacker News, Gmail, GitHub)
- Daily dashboard screenshot
- PDF save, search, etc.

## Proof of Concept

Run 10 queries, log misroutes, retrain router.

**Success criteria:**
- Router correctly selects tools for ≥9/10 queries
- Parallel gatherer finishes in ≤350ms wall time
- No unhandled errors

## Documentation

- `SPEC.md` — full specification
- `router-prompt.md` — router prompt + examples
- `gatherer-logic.md` — gatherer implementation

## License

MIT
