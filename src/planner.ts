import { cosine, embed, normalizeQuery } from "./text.ts";
import {
  TIMEOUTS_MS,
  TOOL_NAMES,
  type Gap,
  type KnownRepo,
  type PlanOptions,
  type PlanTools,
  type QueryPlan,
  type Selection,
  type ToolName,
  type Via,
} from "./types.ts";

/** Minimum cosine for an embedding hit. Keyword routes do not consult this. */
const EMBED_THRESHOLD = 0.8;

const KEYWORD_PHRASES: Record<ToolName, readonly string[]> = {
  herdr_pane_list: ["what panes are open", "which panes are open", "open panes", "pane list"],
  bus_sessions: ["who is online", "whos online", "who is connected", "active sessions", "online sessions"],
  herdr_agent_list: ["agent list", "which agents", "what agents", "running agents", "agents are running"],
  workspace_map: [
    "list files",
    "project files",
    "file tree",
    "project structure",
    "workspace map",
    "files in project",
    "files in the project",
  ],
  vector_search: ["what do you know", "what do we know", "decisions about", "find decisions", "find patterns", "search memory"],
  knowledge_retrieve: ["what do you know", "what do we know", "decisions about", "find decisions", "find patterns", "documented"],
  smart_recall: ["this session", "this conversation", "what did we say", "what did we decide", "smart recall", "session memory"],
  repo_spatial: [],
};

const PROTOTYPES: Record<ToolName, readonly string[]> = {
  herdr_pane_list: ["what panes are open", "open panes", "show panes", "visible panes"],
  bus_sessions: ["who is online", "active sessions", "connected sessions"],
  herdr_agent_list: ["which agents are running", "agent list", "running agents"],
  workspace_map: ["list files in project", "project file tree", "workspace structure"],
  vector_search: ["find decisions", "what do you know", "search memory"],
  knowledge_retrieve: ["retrieve knowledge", "documented decisions", "knowledge about"],
  smart_recall: ["earlier this session", "what did we say", "session memory"],
  repo_spatial: ["where is this function defined", "symbol reference in the repo", "implementation in repo"],
};

const PATH_OWNERS = new Set([
  "src", "dist", "test", "tests", "node_modules", "vendor", "app", "lib", "bin",
  "and", "or", "build", "out", "coverage",
]);

const TOOL_SET = new Set<string>(TOOL_NAMES);

interface Routed {
  tools: Set<ToolName>;
  via: Via;
  score: Partial<Record<ToolName, number>>;
  matched: boolean;
}

export function buildModelPrompt(query: string): string {
  return [
    "You are a context router. Choose tools for an ambiguous request.",
    'Reply with JSON only, no prose. Shape: {"tools":["tool_name"]}.',
    `Allowed tools: ${TOOL_NAMES.join(", ")}.`,
    "Do not invent tools. Omit a tool when you are unsure.",
    "Panes are not files. Do not use herdr_pane_list to list files.",
    "Do not answer live pull-request or CI status from stored memory.",
    "Do not name a repository the user did not mention.",
    `Query: ${JSON.stringify(query)}`,
  ].join("\n");
}

export async function planQuery(query: string, options: PlanOptions = {}): Promise<QueryPlan> {
  const original = query.trim();
  const normalized = normalizeQuery(original);
  const routed = routeDeterministic(normalized, options);
  let usedModel = false;
  let ambiguous = false;
  const gaps: Gap[] = [];

  if (!routed.matched && options.model) {
    usedModel = true;
    ambiguous = true;
    try {
      const names = parseModelTools(await options.model.complete(buildModelPrompt(original)));
      for (const name of names) {
        routed.tools.add(name);
        routed.via = "model";
        routed.score[name] = routed.score[name] ?? 0;
      }
    } catch {
      gaps.push({
        code: "model_unusable",
        message: "The local routing model did not return a usable plan.",
      });
    }
  } else if (!routed.matched) {
    ambiguous = true;
    gaps.push({
      code: "ambiguous_query",
      message: "The ask is ambiguous and no local model is configured, so no tools were guessed.",
    });
  }

  const constrained = enforcePlanConstraints(original, toolsFromNames(routed.tools), options);
  const selections: Partial<Record<ToolName, Selection>> = {};
  for (const name of Object.keys(constrained.tools) as ToolName[]) {
    const addedByConstraint = !routed.tools.has(name);
    selections[name] = {
      via: addedByConstraint ? "constraint" : routed.via,
      score: routed.score[name] ?? 1,
    };
  }

  const mergedGaps = dedupeGaps([...constrained.gaps, ...gaps]);
  const toolCount = Object.keys(constrained.tools).length;
  return {
    tools: constrained.tools,
    gaps: mergedGaps,
    ambiguous: routed.matched || (usedModel && toolCount > 0) ? false : ambiguous,
    usedModel,
    selections,
  };
}

/**
 * Hard rules applied after keyword, embedding, and model selection.
 * A model cannot turn a file listing into a pane listing, answer live PR
 * status from memory, or attach a repository the user did not name.
 */
export function enforcePlanConstraints(
  query: string,
  tools: PlanTools,
  options: PlanOptions = {},
): { tools: PlanTools; gaps: Gap[] } {
  const normalized = normalizeQuery(query);
  const next: PlanTools = { ...tools };
  const gaps: Gap[] = [];
  const repos = mentionedRepos(normalized, options.knownRepos ?? []);

  if (fileIntent(normalized) && !paneIntent(normalized)) {
    delete next.herdr_pane_list;
    if (!next.workspace_map) next.workspace_map = { timeout_ms: TIMEOUTS_MS.live };
  }
  if ((prStatusIntent(normalized) || ciStatusIntent(normalized)) && !memoryIntent(normalized)) {
    delete next.vector_search;
    delete next.knowledge_retrieve;
    delete next.smart_recall;
    if (prStatusIntent(normalized)) {
      gaps.push({
        code: "live_pr_status",
        message: "No live pull-request tool is available. Stored memory was not queried, because it cannot answer current PR status.",
      });
    }
    if (ciStatusIntent(normalized)) {
      gaps.push({
        code: "live_ci_status",
        message: "No live CI tool is available. Stored memory was not queried, because it cannot answer current CI status.",
      });
    }
  }
  if (next.bus_sessions && next.herdr_agent_list) {
    if (sessionIntent(normalized) && !agentIntent(normalized)) delete next.herdr_agent_list;
    if (agentIntent(normalized) && !sessionIntent(normalized)) delete next.bus_sessions;
  }
  if (next.repo_spatial) {
    if (repos.length === 0) delete next.repo_spatial;
    else next.repo_spatial = { ...next.repo_spatial, repos, query: query.trim(), timeout_ms: next.repo_spatial.timeout_ms || TIMEOUTS_MS.repo };
  }
  return { tools: fillDefaults(next, query.trim()), gaps };
}

export function mentionedRepos(normalized: string, knownRepos: readonly KnownRepo[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (repo: string) => {
    if (!repo || seen.has(repo)) return;
    seen.add(repo);
    found.push(repo);
  };
  for (const match of normalized.matchAll(/\b([a-z0-9][a-z0-9._-]{0,63})\/([a-z0-9][a-z0-9._-]{1,63})\b/g)) {
    const owner = match[1];
    const name = match[2];
    if (!owner || !name || PATH_OWNERS.has(owner) || name.includes(".")) continue;
    add(`${owner}/${name}`);
  }
  for (const known of knownRepos) {
    const alias = normalizeQuery(known.alias);
    if (alias.length < 2) continue;
    const pattern = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (pattern.test(normalized)) add(known.repo);
  }
  return found;
}

function routeDeterministic(normalized: string, options: PlanOptions): Routed {
  const keyword = keywordRoute(normalized, options);
  if (keyword.matched) return keyword;
  const embedded = embeddingRoute(normalized);
  if (embedded.matched && embedded.tool) {
    if (embedded.tool === "repo_spatial" && mentionedRepos(normalized, options.knownRepos ?? []).length === 0) {
      return { tools: new Set(), via: "embedding", score: embedded.score, matched: false };
    }
    return {
      tools: new Set([embedded.tool]),
      via: "embedding",
      score: { ...embedded.score, [embedded.tool]: embedded.best },
      matched: true,
    };
  }
  return { tools: new Set(), via: "embedding", score: embedded.score, matched: false };
}

function keywordRoute(normalized: string, options: PlanOptions): Routed {
  const tools = new Set<ToolName>();
  const score: Partial<Record<ToolName, number>> = {};
  const take = (tool: ToolName) => {
    tools.add(tool);
    score[tool] = 1;
  };
  if (includesPhrase(normalized, KEYWORD_PHRASES.herdr_pane_list)) take("herdr_pane_list");
  if (fileIntent(normalized)) take("workspace_map");
  if (sessionIntent(normalized)) take("bus_sessions");
  if (agentIntent(normalized)) take("herdr_agent_list");
  if (memoryIntent(normalized)) {
    take("vector_search");
    take("knowledge_retrieve");
  }
  if (recallIntent(normalized)) take("smart_recall");
  const repos = mentionedRepos(normalized, options.knownRepos ?? []);
  if (codeIntent(normalized) && repos.length > 0) take("repo_spatial");
  else if (codeIntent(normalized)) take("workspace_map");

  const matched = tools.size > 0 || ((prStatusIntent(normalized) || ciStatusIntent(normalized)) && !memoryIntent(normalized));
  return { tools, via: "keyword", score, matched };
}

function embeddingRoute(normalized: string): {
  matched: boolean;
  tool?: ToolName;
  best: number;
  score: Partial<Record<ToolName, number>>;
} {
  const queryVector = embed(normalized);
  const score: Partial<Record<ToolName, number>> = {};
  let bestTool: ToolName | undefined;
  let best = 0;
  let second = 0;
  for (const tool of TOOL_NAMES) {
    let toolScore = 0;
    for (const prototype of PROTOTYPES[tool]) {
      toolScore = Math.max(toolScore, cosine(queryVector, embed(prototype)));
    }
    score[tool] = toolScore;
    if (toolScore > best) {
      second = best;
      best = toolScore;
      bestTool = tool;
    } else if (toolScore > second) {
      second = toolScore;
    }
  }
  if (!bestTool || best < EMBED_THRESHOLD || best - second < 0.05) {
    return { matched: false, best, score };
  }
  return { matched: true, tool: bestTool, best, score };
}

function toolsFromNames(names: Set<ToolName>): PlanTools {
  const tools: PlanTools = {};
  for (const name of names) {
    if (name === "vector_search" || name === "knowledge_retrieve") tools[name] = { query: "", limit: 5, timeout_ms: TIMEOUTS_MS.memory };
    else if (name === "smart_recall") tools[name] = { query: "", scope: "session", limit: 5, timeout_ms: TIMEOUTS_MS.memory };
    else if (name === "repo_spatial") tools[name] = { repos: [], query: "", timeout_ms: TIMEOUTS_MS.repo };
    else tools[name] = { timeout_ms: TIMEOUTS_MS.live };
  }
  return tools;
}

function fillDefaults(tools: PlanTools, query: string): PlanTools {
  const filled: PlanTools = {};
  if (tools.vector_search) filled.vector_search = { query, limit: tools.vector_search.limit || 5, timeout_ms: tools.vector_search.timeout_ms || TIMEOUTS_MS.memory };
  if (tools.knowledge_retrieve) filled.knowledge_retrieve = { query, limit: tools.knowledge_retrieve.limit || 5, timeout_ms: tools.knowledge_retrieve.timeout_ms || TIMEOUTS_MS.memory };
  if (tools.smart_recall) {
    filled.smart_recall = {
      query,
      scope: tools.smart_recall.scope || "session",
      limit: tools.smart_recall.limit || 5,
      timeout_ms: tools.smart_recall.timeout_ms || TIMEOUTS_MS.memory,
    };
  }
  if (tools.herdr_agent_list) filled.herdr_agent_list = { timeout_ms: tools.herdr_agent_list.timeout_ms || TIMEOUTS_MS.live };
  if (tools.herdr_pane_list) filled.herdr_pane_list = { timeout_ms: tools.herdr_pane_list.timeout_ms || TIMEOUTS_MS.live };
  if (tools.bus_sessions) filled.bus_sessions = { timeout_ms: tools.bus_sessions.timeout_ms || TIMEOUTS_MS.live };
  if (tools.workspace_map) filled.workspace_map = { timeout_ms: tools.workspace_map.timeout_ms || TIMEOUTS_MS.live };
  if (tools.repo_spatial) {
    filled.repo_spatial = {
      repos: tools.repo_spatial.repos,
      query,
      timeout_ms: tools.repo_spatial.timeout_ms || TIMEOUTS_MS.repo,
    };
  }
  return filled;
}

function fileIntent(normalized: string): boolean {
  return includesPhrase(normalized, KEYWORD_PHRASES.workspace_map);
}

function paneIntent(normalized: string): boolean {
  return includesPhrase(normalized, KEYWORD_PHRASES.herdr_pane_list) || /\bpanes?\b/.test(normalized);
}

function sessionIntent(normalized: string): boolean {
  if (includesPhrase(normalized, KEYWORD_PHRASES.bus_sessions)) return true;
  return /\bonline\b/.test(normalized) && /\b(who|whos|session|sessions|connected|active|anyone|everybody|everyone)\b/.test(normalized);
}

function agentIntent(normalized: string): boolean {
  return includesPhrase(normalized, KEYWORD_PHRASES.herdr_agent_list) || /\bagents?\b/.test(normalized);
}

function memoryIntent(normalized: string): boolean {
  return includesPhrase(normalized, KEYWORD_PHRASES.vector_search)
    || includesPhrase(normalized, KEYWORD_PHRASES.knowledge_retrieve)
    || /\b(remember|knowledge)\b/.test(normalized);
}

function recallIntent(normalized: string): boolean {
  return includesPhrase(normalized, KEYWORD_PHRASES.smart_recall);
}

function codeIntent(normalized: string): boolean {
  return /\b(where is|where are|defined|definition|implementation|implements|symbol|function|class|method|call sites?|references?|codebase|source code)\b/.test(normalized);
}

function prStatusIntent(normalized: string): boolean {
  return /\b(prs?|pull requests?)\b/.test(normalized) && /\b(status|state|check|merged|closed)\b/.test(normalized);
}

function ciStatusIntent(normalized: string): boolean {
  return /\b(ci|github actions)\b/.test(normalized) && /\b(status|failing|failed|green|red|passing)\b/.test(normalized);
}

function includesPhrase(normalized: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => normalized.includes(normalizeQuery(phrase)));
}

function parseModelTools(text: string): ToolName[] {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("model returned no JSON object");
  const payload = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  return toolNamesFromPayload(payload);
}

function toolNamesFromPayload(payload: unknown): ToolName[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const source = record.tools ?? record;
  if (Array.isArray(source)) {
    return source.filter((name): name is ToolName => typeof name === "string" && TOOL_SET.has(name));
  }
  if (!source || typeof source !== "object") return [];
  return Object.keys(source).filter((name): name is ToolName => TOOL_SET.has(name));
}

function dedupeGaps(gaps: Gap[]): Gap[] {
  const seen = new Set<string>();
  const out: Gap[] = [];
  for (const gap of gaps) {
    if (seen.has(gap.code)) continue;
    seen.add(gap.code);
    out.push(gap);
  }
  return out;
}

/** Normalize a planner result or a legacy tool map. Does not re-route the ask. */
export function coercePlan(input: unknown): QueryPlan {
  const record = typeof input === "string" ? JSON.parse(input) as unknown : input;
  if (!record || typeof record !== "object") {
    return { tools: {}, gaps: [], ambiguous: false, usedModel: false, selections: {} };
  }
  const raw = record as Record<string, unknown>;
  const toolSource = raw.tools && typeof raw.tools === "object" ? raw.tools as Record<string, unknown> : raw;
  const tools: PlanTools = {};
  for (const name of TOOL_NAMES) {
    if (!(name in toolSource)) continue;
    const value = toolSource[name];
    if (value === false || value == null) continue;
    const fields = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (name === "vector_search" || name === "knowledge_retrieve") {
      tools[name] = {
        query: typeof fields.query === "string" ? fields.query : "",
        limit: numberIn(fields.limit, 1, 20) ?? 5,
        timeout_ms: numberIn(fields.timeout_ms, 1, 60_000) ?? TIMEOUTS_MS.memory,
      };
    } else if (name === "smart_recall") {
      const scope = fields.scope === "project" || fields.scope === "session" ? fields.scope : "session";
      tools[name] = {
        query: typeof fields.query === "string" ? fields.query : "",
        scope,
        limit: numberIn(fields.limit, 1, 20) ?? 5,
        timeout_ms: numberIn(fields.timeout_ms, 1, 60_000) ?? TIMEOUTS_MS.memory,
      };
    } else if (name === "repo_spatial") {
      const fromArray = Array.isArray(value) ? value : fields.repos;
      const repos = Array.isArray(fromArray) ? fromArray.filter((repo): repo is string => typeof repo === "string") : [];
      tools[name] = {
        repos,
        query: typeof fields.query === "string" ? fields.query : "",
        timeout_ms: numberIn(fields.timeout_ms, 1, 60_000) ?? TIMEOUTS_MS.repo,
      };
    } else {
      tools[name] = { timeout_ms: numberIn(fields.timeout_ms, 1, 60_000) ?? TIMEOUTS_MS.live };
    }
  }
  return {
    tools,
    gaps: Array.isArray(raw.gaps) ? dedupeGaps(raw.gaps as Gap[]) : [],
    ambiguous: Boolean(raw.ambiguous),
    usedModel: Boolean(raw.usedModel),
    selections: {},
  };
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return undefined;
  return value;
}
