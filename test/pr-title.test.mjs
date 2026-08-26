import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePrTitle } from "../scripts/validate-pr-title.mjs";

test("accepts a canonical ticket id anywhere in a PR title", () => {
  assert.deepEqual(validatePrTitle("Fix login timeout (T-014)"), { ok: true, ticketId: "T-014" });
  assert.deepEqual(validatePrTitle("T-2: document setup"), { ok: true, ticketId: "T-2" });
});

test("rejects missing, malformed, and embedded ticket ids", () => {
  for (const title of ["Fix login timeout", "fix t-014", "Fix T14", "Fix AT-014 bug"]) {
    assert.equal(validatePrTitle(title).ok, false, title);
  }
});
