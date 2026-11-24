import { enforceBudget, resolveBudget } from "./budget.ts";
import { gather, type GatherDeps } from "./gatherer.ts";
import { planQuery } from "./planner.ts";
import type { GatherResult, PackStats, PlanOptions, QueryPlan } from "./types.ts";

export interface LookupDeps extends GatherDeps, PlanOptions {}

export interface LookupResult extends GatherResult {
  plan: QueryPlan;
}

/** Plan an ask, then gather the selected reads into one bounded summary. */
export async function lookup(query: string, deps: LookupDeps = {}): Promise<LookupResult> {
  const plan = await planQuery(query, deps);
  const gathered = await gather(plan, deps);
  return { plan, ...gathered };
}

export interface BurstResult {
  /** One report for every ask, inside the same total and code budgets as a single lookup. */
  summary: string;
  results: LookupResult[];
  stats: PackStats;
}

/**
 * Answer several asks at once. Each ask runs concurrently with an equal share of
 * the total and code budgets, so the joined report stays inside both caps.
 */
export async function lookupBurst(queries: readonly string[], deps: LookupDeps = {}): Promise<BurstResult> {
  const asks = queries.map((query) => query.trim()).filter(Boolean);
  const budget = resolveBudget(deps.budget);
  if (asks.length === 0) {
    return { summary: "", results: [], stats: { rawChars: 0, packedChars: 0, codeChars: 0, ratio: 0 } };
  }
  const headers = asks.map((query, index) => `### Ask ${index + 1}: ${query.length > 80 ? `${query.slice(0, 79)}…` : query}`);
  const separators = Math.max(0, asks.length - 1) * 2;
  const headerChars = headers.reduce((sum, header) => sum + header.length + 1, 0);
  const room = Math.max(0, budget.maxChars - headerChars - separators);
  const share = Math.floor(room / asks.length);
  const codeShare = Math.floor(budget.codeMaxChars / asks.length);
  const results = await Promise.all(asks.map((query) => lookup(query, {
    ...deps,
    budget: { maxChars: share, perItemChars: budget.perItemChars, codeMaxChars: Math.min(share, codeShare) },
  })));
  const joined = results.map((result, index) => `${headers[index]}\n${result.summary}`).join("\n\n");
  const summary = enforceBudget(joined, budget.maxChars);
  const rawChars = results.reduce((sum, result) => sum + result.stats.rawChars, 0);
  return {
    summary,
    results,
    stats: {
      rawChars,
      packedChars: summary.length,
      codeChars: results.reduce((sum, result) => sum + result.stats.codeChars, 0),
      ratio: rawChars > 0 ? Math.round((summary.length / rawChars) * 1000) / 1000 : 0,
    },
  };
}
