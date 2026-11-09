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
  "vector_search": {"query": "...", "limit": 5, "timeout_ms": 5000},
  "knowledge_retrieve": {"query": "...", "limit": 5, "timeout_ms": 5000},
  "smart_recall": {"query": "...", "scope": "project", "limit": 5, "timeout_ms": 5000},
  "herdr_agent_list": {"timeout_ms": 3000},
  "herdr_pane_list": {"timeout_ms": 3000},
  "bus_sessions": {"timeout_ms": 3000},
  "workspace_map": {"timeout_ms": 3000},
  "repo_spatial": {"repos": ["owner/repo"], "timeout_ms": 10000}
}

Rules:
- Only include tools you're confident about
- Don't duplicate tools
- Don't invent tools not listed above
- If unsure, omit the tool
- Live state tools (herdr_*, bus_, workspace_) should not be cached; always fetch fresh

Query: "${query}"

JSON plan:
`;

  const { text } = await tools.codemode({
    code: `
const prompt = ${JSON.stringify(prompt)};
return JSON.stringify({
  vector_search: { query: "${query}", limit: 5 },
  knowledge_retrieve: { query: "${query}", limit: 5 },
  herdr_pane_list: { timeout_ms: 3000 }
});
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
  const validTools = new Set(['vector_search', 'knowledge_retrieve', 'smart_recall', 'herdr_agent_list', 'herdr_pane_list', 'bus_sessions', 'workspace_map', 'repo_spatial']);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(plan)) {
    if (validTools.has(key)) {
      result[key] = value;
    }
  }

  return result;
}
