import { Tools } from '@pi-sdk/tools';

export default {
  about: '/lookup: Route query with context-router, gather with context-gatherer, return formatted output',
  match: /^\/lookup (.+)$/,
  handler: async (query: string, tools: Tools): Promise<string> => {
    // Step 1: Router → tool plan
    const plan = await generatePlan(query, tools);
    
    // Step 2: Gatherer → parallel fetch
    const gathered = await executePlan(plan, tools);
    
    // Step 3: Return formatted output (gatherer already formats)
    return gathered;
  }
};

async function generatePlan(query: string, tools: Tools): Promise<string> {
  const prompt = `
You are a context-router. Turn natural language queries into exact tool call plans.

Output ONLY valid JSON like:
{
  "vector_search": {"query": "...", "limit": 5},
  "knowledge_retrieve": true,
  "smart_recall": {"query": "...", "scope": "project", "limit": 5},
  "herdr_agent_list": true,
  "herdr_pane_list": true,
  "bus_sessions": true,
  "workspace_map": true
}

Rules:
- Only include tools you're confident about
- Don't duplicate tools
- Don't invent tools not listed above
- If unsure, omit the tool

Query: "${query}"

JSON plan:
`;

  const result = await tools.codemode({
    code: `
const prompt = ${JSON.stringify(prompt)};
return JSON.stringify({
  vector_search: ${JSON.stringify({ query, limit: 5 })},
  knowledge_retrieve: { query, limit: 5 },
  herdr_pane_list: true
});
`
  });

  return result;
}

async function executePlan(planJson: string, tools: Tools): Promise<string> {
  const plan = JSON.parse(planJson);
  
  // Use codemode to call gatherer handler directly
  const gathererCode = `
const tools = {
  vector_search: async (input) => await tools.vector_search(input),
  knowledge_retrieve: async (input) => await tools.knowledge_retrieve(input),
  smart_recall: async (input) => await tools.smart_recall(input),
  bus_sessions: async (input) => await tools.bus_sessions(input),
  workspace_map: async (input) => await tools.workspace_map(input),
};

const plan = ${planJson};

return tools.contextGatherer(plan, tools);
`;

  return await tools.codemode({
    code: gathererCode
  });
}
