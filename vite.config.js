import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Hunter Mode's Sol reads the Guardian daemon (guardian/), which serves
// GET /status without CORS headers. Proxying /daemon keeps that request
// same-origin. Set GUARDIAN_URL (env or .env.local) when the daemon runs
// somewhere other than this machine; `vite preview` inherits the proxy.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/daemon": {
          target: env.GUARDIAN_URL || "http://localhost:8547",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/daemon/, ""),
        },
      },
    },
  };
});
