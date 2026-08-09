import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: process.env.CAREEROS_DEV_API_PROXY ? {
    proxy: {
      "/__careeros_hosted": {
        target: process.env.CAREEROS_DEV_API_PROXY,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__careeros_hosted/, ""),
      },
    },
  } : undefined,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@supabase") || id.includes("realtime-js") || id.includes("gotrue-js")) return "collaboration";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          return undefined;
        },
      },
    },
  },
});
