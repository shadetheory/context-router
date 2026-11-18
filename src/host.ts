import type { Budget, KnownRepo, LocalModel, ToolExecutor, ToolName } from "./types.ts";
import type { RepoSpatialFallback, RepoSpatialProvider } from "./repo-spatial.ts";

/** Host tool bag. Each read is optional and mapped only onto itself. */
export interface HostTools {
  vector_search?: (input: unknown) => Promise<unknown>;
  knowledge_retrieve?: (input: unknown) => Promise<unknown>;
  smart_recall?: (input: unknown) => Promise<unknown>;
  herdr_agent_list?: (input: unknown) => Promise<unknown>;
  herdr_pane_list?: (input: unknown) => Promise<unknown>;
  bus_sessions?: (input: unknown) => Promise<unknown>;
  workspace_map?: (input: unknown) => Promise<unknown>;
  localModel?: LocalModel;
  knownRepos?: readonly KnownRepo[];
  repoSpatial?: RepoSpatialProvider;
  repoFallback?: RepoSpatialFallback;
  outputBudget?: Partial<Budget>;
}

/**
 * Bind host methods to executors without wrapping them, so two plan keys that
 * point at the same function collapse to one read.
 * `herdr_agent_list` is not aliased onto `bus_sessions`, and
 * `herdr_pane_list` is not aliased onto `workspace_map`.
 */
export function executorsFromHost(tools: HostTools | undefined): Partial<Record<ToolName, ToolExecutor>> {
  if (!tools) return {};
  const executors: Partial<Record<ToolName, ToolExecutor>> = {};
  const bind = (name: ToolName, fn: ((input: unknown) => Promise<unknown>) | undefined) => {
    if (typeof fn === "function") executors[name] = fn as ToolExecutor;
  };
  bind("vector_search", tools.vector_search);
  bind("knowledge_retrieve", tools.knowledge_retrieve);
  bind("smart_recall", tools.smart_recall);
  bind("herdr_agent_list", tools.herdr_agent_list);
  bind("herdr_pane_list", tools.herdr_pane_list);
  bind("bus_sessions", tools.bus_sessions);
  bind("workspace_map", tools.workspace_map);
  return executors;
}
