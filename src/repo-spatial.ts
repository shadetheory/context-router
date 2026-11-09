/**
 * Opt-in per-repo code index hook (issue #1).
 *
 * This module does not index anything. A host supplies a provider later.
 * The gatherer uses that provider under the rules below:
 * - Nothing is indexed unless the repo is listed by `enabledRepos`.
 * - Snippets must stay inside the output budget.
 * - Secret and generated paths are dropped even if a provider returns them.
 * - A stale index is not current source. The gatherer falls back to direct
 *   file/search and does not surface the stale snippets.
 * - Direct file/search remains available when the index is disabled or missing.
 */

export interface RepoSpatialSnippet {
  repo: string;
  path: string;
  text: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  indexedAt?: string;
  sourceRevision?: string;
  currentRevision?: string;
}

export interface RepoSpatialRequest {
  repos: string[];
  query: string;
  budgetChars: number;
  signal?: AbortSignal;
}

export type RepoSpatialStatus = "ok" | "disabled" | "missing" | "stale" | "error";

export interface RepoSpatialResponse {
  status: RepoSpatialStatus;
  snippets: RepoSpatialSnippet[];
  /** Set when the provider knows the index is behind the working tree. */
  stale?: boolean;
  message?: string;
}

export interface RepoSpatialProvider {
  /** Repos the user has explicitly enabled. Empty means the index is off. */
  enabledRepos(): readonly string[] | Promise<readonly string[]>;
  retrieve(request: RepoSpatialRequest): Promise<RepoSpatialResponse>;
}

/** Direct file or search path used when the index cannot be trusted. */
export interface RepoSpatialFallback {
  search(request: RepoSpatialRequest): Promise<RepoSpatialSnippet[]>;
}

export const unavailableRepoSpatial: RepoSpatialProvider = {
  enabledRepos() {
    return [];
  },
  async retrieve() {
    return {
      status: "disabled",
      snippets: [],
      message: "No code index is configured. Repos are not auto-indexed.",
    };
  },
};

const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|credentials\.(?:json|ya?ml|toml)|secrets\.(?:json|ya?ml|toml)|id_rsa|id_dsa|\.npmrc|\.pypirc|[^/]+\.(?:pem|key))$/i;
const SECRET_DIR = /(?:^|\/)(?:secrets|credentials)\//i;
const GENERATED = /(?:^|\/)(?:node_modules|dist|build|coverage|vendor|\.next|out|generated)\//i;
const MINIFIED = /\.(?:min\.js|min\.css|map)$/i;

export function isExcludedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return SECRET_FILE.test(normalized) || SECRET_DIR.test(normalized) || GENERATED.test(normalized) || MINIFIED.test(normalized);
}

export function filterSnippets(snippets: readonly RepoSpatialSnippet[]): {
  kept: RepoSpatialSnippet[];
  dropped: string[];
} {
  const kept: RepoSpatialSnippet[] = [];
  const dropped: string[] = [];
  for (const snippet of snippets) {
    if (isExcludedPath(snippet.path)) dropped.push(snippet.path);
    else kept.push(snippet);
  }
  return { kept, dropped };
}

export function snippetIsStale(snippet: RepoSpatialSnippet): boolean {
  return Boolean(
    snippet.sourceRevision &&
      snippet.currentRevision &&
      snippet.sourceRevision !== snippet.currentRevision,
  );
}

export function responseIsStale(response: RepoSpatialResponse): boolean {
  return response.stale === true || response.status === "stale" || response.snippets.some(snippetIsStale);
}

/** Pack snippet text until the hint budget is exhausted. Order is the provider's rank. */
export function snippetsWithinBudget(
  snippets: readonly RepoSpatialSnippet[],
  budgetChars: number,
): RepoSpatialSnippet[] {
  if (budgetChars <= 0) return [];
  const kept: RepoSpatialSnippet[] = [];
  let used = 0;
  for (const snippet of snippets) {
    const size = snippet.text.length + snippet.path.length;
    if (kept.length > 0 && used + size > budgetChars) break;
    if (size > budgetChars) {
      const room = Math.max(0, budgetChars - snippet.path.length);
      if (room === 0) break;
      kept.push({ ...snippet, text: snippet.text.slice(0, room) });
      break;
    }
    kept.push(snippet);
    used += size;
  }
  return kept;
}
