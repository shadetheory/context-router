import { createHash } from "node:crypto";
import { resolveBudget, renderBounded } from "./budget.ts";
import { MEMORY_CACHE_TTL_MS, cacheKey, isLiveTool, type ResultCache } from "./cache.ts";
import {
  filterSnippets,
  responseIsStale,
  snippetsWithinBudget,
  unavailableRepoSpatial,
  type RepoSpatialFallback,
  type RepoSpatialProvider,
  type RepoSpatialSnippet,
} from "./repo-spatial.ts";
import { clamp01, stableStringify } from "./text.ts";
import {
  DEFAULT_DEADLINE_MS,
  TIMEOUTS_MS,
  type Budget,
  type Gap,
  type GatherResult,
  type Hit,
  type LateResult,
  type PlanTools,
  type QueryPlan,
  type ToolError,
  type ToolExecutor,
  type ToolMode,
  type ToolName,
  type WriteApproval,
} from "./types.ts";

export interface GatherInput {
  tools: PlanTools;
  gaps?: Gap[];
}

export interface GatherDeps {
  executors?: Partial<Record<ToolName, ToolExecutor>>;
  cache?: ResultCache;
  now?: () => number;
  budget?: Partial<Budget>;
  repoSpatial?: RepoSpatialProvider;
  repoFallback?: RepoSpatialFallback;
  approval?: WriteApproval;
  /** Override the read-only catalog. Write tools run only when named in `approval`. */
  modes?: Partial<Record<string, ToolMode>>;
  /** Whole-gather deadline. Reads still running then are cancelled and their results dropped. */
  deadlineMs?: number;
  /** Called when a dropped read finally settles, so a host can log how late it was. */
  onLate?: (event: { tool: string; elapsedMs: number; deadlineMs: number; status: "ok" | "error" }) => void;
}

interface Job {
  tools: ToolName[];
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<unknown>;
}

const executorIds = new WeakMap<ToolExecutor, number>();
let executorSeq = 1;

export class ToolCallError extends Error {
  readonly tool: string;
  readonly kind: "timeout" | "failure" | "cancelled";

  constructor(tool: string, kind: ToolCallError["kind"], message: string) {
    super(message);
    this.name = "ToolCallError";
    this.tool = tool;
    this.kind = kind;
  }
}

export async function runWithTimeout<T>(
  tool: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;
  if (parent?.aborted) throw new ToolCallError(tool, "cancelled", `${tool} was cancelled`);
  const work = fn(controller.signal);
  work.then(() => undefined, () => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ToolCallError(tool, "timeout", `${tool} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (parent) {
          onParentAbort = () => {
            controller.abort();
            reject(new ToolCallError(tool, "cancelled", `${tool} was cancelled`));
          };
          parent.addEventListener("abort", onParentAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parent && onParentAbort) parent.removeEventListener("abort", onParentAbort);
  }
}

type Settled =
  | { status: "fulfilled"; job: Job; value: unknown }
  | { status: "rejected"; job: Job; reason: unknown }
  | { status: "late"; job: Job };

/**
 * Run independent reads together. One failure or timeout does not cancel the
 * others. The summary is ranked, deduped, and clipped to the output budget.
 * Parallelism here is only a latency win.
 */
export async function gather(plan: GatherInput, deps: GatherDeps = {}): Promise<GatherResult> {
  const now = deps.now ?? Date.now;
  const budget = resolveBudget(deps.budget);
  const observedAt = now();
  const errors: ToolError[] = [];
  const gaps: Gap[] = [...(plan.gaps ?? [])];
  const notes: string[] = [];
  const invocations: string[] = [];
  const cacheHits: string[] = [];
  const cacheBypassed: string[] = [];
  const hits: Hit[] = [];
  const jobs: Job[] = [];
  const groups = new Map<string, { tools: ToolName[]; params: unknown; executor: ToolExecutor; timeoutMs: number }>();

  for (const tool of Object.keys(plan.tools) as ToolName[]) {
    const params = plan.tools[tool];
    if (params === undefined) continue;
    if (toolMode(tool, deps) === "write" && !deps.approval?.writeTools.includes(tool)) {
      errors.push({ tool, message: `${tool} was not called: writes require explicit approval` });
      gaps.push({
        code: "write_requires_approval",
        message: `${tool} is write-capable and was skipped pending explicit approval.`,
      });
      continue;
    }
    if (tool === "repo_spatial") {
      const timeoutMs = timeoutOf(tool, params);
      jobs.push({
        tools: [tool],
        timeoutMs,
        run: (signal) => collectRepoSpatial(params as PlanTools["repo_spatial"], deps, budget.codeMaxChars, signal),
      });
      continue;
    }
    const executor = deps.executors?.[tool];
    if (!executor) {
      errors.push({ tool, message: `${tool} has no executor` });
      continue;
    }
    const live = isLiveTool(tool);
    if (live) {
      cacheBypassed.push(tool);
    } else if (deps.cache) {
      const cached = deps.cache.get(cacheKey(tool, params));
      if (cached !== undefined) {
        cacheHits.push(tool);
        hits.push(...toHits(tool, cached, observedAt));
        continue;
      }
    }
    const key = `${executorId(executor)}:${stableStringify(params)}`;
    const existing = groups.get(key);
    if (existing) existing.tools.push(tool);
    else groups.set(key, { tools: [tool], params, executor, timeoutMs: timeoutOf(tool, params) });
  }

  for (const group of groups.values()) {
    jobs.push({
      tools: group.tools,
      timeoutMs: group.timeoutMs,
      run: async (signal) => {
        const label = group.tools.join("+");
        try {
          const value = await group.executor(group.params, { signal, tool: group.tools[0]! });
          if (deps.cache && group.tools.every((tool) => !isLiveTool(tool))) {
            for (const tool of group.tools) deps.cache.set(cacheKey(tool, group.params), value, MEMORY_CACHE_TTL_MS);
          }
          return value;
        } catch (error) {
          if (error instanceof ToolCallError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw new ToolCallError(label, "failure", `${label} failed: ${message}`);
        }
      },
    });
  }

  const deadlineMs = Number.isFinite(deps.deadlineMs) && (deps.deadlineMs ?? 0) > 0 ? deps.deadlineMs! : DEFAULT_DEADLINE_MS;
  const cancel = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, deadlineMs);
  });
  const running = jobs.map((job) => {
    const label = job.tools.join("+");
    invocations.push(label);
    const startedAt = Date.now();
    const done: Promise<Settled> = runWithTimeout(label, job.timeoutMs, job.run, cancel.signal).then(
      (value) => ({ status: "fulfilled", job, value }),
      (reason) => ({ status: "rejected", job, reason }),
    );
    return { job, label, startedAt, done };
  });
  const settled: Settled[] = await Promise.all(running.map((entry) =>
    Promise.race([entry.done, deadline.then((): Settled => ({ status: "late", job: entry.job }))])));
  if (deadlineTimer) clearTimeout(deadlineTimer);

  const late: LateResult[] = [];
  settled.forEach((result, index) => {
    if (result.status !== "late") return;
    const entry = running[index]!;
    late.push({ tool: entry.label, deadlineMs });
    notes.push(`Dropped late result from ${entry.label}: nothing arrived within the ${deadlineMs}ms deadline.`);
    entry.done.then((outcome) => {
      deps.onLate?.({
        tool: entry.label,
        elapsedMs: Date.now() - entry.startedAt,
        deadlineMs,
        status: outcome.status === "fulfilled" ? "ok" : "error",
      });
    }, () => undefined);
  });
  if (late.length > 0) cancel.abort();

  let rawChars = 0;
  for (const result of settled) {
    if (result.status === "late") continue;
    if (result.status === "rejected") {
      const reason = result.reason;
      const tool = reason instanceof ToolCallError ? reason.tool : "unknown";
      errors.push({
        tool,
        message: reason instanceof Error ? reason.message : String(reason),
      });
      continue;
    }
    const { job, value } = result;
    if (isRepoOutcome(value)) {
      rawChars += value.rawChars;
      hits.push(...value.hits);
      gaps.push(...value.gaps);
      notes.push(...value.notes);
      continue;
    }
    for (const tool of job.tools) {
      const toolHits = toHits(tool, value, observedAt);
      if (tool === job.tools[0]) rawChars += toolHits.reduce((sum, hit) => sum + hit.text.length, 0);
      hits.push(...toolHits);
    }
  }
  // Cache hits are context the caller would otherwise have paid for too.
  rawChars += hits.filter((hit) => cacheHits.includes(hit.sources[0]!)).reduce((sum, hit) => sum + hit.text.length, 0);

  const ranked = dedupe(hits, observedAt).sort((left, right) => {
    const delta = rankScore(right, observedAt) - rankScore(left, observedAt);
    if (delta !== 0) return delta;
    return left.sources.join(",").localeCompare(right.sources.join(","));
  });
  const packed = packLines(ranked, budget);
  if (packed.codeDropped > 0) {
    notes.push(`[code search capped at ${budget.codeMaxChars} chars; dropped ${packed.codeDropped} snippet${packed.codeDropped === 1 ? "" : "s"}]`);
  }
  const rendered = renderBounded({
    lines: packed.lines,
    gaps: dedupeGapMessages(gaps),
    errors: errors.map((error) => error.message),
    notes,
    maxChars: budget.maxChars,
  });

  const keptCount = packed.lines.length - rendered.omitted;
  const keptLines = packed.lines.slice(0, keptCount);
  const codeChars = keptLines.reduce((sum, line, index) => sum + (packed.code[index] ? line.length : 0), 0);
  return {
    summary: rendered.text,
    omitted: rendered.omitted + packed.codeDropped,
    citations: packed.cites.slice(0, keptCount),
    late,
    stats: {
      rawChars,
      packedChars: rendered.text.length,
      codeChars,
      ratio: rawChars > 0 ? Math.round((rendered.text.length / rawChars) * 1000) / 1000 : 0,
    },
    errors,
    gaps: dedupeGapObjects(gaps),
    invocations,
    cacheHits,
    cacheBypassed,
  };
}

const CODE_SOURCE = "repo_spatial";

/**
 * Turn ranked hits into cited summary lines. Every line names its source and a
 * citation before the body, so clipping the tail never strips the citation.
 * Code-search lines share their own cap inside the total budget.
 */
export function packLines(ranked: readonly Hit[], budget: Budget): {
  lines: string[];
  cites: string[];
  code: boolean[];
  codeDropped: number;
} {
  const lines: string[] = [];
  const cites: string[] = [];
  const code: boolean[] = [];
  let codeUsed = 0;
  let codeDropped = 0;
  for (const hit of ranked) {
    const body = hit.text.length > budget.perItemChars ? `${hit.text.slice(0, budget.perItemChars)}…` : hit.text;
    let line = `- [${hit.sources.join(", ")}] (${hit.cite}) ${body}`;
    const isCode = hit.sources.length === 1 && hit.sources[0] === CODE_SOURCE;
    if (isCode) {
      const room = budget.codeMaxChars - codeUsed;
      const head = `- [${hit.sources.join(", ")}] (${hit.cite}) `;
      if (line.length > room) {
        // Clip the first code line that does not fit; drop the rest.
        if (room > head.length + 1 && codeUsed === 0) line = `${line.slice(0, room - 1)}…`;
        else {
          codeDropped += 1;
          continue;
        }
      }
      codeUsed += line.length + 1;
    }
    lines.push(line);
    cites.push(hit.cite);
    code.push(isCode);
  }
  return { lines, cites, code, codeDropped };
}

/** Recency is content age. Freshness is how recently we observed it. */
export function rankScore(hit: Hit, now: number): number {
  const week = 7 * 24 * 60 * 60 * 1000;
  const recency = hit.createdAt == null ? 0.5 : 1 / (1 + Math.max(0, now - hit.createdAt) / week);
  const freshness = hit.stale ? 0 : hit.live ? 1 : 1 / (1 + Math.max(0, now - hit.observedAt) / 300_000);
  return 0.5 * clamp01(hit.relevance) + 0.3 * recency + 0.2 * freshness;
}

interface RepoOutcome {
  kind: "repo";
  rawChars: number;
  hits: Hit[];
  gaps: Gap[];
  notes: string[];
}

async function collectRepoSpatial(
  params: PlanTools["repo_spatial"],
  deps: GatherDeps,
  budgetChars: number,
  signal: AbortSignal,
): Promise<RepoOutcome> {
  const requested = params?.repos ?? [];
  const query = params?.query ?? "";
  const provider = deps.repoSpatial ?? unavailableRepoSpatial;
  const notes: string[] = [];
  const gaps: Gap[] = [];
  let enabled: readonly string[] = [];
  try {
    enabled = await provider.enabledRepos();
  } catch (error) {
    notes.push(`Code index could not list opted-in repos (${errorText(error)}).`);
  }
  const enabledSet = new Set(enabled);
  const optedIn = requested.filter((repo) => enabledSet.has(repo));
  const skipped = requested.filter((repo) => !enabledSet.has(repo));
  if (skipped.length > 0) {
    notes.push(`Code index is opt-in and not enabled for ${skipped.join(", ")}.`);
  }

  const request = { repos: optedIn.length > 0 ? optedIn : requested, query, budgetChars, signal };
  let responseSnippets: RepoSpatialSnippet[] = [];
  let stale = false;
  let failed = false;

  if (optedIn.length === 0) {
    failed = true;
  } else {
    try {
      const response = await provider.retrieve({ ...request, repos: optedIn });
      stale = responseIsStale(response);
      if (stale || response.status !== "ok") {
        failed = true;
        if (response.message) notes.push(response.message);
      } else {
        responseSnippets = response.snippets;
      }
    } catch (error) {
      failed = true;
      notes.push(`Code index retrieve failed (${errorText(error)}).`);
    }
  }

  if (stale) {
    notes.push("Stale index snippets were discarded. A stale index is not current source.");
    responseSnippets = [];
  }

  if (failed || stale) {
    if (deps.repoFallback) {
      try {
        const snippets = await deps.repoFallback.search({ repos: requested, query, budgetChars, signal });
        notes.push(stale ? "Used direct file search instead of the stale index." : "Used direct file search because the code index was unavailable.");
        return { kind: "repo", rawChars: snippetChars(snippets), hits: snippetHits(snippets, budgetChars, notes), gaps, notes };
      } catch (error) {
        notes.push(`Direct file search failed (${errorText(error)}).`);
      }
    }
    gaps.push(stale
      ? { code: "repo_spatial_stale", message: "The code index is stale and no direct file search fallback is configured." }
      : optedIn.length === 0
        ? { code: "repo_spatial_disabled", message: "No opted-in code index covers the requested repos, and no direct file search fallback is configured." }
        : { code: "repo_spatial_unavailable", message: "The code index is unavailable and no direct file search fallback is configured." });
    return { kind: "repo", rawChars: 0, hits: [], gaps, notes };
  }

  return { kind: "repo", rawChars: snippetChars(responseSnippets), hits: snippetHits(responseSnippets, budgetChars, notes), gaps, notes };
}

function snippetChars(snippets: readonly RepoSpatialSnippet[]): number {
  return snippets.reduce((sum, snippet) => sum + snippet.text.length + snippet.path.length, 0);
}

export function snippetCite(snippet: RepoSpatialSnippet): string {
  const where = snippet.lineStart != null
    ? `:${snippet.lineStart}${snippet.lineEnd != null && snippet.lineEnd !== snippet.lineStart ? `-${snippet.lineEnd}` : ""}`
    : "";
  return `${snippet.repo ? `${snippet.repo}:` : ""}${snippet.path}${where}`;
}

function snippetHits(snippets: RepoSpatialSnippet[], budgetChars: number, notes: string[]): Hit[] {
  const filtered = filterSnippets(snippets);
  if (filtered.dropped.length > 0) {
    notes.push(`Excluded ${filtered.dropped.length} secret or generated path${filtered.dropped.length === 1 ? "" : "s"}.`);
  }
  const bounded = snippetsWithinBudget(filtered.kept, budgetChars);
  const cut = filtered.kept.length - bounded.length;
  if (cut > 0) notes.push(`[code search capped at ${budgetChars} chars; dropped ${cut} snippet${cut === 1 ? "" : "s"}]`);
  return bounded.map((snippet) => ({
    sources: ["repo_spatial"],
    text: snippet.symbol ? `${snippet.symbol}: ${snippet.text}` : snippet.text,
    relevance: 0.6,
    observedAt: Date.now(),
    live: false,
    stale: false,
    cite: snippetCite(snippet),
  }));
}

function isRepoOutcome(value: unknown): value is RepoOutcome {
  return Boolean(value && typeof value === "object" && (value as RepoOutcome).kind === "repo");
}

const CITE_FIELDS = ["cite", "url", "source", "path", "id", "key"] as const;

function citeFor(tool: ToolName, row: unknown, index: number): string {
  if (row && typeof row === "object") {
    const record = row as Record<string, unknown>;
    for (const field of CITE_FIELDS) {
      const value = record[field];
      if ((typeof value === "string" && value.trim()) || typeof value === "number") return `${tool}:${String(value).trim()}`;
    }
  }
  return `${tool}#${index + 1}`;
}

function toHits(tool: ToolName, raw: unknown, observedAt: number): Hit[] {
  const rows = unpack(raw);
  return rows.map((row, index) => {
    const cite = citeFor(tool, row, index);
    if (typeof row === "string") {
      return { sources: [tool], text: row, relevance: 0.5, observedAt, live: isLiveTool(tool), stale: false, cite };
    }
    if (row && typeof row === "object") {
      const record = row as Record<string, unknown>;
      const text = typeof record.content === "string"
        ? record.content
        : typeof record.text === "string"
          ? record.text
          : JSON.stringify(record);
      const ageDays = typeof record.age === "number" ? record.age : typeof record.age_days === "number" ? record.age_days : undefined;
      const createdAt = typeof record.createdAt === "number"
        ? record.createdAt
        : ageDays != null
          ? observedAt - ageDays * 86_400_000
          : undefined;
      return {
        sources: [tool],
        text,
        relevance: typeof record.score === "number" ? record.score : 0.5,
        createdAt,
        observedAt,
        live: isLiveTool(tool),
        stale: record.stale === true,
        cite,
      };
    }
    return { sources: [tool], text: String(row), relevance: 0.5, observedAt, live: isLiveTool(tool), stale: false, cite };
  });
}

function unpack(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.results)) return record.results;
    if (Array.isArray(record.hits)) return record.hits;
  }
  return [raw];
}

function dedupe(hits: Hit[], now: number): Hit[] {
  const byHash = new Map<string, Hit>();
  for (const hit of hits) {
    // The same line in two files is two citations, so code hits key on their citation too.
    const key = hit.sources.includes(CODE_SOURCE) ? `${hit.cite}\n${hit.text}` : hit.text;
    const hash = createHash("sha256").update(key.replace(/\s+/g, " ").trim()).digest("hex");
    const existing = byHash.get(hash);
    if (!existing) {
      byHash.set(hash, { ...hit, sources: [...hit.sources] });
      continue;
    }
    for (const source of hit.sources) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    }
    if (rankScore(hit, now) > rankScore(existing, now)) {
      existing.relevance = hit.relevance;
      existing.createdAt = hit.createdAt;
      existing.observedAt = hit.observedAt;
      existing.live = hit.live;
      existing.stale = hit.stale;
      existing.text = hit.text;
      existing.cite = hit.cite;
    }
  }
  return [...byHash.values()];
}

function toolMode(tool: string, deps: GatherDeps): ToolMode {
  return deps.modes?.[tool] ?? "read";
}

function timeoutOf(tool: ToolName, params: unknown): number {
  if (params && typeof params === "object" && "timeout_ms" in params) {
    const value = (params as { timeout_ms?: unknown }).timeout_ms;
    if (typeof value === "number" && value > 0 && Number.isFinite(value)) return value;
  }
  if (tool === "repo_spatial") return TIMEOUTS_MS.repo;
  if (isLiveTool(tool)) return TIMEOUTS_MS.live;
  return TIMEOUTS_MS.memory;
}

function executorId(executor: ToolExecutor): number {
  let id = executorIds.get(executor);
  if (!id) {
    id = executorSeq++;
    executorIds.set(executor, id);
  }
  return id;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dedupeGapMessages(gaps: Gap[]): string[] {
  return dedupeGapObjects(gaps).map((gap) => gap.message);
}

function dedupeGapObjects(gaps: Gap[]): Gap[] {
  const seen = new Set<string>();
  const out: Gap[] = [];
  for (const gap of gaps) {
    if (seen.has(gap.code)) continue;
    seen.add(gap.code);
    out.push(gap);
  }
  return out;
}
