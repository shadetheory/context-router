/** Tools the planner is allowed to emit. All of them are reads. */
export const TOOL_NAMES = [
  "vector_search",
  "knowledge_retrieve",
  "smart_recall",
  "herdr_agent_list",
  "herdr_pane_list",
  "bus_sessions",
  "workspace_map",
  "repo_spatial",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolMode = "read" | "write";

/** Agent, pane, session, and workspace snapshots change underneath a cache. */
export const LIVE_TOOLS: ReadonlySet<ToolName> = new Set([
  "herdr_agent_list",
  "herdr_pane_list",
  "bus_sessions",
  "workspace_map",
]);

export const MEMORY_TOOLS: ReadonlySet<ToolName> = new Set([
  "vector_search",
  "knowledge_retrieve",
  "smart_recall",
]);

export const TIMEOUTS_MS = {
  memory: 5_000,
  live: 3_000,
  repo: 10_000,
} as const;

export interface VectorParams {
  query: string;
  limit: number;
  timeout_ms: number;
}

export interface RecallParams {
  query: string;
  scope: "project" | "session";
  limit: number;
  timeout_ms: number;
  kinds?: string[];
}

export interface LiveParams {
  timeout_ms: number;
}

export interface RepoParams {
  repos: string[];
  query: string;
  timeout_ms: number;
}

export interface PlanTools {
  vector_search?: VectorParams;
  knowledge_retrieve?: VectorParams;
  smart_recall?: RecallParams;
  herdr_agent_list?: LiveParams;
  herdr_pane_list?: LiveParams;
  bus_sessions?: LiveParams;
  workspace_map?: LiveParams;
  repo_spatial?: RepoParams;
}

export type Via = "keyword" | "embedding" | "model" | "constraint";

export interface Selection {
  via: Via;
  score: number;
}

export type GapCode =
  | "live_pr_status"
  | "live_ci_status"
  | "ambiguous_query"
  | "model_unusable"
  | "repo_spatial_disabled"
  | "repo_spatial_stale"
  | "repo_spatial_unavailable"
  | "write_requires_approval";

export interface Gap {
  code: GapCode;
  message: string;
}

export interface QueryPlan {
  tools: PlanTools;
  gaps: Gap[];
  /** True when no deterministic route was confident and a model did not resolve one. */
  ambiguous: boolean;
  usedModel: boolean;
  selections: Partial<Record<ToolName, Selection>>;
}

export interface Budget {
  /** Hard ceiling on the summary string returned to the main model. */
  maxChars: number;
  /** Max characters of a single hit before it competes for the budget. */
  perItemChars: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxChars: 4_000,
  perItemChars: 600,
};

export interface Hit {
  sources: ToolName[];
  text: string;
  relevance: number;
  /** When the underlying content was created, if the tool reported it. */
  createdAt?: number;
  /** When this process observed the content. */
  observedAt: number;
  live: boolean;
  stale: boolean;
}

export interface ToolError {
  tool: string;
  message: string;
}

export interface GatherResult {
  summary: string;
  omitted: number;
  errors: ToolError[];
  gaps: Gap[];
  /** Executor invocations. Coalesced duplicate reads count once. */
  invocations: string[];
  cacheHits: string[];
  cacheBypassed: string[];
}

export interface LocalModel {
  /** Complete a short routing prompt. Called only for ambiguous asks. */
  complete(prompt: string): Promise<string>;
}

export interface KnownRepo {
  /** Name that may appear in an ask, such as "asgard". */
  alias: string;
  /** owner/name slug. */
  repo: string;
}

export interface PlanOptions {
  model?: LocalModel;
  knownRepos?: readonly KnownRepo[];
}

export type ToolExecutor = (
  params: unknown,
  ctx: { signal: AbortSignal; tool: ToolName },
) => Promise<unknown>;

export interface WriteApproval {
  /** Write-capable tools the caller explicitly approved for this gather. */
  writeTools: readonly string[];
}
