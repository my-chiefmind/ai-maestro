/**
 * Tests for T-013: the registry has to describe a portfolio, not just list paths.
 *
 * WHY THIS EXISTS: the registry started as `{name, path}` and became the shared project list
 * behind `maestro drift`, `maestro update --all`, `sync --all`, and the cockpit's portfolio
 * mode. Three things it could not express:
 *
 *   - that a repo is deliberately NOT being worked (so every tool swept every listed repo,
 *     and the only way to stop that was to delete the entry and lose the fact);
 *   - that a project is portfolio tooling rather than a shipping product;
 *   - a group of groups — entries were flat repo roots with no way to compose registries.
 *
 * Plus: it must keep failing LOUDLY. A registry that doesn't load must never be indistinguishable
 * from a portfolio with no work in it.
 *
 * Run: npm test
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry } from "../scripts/registry.mjs";

let tmp;
const write = (rel, obj) => {
  const abs = join(tmp, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, JSON.stringify(obj, null, 2));
  return abs;
};
const names = (r) => r.projects.map((p) => p.name).sort();

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "maestro-registry-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test("the original flat {name, path} format still works, with defaults filled in", () => {
  const f = write("flat.json", { projects: [{ name: "a", path: "/tmp/a" }] });
  const { projects } = readRegistry(f);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "a");
  assert.equal(projects[0].status, "active");
  assert.equal(projects[0].kind, "product");
});

test("parked projects are skipped by default and included on request", () => {
  const f = write("parked.json", {
    projects: [
      { name: "live", path: "/tmp/live" },
      { name: "shelved", path: "/tmp/shelved", status: "parked" },
    ],
  });
  assert.deepEqual(names(readRegistry(f)), ["live"], "a parked project must not be swept");
  assert.deepEqual(names(readRegistry(f, { includeParked: true })), ["live", "shelved"]);
});

test("kind defaults to product and round-trips ops", () => {
  const f = write("kinds.json", {
    projects: [{ name: "app", path: "/tmp/app" }, { name: "tooling", path: "/tmp/tooling", kind: "ops" }],
  });
  const byName = Object.fromEntries(readRegistry(f).projects.map((p) => [p.name, p.kind]));
  assert.deepEqual(byName, { app: "product", tooling: "ops" });
});

test("a nested registry composes into the parent — a group of groups", () => {
  write("group-a/maestro-registry.json", {
    projects: [{ name: "a1", path: "/tmp/a1" }, { name: "a2", path: "/tmp/a2" }],
  });
  write("group-b/maestro-registry.json", { projects: [{ name: "b1", path: "/tmp/b1" }] });
  const root = write("root.json", {
    projects: [
      { registry: "./group-a/maestro-registry.json" },
      { registry: "./group-b/maestro-registry.json" },
      { name: "solo", path: "/tmp/solo" },
    ],
  });
  assert.deepEqual(names(readRegistry(root)), ["a1", "a2", "b1", "solo"]);
});

test("a nested registry path resolves against the file naming it, not the cwd", () => {
  write("deep/inner/maestro-registry.json", { projects: [{ name: "inner", path: "/tmp/inner" }] });
  write("deep/mid.json", { projects: [{ registry: "./inner/maestro-registry.json" }] });
  const root = write("deep-root.json", { projects: [{ registry: "./deep/mid.json" }] });
  assert.deepEqual(names(readRegistry(root)), ["inner"], "two levels deep, each relative to its own file");
});

test("parked applies inside a nested registry too", () => {
  write("g/maestro-registry.json", {
    projects: [{ name: "g1", path: "/tmp/g1" }, { name: "g2", path: "/tmp/g2", status: "parked" }],
  });
  const root = write("g-root.json", { projects: [{ registry: "./g/maestro-registry.json" }] });
  assert.deepEqual(names(readRegistry(root)), ["g1"]);
});

test("an include cycle is reported with the chain, not left to recurse forever", () => {
  const a = join(tmp, "cycle-a.json");
  const b = join(tmp, "cycle-b.json");
  writeFileSync(a, JSON.stringify({ projects: [{ registry: "./cycle-b.json" }] }));
  writeFileSync(b, JSON.stringify({ projects: [{ registry: "./cycle-a.json" }] }));
  assert.throws(() => readRegistry(a), (e) => e.code === "ECYCLE" && /cycle-a\.json/.test(e.message));
});

test("a registry that includes itself is a cycle", () => {
  const f = join(tmp, "self.json");
  writeFileSync(f, JSON.stringify({ projects: [{ registry: "./self.json" }] }));
  assert.throws(() => readRegistry(f), (e) => e.code === "ECYCLE");
});

test("a duplicate project name across registries is an error, not a silent winner", () => {
  write("dup/maestro-registry.json", { projects: [{ name: "same", path: "/tmp/one" }] });
  const root = write("dup-root.json", {
    projects: [{ registry: "./dup/maestro-registry.json" }, { name: "same", path: "/tmp/two" }],
  });
  assert.throws(() => readRegistry(root), (e) => e.code === "EDUPNAME" && /"same"/.test(e.message));
});

test("a duplicate name is caught even when both entries are parked-and-skipped", () => {
  // Uniqueness is a property of the registry, not of what a given sweep happens to return —
  // otherwise un-parking a project could surface a clash that was there all along.
  const f = write("dup-parked.json", {
    projects: [
      { name: "same", path: "/tmp/one", status: "parked" },
      { name: "same", path: "/tmp/two", status: "parked" },
    ],
  });
  assert.throws(() => readRegistry(f), (e) => e.code === "EDUPNAME");
});

test("malformed registries fail loudly rather than reading as an empty portfolio", () => {
  const missing = join(tmp, "nope.json");
  assert.throws(() => readRegistry(missing), (e) => e.code === "ENOREGISTRY");

  const bad = join(tmp, "bad.json");
  writeFileSync(bad, "{ not json");
  assert.throws(() => readRegistry(bad), (e) => e.code === "EBADJSON");

  assert.throws(
    () => readRegistry(write("notarray.json", { projects: {} })),
    (e) => e.code === "EBADREGISTRY"
  );
  assert.throws(
    () => readRegistry(write("nopath.json", { projects: [{ name: "x" }] })),
    (e) => e.code === "EBADREGISTRY" && /needs a "path"/.test(e.message)
  );
  assert.throws(
    () => readRegistry(write("badstatus.json", { projects: [{ path: "/tmp/x", status: "asleep" }] })),
    (e) => e.code === "EBADREGISTRY" && /status "asleep"/.test(e.message)
  );
  assert.throws(
    () => readRegistry(write("badkind.json", { projects: [{ path: "/tmp/x", kind: "thing" }] })),
    (e) => e.code === "EBADREGISTRY" && /kind "thing"/.test(e.message)
  );
  assert.throws(
    () => readRegistry(write("both.json", { projects: [{ path: "/tmp/x", registry: "./y.json" }] })),
    (e) => e.code === "EBADREGISTRY" && /both "registry" and "path"/.test(e.message)
  );
});

test("an entry records which registry file it came from", () => {
  write("src/maestro-registry.json", { projects: [{ name: "s", path: "/tmp/s" }] });
  const root = write("src-root.json", { projects: [{ registry: "./src/maestro-registry.json" }] });
  const { projects } = readRegistry(root);
  assert.match(projects[0].source, /src\/maestro-registry\.json$/, "so a clash can name both files");
});
