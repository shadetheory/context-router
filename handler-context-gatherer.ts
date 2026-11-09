import { enforceBudget } from "./src/budget.ts";
import { gather } from "./src/gatherer.ts";
import { executorsFromHost, type HostTools } from "./src/host.ts";
import { coercePlan } from "./src/planner.ts";
import { DEFAULT_BUDGET } from "./src/types.ts";

const handler = {
  about: "Execute a context plan with parallel reads, timeouts, partial failure, dedupe, rank, and a hard output budget.",
  match: /^context-gatherer (.+)$/,
  handler: async (plan: string, tools?: HostTools): Promise<string> => {
    try {
      const parsed = coercePlan(plan);
      const result = await gather(parsed, {
        executors: executorsFromHost(tools),
        repoSpatial: tools?.repoSpatial,
        repoFallback: tools?.repoFallback,
        budget: tools?.outputBudget,
      });
      return result.summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return enforceBudget(`## Errors\n- Invalid tool plan: ${message}`, tools?.outputBudget?.maxChars ?? DEFAULT_BUDGET.maxChars);
    }
  },
};

export default handler;
