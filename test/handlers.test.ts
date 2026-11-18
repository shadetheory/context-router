import assert from "node:assert/strict";
import test from "node:test";
import gatherer from "../handler-context-gatherer.ts";
import router from "../handler-context-router.ts";
import lookup from "../index.ts";

test("the router handler no longer returns a fixed stub plan", async () => {
  let calls = 0;
  const raw = await router.handler("who is online", {
    localModel: {
      async complete() {
        calls += 1;
        return JSON.stringify({ tools: ["herdr_pane_list", "vector_search", "knowledge_retrieve"] });
      },
    },
  });
  const plan = JSON.parse(raw) as { tools: Record<string, unknown>; usedModel: boolean };
  assert.equal(calls, 0);
  assert.equal(plan.usedModel, false);
  assert.ok(plan.tools.bus_sessions);
  assert.equal(plan.tools.herdr_pane_list, undefined);
  assert.equal(plan.tools.vector_search, undefined);
  assert.equal(plan.tools.knowledge_retrieve, undefined);
});

test("the gatherer handler passes object params and keeps a partial success", async () => {
  let knowledge: unknown;
  const summary = await gatherer.handler(JSON.stringify({
    vector_search: { query: "nas", limit: 5, timeout_ms: 5000 },
    knowledge_retrieve: true,
  }), {
    vector_search: async () => "VECTOR_HIT",
    knowledge_retrieve: async (params) => {
      knowledge = params;
      throw new Error("search down");
    },
  });
  assert.deepEqual(knowledge, { query: "", limit: 5, timeout_ms: 5000 });
  assert.match(summary, /VECTOR_HIT/);
  assert.match(summary, /knowledge_retrieve failed: search down/);
});

test("lookup returns one bounded summary for an obvious ask", async () => {
  const summary = await lookup.handler("what panes are open", {
    herdr_pane_list: async () => `PANE_A ${"p".repeat(5_000)}`,
    herdr_agent_list: async () => {
      throw new Error("agent list should not be called");
    },
    outputBudget: { maxChars: 180, perItemChars: 2_000 },
  });
  assert.match(summary, /PANE_A/);
  assert.match(summary, /herdr_pane_list/);
  assert.ok(summary.length <= 180);
  assert.doesNotMatch(summary, /agent list should not be called/);
});

test("lookup does not fetch stored memory for a live PR status ask", async () => {
  let calls = 0;
  const summary = await lookup.handler("check PR status for lex", {
    vector_search: async () => {
      calls += 1;
      return "STALE_MEMORY";
    },
    knowledge_retrieve: async () => {
      calls += 1;
      return "STALE_MEMORY";
    },
  });
  assert.equal(calls, 0);
  assert.match(summary, /current PR status/);
  assert.doesNotMatch(summary, /STALE_MEMORY/);
});

test("an invalid gatherer plan becomes an error summary", async () => {
  const summary = await gatherer.handler("not json", {});
  assert.match(summary, /Invalid tool plan/);
});
