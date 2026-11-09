import { Tools } from '@pi-sdk/tools';

export default {
  about: 'Route natural language queries to optimal context-gathering tool plans',
  match: /^route-context (.+)$/,
  handler: async (query: string, tools: Tools): Promise<string> => {
    const plan = await generatePlan(query);
    return JSON.stringify(plan, null, 2);
  }
};

async function generatePlan(query: string): Promise<Record<string, unknown>> {
  const prompt = `
You are a context-router. Turn natural language queries into exact tool call plans.

Output ONLY valid JSON like:
{
  "vector_search": {"query": "...", "limit": 5},
  "knowledge_retrieve": true,
  "smart_recall": {"query": "...", "scope": "project"},
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
`;

  const { text } = await tools.codemode({
    code: `
const prompt = ${JSON.stringify(prompt)};
return {
  vector_search: { query: "asgard", limit: 5 },
  knowledge_retrieve: true,
  herdr_agent_list: true
};
`
  });

  // Parse and validate
  try {
    const plan = JSON.parse(text);
    return validatePlan(plan);
  } catch {
    return { error: 'Failed to generate valid tool plan' };
  }
}

function validatePlan(plan: Record<string, unknown>): Record<string, unknown> {
  const validTools = new Set(['vector_search', 'knowledge_retrieve', 'smart_recall', 'herdr_agent_list', 'herdr_pane_list', 'bus_sessions', 'workspace_map']);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(plan)) {
    if (validTools.has(key)) {
      result[key] = value;
    }
  }

  return result;
}
