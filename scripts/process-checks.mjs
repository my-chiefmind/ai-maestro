#!/usr/bin/env node
/**
 * Two delivery-process checks over git history (opt-in: nothing runs them unless you do).
 *
 *   maestro check process-ratio   [--days 30] [--ref origin/main] [--check] [--json]
 *     How much of recent work on a branch was process (evidence, board, docs) rather than code
 *     or tests. Counts added lines only, so evidence clean-ups (deletions) do not inflate it;
 *     merge commits are skipped. Report-only unless --check, which exits 1 when a target is
 *     missed.
 *
 *   maestro check evidence-budget [--base origin/main]... [--json]
 *     Fails a branch that commits raw evidence or oversized reports under the board's reports
 *     folder: a new file there must have an allowed suffix (Markdown/HTML), one file may add at
 *     most maxFileLines lines, and the branch at most maxTotalLines. Deletions and edits that
 *     add no lines always pass. A waiver (env EVIDENCE_BUDGET_WAIVER="<approval reference>")
 *     reports WAIVED and exits 0.
 *
 * Both read their targets from config.json `checks.processRatio` / `checks.evidenceBudget`
 * (see DEFAULT_PROCESS_RATIO / DEFAULT_EVIDENCE_BUDGET); flags override config for one run.
 * Paths are relative to the repository root. No third-party dependencies.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { globMatches } from "./lane-core.mjs";

export const DEFAULT_PROCESS_RATIO = Object.freeze({
  days: 30,
  ref: "origin/main",
  lineTargetPct: 10,
  commitTargetPct: 15,
  /** Categories counted as process overhead. */
  process: Object.freeze(["evidence", "board", "docs"]),
  /** Globs (repo-relative) whose lines are generated and never counted. */
  generated: Object.freeze([
    "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/uv.lock", "**/poetry.lock",
    "**/Cargo.lock", "**/go.sum", "**/.maestro.lock",
  ]),
  /** Globs counted as docs, besides any `*.md`. */
  docs: Object.freeze(["docs/**"]),
});

export const DEFAULT_EVIDENCE_BUDGET = Object.freeze({
  allowedSuffixes: Object.freeze([".md", ".html"]),
  maxFileLines: 200,
  maxTotalLines: 400,
  bases: Object.freeze(["origin/main", "main"]),
  waiverEnv: "EVIDENCE_BUDGET_WAIVER",
});

const TEST_PATH = /(test_[^/]*\.py$|_test\.py$|\.(test|spec|cy)\.[cm]?[jt]sx?$|(^|\/)tests?\/|(^|\/)__tests__\/)/;
const CATEGORIES = ["code", "tests", "evidence", "board", "docs"];
const posix = (p) => p.split(sep).join("/");
const withSlash = (p) => (p && !p.endsWith("/") ? `${p}/` : p);

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** Settings for one check, from config merged over defaults. `boardRel` is the board's repo-relative path. */
export function processRatioSettings(config = {}, { boardRel = "maestro/board" } = {}) {
  const raw = isObject(config?.checks?.processRatio) ? config.checks.processRatio : {};
  const s = {
    ...DEFAULT_PROCESS_RATIO,
    reportsDir: posix(`${boardRel}/reports`),
    boardDir: posix(boardRel),
    ...raw,
    generated: [...DEFAULT_PROCESS_RATIO.generated, ...(Array.isArray(raw.generated) ? raw.generated : [])],
  };
  return { ...s, reportsDir: withSlash(s.reportsDir), boardDir: withSlash(s.boardDir) };
}

export function evidenceBudgetSettings(config = {}, { boardRel = "maestro/board" } = {}) {
  const raw = isObject(config?.checks?.evidenceBudget) ? config.checks.evidenceBudget : {};
  const s = { ...DEFAULT_EVIDENCE_BUDGET, reportsDir: posix(`${boardRel}/reports`), ...raw };
  return { ...s, reportsDir: withSlash(s.reportsDir) };
}

/** Problems with config.checks, as messages. */
export function processChecksConfigIssues(config = {}) {
  const checks = config?.checks;
  if (checks == null) return [];
  if (!isObject(checks)) return ["config.checks must be an object."];
  const issues = [];
  const num = (obj, key, where) => {
    if (obj[key] != null && !(typeof obj[key] === "number" && obj[key] >= 0)) issues.push(`${where}.${key} must be a non-negative number.`);
  };
  const strings = (obj, key, where) => {
    if (obj[key] != null && !(Array.isArray(obj[key]) && obj[key].every((x) => typeof x === "string" && x))) issues.push(`${where}.${key} must be a list of strings.`);
  };
  const known = (obj, keys, where) => {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) issues.push(`${where}.${k} is not a known setting (known: ${keys.join(", ")}).`);
  };
  if (checks.processRatio != null) {
    const p = checks.processRatio, w = "config.checks.processRatio";
    if (!isObject(p)) issues.push(`${w} must be an object.`);
    else {
      known(p, ["days", "ref", "lineTargetPct", "commitTargetPct", "process", "generated", "docs", "reportsDir", "boardDir"], w);
      for (const k of ["days", "lineTargetPct", "commitTargetPct"]) num(p, k, w);
      for (const k of ["process", "generated", "docs"]) strings(p, k, w);
      if (Array.isArray(p.process)) for (const c of p.process) if (!CATEGORIES.includes(c)) issues.push(`${w}.process: "${c}" is not a category (${CATEGORIES.join(", ")}).`);
    }
  }
  if (checks.evidenceBudget != null) {
    const e = checks.evidenceBudget, w = "config.checks.evidenceBudget";
    if (!isObject(e)) issues.push(`${w} must be an object.`);
    else {
      known(e, ["reportsDir", "allowedSuffixes", "maxFileLines", "maxTotalLines", "bases", "waiverEnv"], w);
      for (const k of ["maxFileLines", "maxTotalLines"]) num(e, k, w);
      for (const k of ["allowedSuffixes", "bases"]) strings(e, k, w);
    }
  }
  for (const k of Object.keys(checks)) if (!["processRatio", "evidenceBudget"].includes(k)) issues.push(`config.checks.${k} is not a known check (known: processRatio, evidenceBudget).`);
  return issues;
}

// ── process ratio ───────────────────────────────────────────────────────────────────────

export function categorize(path, settings) {
  if (path.startsWith(settings.reportsDir)) return "evidence";
  if (path.startsWith(settings.boardDir)) return "board";
  if (settings.generated.some((g) => globMatches(path, g))) return "generated";
  if (path.endsWith(".md") || settings.docs.some((g) => globMatches(path, g))) return "docs";
  if (TEST_PATH.test(path)) return "tests";
  return "code";
}

/** Commits as {header, added: {category: lines}} from `git log --numstat --format=@@%h %s`. */
export function parseNumstatLog(text, settings) {
  const commits = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) { commits.push({ header: line.slice(2), added: {} }); continue; }
    const parts = line.split("\t");
    if (commits.length && parts.length === 3 && parts[0] !== "-") {
      const c = categorize(parts[2], settings);
      const added = commits[commits.length - 1].added;
      added[c] = (added[c] ?? 0) + Number(parts[0]);
    }
  }
  return commits;
}

export function summarizeProcessRatio(commits, settings) {
  const added = {};
  let noCode = 0, counted = 0;
  for (const { added: cats } of commits) {
    for (const [c, n] of Object.entries(cats)) added[c] = (added[c] ?? 0) + n;
    const touched = Object.entries(cats).filter(([c, n]) => n && c !== "generated").map(([c]) => c);
    if (!touched.length) continue;
    counted++;
    if (!touched.includes("code") && !touched.includes("tests")) noCode++;
  }
  const total = Object.entries(added).filter(([c]) => c !== "generated").reduce((n, [, v]) => n + v, 0);
  const process = settings.process.reduce((n, c) => n + (added[c] ?? 0), 0);
  const processPct = total ? (100 * process) / total : 0;
  const noCodePct = counted ? (100 * noCode) / counted : 0;
  return {
    added, total, processPct, commits: counted, noCodeCommits: noCode, noCodePct,
    lineTargetPct: settings.lineTargetPct, commitTargetPct: settings.commitTargetPct,
    missed: processPct > settings.lineTargetPct || noCodePct > settings.commitTargetPct,
  };
}

export function renderProcessRatio(summary, { days, ref }) {
  const lines = [`process-ratio: last ${days} days of ${ref} (added lines, merges skipped)`];
  for (const name of CATEGORIES) {
    const n = summary.added[name] ?? 0;
    const pct = summary.total ? (100 * n) / summary.total : 0;
    lines.push(`  ${name.padEnd(9)} ${String(n).padStart(9)}  ${pct.toFixed(1).padStart(5)}%`);
  }
  lines.push(`  process share of added lines: ${summary.processPct.toFixed(1)}% (target <= ${summary.lineTargetPct}%)`);
  lines.push(`  commits touching no code/tests: ${summary.noCodeCommits} of ${summary.commits} = ${summary.noCodePct.toFixed(1)}% (target <= ${summary.commitTargetPct}%)`);
  return lines.join("\n");
}

/** Run the process-ratio check against the repository at `root`. */
export function processRatio({ root, settings }) {
  const r = spawnSync("git", ["log", settings.ref, `--since=${settings.days} days ago`, "--no-merges", "--numstat", "--format=@@%h %s"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return { error: `cannot read ${settings.ref}: ${r.stderr.trim()}` };
  return summarizeProcessRatio(parseNumstatLog(r.stdout, settings), settings);
}

// ── evidence budget ─────────────────────────────────────────────────────────────────────

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function mergeBase(root, bases) {
  for (const base of bases) {
    const out = git(root, ["merge-base", "HEAD", base]);
    if (out) return out.trim();
  }
  return null;
}

/** [status, path, added lines] for every report path changed since `base` (working tree included). */
export function reportChanges(root, base, reportsDir) {
  // -z keeps paths verbatim: without it git quotes non-ASCII names.
  const statusOut = git(root, ["diff", "-z", "--name-status", "--no-renames", base, "--", reportsDir]) ?? "";
  const numstatOut = git(root, ["diff", "-z", "--numstat", "--no-renames", base, "--", reportsDir]) ?? "";
  const added = new Map();
  for (const record of numstatOut.split("\0")) {
    const parts = record.split("\t");
    if (parts.length === 3) added.set(parts[2], parts[0] === "-" ? 0 : Number(parts[0]));
  }
  const fields = statusOut.split("\0");
  const rows = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] && fields[i + 1]) rows.push([fields[i][0], fields[i + 1], added.get(fields[i + 1]) ?? 0]);
  }
  return rows;
}

export function evidenceViolations(rows, settings) {
  const problems = [];
  let total = 0;
  for (const [status, path, lines] of rows) {
    if (status === "D") continue;
    total += lines;
    if (status === "A" && !settings.allowedSuffixes.some((s) => path.endsWith(s))) {
      problems.push(`${path}: raw evidence is not committed; keep it outside the repository (for example .local/evidence/<ticket>/) and commit a short ${settings.allowedSuffixes.join("/")} verdict`);
    } else if (lines > settings.maxFileLines) {
      problems.push(`${path}: adds ${lines} lines (limit ${settings.maxFileLines}); commit a short verdict and keep the detail local`);
    }
  }
  if (total > settings.maxTotalLines) problems.push(`branch adds ${total} report lines in total (limit ${settings.maxTotalLines})`);
  return { problems, total };
}

/** Run the evidence-budget check. `verdict` is PASS, FAIL, WAIVED or SKIP. */
export function evidenceBudget({ root, settings, env = process.env }) {
  const base = mergeBase(root, settings.bases);
  if (!base) return { verdict: "SKIP", reason: `no ${settings.bases.join(" or ")} to compare against`, problems: [], total: 0 };
  const { problems, total } = evidenceViolations(reportChanges(root, base, settings.reportsDir), settings);
  if (!problems.length) return { verdict: "PASS", base, problems, total };
  const waiver = String(env[settings.waiverEnv] ?? "").trim();
  return waiver ? { verdict: "WAIVED", waiver, base, problems, total } : { verdict: "FAIL", base, problems, total };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────

function findConfig(start, explicit) {
  if (explicit) return resolve(explicit);
  for (const c of [join(start, "maestro", "config.json"), join(start, "config.json")]) if (existsSync(c)) return c;
  const kit = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return existsSync(join(kit, "config.json")) ? join(kit, "config.json") : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const op = argv[0];
  const has = (n) => argv.includes(`--${n}`);
  const value = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
  const values = (n) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] != null ? [argv[i + 1]] : []));
  const JSON_OUT = has("json");
  const fail = (msg, code = 2) => {
    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
    else process.stderr.write(`${msg}\n`);
    process.exit(code);
  };
  if (!["process-ratio", "evidence-budget"].includes(op)) {
    process.stdout.write(`
  maestro check — delivery-process checks over git history (targets from config.json "checks")

    maestro check process-ratio   [--days N] [--ref <ref>] [--check] [--json]
    maestro check evidence-budget [--base <ref>]... [--json]

  Common flags: --config <config.json> (default maestro/config.json, then ./config.json)
                --root <repo> (default: the git top level of the current directory)
`);
    process.exit(!op || ["help", "--help", "-h"].includes(op) ? 0 : 2);
  }
  const cwd = process.cwd();
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  const root = resolve(value("root") ?? (top.status === 0 ? top.stdout.trim() : cwd));
  const configPath = findConfig(root, value("config"));
  let config = {};
  if (configPath && existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { fail(`${configPath} is not valid JSON.`); }
  }
  const issues = processChecksConfigIssues(config);
  if (issues.length) fail(issues.join("\n"));
  // The board lives in <config dir>/board; its repo-relative path decides the report folders.
  const boardAbs = configPath ? join(dirname(configPath), "board") : join(root, "board");
  const rel = posix(relative(root, boardAbs));
  const boardRel = rel.startsWith("..") || isAbsolute(rel) ? "board" : rel;

  if (op === "process-ratio") {
    const settings = processRatioSettings(config, { boardRel });
    if (value("days") != null) settings.days = Number(value("days"));
    if (value("ref") != null) settings.ref = value("ref");
    const summary = processRatio({ root, settings });
    if (summary.error) fail(`process-ratio: ${summary.error}`);
    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: !summary.missed, days: settings.days, ref: settings.ref, ...summary }) + "\n");
    else process.stdout.write(renderProcessRatio(summary, settings) + "\n");
    process.exit(has("check") && summary.missed ? 1 : 0);
  }

  const settings = evidenceBudgetSettings(config, { boardRel });
  if (values("base").length) settings.bases = values("base");
  const result = evidenceBudget({ root, settings });
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: result.verdict !== "FAIL", reportsDir: settings.reportsDir, ...result }) + "\n");
  } else if (result.verdict === "SKIP") {
    process.stdout.write(`evidence-budget: SKIP (${result.reason})\n`);
  } else if (result.verdict === "PASS") {
    process.stdout.write(`evidence-budget: PASS (${result.total} report lines added since ${result.base.slice(0, 12)})\n`);
  } else {
    const stream = result.verdict === "WAIVED" ? process.stdout : process.stderr;
    for (const p of result.problems) stream.write(`  - ${p}\n`);
    if (result.verdict === "WAIVED") process.stdout.write(`evidence-budget: WAIVED (${result.waiver})\n`);
    else process.stderr.write(`evidence-budget: FAIL (${settings.reportsDir}; waive with ${settings.waiverEnv}="<approval reference>")\n`);
  }
  process.exit(result.verdict === "FAIL" ? 1 : 0);
}
