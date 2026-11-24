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
  "code_host",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolMode = "read" | "write";

/** Agent, pane, session, and workspace snapshots change underneath a cache. */
export const LIVE_TOOLS: ReadonlySet<ToolName> = new Set([
  "herdr_agent_list",
  "herdr_pane_list",
  "bus_sessions",
  "workspace_map",
  "code_host",
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
  codeHost: 8_000,
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
  /** Live pull-request / CI read from the code host. Planned only when the host has one. */
  code_host?: RepoParams;
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
  | "write_requires_approval"
  | "needs_jordan"
  | "capability_unwired";

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
  /** Hard ceiling on code-search (repo_spatial) lines inside the summary. Never above maxChars. */
  codeMaxChars: number;
}

/** Jordan's Nov 9 budget: 6,000 characters in total, at most 3,000 of them code search. */
export const DEFAULT_BUDGET: Budget = {
  maxChars: 6_000,
  perItemChars: 600,
  codeMaxChars: 3_000,
};

/** A gather returns what it has at this point. Reads that land later are dropped and logged. */
export const DEFAULT_DEADLINE_MS = 10_000;

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
  /** Where this text came from: repo:path:line for code, tool:ref or tool#n otherwise. */
  cite: string;
}

export interface ToolError {
  tool: string;
  message: string;
}

/** A read that had not finished when the gather deadline passed. Its result is never used. */
export interface LateResult {
  tool: string;
  deadlineMs: number;
}

export interface PackStats {
  /** Characters the reads returned before dedupe, clipping, and budgets. */
  rawChars: number;
  /** Length of the summary handed back. */
  packedChars: number;
  /** Characters of code-search lines kept in the summary. */
  codeChars: number;
  /** packedChars / rawChars, rounded to 3 places. 0 when nothing came back. */
  ratio: number;
}

export interface GatherResult {
  summary: string;
  omitted: number;
  /** Citation for each context line kept in the summary, in summary order. */
  citations: string[];
  late: LateResult[];
  stats: PackStats;
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
  /** Model tag, for the ledger-model line. */
  name?: string;
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
  /** The host can read live PR and CI state, so those asks go to `code_host`, not to a gap. */
  codeHost?: boolean;
}

export type ToolExecutor = (
  params: unknown,
  ctx: { signal: AbortSignal; tool: ToolName },
) => Promise<unknown>;

export interface WriteApproval {
  /** Write-capable tools the caller explicitly approved for this gather. */
  writeTools: readonly string[];
}
