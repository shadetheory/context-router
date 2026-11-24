import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { cosine, embed, normalizeQuery } from "./text.ts";

/**
 * One thing the house can do, read from Asgard's capability catalog
 * (`app/RequestLayer/HouseCapabilityCatalog.php` in shadetheory/Asgard).
 * Asgard owns the catalog. context-router reads it and never keeps a fork.
 */
export interface Capability {
  /** `domain.action`, unique in Asgard's catalog. */
  id: string;
  domain: string;
  action: string;
  /** Normalized spoken targets. Ignored when `queryTarget` is true. */
  spokenTargets: string[];
  /** The target is free text (a song title, a recipient), not a fixed list. */
  queryTarget: boolean;
  tool: string;
  entity: string;
  risk: "low" | "high";
  timeoutMs: number;
  /** False when Asgard lists the capability as catalogued but not wired. */
  wired: boolean;
  recommendedBuild?: string;
  source: string;
}

export interface CapabilityMatch {
  capability: Capability;
  /** The spoken target or free-text target the ask named. */
  target: string;
  via: "keyword" | "embedding" | "model";
  score: number;
}

const DEFAULT_TIMEOUT_SECONDS = 60;
export const ASGARD_CATALOG_PATH = "app/RequestLayer/HouseCapabilityCatalog.php";

/**
 * Parse Asgard's PHP catalog without running PHP. Reads the named arguments
 * of each `new HouseCapability(...)`, resolves `$variables` from their
 * assignment defaults (`$this->entity('lights', 'bedroom_light')`) and the
 * `config('…', default)` fallbacks in the helper methods, and reads the
 * "Wired today" line of the class docblock.
 */
export function parseAsgardCatalogPhp(source: string, origin = "asgard"): Capability[] {
  const vars = resolveVariables(source);
  const wired = wiredTools(source);
  const out: Capability[] = [];
  for (const block of capabilityBlocks(source)) {
    const args = namedArgs(block);
    const domain = phpString(args.domain, vars);
    const action = phpString(args.action, vars);
    const tool = phpString(args.tool, vars);
    if (!domain || !action || !tool) continue;
    const timeoutSeconds = phpNumber(args.timeoutSeconds, vars) ?? DEFAULT_TIMEOUT_SECONDS;
    out.push({
      id: `${domain}.${action}`,
      domain,
      action,
      spokenTargets: phpStringList(args.spokenTargets),
      queryTarget: /^true$/i.test((args.queryTarget ?? "").trim()),
      tool,
      entity: phpString(args.entity, vars) ?? "",
      risk: /HouseRisk::High/.test(args.risk ?? "") ? "high" : "low",
      timeoutMs: timeoutSeconds * 1000,
      wired: wired === undefined ? true : wired.has(tool),
      recommendedBuild: phpString(args.recommendedBuild, vars),
      source: origin,
    });
  }
  return out;
}

/** Accept a JSON export too, in camelCase or snake_case, should Asgard publish one. */
export function parseCatalogJson(text: string, origin = "asgard"): Capability[] {
  const raw = JSON.parse(text) as unknown;
  const rows = Array.isArray(raw) ? raw : (raw as { capabilities?: unknown[] })?.capabilities ?? [];
  const out: Capability[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const pick = (...keys: string[]) => keys.map((key) => r[key]).find((value) => value !== undefined);
    const domain = String(pick("domain") ?? "");
    const action = String(pick("action") ?? "");
    const tool = String(pick("tool") ?? "");
    if (!domain || !action || !tool) continue;
    const seconds = Number(pick("timeoutSeconds", "timeout_seconds") ?? DEFAULT_TIMEOUT_SECONDS);
    const targets = pick("spokenTargets", "spoken_targets");
    out.push({
      id: `${domain}.${action}`,
      domain,
      action,
      spokenTargets: Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [],
      queryTarget: Boolean(pick("queryTarget", "query_target")),
      tool,
      entity: String(pick("entity") ?? ""),
      risk: String(pick("risk") ?? "low").toLowerCase() === "high" ? "high" : "low",
      timeoutMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000,
      wired: pick("wired") === undefined ? true : Boolean(pick("wired")),
      recommendedBuild: typeof pick("recommendedBuild", "recommended_build") === "string" ? String(pick("recommendedBuild", "recommended_build")) : undefined,
      source: origin,
    });
  }
  return out;
}

export interface AsgardCatalogSource {
  /** A local Asgard checkout. Read with `git show`, so the work tree is never touched. */
  checkout?: string;
  /** Git ref to read. Default `origin/main`. */
  ref?: string;
  /** Or a file: Asgard's PHP catalog or a JSON export. */
  file?: string;
}

/** Read Asgard's catalog. Read-only: `git show <ref>:<path>` or a plain file read. */
export async function loadAsgardCatalog(source: AsgardCatalogSource): Promise<Capability[]> {
  if (source.file) {
    const text = await readFile(source.file, "utf8");
    return source.file.endsWith(".json") ? parseCatalogJson(text, source.file) : parseAsgardCatalogPhp(text, source.file);
  }
  if (!source.checkout) throw new Error("loadAsgardCatalog needs a checkout or a file");
  const ref = source.ref ?? "origin/main";
  const { stdout } = await promisify(execFile)("git", ["-C", source.checkout, "show", `${ref}:${ASGARD_CATALOG_PATH}`], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  return parseAsgardCatalogPhp(stdout, `asgard@${ref}`);
}

/** Spoken verbs per action. Asgard's splitter owns the full grammar; this is the planner's cut. */
const ACTION_VERBS: Record<string, readonly RegExp[]> = {
  off: [/\bturn (?:\w+ ){0,3}off\b/, /\bswitch (?:\w+ ){0,3}off\b/, /\bshut (?:\w+ ){0,3}off\b/, /\bkill the\b/],
  on: [/\bturn (?:\w+ ){0,3}on\b/, /\bswitch (?:\w+ ){0,3}on\b/],
  play: [/^play\b/, /\bplay (?:some|me|the|a)\b/, /\bput on\b/],
  set_temperature: [/\bset (?:\w+ ){0,3}(?:to )?\d+\s*(?:degrees?)?\b/, /\btemperature\b/, /\bthermostat\b/, /\b\d+ degrees\b/],
  lock: [/\block (?:the )?\w+/],
  send: [/\bsend\b/, /\bpay\b/, /\bpost\b/, /\bmessage\b/, /\btransfer\b/],
};

/** A domain word that has to appear when two capabilities share an action. */
const DOMAIN_CUES: Record<string, RegExp> = {
  money: /\b(money|pay|paid|dollars?|\$\d+|venmo|transfer|cash)\b/,
  message: /\b(message|post|mattermost|slack|text|tell|dm)\b/,
};

/**
 * Deterministic first: an action verb plus a spoken target (or any free text
 * for query targets). Then a token-embedding match. Only when the top two
 * candidates tie does the caller's local model get asked to pick.
 */
export function matchCapabilitiesDeterministic(query: string, catalog: readonly Capability[]): {
  matches: CapabilityMatch[];
  tie: CapabilityMatch[];
} {
  const normalized = normalizeQuery(query);
  const matches: CapabilityMatch[] = [];
  for (const capability of catalog) {
    const verbs = ACTION_VERBS[capability.action];
    if (!verbs || !verbs.some((verb) => verb.test(normalized))) continue;
    const cue = DOMAIN_CUES[capability.domain];
    const sharesAction = catalog.some((other) => other !== capability && other.action === capability.action);
    if (cue && sharesAction && !cue.test(normalized)) continue;
    if (capability.queryTarget) {
      const target = freeTarget(normalized, verbs);
      if (target) matches.push({ capability, target, via: "keyword", score: 1 });
      continue;
    }
    const target = [...capability.spokenTargets]
      .sort((a, b) => b.length - a.length)
      .find((spoken) => new RegExp(`\\b${escape(normalizeQuery(spoken))}\\b`).test(normalized));
    if (target) matches.push({ capability, target, via: "keyword", score: 1 });
  }
  if (matches.length > 0) return { matches: dedupeById(matches), tie: [] };

  const scored = catalog
    .map((capability) => ({ capability, score: bestPrototypeScore(normalized, capability) }))
    .sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  if (!first || first.score < EMBED_THRESHOLD) return { matches: [], tie: [] };
  const target = first.capability.queryTarget ? normalized : first.capability.spokenTargets[0] ?? "";
  if (second && first.score - second.score < TIE_MARGIN) {
    const tied = scored.filter((entry) => first.score - entry.score < TIE_MARGIN);
    return {
      matches: [],
      tie: tied.map((entry) => ({ capability: entry.capability, target, via: "embedding", score: entry.score })),
    };
  }
  return { matches: [{ capability: first.capability, target, via: "embedding", score: first.score }], tie: [] };
}

const EMBED_THRESHOLD = 0.8;
const TIE_MARGIN = 0.05;

export function buildTieBreakPrompt(query: string, tied: readonly CapabilityMatch[]): string {
  return [
    "You break ties between house capabilities. Pick at most one.",
    'Reply with JSON only, no prose. Shape: {"capability":"<id>"} or {"capability":null}.',
    `Candidates: ${tied.map((match) => `${match.capability.id} (tool ${match.capability.tool})`).join("; ")}.`,
    "Pick null when none of them is what the user asked for.",
    `Query: ${JSON.stringify(query)}`,
  ].join("\n");
}

export function parseTieBreak(text: string, tied: readonly CapabilityMatch[]): CapabilityMatch | undefined {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("model returned no JSON object");
  const payload = JSON.parse(trimmed.slice(start, end + 1)) as { capability?: unknown };
  if (payload.capability == null) return undefined;
  const id = String(payload.capability);
  const hit = tied.find((match) => match.capability.id === id);
  return hit ? { ...hit, via: "model" } : undefined;
}

function bestPrototypeScore(normalized: string, capability: Capability): number {
  const query = embed(normalized);
  const verb = capability.action.replace(/_/g, " ");
  const prototypes = capability.queryTarget
    ? [`${verb} ${capability.domain}`]
    : capability.spokenTargets.map((target) => `${verb} ${target}`);
  return Math.max(0, ...prototypes.map((prototype) => cosine(query, embed(prototype))));
}

function freeTarget(normalized: string, verbs: readonly RegExp[]): string {
  for (const verb of verbs) {
    const match = verb.exec(normalized);
    if (!match) continue;
    const rest = normalized.slice(match.index + match[0].length).trim();
    if (rest) return rest;
  }
  return "";
}

function dedupeById(matches: CapabilityMatch[]): CapabilityMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => (seen.has(match.capability.id) ? false : (seen.add(match.capability.id), true)));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capabilityBlocks(source: string): string[] {
  const blocks: string[] = [];
  const marker = /new\s+HouseCapability\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source))) {
    let depth = 1;
    let i = match.index + match[0].length;
    let quote: string | null = null;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
    }
    blocks.push(source.slice(match.index + match[0].length, i - 1));
  }
  return blocks;
}

/** Split `name: value, name: value` at top-level commas. */
function namedArgs(block: string): Record<string, string> {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\") current += block[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  const args: Record<string, string> = {};
  for (const part of parts) {
    const m = part.match(/^\s*(\w+)\s*:\s*([\s\S]*?)\s*$/);
    if (m) args[m[1]!] = m[2]!;
  }
  return args;
}

function unquote(literal: string): string | undefined {
  const m = literal.trim().match(/^(['"])([\s\S]*)\1$/);
  if (!m) return undefined;
  return m[2]!.replace(/\\(['"\\])/g, "$1");
}

function phpString(value: string | undefined, vars: Map<string, string>): string | undefined {
  if (value === undefined) return undefined;
  const literal = unquote(value);
  if (literal !== undefined) return literal;
  const variable = value.trim().match(/^\$(\w+)$/);
  return variable ? vars.get(variable[1]!) : undefined;
}

function phpNumber(value: string | undefined, vars: Map<string, string>): number | undefined {
  const text = value === undefined ? undefined : /^\d+$/.test(value.trim()) ? value.trim() : phpString(value, vars);
  const n = Number(text);
  return text !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
}

function phpStringList(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
}

/** `$x = $this->helper('key', 'default')` → default; `$x = $this->helper()` → the helper's config() default. */
function resolveVariables(source: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of source.matchAll(/\$(\w+)\s*=\s*\$this->(\w+)\(([^)]*)\)\s*;/g)) {
    const [, name, method, rawArgs] = m;
    const literals = [...(rawArgs ?? "").matchAll(/'([^']*)'|(\d+)/g)].map((lit) => lit[1] ?? lit[2]!);
    if (literals.length >= 2) {
      vars.set(name!, literals[literals.length - 1]!);
      continue;
    }
    const body = source.match(new RegExp(`function\\s+${method}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n    \\}`));
    const fallback = body?.[1]?.match(/config\(\s*'[^']*'\s*,\s*(?:'([^']*)'|(\d+))\s*\)/);
    const value = fallback?.[1] ?? fallback?.[2];
    if (value !== undefined) vars.set(name!, value);
  }
  return vars;
}

function wiredTools(source: string): Set<string> | undefined {
  const line = source.match(/Wired today:\s*([^\n.]+)/);
  if (!line) return undefined;
  return new Set(line[1]!.split(",").map((tool) => tool.trim()).filter(Boolean));
}
