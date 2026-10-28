/**
 * Refresh a vendored kit's files without dropping the project's own edits to them.
 *
 * `update` used to remove each vendored folder (scripts/, render/, bin/, …) and copy the new
 * release over it. A project that had patched a kit script lost the patch silently, and had to
 * find and re-apply it by hand. Now every vendored file is handled on its own, as a 3-way merge:
 *
 *   base   = what the previous update wrote (the kit as it was),
 *   ours   = what is on disk now (the kit plus the project's edits),
 *   theirs = what this release ships.
 *
 * An unedited file (ours == base) simply takes the new release. An edited one is merged with
 * `git merge-file`; a clean merge keeps both changes, a conflicting one is written with
 * conflict markers and reported, and the update stops before re-rendering until it is resolved.
 *
 * Where `base` comes from, in order:
 *   1. <kit>/.maestro-vendor-base/files/<file> — the pristine kit copy kept for every file the project
 *      has edited (written by each update; small, committed with the project, works offline);
 *   2. `--base <dir>`: a copy of the previous kit release (an extracted package or a checkout);
 *   3. the project's git history: a committed version of the file whose hash is the one the
 *      vendor lock recorded;
 *   4. the previous release from the npm registry (`npm pack`), unless `--offline`.
 *
 * Which files were edited is decided by the vendor lock's `files` map (a hash per vendored
 * file). A lock from before that map existed has no record, so the previous release (from 2 or
 * 4) is the record instead. With neither, an edit cannot be told apart from an older kit
 * version: the on-disk copy is kept under custom/rescued/ and reported, never dropped silently.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

export const VENDOR_BASE_DIR = ".maestro-vendor-base";
const sha256 = (data) => "sha256:" + createHash("sha256").update(data).digest("hex");
const posix = (p) => p.split(sep).join("/");

/** Marker lines a merge leaves in a file; their presence means the conflict is unresolved. */
export const CONFLICT_START = "<<<<<<< local";
const CONFLICT_RE = /^<<<<<<< local\r?$/m;
export const hasConflictMarkers = (text) => CONFLICT_RE.test(text);

// A kit file is written to a temporary name beside it, then renamed into place: an update killed
// mid-write must not leave a truncated script, which the next run would take for a local edit
// and keep. A temporary file left by a killed run is never a kit file; listing removes it.
const TMP_SUFFIX = /\.maestro-tmp-\d+$/;
export function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.maestro-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Every file under `root/entry` (or the file `root/entry` itself), as posix paths relative to `root`. */
export function listEntryFiles(root, entry, skip = new Set()) {
  const abs = join(root, entry);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [entry];
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      if (TMP_SUFFIX.test(name)) { rmSync(p, { force: true }); continue; }
      if (statSync(p).isDirectory()) walk(p);
      else out.push(posix(relative(root, p)));
    }
  };
  walk(abs);
  return out;
}

/** Hash of every vendored file, for the vendor lock. */
export function fileHashes(root, entries, skip) {
  const hashes = {};
  for (const entry of entries) for (const rel of listEntryFiles(root, entry, skip)) hashes[rel] = sha256(readFileSync(join(root, rel)));
  return hashes;
}

/**
 * 3-way merge of three texts with `git merge-file`. Returns { text, conflicts } where conflicts
 * is the number of conflicting hunks (0 = clean). Throws when git is unavailable.
 */
export function mergeTexts({ ours, base, theirs, labels = ["local", "base", "kit"] }) {
  const dir = mkdtempSync(join(tmpdir(), "maestro-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(dir, n));
    writeFileSync(o, ours); writeFileSync(b, base ?? ""); writeFileSync(t, theirs);
    const r = spawnSync("git", ["merge-file", "-p", "-L", labels[0], "-L", labels[1], "-L", labels[2], o, b, t], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status == null || r.status < 0) throw new Error(`git merge-file failed: ${r.error?.message ?? r.stderr}`);
    return { text: r.stdout, conflicts: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The previous kit release from npm, extracted; null when it cannot be fetched. */
export function fetchPublishedKit(pkg, version) {
  const dir = mkdtempSync(join(tmpdir(), "maestro-base-"));
  const pack = spawnSync("npm", ["pack", `${pkg}@${version}`, "--pack-destination", dir, "--silent"], { encoding: "utf8", timeout: 60000, shell: process.platform === "win32" });
  const tarball = pack.status === 0 ? pack.stdout.trim().split("\n").pop() : null;
  if (!tarball || !existsSync(join(dir, tarball))) { rmSync(dir, { recursive: true, force: true }); return null; }
  const untar = spawnSync("tar", ["-xzf", join(dir, tarball), "-C", dir], { encoding: "utf8" });
  if (untar.status !== 0 || !existsSync(join(dir, "package"))) { rmSync(dir, { recursive: true, force: true }); return null; }
  return join(dir, "package");
}

/** The content of `repoPath` at the newest commit (of the last `limit` touching it) whose hash is `hash`. */
function fromGitHistory(repoRoot, repoPath, hash, limit = 200) {
  if (!repoRoot) return null;
  const log = spawnSync("git", ["-C", repoRoot, "log", `-n${limit}`, "--format=%H", "--", repoPath], { encoding: "utf8" });
  if (log.status !== 0) return null;
  for (const commit of log.stdout.split("\n").filter(Boolean)) {
    const show = spawnSync("git", ["-C", repoRoot, "show", `${commit}:${repoPath}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    if (show.status === 0 && sha256(show.stdout) === hash) return show.stdout;
  }
  return null;
}

/**
 * Remove the folders under `root/entry` that are left empty and that `kitRoot` no longer ships.
 * Deleting a release's removed files one by one leaves their folders behind (a dropped starter
 * would linger as an empty tree); a folder still holding anything, or still shipped, stays.
 */
function pruneEmptyDirs(root, entry, kitRoot) {
  const abs = join(root, entry);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
    }
    const rel = relative(root, dir);
    if (dir !== abs && readdirSync(dir).length === 0 && !existsSync(join(kitRoot, rel))) rmSync(dir, { recursive: true, force: true });
  };
  walk(abs);
}

function gitTopLevel(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Refresh the merge-managed entries of a vendored kit at `dest` from `kitRoot`.
 *
 * @param {object} o
 * @param {string} o.kitRoot      the new release
 * @param {string} o.dest         the vendored kit
 * @param {string[]} o.entries    vendored entries handled here (folders or single files)
 * @param {string[]} [o.overwrite] entries always replaced, never merged (e.g. VERSION)
 * @param {Record<string,string>|null} o.priorFiles  the vendor lock's `files` map, or null
 * @param {Set<string>} o.skip    names never vendored (node_modules, …)
 * @param {string} o.before       version on disk; @param {string} o.target version shipped
 * @param {string|null} [o.baseDir] a copy of the `before` release (--base)
 * @param {boolean} [o.offline]   never fetch the previous release from npm
 * @param {string} [o.pkg]        npm package name
 * @param {string} o.rescueDir    where unmergeable local copies are kept (custom/rescued)
 * @returns {{ files: Record<string,string>, merged: string[], conflicts: string[], rescued: Array<{from:string,to:string,why:string}>, kept: string[], baseSource: string|null }}
 */
export function refreshMergedEntries(o) {
  const { kitRoot, dest, entries, overwrite = [], priorFiles, skip, before, target, offline = false, pkg, rescueDir } = o;
  const report = { files: {}, merged: [], conflicts: [], rescued: [], kept: [], baseSource: null };
  const repoRoot = gitTopLevel(dest);
  const baseRoot = join(dest, VENDOR_BASE_DIR);
  const baseStore = join(baseRoot, "files");
  const labels = ["local", `kit v${before}`, `kit v${target}`];

  // The previous release, fetched at most once and only when something needs it.
  let baseKit = o.baseDir && existsSync(o.baseDir) ? o.baseDir : undefined;
  if (baseKit) report.baseSource = `--base ${o.baseDir}`;
  let fetched = null;
  const previousRelease = () => {
    if (baseKit !== undefined) return baseKit;
    baseKit = null;
    if (!offline && pkg && before && before !== "0.0.0") {
      fetched = fetchPublishedKit(pkg, before);
      if (fetched) { baseKit = fetched; report.baseSource = `${pkg}@${before} from npm`; }
    }
    return baseKit;
  };

  /** What the previous update wrote for `rel`: { hash, content } (content may be null), or null = no record. */
  const baseOf = (rel) => {
    if (priorFiles) {
      const hash = priorFiles[rel];
      if (!hash) return { hash: null, content: null }; // not a kit file last time
      const stored = join(baseStore, rel);
      if (existsSync(stored)) { const c = readFileSync(stored); if (sha256(c) === hash) return { hash, content: c }; }
      const kit = previousRelease();
      if (kit && existsSync(join(kit, rel))) { const c = readFileSync(join(kit, rel)); if (sha256(c) === hash) return { hash, content: c }; }
      const hist = repoRoot ? fromGitHistory(repoRoot, posix(relative(repoRoot, join(dest, rel))), hash) : null;
      return { hash, content: hist };
    }
    const kit = previousRelease();
    if (!kit) return null;
    if (!existsSync(join(kit, rel))) return { hash: null, content: null };
    const c = readFileSync(join(kit, rel));
    return { hash: sha256(c), content: c };
  };

  const rescue = (rel, why) => {
    const to = join(rescueDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(dest, rel), to);
    report.rescued.push({ from: rel, to: posix(relative(dest, to)), why });
  };
  const write = (rel, content) => writeAtomic(join(dest, rel), content);
  const keepBase = new Map(); // rel → pristine kit content, for files that end up differing from the kit

  try {
    for (const entry of overwrite) {
      for (const rel of listEntryFiles(dest, entry, skip)) rmSync(join(dest, rel), { force: true });
      for (const rel of listEntryFiles(kitRoot, entry, skip)) {
        const c = readFileSync(join(kitRoot, rel));
        write(rel, c);
        report.files[rel] = sha256(c);
      }
    }
    for (const entry of entries) {
      const shipped = new Set(listEntryFiles(kitRoot, entry, skip));
      const onDisk = new Set(listEntryFiles(dest, entry, skip));
      for (const rel of [...new Set([...shipped, ...onDisk])].sort()) {
        const inKit = shipped.has(rel), here = onDisk.has(rel);
        const theirs = inKit ? readFileSync(join(kitRoot, rel)) : null;
        const ours = here ? readFileSync(join(dest, rel)) : null;
        if (inKit) report.files[rel] = sha256(theirs);
        if (inKit && !here) { write(rel, theirs); continue; }
        const oursHash = sha256(ours);
        if (inKit && oursHash === report.files[rel]) continue; // already the new release

        const base = baseOf(rel);
        if (base === null) {
          // No record of what the kit was: an edit and an older release look the same.
          rescue(rel, `could not tell whether this was edited (no record of kit v${before}); the copy on disk is kept here — re-run with --base <kit v${before}> to merge it`);
          if (inKit) write(rel, theirs); else rmSync(join(dest, rel), { force: true });
          continue;
        }
        if (!base.hash) {
          // Not a kit file in the previous release.
          if (!inKit) { report.kept.push(rel); continue; } // the project's own file — leave it
          // The project and the release both added it: merge against nothing.
        } else if (oursHash === base.hash) {
          // Unedited since the last update.
          if (inKit) write(rel, theirs); else rmSync(join(dest, rel), { force: true });
          continue;
        }
        // Edited locally (or added by both sides).
        if (!inKit) {
          rescue(rel, `edited locally, and kit v${target} no longer ships it`);
          rmSync(join(dest, rel), { force: true });
          continue;
        }
        if (ours.includes(0) || theirs.includes(0)) {
          // Binary (an image under docs/): no text merge. Keep the local copy aside, take the release's.
          rescue(rel, `binary file edited locally; kit v${target} changed it too`);
          write(rel, theirs);
          continue;
        }
        const merge = mergeTexts({ ours, base: base.content ?? "", theirs, labels: [labels[0], base.content ? labels[1] : "(no base)", labels[2]] });
        // A file already carrying unresolved markers from an earlier stopped update stays a conflict.
        const conflicted = merge.conflicts > 0 || hasConflictMarkers(merge.text);
        write(rel, merge.text);
        keepBase.set(rel, theirs);
        if (conflicted) report.conflicts.push(rel);
        else if (merge.text !== theirs.toString()) report.merged.push(rel);
      }
      pruneEmptyDirs(dest, entry, kitRoot);
    }
  } finally {
    if (fetched) rmSync(dirname(fetched), { recursive: true, force: true });
  }

  // The base store holds exactly the files that differ from this release, as this release
  // ships them — the `base` of the next update.
  rmSync(baseRoot, { recursive: true, force: true });
  for (const [rel, content] of keepBase) {
    if (readFileSync(join(dest, rel)).equals(content)) continue;
    mkdirSync(dirname(join(baseStore, rel)), { recursive: true });
    writeFileSync(join(baseStore, rel), content);
  }
  if (existsSync(baseStore)) {
    writeFileSync(join(baseRoot, "README.md"), `# Kit base copies (managed by \`maestro update\`)

Pristine copies of the kit files this project has edited, as kit v${target} shipped them.
\`maestro update\` uses them as the common base of a 3-way merge, so your edits survive an
upgrade. Commit this folder; do not edit it.
`);
  }
  return report;
}
