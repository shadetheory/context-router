const STOP = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "to", "of", "and", "or",
  "for", "in", "on", "now", "currently", "me", "my", "our", "please", "do",
  "you", "your", "what", "who", "which", "how", "about", "that", "this",
  "with", "from", "at", "it", "its", "right", "are", "am",
]);

const PLURALS: Record<string, string> = {
  panes: "pane",
  files: "file",
  agents: "agent",
  sessions: "session",
  decisions: "decision",
  patterns: "pattern",
  windows: "window",
  references: "reference",
  functions: "function",
  classes: "class",
  repos: "repo",
  snippets: "snippet",
};

export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s/_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalizeQuery(text);
  const out: string[] = [];
  for (const raw of normalized.split(" ")) {
    if (!raw || STOP.has(raw)) continue;
    out.push(PLURALS[raw] ?? raw);
  }
  return out;
}

/** Sparse token embedding. Unigrams dominate so a reordered paraphrase still matches. */
export function embed(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const features = new Map<string, number>();
  const add = (feature: string, weight: number) => features.set(feature, (features.get(feature) ?? 0) + weight);
  for (const token of tokens) add(token, 1);
  for (let i = 0; i < tokens.length - 1; i++) add(`${tokens[i]} ${tokens[i + 1]}`, 0.25);
  let norm = 0;
  for (const weight of features.values()) norm += weight * weight;
  norm = Math.sqrt(norm) || 1;
  for (const [feature, weight] of features) features.set(feature, weight / norm);
  return features;
}

export function cosine(left: Map<string, number>, right: Map<string, number>): number {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let dot = 0;
  for (const [feature, weight] of small) {
    const other = large.get(feature);
    if (other) dot += weight * other;
  }
  return dot;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
