/**
 * Tests for the cross-review ticket fields (dev_runtime/dev_model/reviewer_runtime/
 * reviewer_model) added to board-core.mjs's validateBoard. These are additive and optional —
 * a board with none of them set behaves exactly as before (covered by the existing suite).
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBoard } from "../scripts/board-core.mjs";

const EPIC = { id: "E-1", name: "Epic" };

function ticket(overrides = {}) {
  return {
    id: "T-1", epicId: "E-1", name: "ticket", desc: "d", area: "general",
    status: "backlog", priority: "P2", depends_on: [], agent_plan: [], model: "sonnet",
    ...overrides,
  };
}

test("cross-review fields are valid and produce no errors", () => {
  const { errors } = validateBoard({
    epics: [EPIC],
    tickets: [ticket({
      dev_runtime: "claude", dev_model: "sonnet",
      reviewer_runtime: "codex", reviewer_model: "opus",
    })],
  });
  assert.deepEqual(errors, []);
});

test("a project-defined runtime id is accepted by the runtime-neutral board", () => {
  const { errors } = validateBoard({
    epics: [EPIC],
    tickets: [ticket({ dev_runtime: "gpt5", reviewer_runtime: "codex" })],
  });
  assert.deepEqual(errors, []);
});

test("a runtime-specific model id is accepted", () => {
  const { errors } = validateBoard({
    epics: [EPIC],
    tickets: [ticket({ dev_runtime: "claude", reviewer_runtime: "codex", reviewer_model: "gpt-4" })],
  });
  assert.deepEqual(errors, []);
});

test("cross-review ids must be non-empty strings", () => {
  const { errors } = validateBoard({
    epics: [EPIC],
    tickets: [ticket({ dev_runtime: "", reviewer_runtime: "codex", reviewer_model: 42 })],
  });
  assert.ok(errors.some((e) => /dev_runtime must be a non-empty string/.test(e)));
  assert.ok(errors.some((e) => /reviewer_model must be a non-empty string/.test(e)));
});

test("a reviewer_runtime the project doesn't render for warns, not errors", () => {
  const { errors, warnings } = validateBoard({
    epics: [EPIC],
    tickets: [ticket({ dev_runtime: "claude", reviewer_runtime: "codex" })],
  }, { config: { targets: { claude: true, codex: false } } });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /effective reviewer_runtime "codex" is not enabled in config.targets/.test(w)));
});

test("a reviewer role with no dev role warns that cross-review needs both", () => {
  const { warnings } = validateBoard({
    epics: [EPIC],
    tickets: [ticket({ reviewer_runtime: "codex", reviewer_model: "sonnet" })],
  });
  assert.ok(warnings.some((w) => /cross-review needs both a developer runtime and a reviewer runtime/.test(w)));
});

test("a dev role with no reviewer role warns symmetrically", () => {
  const { warnings } = validateBoard({
    epics: [EPIC],
    tickets: [ticket({ dev_runtime: "claude", dev_model: "sonnet" })],
  });
  assert.ok(warnings.some((w) => /cross-review needs both a developer runtime and a reviewer runtime/.test(w)));
});

test("a board with none of the cross-review fields is unaffected (no new errors/warnings)", () => {
  const { errors, warnings } = validateBoard({ epics: [EPIC], tickets: [ticket()] });
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some((w) => /runtime|reviewer/.test(w)));
});
