import assert from "node:assert/strict";
import test from "node:test";
import { gather } from "../src/gatherer.ts";
import {
  filterSnippets,
  isExcludedPath,
  snippetsWithinBudget,
  unavailableRepoSpatial,
  type RepoSpatialProvider,
  type RepoSpatialSnippet,
} from "../src/repo-spatial.ts";

const repoParams = {
  repos: ["shadetheory/context-router"],
  query: "gather",
  timeout_ms: 1_000,
};

test("secret and generated paths are excluded", () => {
  assert.equal(isExcludedPath(".env"), true);
  assert.equal(isExcludedPath("src/.env.local"), true);
  assert.equal(isExcludedPath("secrets/keys.json"), true);
  assert.equal(isExcludedPath("id_rsa"), true);
  assert.equal(isExcludedPath("cert.pem"), true);
  assert.equal(isExcludedPath("node_modules/pkg/index.js"), true);
  assert.equal(isExcludedPath("dist/app.js"), true);
  assert.equal(isExcludedPath("src/app.min.js"), true);
  assert.equal(isExcludedPath("src/planner.ts"), false);
  assert.equal(isExcludedPath("src/secret-rotation.ts"), false);
});

test("snippet packing stays inside the hint budget", () => {
  const snippets: RepoSpatialSnippet[] = [
    { repo: "shadetheory/context-router", path: "src/a.ts", text: "A".repeat(50) },
    { repo: "shadetheory/context-router", path: "src/b.ts", text: "B".repeat(50) },
    { repo: "shadetheory/context-router", path: "src/c.ts", text: "C".repeat(50) },
  ];
  const packed = snippetsWithinBudget(snippets, 80);
  const size = packed.reduce((sum, snippet) => sum + snippet.path.length + snippet.text.length, 0);
  assert.ok(size <= 80);
  assert.ok(packed.length >= 1);
  assert.equal(packed.some((snippet) => snippet.text.startsWith("C")), false);
});

test("a disabled index is not queried and direct search is the fallback", async () => {
  let retrieved = 0;
  const provider: RepoSpatialProvider = {
    enabledRepos: () => [],
    async retrieve() {
      retrieved += 1;
      throw new Error("should not retrieve");
    },
  };
  const result = await gather({ tools: { repo_spatial: repoParams } }, {
    repoSpatial: provider,
    repoFallback: {
      async search() {
        return [{ repo: "shadetheory/context-router", path: "src/gatherer.ts", text: "DIRECT_SOURCE" }];
      },
    },
  });
  assert.equal(retrieved, 0);
  assert.match(result.summary, /DIRECT_SOURCE/);
  assert.match(result.summary, /not enabled/);
  assert.equal(result.gaps.some((gap) => gap.code === "repo_spatial_disabled"), false);
});

test("retrieve is only called for repos that were opted in", async () => {
  const seen: string[][] = [];
  const provider: RepoSpatialProvider = {
    enabledRepos: () => ["shadetheory/context-router"],
    async retrieve(request) {
      seen.push(request.repos);
      return {
        status: "ok",
        snippets: [{ repo: "shadetheory/context-router", path: "src/planner.ts", text: "KEEP_PLANNER" }],
      };
    },
  };
  const result = await gather({
    tools: {
      repo_spatial: {
        repos: ["shadetheory/context-router", "other/repo"],
        query: "plan",
        timeout_ms: 1_000,
      },
    },
  }, { repoSpatial: provider });
  assert.deepEqual(seen, [["shadetheory/context-router"]]);
  assert.match(result.summary, /KEEP_PLANNER/);
  assert.match(result.summary, /other\/repo/);
});

test("stale index snippets are not returned as current source", async () => {
  const result = await gather({ tools: { repo_spatial: repoParams } }, {
    repoSpatial: {
      enabledRepos: () => ["shadetheory/context-router"],
      async retrieve() {
        return {
          status: "ok",
          snippets: [{
            repo: "shadetheory/context-router",
            path: "src/old.ts",
            text: "STALE_SNIPPET",
            sourceRevision: "aaa",
            currentRevision: "bbb",
          }],
        };
      },
    },
    repoFallback: {
      async search() {
        return [{ repo: "shadetheory/context-router", path: "src/fresh.ts", text: "FRESH_SOURCE" }];
      },
    },
  });
  assert.match(result.summary, /FRESH_SOURCE/);
  assert.doesNotMatch(result.summary, /STALE_SNIPPET/);
  assert.match(result.summary, /stale/i);
});

test("secret and generated snippets are dropped from an otherwise good index", async () => {
  const result = await gather({ tools: { repo_spatial: repoParams } }, {
    repoSpatial: {
      enabledRepos: () => ["shadetheory/context-router"],
      async retrieve() {
        return {
          status: "ok",
          snippets: [
            { repo: "shadetheory/context-router", path: "src/planner.ts", text: "KEEP_PLANNER" },
            { repo: "shadetheory/context-router", path: ".env", text: "SUPER_SECRET_VALUE" },
            { repo: "shadetheory/context-router", path: "dist/index.js", text: "GENERATED_BUNDLE" },
          ],
        };
      },
    },
  });
  assert.match(result.summary, /KEEP_PLANNER/);
  assert.doesNotMatch(result.summary, /SUPER_SECRET_VALUE/);
  assert.doesNotMatch(result.summary, /GENERATED_BUNDLE/);
  assert.match(result.summary, /Excluded 2 secret or generated paths/);
});

test("with no provider and no fallback the index stays disabled", async () => {
  const result = await gather({ tools: { repo_spatial: repoParams } }, {
    repoSpatial: unavailableRepoSpatial,
  });
  assert.match(result.summary, /opt-in|not enabled|No opted-in/i);
  assert.equal(result.gaps.some((gap) => gap.code === "repo_spatial_disabled"), true);
  assert.doesNotMatch(result.summary, /indexed every/i);
});

test("filterSnippets reports the dropped paths and keeps source files", () => {
  const filtered = filterSnippets([
    { repo: "a/b", path: "src/planner.ts", text: "keep" },
    { repo: "a/b", path: ".env", text: "nope" },
  ]);
  assert.deepEqual(filtered.kept.map((snippet) => snippet.path), ["src/planner.ts"]);
  assert.deepEqual(filtered.dropped, [".env"]);
});
