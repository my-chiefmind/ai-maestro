/**
 * Unit tests for scripts/registry.mjs — the shared registry format read by `maestro drift`,
 * `sync.mjs --all`, and (T-003) the cockpit's portfolio mode.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry, expandHome, findKitDir } from "../scripts/registry.mjs";

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
