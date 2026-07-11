import { defineConfig } from "vite";

// Tauri expects a fixed dev port; don't auto-increment.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022" },
});
