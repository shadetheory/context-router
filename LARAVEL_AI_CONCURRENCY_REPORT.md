# Laravel AI Concurrency Feasibility Report

> Status: the gatherer in this repository runs the tool reads with `Promise.allSettled`, per-tool timeouts, and a hard output budget. See `SPEC.md`. The notes below are the original feasibility write-up and are not the current design.

## Date: 2026-11-09
## Author: pi

## Executive Summary
The `laravel/ai` package (`^0.10.3`) **does not provide native concurrency primitives** for parallel tool calls. Concurrency must be implemented at the application layer using Laravel's existing concurrency tools (queues, promises, Symfony Process) or PHP extensions (`pcntl_fork`, `parallel` extension not installed).

## Findings

### 1. Laravel AI Package Structure
- No `concurrent`, `batch`, `all`, `wait`, `await`, or `Promise` classes found in source
- `Pending*Generation.php` classes exist but all are synchronous in interface
- `AiManager`, `AiServiceProvider`, `Pending*` classes — all synchronous

### 2. PHP Concurrency Options
| Option | Installed? | Notes |
|--------|------------|-------|
| `pcntl` | ✅ Yes | `pcntl_fork()` available for process-level parallelism |
| `parallel` extension | ❌ No | Not installed |
| Laravel queues | ✅ Yes | Use `Dispatchable`, `Queueable` for async jobs |
| Symfony Process | ✅ Yes | `Symfony\Component\Process\Process` for CLI parallelism |

### 3. Laravel AI Usage Pattern (Current)
```php
// Current (synchronous)
response = Ai::text()->message('Hello')->send();
```

### 4. Suggested Concurrency Pattern
```php
// Parallel context gathering (JavaScript/Node)
const results = await Promise.allSettled([
  vector_search(query),
  knowledge_retrieve(query),
  herdr_pane_list(),
  workspace_map(),
]);

// Or PHP with pcntl_fork
$children = [];
foreach ($tools as $tool) {
    $pid = pcntl_fork();
    if ($pid === 0) {
        // child: execute tool
        exit(0);
    }
    $children[] = $pid;
}
```

## Recommendation

**Use `Promise.allSettled` in JavaScript/TypeScript** for context gatherer because:
1. ** pi code is in Ts ** — already wired to all tools
2. No external PHP dependencies needed
3. Native support for error handling (`anyhow` style) per call
4. Already proven in sidecar, auto-indexer, qdrant-monitor

## Next Steps
1. Implement `context-gatherer/index.ts` with `Promise.allSettled`
2. Timing benchmark: sequential vs concurrent (10 calls each)
3. `/lookup` slash command → router → gatherer
4. 10-query test loop, log misroutes to `~/.pi/agent/learning/context-routes.json`

## References
- `laravel/ai` source: `/home/jordan/Projects/jordanpartridge/asgard/vendor/laravel/ai/src/`
- pi tools: `vector_search`, `knowledge_retrieve`, `herdr_agent_list`, `herdr_pane_list`, `bus_sessions`, `workspace_map`, `smart_recall`, `repo_spatial`
