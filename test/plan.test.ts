import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseAsgardCatalogPhp, type Capability } from "../src/catalog.ts";
import { buildPlan, toParallelToolsBatch, type ExecutionPlan } from "../src/plan.ts";
import type { LocalModel } from "../src/types.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/asgard-HouseCapabilityCatalog.php", import.meta.url));
const catalog = parseAsgardCatalogPhp(readFileSync(FIXTURE, "utf8"));
const knownRepos = [
  { alias: "asgard", repo: "shadetheory/Asgard" },
  { alias: "context-router", repo: "shadetheory/context-router" },
];

function countingModel(reply: string, name = "qwen3.8:latest"): LocalModel & { calls: number } {
  const model = {
    name,
    calls: 0,
    async complete() {
      model.calls += 1;
      return reply;
    },
  };
  return model;
}

function targets(plan: ExecutionPlan): string[] {
  return plan.steps.map((step) => step.target.kind === "capability" ? step.target.capability : step.target.name).sort();
}

// AT-4: 20 canned asks, including the Nov 8 mis-routes.
const AT4: Array<[string, string[]]> = [
  ["list project files", ["workspace_map"]],
  ["check a PR", ["code_host"]],
  ["check PR status for asgard", ["code_host"]],
  ["is CI green on context-router", ["code_host"]],
  ["who is online", ["bus_sessions"]],
  ["what panes are open", ["herdr_pane_list"]],
  ["which agents are running", ["herdr_agent_list"]],
  ["find decisions about NAS", ["knowledge_retrieve", "vector_search"]],
  ["what did we decide this session", ["smart_recall"]],
  ["where is queueIntakeKind defined in asgard", ["repo_spatial"]],
  ["show me the file tree", ["workspace_map"]],
  ["turn off the lights", ["physical.off"]],
  ["turn the bedroom lights on", ["physical.on"]],
  ["play Daft Punk", ["media.play"]],
  ["set the ac to 72 degrees", ["climate.set_temperature"]],
  ["lock the front door", ["physical.lock"]],
  ["pay mel 20 dollars", ["money.send"]],
  ["post a message to the team channel saying hi", ["message.send"]],
  ["what do we know about the lex pull request", ["knowledge_retrieve", "vector_search"]],
  ["who is online and which agents are running", ["bus_sessions", "herdr_agent_list"]],
];

test("AT-4: at least 18 of 20 canned asks route to the expected capabilities, with no model call", async () => {
  const model = countingModel('{"tools":["vector_search"]}');
  const misses: string[] = [];
  for (const [ask, expected] of AT4) {
    const plan = await buildPlan(ask, { catalog, knownRepos, codeHost: true, model });
    const got = targets(plan);
    if (JSON.stringify(got) !== JSON.stringify([...expected].sort())) misses.push(`${ask} -> ${got.join(",") || "none"}`);
  }
  assert.ok(AT4.length - misses.length >= 18, `misses: ${misses.join("; ")}`);
  assert.deepEqual(misses, []);
  assert.equal(model.calls, 0);
});

test("list project files never becomes a pane listing", async () => {
  const plan = await buildPlan("list project files", { catalog, codeHost: true });
  assert.equal(plan.steps.some((step) => step.target.name === "herdr_pane_list"), false);
});

test("check a PR goes to the code host and never to stored memory", async () => {
  const plan = await buildPlan("check PR status for asgard", { catalog, knownRepos, codeHost: true });
  assert.deepEqual(plan.steps.map((step) => step.target.name), ["code_host"]);
  assert.deepEqual(plan.steps[0]?.args.repos, ["shadetheory/Asgard"]);
  assert.equal(plan.gaps.some((gap) => gap.code === "live_pr_status"), false);
  const withoutHost = await buildPlan("check PR status for asgard", { catalog, knownRepos });
  assert.deepEqual(withoutHost.steps, []);
  assert.ok(withoutHost.gaps.some((gap) => gap.code === "live_pr_status"));
});

test("a high-risk capability is planned but waits for Jordan", async () => {
  const plan = await buildPlan("lock the front door", { catalog });
  const step = plan.steps[0]!;
  assert.equal(step.target.kind, "capability");
  assert.equal(step.requires_approval, true);
  assert.equal(step.concurrent, false);
  assert.equal(step.risk, "high");
  assert.ok(plan.gaps.some((gap) => gap.code === "needs_jordan"));
  assert.ok(plan.gaps.some((gap) => gap.code === "capability_unwired"));
});

test("plans carry the 6,000/3,000 budget, a deadline, and per-step bounds", async () => {
  const plan = await buildPlan("where is queueIntakeKind defined in asgard", { catalog, knownRepos });
  assert.equal(plan.version, 1);
  assert.deepEqual(plan.budget, { total_chars: 6_000, code_chars: 3_000 });
  assert.equal(plan.deadline_ms, 10_000);
  const step = plan.steps[0]!;
  assert.equal(step.target.name, "repo_spatial");
  assert.equal(step.budget_chars, 3_000);
  assert.ok(step.timeout_ms <= plan.deadline_ms);
  assert.equal(plan.used_model, false);
  assert.deepEqual(plan.model_calls, []);
});

test("an ambiguous read ask calls the local model once and writes a ledger-model line", async () => {
  const model = countingModel('{"tools":["bus_sessions"]}');
  const logged: unknown[] = [];
  const plan = await buildPlan("status", { catalog, model, onModelCall: (entry) => logged.push(entry) });
  assert.equal(model.calls, 1);
  assert.equal(plan.used_model, true);
  assert.equal(plan.model_calls.length, 1);
  assert.equal(plan.model_calls[0]?.purpose, "tool-routing");
  assert.equal(plan.model_calls[0]?.model, "qwen3.8:latest");
  assert.match(plan.model_calls[0]?.why ?? "", /Local only/);
  assert.deepEqual(logged, plan.model_calls);
  assert.deepEqual(plan.steps.map((step) => step.target.name), ["bus_sessions"]);
});

const twins: Capability[] = ["porch", "patio"].map((domain) => ({
  id: `${domain}.dim`,
  domain,
  action: "dim",
  spokenTargets: ["lamp"],
  queryTarget: false,
  tool: `${domain}_dim`,
  entity: `light.${domain}`,
  risk: "low",
  timeoutMs: 5_000,
  wired: true,
  source: "test",
}));

test("two tied capabilities go to the local model only as a tie-break", async () => {
  const model = countingModel('{"capability":"patio.dim"}');
  const plan = await buildPlan("dim lamp", { catalog: twins, model });
  assert.equal(model.calls, 1);
  assert.deepEqual(targets(plan), ["patio.dim"]);
  assert.equal(plan.steps[0]?.via, "model");
  assert.equal(plan.model_calls[0]?.purpose, "capability-tie-break");
  assert.match(plan.model_calls[0]?.why ?? "", /tie/);
});

test("a tie without a model plans nothing and says so", async () => {
  const plan = await buildPlan("dim lamp", { catalog: twins });
  assert.deepEqual(plan.steps, []);
  assert.ok(plan.gaps.some((gap) => gap.code === "ambiguous_query"));
});

test("the plan converts to a parallel-tools batch with unapproved calls", async () => {
  const plan = await buildPlan("who is online and which agents are running", { catalog });
  const batch = toParallelToolsBatch(plan);
  assert.equal(batch.options.mode, "parallel");
  assert.equal(batch.options.timeout_ms, plan.deadline_ms);
  assert.deepEqual(batch.calls.map((call) => call.name).sort(), ["bus_sessions", "herdr_agent_list"]);
  for (const call of batch.calls) {
    assert.ok(call.id.startsWith(`${plan.id}:`));
    assert.equal(call.approved, false);
  }
});
