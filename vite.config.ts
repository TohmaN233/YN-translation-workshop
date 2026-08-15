import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: "index.html",
        "agent-embedded": "src/renderer/agent/embedded.tsx"
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
