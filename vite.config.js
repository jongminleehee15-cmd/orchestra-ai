import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend talks only to /api/* — Vite proxies that to the Express server in
// dev so the Anthropic key never reaches the browser. In production the client
// calls the deployed backend directly via VITE_API_BASE_URL (see src/api/client.js
// and README "Deployment") — a real cross-origin request, so the backend's CORS
// allowlist is actually enforced by the browser.
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
