#!/usr/bin/env node

/**
 * Require a canonical AI Maestro ticket id in a pull-request title.
 *
 * The ticket is the unit of delivery and already points to its epic through `epicId`, so a
 * title only needs the ticket id to give a reviewer an unambiguous path into the board.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const TICKET_ID = /(?:^|[^A-Za-z0-9])(T-\d+)(?=$|[^A-Za-z0-9])/;

export function ticketIdFromPrTitle(title) {
  return String(title || "").match(TICKET_ID)?.[1] || null;
}

export function validatePrTitle(title) {
  const ticketId = ticketIdFromPrTitle(title);
  if (ticketId) return { ok: true, ticketId };
  return {
    ok: false,
    message: "PR title must include an AI Maestro ticket id, for example: Fix login timeout (T-014)",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = validatePrTitle(process.argv.slice(2).join(" "));
  if (!result.ok) {
    console.error(`::error title=Missing ticket id::${result.message}`);
    process.exit(1);
  }
  console.log(`PR title references ${result.ticketId}`);
}
