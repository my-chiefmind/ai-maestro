/**
 * Unit tests for scripts/registry.mjs — the shared registry format read by `maestro drift`,
 * `sync.mjs --all`, and (T-003) the cockpit's portfolio mode.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRegistry, expandHome, findKitDir } from "../scripts/registry.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("expandHome resolves a leading ~ against the home directory", () => {
  assert.equal(expandHome("~/source/foo"), join(homedir(), "source", "foo"));
  assert.equal(expandHome("/abs/path"), "/abs/path");
});

test("readRegistry resolves paths and defaults name to path when absent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "registry-"));
  try {
    const registryPath = join(tmp, "registry.json");
    writeFileSync(registryPath, JSON.stringify({
      projects: [{ name: "foo", path: join(tmp, "foo") }, { path: join(tmp, "bar") }],
    }));
    const { projects } = readRegistry(registryPath);
    assert.equal(projects.length, 2);
    assert.equal(projects[0].name, "foo");
    assert.equal(projects[0].path, join(tmp, "foo"));
    assert.equal(projects[1].name, join(tmp, "bar"), "no name given — falls back to the path");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readRegistry throws ENOREGISTRY for a missing file, not an empty list", () => {
  assert.throws(() => readRegistry("/does/not/exist/registry.json"), (e) => e.code === "ENOREGISTRY");
});

test("readRegistry throws EBADJSON for malformed JSON", () => {
  const tmp = mkdtempSync(join(tmpdir(), "registry-"));
  try {
    const registryPath = join(tmp, "registry.json");
    writeFileSync(registryPath, "{ not json");
    assert.throws(() => readRegistry(registryPath), (e) => e.code === "EBADJSON");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("findKitDir prefers a vendored maestro/ over the project root", () => {
  const tmp = mkdtempSync(join(tmpdir(), "registry-"));
  try {
    mkdirSync(join(tmp, "maestro"), { recursive: true });
    writeFileSync(join(tmp, "maestro", "config.json"), "{}");
    writeFileSync(join(tmp, "config.json"), "{}"); // a clone-flow kit could also sit at root
    assert.equal(findKitDir(tmp), join(tmp, "maestro"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("findKitDir falls back to the project root for a clone-flow kit", () => {
  const tmp = mkdtempSync(join(tmpdir(), "registry-"));
  try {
    writeFileSync(join(tmp, "config.json"), "{}");
    assert.equal(findKitDir(tmp), tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("findKitDir returns null for a project that was never set up", () => {
  const tmp = mkdtempSync(join(tmpdir(), "registry-"));
  try {
    assert.equal(findKitDir(tmp), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// T-007 AC: the registry example in docs/GETTING-STARTED.md must actually be what
// registry.mjs parses, not just prose that happens to look like it. Extracted from the
// ```jsonc fence rather than duplicated here, so an edit to one is checked against the other.
test("the registry example in docs/GETTING-STARTED.md is valid and loads via readRegistry", () => {
  const doc = readFileSync(join(KIT, "docs", "GETTING-STARTED.md"), "utf8");
  const fence = doc.match(/```jsonc\n\/\/ maestro-registry\.json[^\n]*\n([\s\S]*?)\n```/);
  assert.ok(fence, "expected a ```jsonc maestro-registry.json example in GETTING-STARTED.md");

  const parsed = JSON.parse(fence[1]); // jsonc's only extra syntax here was the stripped comment line
  assert.ok(Array.isArray(parsed.projects) && parsed.projects.length > 0);

  const tmp = mkdtempSync(join(tmpdir(), "docs-registry-"));
  try {
    const registryPath = join(tmp, "maestro-registry.json");
    writeFileSync(registryPath, JSON.stringify(parsed));
    const { projects } = readRegistry(registryPath);
    assert.deepEqual(projects.map((p) => p.name), parsed.projects.map((p) => p.name));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
