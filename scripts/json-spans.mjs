/**
 * json-spans.mjs — locate the byte spans of values inside a JSON text.
 *
 * Writers that must not reformat a hand-maintained file (the portfolio registry) edit the text
 * surgically: they find the exact span of the one value they change and splice it, so every
 * other byte — indentation, key order, unrelated entries — survives untouched. JSON.parse
 * cannot give positions, so this is a minimal scanner. It assumes text that JSON.parse already
 * accepted; it does not re-validate.
 *
 * Node shape:
 *   { type: "object", start, end, members: [{ key, keyStart, value: Node }] }
 *   { type: "array",  start, end, items: [Node] }
 *   { type: "scalar", start, end }
 * `end` is exclusive.
 *
 * No third-party dependencies.
 */

const WS = new Set([" ", "\t", "\n", "\r"]);

/** @param {string} text @returns {any} root node */
export function scanJson(text) {
  let i = 0;
  const skip = () => { while (i < text.length && WS.has(text[i])) i++; };

  function str() {
    const start = i;
    i++; // opening quote
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return { start, end: i, value: JSON.parse(text.slice(start, i)) };
  }

  function value() {
    skip();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const members = [];
      skip();
      if (text[i] === "}") { i++; return { type: "object", start, end: i, members }; }
      for (;;) {
        skip();
        const k = str();
        skip(); i++; // colon
        const v = value();
        members.push({ key: k.value, keyStart: k.start, value: v });
        skip();
        if (text[i] === ",") { i++; continue; }
        i++; // closing brace
        return { type: "object", start, end: i, members };
      }
    }
    if (c === "[") {
      i++;
      const items = [];
      skip();
      if (text[i] === "]") { i++; return { type: "array", start, end: i, items }; }
      for (;;) {
        items.push(value());
        skip();
        if (text[i] === ",") { i++; continue; }
        i++;
        return { type: "array", start, end: i, items };
      }
    }
    if (c === '"') { const s = str(); return { type: "scalar", start: s.start, end: s.end }; }
    while (i < text.length && !WS.has(text[i]) && !",]}".includes(text[i])) i++;
    return { type: "scalar", start, end: i };
  }

  return value();
}

/** The member a JSON.parse would keep for `key` (the last duplicate wins). */
export function memberOf(objectNode, key) {
  let found = null;
  for (const m of objectNode?.members ?? []) if (m.key === key) found = m;
  return found;
}
