import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAsgardCatalog, matchCapabilitiesDeterministic, parseAsgardCatalogPhp, parseCatalogJson } from "../src/catalog.ts";

// Copied read-only from shadetheory/Asgard@d3600fb app/RequestLayer/HouseCapabilityCatalog.php.
const FIXTURE = fileURLToPath(new URL("./fixtures/asgard-HouseCapabilityCatalog.php", import.meta.url));
const catalog = parseAsgardCatalogPhp(readFileSync(FIXTURE, "utf8"));

test("Asgard's PHP catalog parses into every capability with its risk and wiring", () => {
  assert.deepEqual(catalog.map((cap) => cap.id), [
    "physical.off",
    "physical.on",
    "media.play",
    "climate.set_temperature",
    "physical.lock",
    "money.send",
    "message.send",
  ]);
  const byId = Object.fromEntries(catalog.map((cap) => [cap.id, cap]));
  assert.equal(byId["physical.off"]?.tool, "ha_turn_off");
  assert.equal(byId["physical.off"]?.entity, "bedroom_light");
  assert.deepEqual(byId["physical.off"]?.spokenTargets, ["lights", "light", "bedroom lights", "bedroom light"]);
  assert.equal(byId["media.play"]?.queryTarget, true);
  assert.equal(byId["media.play"]?.entity, "thor");
  assert.equal(byId["climate.set_temperature"]?.entity, "climate.air_conditioner");
  assert.equal(byId["climate.set_temperature"]?.wired, false);
  assert.equal(byId["physical.on"]?.wired, true);
  assert.equal(byId["physical.lock"]?.risk, "high");
  assert.equal(byId["money.send"]?.risk, "high");
  assert.equal(byId["message.send"]?.tool, "mattermost_create_post");
  for (const cap of catalog) assert.equal(cap.timeoutMs, 60_000);
});

test("a JSON export in snake_case reads the same way", () => {
  const caps = parseCatalogJson(JSON.stringify({
    capabilities: [{ domain: "physical", action: "off", spoken_targets: ["lights"], query_target: false, tool: "ha_turn_off", entity: "light.x", risk: "low", timeout_seconds: 30 }],
  }));
  assert.equal(caps[0]?.id, "physical.off");
  assert.equal(caps[0]?.timeoutMs, 30_000);
  assert.deepEqual(caps[0]?.spokenTargets, ["lights"]);
});

test("loadAsgardCatalog reads a catalog file without writing anything", async () => {
  const caps = await loadAsgardCatalog({ file: FIXTURE });
  assert.equal(caps.length, 7);
});

test("deterministic matching needs both the verb and a catalog target", () => {
  assert.equal(matchCapabilitiesDeterministic("turn off the lights", catalog).matches[0]?.capability.id, "physical.off");
  assert.equal(matchCapabilitiesDeterministic("turn off the garage fan", catalog).matches.length, 0);
  assert.equal(matchCapabilitiesDeterministic("what panes are open", catalog).matches.length, 0);
  const play = matchCapabilitiesDeterministic("play Daft Punk", catalog).matches[0];
  assert.equal(play?.capability.id, "media.play");
  assert.equal(play?.target, "daft punk");
});

test("a shared action needs its domain cue, so a message is never planned as money", () => {
  assert.deepEqual(matchCapabilitiesDeterministic("post a message to the team saying hi", catalog).matches.map((m) => m.capability.id), ["message.send"]);
  assert.deepEqual(matchCapabilitiesDeterministic("pay mel 20 dollars", catalog).matches.map((m) => m.capability.id), ["money.send"]);
});
