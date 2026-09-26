// @ts-check
// Keep Cockpit's cache at the edge, while all aggregation stays in the public package
// facade. Exporting this small consumer also lets reconciliation tests exercise the same
// code path without opening a loopback socket.
import { buildUsageReport } from "../../scripts/usage-api.mjs";

const USAGE_TTL_MS = 20_000;
/** @type {Map<string, { at: number, report: any }>} */
const usageMemo = new Map();

/** @param {{ boardDir: string }} scope @param {boolean} fresh */
export function usageFor(scope, fresh) {
  const hit = usageMemo.get(scope.boardDir);
  if (!fresh && hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.report;
  const report = buildUsageReport({ boardPath: scope.boardDir });
  usageMemo.set(scope.boardDir, { at: Date.now(), report });
  return report;
}

/** CSV views an endpoint may expose for this exact report shape. */
/** @param {{breakdown?: Record<string, unknown>}} report */
export function usageCsvViews(report) {
  return ["tickets", ...Object.keys(report.breakdown || {})];
}
