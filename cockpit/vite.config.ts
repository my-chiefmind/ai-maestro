import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the UI and proxies /api to the data service (server/index.mjs).
//
// Both ports are chosen by server/dev.mjs before either process starts, and arrive here as
// env. They are NOT hardcoded because every AI Maestro kit ships the same defaults, so two
// projects with boards open would otherwise fight over them — and the loser used to proxy
// /api straight into the other project's board.
//
// The fallbacks below only apply to a bare `vite` (no launcher), where the defaults are the
// best guess available.
const API_PORT = Number(process.env.MAESTRO_API_PORT) || 4600;
const UI_PORT = Number(process.env.MAESTRO_UI_PORT) || 5273;

export default defineConfig({
  plugins: [react()],
  server: {
    // Deliberately not strictPort: dev.mjs probed this port, but nothing reserved it. If it
    // went in the meantime, Vite advancing one is fine — it prints the URL it settled on,
    // and the proxy target above is unaffected.
    port: UI_PORT,
    proxy: { '/api': `http://localhost:${API_PORT}` },
  },
});
