import assert from "node:assert/strict";
import test from "node:test";
import { budgetFromTokens, resolveBudget } from "../src/budget.ts";
import { gather } from "../src/gatherer.ts";
import { lookupBurst } from "../src/lookup.ts";
import type { RepoSpatialProvider, RepoSpatialSnippet } from "../src/repo-spatial.ts";
import { DEFAULT_BUDGET } from "../src/types.ts";

function provider(snippets: RepoSpatialSnippet[]): RepoSpatialProvider {
  return {
    enabledRepos: () => ["shadetheory/asgard"],
    retrieve: async () => ({ status: "ok", snippets }),
  };
}

function codeSnippets(count: number, size: number): RepoSpatialSnippet[] {
  return Array.from({ length: count }, (_, index) => ({
    repo: "shadetheory/asgard",
    path: `app/File${index}.php`,
    lineStart: index + 10,
    text: `CODE_${index} ${"c".repeat(size)}`,
  }));
}

function contextLines(summary: string): string[] {
  const block = summary.split("\n\n").find((part) => part.startsWith("## Context")) ?? "";
  return block.split("\n").slice(1).filter(Boolean);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the default budget is 6,000 characters with a 3,000 code-search cap", () => {
  assert.equal(DEFAULT_BUDGET.maxChars, 6_000);
  assert.equal(DEFAULT_BUDGET.codeMaxChars, 3_000);
  assert.deepEqual(resolveBudget(), { maxChars: 6_000, perItemChars: 600, codeMaxChars: 3_000 });
  const fromTokens = budgetFromTokens(1500);
  assert.equal(fromTokens.maxChars, 6_000);
  assert.equal(fromTokens.codeMaxChars, 3_000);
  assert.equal(resolveBudget({ maxChars: 1_000, codeMaxChars: 5_000 }).codeMaxChars, 1_000);
});

test("code search never takes more than its 3,000-character share", async () => {
  const result = await gather({
    tools: {
      repo_spatial: { repos: ["shadetheory/asgard"], query: "where is x", timeout_ms: 1_000 },
      vector_search: { query: "x", limit: 5, timeout_ms: 1_000 },
    },
  }, {
    repoSpatial: provider(codeSnippets(20, 500)),
    executors: { vector_search: async () => ["MEMORY_NOTE about x"] },
  });
  assert.ok(result.summary.length <= 6_000, `summary ${result.summary.length}`);
  assert.ok(result.stats.codeChars <= 3_000, `code ${result.stats.codeChars}`);
  const codeLines = contextLines(result.summary).filter((line) => line.startsWith("- [repo_spatial]"));
  assert.ok(codeLines.length > 0);
  assert.ok(codeLines.reduce((sum, line) => sum + line.length + 1, 0) <= 3_000);
  assert.match(result.summary, /MEMORY_NOTE/);
  assert.match(result.summary, /code search capped at 3000 chars/);
});

test("every kept context line carries a citation", async () => {
  const result = await gather({
    tools: {
      repo_spatial: { repos: ["shadetheory/asgard"], query: "where is x", timeout_ms: 1_000 },
      vector_search: { query: "x", limit: 5, timeout_ms: 1_000 },
      knowledge_retrieve: { query: "x", limit: 5, timeout_ms: 1_000 },
    },
  }, {
    repoSpatial: provider(codeSnippets(2, 40)),
    executors: {
      vector_search: async () => ["PLAIN_NOTE"],
      knowledge_retrieve: async () => ({ results: [{ content: "DOC_NOTE", url: "https://kb/doc/7" }] }),
    },
  });
  const lines = contextLines(result.summary);
  assert.equal(lines.length, result.citations.length);
  for (const line of lines) assert.match(line, /^- \[[a-z_, ]+\] \([^)]+\) /);
  assert.ok(result.citations.includes("shadetheory/asgard:app/File0.php:10"));
  assert.ok(result.citations.includes("knowledge_retrieve:https://kb/doc/7"));
  assert.ok(result.citations.includes("vector_search#1"));
});

test("the same line in two files keeps both citations", async () => {
  const result = await gather({
    tools: { repo_spatial: { repos: ["shadetheory/asgard"], query: "where is x", timeout_ms: 1_000 } },
  }, {
    repoSpatial: provider([
      { repo: "shadetheory/asgard", path: "a.php", lineStart: 1, text: "use X;" },
      { repo: "shadetheory/asgard", path: "b.php", lineStart: 2, text: "use X;" },
    ]),
  });
  assert.deepEqual([...result.citations].sort(), ["shadetheory/asgard:a.php:1", "shadetheory/asgard:b.php:2"]);
});

test("a read that misses the deadline is dropped and logged, siblings still land", async () => {
  const lateEvents: Array<{ tool: string; status: string }> = [];
  const result = await gather({
    tools: {
      vector_search: { query: "x", limit: 5, timeout_ms: 2_000 },
      bus_sessions: { timeout_ms: 2_000 },
    },
  }, {
    deadlineMs: 40,
    onLate: (event) => lateEvents.push(event),
    executors: {
      vector_search: async () => {
        await sleep(120);
        return ["LATE_MEMORY"];
      },
      bus_sessions: async () => ["FAST_SESSION"],
    },
  });
  assert.match(result.summary, /FAST_SESSION/);
  assert.doesNotMatch(result.summary, /LATE_MEMORY/);
  assert.deepEqual(result.late, [{ tool: "vector_search", deadlineMs: 40 }]);
  assert.match(result.summary, /Dropped late result from vector_search/);
  assert.equal(result.errors.length, 0);
  await sleep(150);
  assert.deepEqual(lateEvents.map((event) => event.tool), ["vector_search"]);
});

test("a cancelled late read sees its abort signal", async () => {
  let aborted = false;
  await gather({ tools: { bus_sessions: { timeout_ms: 2_000 } } }, {
    deadlineMs: 20,
    executors: {
      bus_sessions: (_params, ctx) => new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          resolve(["TOO_LATE"]);
        });
      }),
    },
  });
  assert.equal(aborted, true);
});

test("a burst of three asks fits one 6,000/3,000 report with every snippet cited", async () => {
  const burst = await lookupBurst([
    "where is the router defined in asgard",
    "find decisions about NAS",
    "who is online",
  ], {
    knownRepos: [{ alias: "asgard", repo: "shadetheory/asgard" }],
    repoSpatial: provider(codeSnippets(30, 400)),
    executors: {
      vector_search: async () => Array.from({ length: 10 }, (_, i) => `NAS_NOTE_${i} ${"n".repeat(500)}`),
      knowledge_retrieve: async () => Array.from({ length: 10 }, (_, i) => `NAS_DOC_${i} ${"d".repeat(500)}`),
      bus_sessions: async () => ["piper online", "locally online"],
    },
  });
  assert.equal(burst.results.length, 3);
  assert.ok(burst.summary.length <= 6_000, `summary ${burst.summary.length}`);
  assert.ok(burst.stats.codeChars <= 3_000);
  assert.match(burst.summary, /### Ask 1: where is the router defined in asgard/);
  assert.match(burst.summary, /### Ask 3: who is online/);
  for (const line of burst.summary.split("\n").filter((l) => l.startsWith("- ["))) {
    assert.match(line, /^- \[[a-z_, ]+\] \([^)]+\) /);
  }
  assert.ok(burst.stats.rawChars > burst.stats.packedChars);
  assert.ok(burst.stats.ratio > 0 && burst.stats.ratio < 1);
});
