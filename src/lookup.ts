import { gather, type GatherDeps } from "./gatherer.ts";
import { planQuery } from "./planner.ts";
import type { GatherResult, PlanOptions, QueryPlan } from "./types.ts";

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
