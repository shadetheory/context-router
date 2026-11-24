import { createHash } from "node:crypto";
import {
  buildTieBreakPrompt,
  matchCapabilitiesDeterministic,
  parseTieBreak,
  type Capability,
  type CapabilityMatch,
} from "./catalog.ts";
import { planQuery } from "./planner.ts";
import {
  TIMEOUTS_MS,
  type Gap,
  type LocalModel,
  type PlanOptions,
  type QueryPlan,
  type ToolName,
} from "./types.ts";

export const PLAN_VERSION = 1;

/** One ledger-model line per model call: which model, why it was needed, and how it went. */
export interface ModelLedgerEntry {
  purpose: "tool-routing" | "capability-tie-break";
  model: string;
  why: string;
  at: string;
  outcome: "ok" | "unusable";
  elapsedMs: number;
}

export type StepTarget =
  | { kind: "tool"; name: ToolName }
  | { kind: "capability"; name: string; capability: string; entity: string; target: string };

export interface PlanStep {
  /** Stable within a plan; use it as the job / call id. */
  id: string;
  target: StepTarget;
  args: Record<string, unknown>;
  timeout_ms: number;
  /** Characters this step may contribute to the packed report. */
  budget_chars: number;
  risk: "read" | "low" | "high";
  /** High-risk capabilities are recorded and wait for Jordan's yes; nothing runs them. */
  requires_approval: boolean;
  /** Reads may overlap. Capability actions run alone. */
  concurrent: boolean;
  via: string;
  score: number;
}

/** The planner's output: N bounded calls the fan-out executor can run as jobs. */
export interface ExecutionPlan {
  version: number;
  id: string;
  query: string;
  created_at: string;
  budget: { total_chars: number; code_chars: number };
  deadline_ms: number;
  steps: PlanStep[];
  gaps: Gap[];
  ambiguous: boolean;
  used_model: boolean;
  model_calls: ModelLedgerEntry[];
}

export interface BuildPlanOptions extends PlanOptions {
  /** Asgard's capability catalog, from `loadAsgardCatalog`. */
  catalog?: readonly Capability[];
  budget?: { maxChars?: number; codeMaxChars?: number };
  deadlineMs?: number;
  now?: () => Date;
  /** Called once per model call so a host can append it to the ledger-model log. */
  onModelCall?: (entry: ModelLedgerEntry) => void;
}

const DEFAULT_TOTAL = 6_000;
const DEFAULT_CODE = 3_000;
const DEFAULT_DEADLINE = 10_000;

/**
 * Plan an ask end to end: read tools from the deterministic router, house
 * capabilities from Asgard's catalog. A local model is consulted only when
 * routing is ambiguous or two capabilities tie, and every call is logged.
 */
export async function buildPlan(query: string, options: BuildPlanOptions = {}): Promise<ExecutionPlan> {
  const now = options.now ?? (() => new Date());
  const modelCalls: ModelLedgerEntry[] = [];
  const record = (entry: ModelLedgerEntry) => {
    modelCalls.push(entry);
    options.onModelCall?.(entry);
  };
  const total = positive(options.budget?.maxChars) ?? DEFAULT_TOTAL;
  const code = Math.min(total, positive(options.budget?.codeMaxChars) ?? Math.min(DEFAULT_CODE, Math.floor(total / 2)));
  const deadline = positive(options.deadlineMs) ?? DEFAULT_DEADLINE;

  const gaps: Gap[] = [];
  const capabilityMatches = await planCapabilities(query, options, record, now, gaps);
  // An ask that is a house action is not also an ambiguous context read.
  const readOptions: PlanOptions = {
    knownRepos: options.knownRepos,
    codeHost: options.codeHost,
    model: capabilityMatches.length > 0 ? undefined : ledgered(options.model, "tool-routing", record, now,
      "No keyword or embedding route was confident for this ask, so the local model picks read tools. Local only; no cloud fallback."),
  };
  const reads: QueryPlan = await planQuery(query, readOptions);

  const steps: PlanStep[] = [];
  const readNames = Object.keys(reads.tools) as ToolName[];
  const nonCode = readNames.filter((name) => name !== "repo_spatial").length;
  for (const name of readNames) {
    const args = reads.tools[name] as unknown as Record<string, unknown>;
    const selection = reads.selections[name];
    steps.push({
      id: `s${steps.length + 1}`,
      target: { kind: "tool", name },
      args,
      timeout_ms: Math.min(deadline, Number(args.timeout_ms) || TIMEOUTS_MS.memory),
      budget_chars: name === "repo_spatial" ? code : Math.floor((total - (readNames.includes("repo_spatial") ? code : 0)) / Math.max(1, nonCode)),
      risk: "read",
      requires_approval: false,
      concurrent: true,
      via: selection?.via ?? "keyword",
      score: selection?.score ?? 1,
    });
  }
  for (const match of capabilityMatches) {
    const cap = match.capability;
    steps.push({
      id: `s${steps.length + 1}`,
      target: { kind: "capability", name: cap.tool, capability: cap.id, entity: cap.entity, target: match.target },
      args: { entity: cap.entity, target: match.target },
      timeout_ms: cap.timeoutMs,
      budget_chars: 0,
      risk: cap.risk,
      requires_approval: cap.risk === "high",
      concurrent: false,
      via: match.via,
      score: match.score,
    });
    if (cap.risk === "high") {
      gaps.push({ code: "needs_jordan", message: `${cap.id} (${cap.tool}) is high risk. It is planned and waits for Jordan's yes; nothing runs it.` });
    }
    if (!cap.wired) {
      gaps.push({ code: "capability_unwired", message: `${cap.id} is in Asgard's catalog but ${cap.tool} is not wired yet. ${cap.recommendedBuild ?? ""}`.trim() });
    }
  }

  const allGaps = dedupe([...reads.gaps.filter((gap) => !(capabilityMatches.length > 0 && gap.code === "ambiguous_query")), ...gaps]);
  return {
    version: PLAN_VERSION,
    id: planId(query, now()),
    query: query.trim(),
    created_at: now().toISOString(),
    budget: { total_chars: total, code_chars: code },
    deadline_ms: deadline,
    steps,
    gaps: allGaps,
    ambiguous: steps.length === 0 && (reads.ambiguous || allGaps.some((gap) => gap.code === "ambiguous_query")),
    used_model: modelCalls.length > 0,
    model_calls: modelCalls,
  };
}

/**
 * The fan-out executor (parallel-tools-rs CLI) takes `{version, options, tools, calls}`.
 * This fills `options` and `calls`; the host supplies `tools` (how each name runs).
 * Approval-gated steps go in unapproved, so the executor refuses them.
 */
export function toParallelToolsBatch(plan: ExecutionPlan): {
  version: 1;
  options: { mode: "parallel"; timeout_ms: number };
  calls: Array<{ id: string; name: string; args: Record<string, unknown>; approved: boolean }>;
} {
  return {
    version: 1,
    options: { mode: "parallel", timeout_ms: plan.deadline_ms },
    calls: plan.steps.map((step) => ({
      id: `${plan.id}:${step.id}`,
      name: step.target.name,
      args: step.args,
      approved: false,
    })),
  };
}

async function planCapabilities(
  query: string,
  options: BuildPlanOptions,
  record: (entry: ModelLedgerEntry) => void,
  now: () => Date,
  gaps: Gap[],
): Promise<CapabilityMatch[]> {
  if (!options.catalog || options.catalog.length === 0) return [];
  const { matches, tie } = matchCapabilitiesDeterministic(query, options.catalog);
  if (matches.length > 0 || tie.length === 0) return matches;
  if (!options.model) {
    gaps.push({ code: "ambiguous_query", message: `The ask could be ${tie.map((m) => m.capability.id).join(" or ")}. No local model is configured to break the tie, so none was planned.` });
    return [];
  }
  const model = ledgered(options.model, "capability-tie-break", record, now,
    `Embedding scores tie between ${tie.map((m) => `${m.capability.id} (${m.score.toFixed(2)})`).join(" and ")}. The local model breaks the tie. Local only; no cloud fallback.`)!;
  try {
    const picked = parseTieBreak(await model.complete(buildTieBreakPrompt(query, tie)), tie);
    return picked ? [picked] : [];
  } catch {
    gaps.push({ code: "model_unusable", message: "The local tie-break model did not return a usable pick." });
    return [];
  }
}

/** Wrap a local model so each call writes one ledger-model entry, success or not. */
function ledgered(
  model: LocalModel | undefined,
  purpose: ModelLedgerEntry["purpose"],
  record: (entry: ModelLedgerEntry) => void,
  now: () => Date,
  why: string,
): LocalModel | undefined {
  if (!model) return undefined;
  return {
    name: model.name,
    async complete(prompt: string) {
      const started = Date.now();
      const base = { purpose, model: model.name ?? "local-model", why, at: now().toISOString() };
      try {
        const text = await model.complete(prompt);
        record({ ...base, outcome: text.trim() ? "ok" : "unusable", elapsedMs: Date.now() - started });
        return text;
      } catch (error) {
        record({ ...base, outcome: "unusable", elapsedMs: Date.now() - started });
        throw error;
      }
    },
  };
}

function planId(query: string, at: Date): string {
  return createHash("sha256").update(`${at.toISOString()}\n${query}`).digest("hex").slice(0, 12);
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function dedupe(gaps: Gap[]): Gap[] {
  const seen = new Set<string>();
  return gaps.filter((gap) => (seen.has(gap.code) ? false : (seen.add(gap.code), true)));
}
