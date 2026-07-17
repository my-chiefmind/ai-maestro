import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the UI on 5273; /api is proxied to the data service (server/index.mjs).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: { '/api': 'http://localhost:4600' },
  },
});
