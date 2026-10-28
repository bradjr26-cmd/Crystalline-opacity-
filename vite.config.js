import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Hunter Mode reads the Guardian daemon (guardian/): its channels come from
// GET /signals and Sol reads GET /status. The daemon sends no CORS headers,
// so proxying /daemon keeps those requests same-origin. Set GUARDIAN_URL (env or .env.local) when the daemon runs
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
