// @ts-check
/**
 * Port probing for the cockpit.
 *
 * WHY THIS EXISTS: every AI Maestro kit ships the same two default ports (4600 for the data
 * service, 5273 for the UI). The moment someone keeps boards open for two projects, the
 * second one lands on a port the first already holds. Express calls the `listen` callback
 * before the bind result is known, so that second board printed a cheerful "ready on 4600"
 * banner and then died silently — see the EADDRINUSE handler in index.mjs.
 *
 * So the defaults have to be able to move. These helpers find the next free port instead of
 * failing, which is what `server/dev.mjs` and `server/index.mjs` both do on startup.
 *
 * No third-party dependencies.
 */

import { createServer } from "net";

/**
 * Can we bind this port on every host we care about?
 *
 * A port is only free if it is free on ALL of them. Vite binds `localhost`, which resolves
 * to `::1` on this machine and `127.0.0.1` on others, so checking one family would happily
 * hand back a port the other family is already serving.
 *
 * Only EADDRINUSE (and EACCES, which is the same answer for our purposes — we can't have
 * it) counts as taken. Any other error means the probe itself couldn't run, most often
 * EADDRNOTAVAIL because the host has no IPv6 stack at all; treating that as "taken" would
 * walk the whole scan range and find nothing.
 *
 * @param {number} port
 * @param {string[]} hosts
 * @returns {Promise<boolean>}
 */
export async function isPortFree(port, hosts) {
  for (const host of hosts) {
    const free = await new Promise((res) => {
      const probe = createServer();
      probe.once("error", (/** @type {NodeJS.ErrnoException} */ err) => {
        res(err.code !== "EADDRINUSE" && err.code !== "EACCES");
      });
      probe.once("listening", () => probe.close(() => res(true)));
      probe.listen(port, host);
    });
    if (!free) return false;
  }
  return true;
}

/**
 * First free port at or after `start`.
 *
 * This is advisory, not a reservation — the port is closed again before we return it, so a
 * racing process can still take it in between. Callers must keep their own EADDRINUSE
 * handling; this only stops the *common* collision (a board already running), not every
 * possible one.
 *
 * @param {number} start   first port to try
 * @param {string[]} hosts hosts the caller intends to bind
 * @param {number} [limit] how many consecutive ports to try before giving up
 * @returns {Promise<number>} a port that was free a moment ago
 * @throws {Error} if `limit` consecutive ports are all taken
 */
export async function findFreePort(start, hosts, limit = 20) {
  for (let port = start; port < start + limit; port++) {
    if (await isPortFree(port, hosts)) return port;
  }
  throw new Error(
    `No free port in ${start}–${start + limit - 1}. Something is holding that whole range; ` +
    `close some boards, or pick a range with PORT=<n>.`
  );
}
