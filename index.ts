import { lookup } from "./src/lookup.ts";
import { executorsFromHost, type HostTools } from "./src/host.ts";

const skill = {
  about: "/lookup: plan a context ask and return one bounded summary",
  match: /^\/lookup (.+)$/,
  handler: async (query: string, tools?: HostTools): Promise<string> => {
    const result = await lookup(query, {
      model: tools?.localModel,
      knownRepos: tools?.knownRepos,
      executors: executorsFromHost(tools),
      repoSpatial: tools?.repoSpatial,
      repoFallback: tools?.repoFallback,
      budget: tools?.outputBudget,
    });
    return result.summary;
  },
};

export default skill;
