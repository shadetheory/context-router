import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryCache, cacheKey } from "../src/cache.ts";
import { gather } from "../src/gatherer.ts";
import { executorsFromHost } from "../src/host.ts";
import type { ToolExecutor } from "../src/types.ts";

const vectorParams = { query: "nas", limit: 5, timeout_ms: 5_000 };
const liveParams = { timeout_ms: 3_000 };

test("independent reads overlap and a failure does not drop the sibling", async () => {
  const starts: number[] = [];
  const ends: number[] = [];
  const slow = async () => {
    starts.push(Date.now());
    await delay(80);
    ends.push(Date.now());
    return "SLOW_OK";
  };
  const failing: ToolExecutor = async () => {
    starts.push(Date.now());
    await delay(80);
    ends.push(Date.now());
    throw new Error("boom");
  };
  const result = await gather({
    tools: {
      vector_search: vectorParams,
      knowledge_retrieve: { ...vectorParams, query: "other" },
    },
  }, {
    executors: { vector_search: slow, knowledge_retrieve: failing },
  });
  assert.equal(result.invocations.length, 2);
  assert.ok(starts.length === 2 && ends.length === 2);
  assert.ok(starts[1]! < ends[0]!, "second read should start before the first finishes");
  assert.match(result.summary, /SLOW_OK/);
  assert.match(result.summary, /knowledge_retrieve failed: boom/);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.tool, "knowledge_retrieve");
});

test("a timed out read is reported and the sibling is kept", async () => {
  const started = Date.now();
  const result = await gather({
    tools: {
      vector_search: { ...vectorParams, timeout_ms: 40 },
      knowledge_retrieve: vectorParams,
    },
  }, {
    executors: {
      vector_search: () => new Promise(() => {}),
      knowledge_retrieve: async () => "SIBLING_OK",
    },
  });
  assert.ok(Date.now() - started < 500);
  assert.match(result.summary, /SIBLING_OK/);
  assert.match(result.summary, /vector_search timed out after 40ms/);
  assert.equal(result.errors[0]?.tool, "vector_search");
});

test("identical content is deduped and higher relevance ranks first", async () => {
  const result = await gather({
    tools: { vector_search: vectorParams, knowledge_retrieve: vectorParams },
  }, {
    executors: {
      vector_search: async () => [
        { content: "LOW_RANK", score: 0.1, age: 40 },
        { content: "HIGH_RANK", score: 0.95, age: 1 },
      ],
      knowledge_retrieve: async () => "HIGH_RANK",
    },
  });
  assert.equal(result.summary.split("HIGH_RANK").length - 1, 1);
  assert.ok(result.summary.indexOf("HIGH_RANK") < result.summary.indexOf("LOW_RANK"));
  assert.match(result.summary, /\[vector_search, knowledge_retrieve\] HIGH_RANK/);
});

test("the same executor and params are invoked once", async () => {
  let calls = 0;
  const shared: ToolExecutor = async () => {
    calls += 1;
    return "ROSTER";
  };
  const result = await gather({
    tools: { herdr_agent_list: liveParams, bus_sessions: liveParams },
  }, {
    executors: { herdr_agent_list: shared, bus_sessions: shared },
  });
  assert.equal(calls, 1);
  assert.equal(result.invocations.length, 1);
  assert.equal(result.summary.split("ROSTER").length - 1, 1);
});

test("herdr_pane_list is not aliased onto workspace_map", async () => {
  let maps = 0;
  const result = await gather({
    tools: { herdr_pane_list: liveParams },
  }, {
    executors: executorsFromHost({
      workspace_map: async () => {
        maps += 1;
        return "FILES";
      },
    }),
  });
  assert.equal(maps, 0);
  assert.match(result.summary, /herdr_pane_list has no executor/);
  assert.doesNotMatch(result.summary, /FILES/);
});

test("herdr_agent_list is not aliased onto bus_sessions", async () => {
  let sessions = 0;
  const result = await gather({
    tools: { herdr_agent_list: liveParams },
  }, {
    executors: executorsFromHost({
      bus_sessions: async () => {
        sessions += 1;
        return "SESSIONS";
      },
    }),
  });
  assert.equal(sessions, 0);
  assert.match(result.summary, /herdr_agent_list has no executor/);
  assert.doesNotMatch(result.summary, /SESSIONS/);
});

test("live session state bypasses the cache", async () => {
  const cache = createMemoryCache();
  cache.set(cacheKey("bus_sessions", liveParams), "STALE_LIVE", 60_000);
  const gets: string[] = [];
  const watching = {
    get(key: string) {
      gets.push(key);
      return cache.get(key);
    },
    set(key: string, value: unknown, ttlMs: number) {
      cache.set(key, value, ttlMs);
    },
  };
  let calls = 0;
  const result = await gather({ tools: { bus_sessions: liveParams } }, {
    cache: watching,
    executors: {
      bus_sessions: async () => {
        calls += 1;
        return "FRESH_LIVE";
      },
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(gets, []);
  assert.ok(result.cacheBypassed.includes("bus_sessions"));
  assert.match(result.summary, /FRESH_LIVE/);
  assert.doesNotMatch(result.summary, /STALE_LIVE/);
});

test("memory reads reuse a fresh cache entry", async () => {
  const cache = createMemoryCache();
  let calls = 0;
  const plan = { tools: { vector_search: vectorParams } };
  const executors = {
    vector_search: async () => {
      calls += 1;
      return "MEMORY_HIT";
    },
  };
  await gather(plan, { cache, executors });
  const second = await gather(plan, { cache, executors });
  assert.equal(calls, 1);
  assert.deepEqual(second.cacheHits, ["vector_search"]);
  assert.match(second.summary, /MEMORY_HIT/);
});

test("write-capable tools wait for explicit approval", async () => {
  let calls = 0;
  const executors = {
    vector_search: async () => {
      calls += 1;
      return "WROTE";
    },
  };
  const blocked = await gather({ tools: { vector_search: vectorParams } }, {
    executors,
    modes: { vector_search: "write" },
  });
  assert.equal(calls, 0);
  assert.match(blocked.summary, /writes require explicit approval/);
  const allowed = await gather({ tools: { vector_search: vectorParams } }, {
    executors,
    modes: { vector_search: "write" },
    approval: { writeTools: ["vector_search"] },
  });
  assert.equal(calls, 1);
  assert.match(allowed.summary, /WROTE/);
});

test("parallel fan-in still has to fit in one output budget", async () => {
  let calls = 0;
  const result = await gather({
    tools: {
      vector_search: vectorParams,
      knowledge_retrieve: { ...vectorParams, query: "other" },
    },
  }, {
    budget: { maxChars: 250, perItemChars: 8_000 },
    executors: {
      vector_search: async () => {
        calls += 1;
        return { content: `KEEP_HIGH ${"y".repeat(8_000)}`, score: 0.99, age: 0 };
      },
      knowledge_retrieve: async () => {
        calls += 1;
        return `DROP_LOW ${"x".repeat(10_000)}`;
      },
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.invocations.length, 2);
  assert.ok(result.summary.length <= 250);
  assert.match(result.summary, /KEEP_HIGH/);
  assert.doesNotMatch(result.summary, /DROP_LOW/);
  assert.ok(result.omitted >= 1);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
