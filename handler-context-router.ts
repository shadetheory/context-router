import type { HostTools } from "./src/host.ts";
import { planQuery } from "./src/planner.ts";

const handler = {
  about: "Route a natural-language ask to a tool plan. Obvious asks use keywords or embeddings; a local model is called only when the ask is ambiguous.",
  match: /^route-context (.+)$/,
  handler: async (query: string, tools?: HostTools): Promise<string> => {
    const plan = await planQuery(query, {
      model: tools?.localModel,
      knownRepos: tools?.knownRepos,
    });
    return JSON.stringify(plan, null, 2);
  },
};

export default handler;
