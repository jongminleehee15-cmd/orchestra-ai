import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend talks only to /api/* — Vite proxies that to the Express server in
// dev so the Anthropic key never reaches the browser. In production the host
// rewrites /api/* to the deployed backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
