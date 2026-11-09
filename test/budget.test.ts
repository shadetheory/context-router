import assert from "node:assert/strict";
import test from "node:test";
import { budgetFromTokens, enforceBudget, renderBounded, CHARS_PER_TOKEN } from "../src/budget.ts";
import { gather } from "../src/gatherer.ts";

test("enforceBudget never returns more than maxChars", () => {
  assert.equal(enforceBudget("abcdef", 0), "");
  assert.equal(enforceBudget("abcdef", 3), "abc");
  const clipped = enforceBudget("x".repeat(500), 40);
  assert.ok(clipped.length <= 40);
  assert.match(clipped, /\[truncated\]$/);
  assert.equal(enforceBudget("short", 40), "short");
});

test("token budgets convert to a character ceiling", () => {
  const budget = budgetFromTokens(100);
  assert.equal(budget.maxChars, 100 * CHARS_PER_TOKEN);
  assert.equal(budgetFromTokens(-5).maxChars, 0);
});

test("renderBounded drops the lowest-ranked lines before clipping the best one", () => {
  const rendered = renderBounded({
    lines: ["- [vector_search] KEEP_HIGH", `- [knowledge_retrieve] DROP_LOW ${"z".repeat(2_000)}`],
    gaps: [],
    errors: [],
    notes: [],
    maxChars: 400,
  });
  assert.ok(rendered.text.length <= 400);
  assert.match(rendered.text, /KEEP_HIGH/);
  assert.doesNotMatch(rendered.text, /DROP_LOW/);
  assert.equal(rendered.omitted, 1);
});

test("a single oversized hit is clipped inside the hard budget", () => {
  const rendered = renderBounded({
    lines: [`- [vector_search] HUGE_START ${"z".repeat(20_000)}`],
    gaps: [],
    errors: [],
    notes: [],
    maxChars: 180,
  });
  assert.ok(rendered.text.length <= 180);
  assert.match(rendered.text, /HUGE_START/);
  assert.doesNotMatch(rendered.text, /z{500}/);
});

test("gather clips a huge read to the hard budget", async () => {
  const result = await gather({
    tools: { vector_search: { query: "nas", limit: 5, timeout_ms: 5000 } },
  }, {
    budget: { maxChars: 160, perItemChars: 50_000 },
    executors: {
      vector_search: async () => `HUGE_START ${"z".repeat(20_000)}`,
    },
  });
  assert.ok(result.summary.length <= 160);
  assert.match(result.summary, /HUGE_START/);
  assert.equal(result.summary.includes("z".repeat(500)), false);
});
