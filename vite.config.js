import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Renderer only. The main process and the executor are plain ESM that Node and
// Electron run directly — there is nothing to bundle there, and putting them
// through a build step would only obscure the stack traces.
export default defineConfig({
  root: path.resolve("src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve("dist-renderer"),
    emptyOutDir: true,
  },
  server: {
    // Off the default 5173, which collides with whatever else is already running
    // on this machine. strictPort so a silent fallback never leaves Electron
    // pointed at a port with someone else's app on it.
    port: 5273,
    strictPort: true,
  },
});
