// @ts-check
/**
 * Raw-HTML neutering for the docs renderer.
 *
 * `marked` passes raw HTML in markdown through untouched, and the UI injects the rendered
 * result with dangerouslySetInnerHTML — so any raw HTML in a doc runs with the cockpit's
 * origin. The docs the renderer serves include the agent and skill files under `agents/`
 * and `skills/`, which AI agents author in normal use, so "raw HTML in a doc" is content
 * a prompt-injected agent can genuinely produce (SECURITY.md §2).
 *
 * The approach is allow-exactly-or-escape, not strip-what-looks-bad: a token is kept
 * verbatim ONLY when every `<...>` run in it anchors-matches a small tag/attribute
 * grammar AND no stray `<` remains outside those runs (an unclosed tag could otherwise
 * swallow following markup and revive itself). Anything else — unknown tags, valueless or
 * single-quoted attributes, event handlers, comments, malformed nesting — is escaped
 * wholesale, visibly. Kept output is therefore inert by construction: allowlisted tags
 * whose URLs carry no scheme (or exactly http/https), plus text containing no `<`.
 *
 * The allowlist is the raw HTML the shipped docs actually use (the README header and its
 * `<details>` gallery) plus inert formatting tags — not "HTML that seems safe".
 */

/** @type {Record<string, string>} */
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * @param {string} s
 * @returns {string}
 */
export const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

// Tag → attributes it may carry. A tag absent here never passes; an attribute absent
// here fails the whole token. No on*, no style, no id/class (the cockpit's CSS is not a
// boundary worth handing to doc authors).
/** @type {Record<string, string[]>} */
const ALLOWED = {
  b: [], strong: [], i: [], em: [], code: [], kbd: [], sub: [], sup: [],
  br: [], details: [], summary: [],
  p: ["align"], div: ["align"],
  h1: ["align"], h2: ["align"], h3: ["align"], h4: ["align"], h5: ["align"], h6: ["align"],
  img: ["src", "alt", "width", "height"],
  a: ["href"],
};

// One whole tag: optional close slash, name, then zero or more space-separated
// DOUBLE-quoted attributes (values free of quotes and angle brackets), optional
// self-closing slash. Anchored — a tag is this shape exactly or it fails.
const TAG_SHAPE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+="[^"<>]*")*)\s*\/?>$/;
const ATTR = /([a-zA-Z-]+)="([^"<>]*)"/g;
const TAG_RUN = /<[^>]*>/g;

/**
 * URL attribute values: relative paths, fragments, or explicit http(s) only.
 * @param {string} v
 * @returns {boolean}
 */
function safeUrl(v) {
  // Whitespace and control chars first: browsers strip tab/newline when parsing URLs, so
  // "java\nscript:" reads as no-scheme here but executes there. `&` second: entities
  // decode inside attribute values, so "javascript&colon;" becomes a scheme after the
  // scheme check ran.
  if (/[\s\x00-\x1f&]/.test(v)) return false;
  if (/^https?:\/\//i.test(v)) return true;
  if (v.startsWith("//")) return false; // protocol-relative → remote
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v); // any other scheme (javascript:, data:, …)
}

/**
 * @param {string} tag one `<...>` run
 * @returns {boolean}
 */
function tagAllowed(tag) {
  const m = TAG_SHAPE.exec(tag);
  if (!m) return false;
  const closing = m[1] === "/";
  const name = (m[2] ?? "").toLowerCase();
  const attrsRaw = m[3] ?? "";
  const allowed = ALLOWED[name];
  if (!allowed) return false;
  if (closing) return attrsRaw === "";
  for (const [, rawName, value] of attrsRaw.matchAll(ATTR)) {
    const attr = (rawName ?? "").toLowerCase();
    if (!allowed.includes(attr)) return false;
    if ((attr === "src" || attr === "href") && !safeUrl(value ?? "")) return false;
  }
  return true;
}

/**
 * Keep a raw-HTML token verbatim only if it is provably inert; otherwise escape all of it.
 * @param {string} text a raw `html` token from marked (block or inline)
 * @returns {string}
 */
export function neuterRawHtml(text) {
  const tags = text.match(TAG_RUN) ?? [];
  const outsideTags = text.replace(TAG_RUN, "");
  if (!outsideTags.includes("<") && tags.every(tagAllowed)) return text;
  return escapeHtml(text);
}
