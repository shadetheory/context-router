import { Tools } from '@pi-sdk/tools';

interface ContextPlan {
  vector_search?: { query: string; limit?: number; timeout_ms?: number };
  knowledge_retrieve?: { query: string; limit?: number; timeout_ms?: number };
  smart_recall?: { query: string; scope?: 'project' | 'session'; kinds?: string[]; limit?: number; timeout_ms?: number };
  herdr_agent_list?: { timeout_ms?: number };
  herdr_pane_list?: { timeout_ms?: number };
  bus_sessions?: { timeout_ms?: number };
  workspace_map?: { timeout_ms?: number };
  repo_spatial?: { repos: string[]; timeout_ms?: number };
}

interface ContextResult {
  source: string;
  content: string;
  score?: number;
  age?: number;
  metadata?: Record<string, unknown>;
}

function executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  return Promise.race<T>([
    fn(),
    new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timeoutId));
}

function repoSpatialCall(plan: { repos: string[]; timeout_ms?: number }): Promise<string> {
  const timeout = plan.timeout_ms ?? 10000;
  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(
      () => reject(new Error(`repo_spatial timeout after ${timeout}ms`)),
      timeout
    );
    // In production, this would call an MCP server or web service
    // For now, return a placeholder
    clearTimer();
    resolve(JSON.stringify({ repos: plan.repos, count: plan.repos.length, max_age_days: 30 }));
  });

  function clearTimer() { clearTimeout(timeoutId); }
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
        executeWithTimeout(
          () => tools.vector_search(planObj.vector_search),
          planObj.vector_search.timeout_ms ?? 5000
        ).then((res) => ({ source: 'vector_search', content: res, type: 'memory' }))
      );
    }

    if (planObj.knowledge_retrieve) {
      calls.push(
        executeWithTimeout(
          () => tools.knowledge_retrieve(planObj.knowledge_retrieve),
          planObj.knowledge_retrieve.timeout_ms ?? 5000
        ).then((res) => ({ source: 'knowledge_retrieve', content: res, type: 'memory' }))
      );
    }

    if (planObj.smart_recall) {
      calls.push(
        executeWithTimeout(
          () => tools.smart_recall(planObj.smart_recall),
          planObj.smart_recall.timeout_ms ?? 5000
        ).then((res) => ({ source: 'smart_recall', content: res, type: 'memory' }))
      );
    }

    if (planObj.herdr_agent_list) {
      calls.push(
        executeWithTimeout(
          () => tools.bus_sessions({}),
          planObj.herdr_agent_list.timeout_ms ?? 3000
        ).then((res) => ({ source: 'herdr_agent_list', content: res, type: 'live', key: 'agents' }))
      );
    }

    if (planObj.herdr_pane_list) {
      calls.push(
        executeWithTimeout(
          () => tools.workspace_map({}),
          planObj.herdr_pane_list.timeout_ms ?? 3000
        ).then((res) => ({ source: 'herdr_pane_list', content: res, type: 'live', key: 'panes' }))
      );
    }

    if (planObj.bus_sessions) {
      calls.push(
        executeWithTimeout(
          () => tools.bus_sessions({}),
          planObj.bus_sessions.timeout_ms ?? 3000
        ).then((res) => ({ source: 'bus_sessions', content: res, type: 'live', key: 'sessions' }))
      );
    }

    if (planObj.workspace_map) {
      calls.push(
        executeWithTimeout(
          () => tools.workspace_map({}),
          planObj.workspace_map.timeout_ms ?? 3000
        ).then((res) => ({ source: 'workspace_map', content: res, type: 'live', key: 'workspace' }))
      );
    }

    if (planObj.repo_spatial) {
      calls.push(
        executeWithTimeout(
          () => repoSpatialCall(planObj.repo_spatial),
          planObj.repo_spatial.timeout_ms ?? 10000
        ).then((res) => ({ source: 'repo_spatial', content: res, type: 'memory' }))
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
