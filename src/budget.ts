import { DEFAULT_BUDGET, type Budget } from "./types.ts";

/** Characters reserved per token when a caller budgets in tokens. */
export const CHARS_PER_TOKEN = 4;

export function budgetFromTokens(maxTokens: number, charsPerToken = CHARS_PER_TOKEN): Budget {
  const tokens = Number.isFinite(maxTokens) ? Math.max(0, maxTokens) : 0;
  return {
    maxChars: Math.floor(tokens * charsPerToken),
    perItemChars: DEFAULT_BUDGET.perItemChars,
  };
}

export function resolveBudget(budget?: Partial<Budget>): Budget {
  const maxChars = budget?.maxChars ?? DEFAULT_BUDGET.maxChars;
  const perItemChars = budget?.perItemChars ?? DEFAULT_BUDGET.perItemChars;
  return {
    maxChars: Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : DEFAULT_BUDGET.maxChars,
    perItemChars: Number.isFinite(perItemChars) ? Math.max(1, Math.floor(perItemChars)) : DEFAULT_BUDGET.perItemChars,
  };
}

/**
 * Hard ceiling. Every summary path ends here so a formatting miss cannot
 * exceed the budget the main model was promised.
 */
export function enforceBudget(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const notice = "\n[truncated]";
  if (maxChars <= notice.length) return text.slice(0, maxChars);
  return text.slice(0, maxChars - notice.length).trimEnd() + notice;
}

export interface RenderInput {
  lines: string[];
  gaps: string[];
  errors: string[];
  notes: string[];
  maxChars: number;
}

export interface RenderOutput {
  text: string;
  omitted: number;
}

function section(title: string, lines: string[]): string {
  const body = lines.map((line) => line.trim()).filter(Boolean);
  if (body.length === 0) return "";
  return [`## ${title}`, ...body].join("\n");
}

function compose(input: RenderInput, kept: string[], omitted: number): string {
  const notes = [...input.notes];
  if (omitted > 0) {
    notes.push(`[omitted ${omitted} lower-ranked items; output budget ${input.maxChars} chars]`);
  }
  const blocks = [
    section("Context", kept),
    section("Gaps", input.gaps.map((gap) => `- ${gap}`)),
    section("Errors", input.errors.map((error) => `- ${error}`)),
    section("Notes", notes.map((note) => (note.startsWith("[") || note.startsWith("-") ? note : `- ${note}`))),
  ].filter(Boolean);
  return blocks.join("\n\n").trim();
}

/**
 * Keep the highest-ranked lines that fit, then clip the last remaining line
 * before giving up. The returned string is always at most `maxChars`.
 */
export function renderBounded(input: RenderInput): RenderOutput {
  const maxChars = input.maxChars;
  if (maxChars <= 0) return { text: "", omitted: input.lines.length };

  let kept = input.lines.slice();
  let omitted = 0;
  let text = compose(input, kept, omitted);
  while (text.length > maxChars && kept.length > 1) {
    kept.pop();
    omitted += 1;
    text = compose(input, kept, omitted);
  }
  if (text.length > maxChars && kept.length === 1) {
    const line = kept[0] ?? "";
    let lo = 0;
    let hi = line.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (compose(input, [line.slice(0, mid)], omitted).length <= maxChars) lo = mid;
      else hi = mid - 1;
    }
    if (lo === 0) {
      kept = [];
      omitted += 1;
    } else {
      kept = [line.slice(0, lo)];
    }
    text = compose(input, kept, omitted);
  }
  if (text.length <= maxChars) return { text, omitted };
  return { text: enforceBudget(text, maxChars), omitted };
}
