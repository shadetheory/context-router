import { LIVE_TOOLS, type ToolName } from "./types.ts";
import { stableStringify } from "./text.ts";

export interface ResultCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export function createMemoryCache(now: () => number = Date.now): ResultCache {
  const entries = new Map<string, Entry>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
  };
}

export function cacheKey(tool: string, params: unknown): string {
  return `${tool}:${stableStringify(params)}`;
}

export function isLiveTool(tool: string): boolean {
  return LIVE_TOOLS.has(tool as ToolName);
}

/** Memory hits can be reused briefly. Live state and repo index reads cannot. */
export const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000;
