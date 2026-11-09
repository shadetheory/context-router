import assert from "node:assert/strict";
import test from "node:test";
import { enforcePlanConstraints, planQuery } from "../src/planner.ts";
import { TIMEOUTS_MS, type LocalModel } from "../src/types.ts";

function model(payload: unknown, calls: { n: number }): LocalModel {
  return {
    async complete(prompt: string) {
      calls.n += 1;
      assert.match(prompt, /JSON only/);
      assert.match(prompt, /herdr_pane_list/);
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

test("who is online routes to bus_sessions and does not call a model", async () => {
  const calls = { n: 0 };
  const plan = await planQuery("who is online", { model: model({ tools: ["herdr_pane_list"] }, calls) });
  assert.equal(calls.n, 0);
  assert.equal(plan.usedModel, false);
  assert.equal(plan.ambiguous, false);
  assert.deepEqual(Object.keys(plan.tools), ["bus_sessions"]);
  assert.equal(plan.selections.bus_sessions?.via, "keyword");
  assert.equal(plan.tools.herdr_agent_list, undefined);
  assert.equal(plan.tools.herdr_pane_list, undefined);
});

test("what panes are open is a keyword route to herdr_pane_list", async () => {
  const calls = { n: 0 };
  const plan = await planQuery("what panes are open", { model: model({}, calls) });
  assert.equal(calls.n, 0);
  assert.deepEqual(Object.keys(plan.tools), ["herdr_pane_list"]);
  assert.equal(plan.selections.herdr_pane_list?.via, "keyword");
});

test("a reordered pane ask uses embeddings and still skips the model", async () => {
  const calls = { n: 0 };
  const plan = await planQuery("are the panes open now", { model: model({ tools: ["workspace_map"] }, calls) });
  assert.equal(calls.n, 0);
  assert.equal(plan.usedModel, false);
  assert.equal(plan.tools.herdr_pane_list?.timeout_ms, TIMEOUTS_MS.live);
  assert.equal(plan.selections.herdr_pane_list?.via, "embedding");
  assert.equal(plan.tools.workspace_map, undefined);
  assert.ok((plan.selections.herdr_pane_list?.score ?? 0) >= 0.8);
});

test("list files in project routes to the workspace map, not panes", async () => {
  const plan = await planQuery("list files in project");
  assert.deepEqual(Object.keys(plan.tools), ["workspace_map"]);
  assert.equal(plan.selections.workspace_map?.via, "keyword");
  assert.equal(plan.tools.herdr_pane_list, undefined);
});

test("what did we decide this session uses smart recall", async () => {
  const plan = await planQuery("what did we decide this session");
  assert.deepEqual(Object.keys(plan.tools), ["smart_recall"]);
  assert.equal(plan.tools.smart_recall?.scope, "session");
  assert.equal(plan.usedModel, false);
});

test("ci status is a gap, not a memory lookup", async () => {
  const calls = { n: 0 };
  const plan = await planQuery("ci status", { model: model({ tools: ["vector_search"] }, calls) });
  assert.equal(calls.n, 0);
  assert.deepEqual(plan.tools, {});
  assert.ok(plan.gaps.some((gap) => gap.code === "live_ci_status"));
});

test("find decisions about NAS selects memory tools with object params", async () => {
  const plan = await planQuery("find decisions about NAS");
  assert.equal(plan.usedModel, false);
  assert.deepEqual(plan.tools.vector_search, {
    query: "find decisions about NAS",
    limit: 5,
    timeout_ms: TIMEOUTS_MS.memory,
  });
  assert.deepEqual(plan.tools.knowledge_retrieve, {
    query: "find decisions about NAS",
    limit: 5,
    timeout_ms: TIMEOUTS_MS.memory,
  });
  assert.equal(typeof plan.tools.knowledge_retrieve, "object");
  assert.equal(plan.tools.repo_spatial, undefined);
});

test("what do you know about asgard does not invent a repository", async () => {
  const plan = await planQuery("what do you know about asgard", {
    knownRepos: [{ alias: "asgard", repo: "shadetheory/asgard" }],
  });
  assert.ok(plan.tools.vector_search);
  assert.ok(plan.tools.knowledge_retrieve);
  assert.equal(plan.tools.repo_spatial, undefined);
  assert.equal(JSON.stringify(plan).includes("jordanpartridge"), false);
});

test("a code question names only the repository the user wrote", async () => {
  const plan = await planQuery("where is gather defined in shadetheory/context-router");
  assert.deepEqual(plan.tools.repo_spatial?.repos, ["shadetheory/context-router"]);
  assert.equal(plan.tools.repo_spatial?.query, "where is gather defined in shadetheory/context-router");
  assert.equal(plan.tools.herdr_pane_list, undefined);
});

test("a configured alias can satisfy a code question", async () => {
  const plan = await planQuery("where is the router defined in asgard", {
    knownRepos: [{ alias: "asgard", repo: "shadetheory/asgard" }],
  });
  assert.deepEqual(plan.tools.repo_spatial?.repos, ["shadetheory/asgard"]);
});

test("code questions without a repo use the workspace map", async () => {
  const plan = await planQuery("where is gather defined");
  assert.ok(plan.tools.workspace_map);
  assert.equal(plan.tools.repo_spatial, undefined);
});

test("which agents are running does not also fetch sessions", async () => {
  const plan = await planQuery("which agents are running");
  assert.deepEqual(Object.keys(plan.tools), ["herdr_agent_list"]);
});

test("asking for both presence and agents keeps both reads", async () => {
  const plan = await planQuery("who is online and which agents are running");
  assert.ok(plan.tools.bus_sessions);
  assert.ok(plan.tools.herdr_agent_list);
  assert.equal(plan.usedModel, false);
});

test("check PR status for lex does not answer from stored memory", async () => {
  const calls = { n: 0 };
  const plan = await planQuery("check PR status for lex", { model: model({ tools: ["vector_search", "knowledge_retrieve"] }, calls) });
  assert.equal(calls.n, 0);
  assert.equal(plan.ambiguous, false);
  assert.equal(plan.usedModel, false);
  assert.deepEqual(plan.tools, {});
  assert.ok(plan.gaps.some((gap) => gap.code === "live_pr_status"));
  assert.equal(plan.tools.vector_search, undefined);
  assert.equal(plan.tools.knowledge_retrieve, undefined);
});

test("an explicit memory question about a PR may use memory tools", async () => {
  const plan = await planQuery("what do you know about the lex pull request");
  assert.ok(plan.tools.vector_search);
  assert.ok(plan.tools.knowledge_retrieve);
  assert.equal(plan.gaps.some((gap) => gap.code === "live_pr_status"), false);
});

test("an ambiguous ask calls the local model once and drops unknown tools", async () => {
  const calls = { n: 0 };
  const plan = await planQuery("status", {
    model: model({
      tools: {
        bus_sessions: { timeout_ms: 3000 },
        knowledge_retrieve: true,
        rm_rf: true,
      },
    }, calls),
  });
  assert.equal(calls.n, 1);
  assert.equal(plan.usedModel, true);
  assert.equal(plan.ambiguous, false);
  assert.equal(plan.tools.bus_sessions?.timeout_ms, TIMEOUTS_MS.live);
  assert.deepEqual(plan.tools.knowledge_retrieve, {
    query: "status",
    limit: 5,
    timeout_ms: TIMEOUTS_MS.memory,
  });
  assert.equal("rm_rf" in plan.tools, false);
  assert.equal(plan.selections.bus_sessions?.via, "model");
});

test("an ambiguous ask without a model does not guess tools", async () => {
  const plan = await planQuery("status");
  assert.equal(plan.usedModel, false);
  assert.equal(plan.ambiguous, true);
  assert.deepEqual(plan.tools, {});
  assert.ok(plan.gaps.some((gap) => gap.code === "ambiguous_query"));
});

test("constraints stop a file listing from being planned as panes", () => {
  const result = enforcePlanConstraints("list files in project", {
    herdr_pane_list: { timeout_ms: 3000 },
    vector_search: { query: "files", limit: 5, timeout_ms: 5000 },
  });
  assert.equal(result.tools.herdr_pane_list, undefined);
  assert.ok(result.tools.workspace_map);
  assert.ok(result.tools.vector_search);
});

test("constraints strip memory tools from a live PR status plan", () => {
  const result = enforcePlanConstraints("check PR status for lex", {
    vector_search: { query: "lex PR", limit: 3, timeout_ms: 5000 },
    knowledge_retrieve: { query: "lex PR", limit: 3, timeout_ms: 5000 },
    bus_sessions: { timeout_ms: 3000 },
  });
  assert.equal(result.tools.vector_search, undefined);
  assert.equal(result.tools.knowledge_retrieve, undefined);
  assert.ok(result.tools.bus_sessions);
  assert.ok(result.gaps.some((gap) => gap.code === "live_pr_status"));
});

test("constraints do not keep both session and agent tools unless the ask names both", () => {
  const result = enforcePlanConstraints("who is online", {
    bus_sessions: { timeout_ms: 3000 },
    herdr_agent_list: { timeout_ms: 3000 },
  });
  assert.ok(result.tools.bus_sessions);
  assert.equal(result.tools.herdr_agent_list, undefined);
});

test("constraints drop a repository the user did not mention", () => {
  const result = enforcePlanConstraints("where is gather defined", {
    repo_spatial: { repos: ["jordanpartridge/asgard"], query: "gather", timeout_ms: 10000 },
  });
  assert.equal(result.tools.repo_spatial, undefined);
  assert.equal(JSON.stringify(result).includes("jordanpartridge"), false);
});
