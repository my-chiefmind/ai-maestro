/**
 * Format the interactive "Pick a command" menu so the numbers are right-aligned to the widest
 * index: " 9)" and "10)" end in the same column, so every key and label lines up.
 */
export function formatMenuLines(commands) {
  const width = String(commands.length).length;
  const keyWidth = Math.max(0, ...commands.map((c) => c.key.length)) + 1;
  const rows = commands.map((c, i) => `  ${String(i + 1).padStart(width)})  ${c.key.padEnd(keyWidth)} ${c.label}`);
  rows.push(`  ${"q".padStart(width)})  quit`);
  return rows;
}
