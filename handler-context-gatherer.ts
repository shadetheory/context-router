import { Tools } from '@pi-sdk/tools';

interface VectorSearchInput {
  query: string;
  limit?: number;
}

interface KnowledgeRetrieveInput {
  query: string;
  limit?: number;
}

interface ContextPlan {
  vector_search?: VectorSearchInput;
  knowledge_retrieve?: KnowledgeRetrieveInput;
  smart_recall?: { query: string; scope?: 'project' | 'session'; kinds?: string[]; limit?: number };
  herdr_agent_list?: boolean;
  herdr_pane_list?: boolean;
  bus_sessions?: boolean;
  workspace_map?: boolean;
}

interface ContextResult {
  source: string;
  content: string;
  score?: number;
  age?: number; // days
  metadata?: Record<string, unknown>;
}

interface GatheredContext {
  memory: ContextResult[];
  live: Record<string, unknown>;
  errors: string[];
}

export default {
  about: 'Execute context-gathering tool plans in parallel and merge results',
  match: /^context-gatherer (.+)$/,
  handler: async (plan: string, tools: Tools): Promise<string> => {
    const planObj: ContextPlan = JSON.parse(plan);
    const results: ContextResult[] = [];
    const live: Record<string, unknown> = {};
    const errors: string[] = [];

    const calls: Promise<unknown>[] = [];

    if (planObj.vector_search) {
      calls.push(
        tools.vector_search(planObj.vector_search).then((res) => ({ source: 'vector_search', content: res, type: 'memory' }))
      );
    }

    if (planObj.knowledge_retrieve) {
      calls.push(
        tools.knowledge_retrieve(planObj.knowledge_retrieve).then((res) => ({ source: 'knowledge_retrieve', content: res, type: 'memory' }))
      );
    }

    if (planObj.smart_recall) {
      calls.push(
        tools.smart_recall(planObj.smart_recall).then((res) => ({ source: 'smart_recall', content: res, type: 'memory' }))
      );
    }

    if (planObj.herdr_agent_list) {
      calls.push(
        tools.bus_sessions({}).then((res) => ({ source: 'herdr_agent_list', content: res, type: 'live', key: 'agents' }))
      );
    }

    if (planObj.herdr_pane_list) {
      calls.push(
        tools.workspace_map({}).then((res) => ({ source: 'herdr_pane_list', content: res, type: 'live', key: 'panes' }))
      );
    }

    if (planObj.bus_sessions) {
      calls.push(
        tools.bus_sessions({}).then((res) => ({ source: 'bus_sessions', content: res, type: 'live', key: 'sessions' }))
      );
    }

    if (planObj.workspace_map) {
      calls.push(
        tools.workspace_map({}).then((res) => ({ source: 'workspace_map', content: res, type: 'live', key: 'workspace' }))
      );
    }

    const settled = await Promise.allSettled(calls);

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const r = result.value as ContextResult & { key?: string };
        if (r.type === 'live') {
          if (r.key) {
            live[r.key] = r.content;
          } else {
            live[r.source] = r.content;
          }
        } else {
          results.push(r as ContextResult);
        }
      } else {
        errors.push(`Tool ${result.reason?.source || 'unknown'} failed: ${result.reason?.message || 'Unknown error'}`);
      }
    }

    return formatOutput(results, live, errors);
  }
};

function formatOutput(memory: ContextResult[], live: Record<string, unknown>, errors: string[]): string {
  let output = '';

  if (memory.length > 0) {
    output += '## Context from memory\n';
    for (const m of memory) {
      output += `- [${m.source}] ${m.content}`;
      if (m.score !== undefined) output += ` (score: ${m.score.toFixed(2)})`;
      if (m.age !== undefined) output += ` (age: ${m.age}d)`;
      output += '\n';
    }
    output += '\n';
  }

  if (Object.keys(live).length > 0) {
    output += '## Live state\n';
    for (const [key, value] of Object.entries(live)) {
      output += `- ${key}: ${value}\n`;
    }
    output += '\n';
  }

  if (errors.length > 0) {
    output += '## Errors\n';
    for (const e of errors) {
      output += `- ${e}\n`;
    }
  }

  return output.trim();
}
