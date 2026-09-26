#!/usr/bin/env node
// @ts-check
/**
 * Dev launcher for the cockpit — `npm run board` / `npm --prefix cockpit run dev`.
 *
 * WHY A LAUNCHER AND NOT JUST `concurrently`: the two dev processes are not independent.
 * Vite proxies `/api` to the data service, so it has to know which port that service ended
 * up on. If each process picked its own free port after starting, Vite would have baked in
 * a proxy target before the API had chosen — and the UI would load fine while every request
 * 500s, which is a far worse failure than not starting.
 *
 * So the ports are decided here, once, before either child exists, and handed down as env.
 * The API port is pinned for the child (see PINNED_PORT in index.mjs): we already told Vite
 * that number, so the service must bind it or fail loudly rather than drift.
 *
 * The UI port is a suggestion — Vite falls back to the next free port on its own, and prints
 * the URL it actually used, which is the one the user should open.
 */

import concurrently from "concurrently";
import { findFreePort } from "./ports.mjs";

const DEFAULT_API_PORT = 4600;
const DEFAULT_UI_PORT = 5273;

// Same host the data service binds (index.mjs), so we probe what it will actually try.
const API_HOST = process.env.MAESTRO_HOST || "127.0.0.1";
// Vite binds `localhost`, which is ::1 on some machines and 127.0.0.1 on others. A port is
// only really free for it if both families are free.
const UI_HOSTS = ["127.0.0.1", "::1"];

const apiPort = await findFreePort(Number(process.env.PORT) || DEFAULT_API_PORT, [API_HOST]);
const uiPort = await findFreePort(Number(process.env.MAESTRO_UI_PORT) || DEFAULT_UI_PORT, UI_HOSTS);

if (apiPort !== DEFAULT_API_PORT || uiPort !== DEFAULT_UI_PORT) {
  console.log(
    `Default ports were busy (another project's board?) — using UI ${uiPort}, API ${apiPort}.`
  );
}

const env = {
  ...process.env,
  MAESTRO_API_PORT: String(apiPort), // Vite's proxy target (vite.config.ts)
  MAESTRO_UI_PORT: String(uiPort),
};

const { result } = concurrently(
  [
    // `--port`, not PORT: PORT would only move the service's starting point, and it must
    // land on this exact number — Vite's proxy target below is already fixed to it.
    { command: `node server/index.mjs --port ${apiPort}`, name: "api", prefixColor: "magenta", env },
    { command: "vite", name: "web", prefixColor: "cyan", env },
  ],
  // killOthers on success as well as failure: the data service exiting cleanly still means
  // there is no board, so leaving Vite up would serve a UI with nothing behind it.
  { killOthersOn: ["failure", "success"], prefix: "name" }
);

result.then(
  () => process.exit(0),
  () => process.exit(1)
);
