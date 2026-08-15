import { defineConfig } from "vite";

// Two targets out of one source (see src/target.ts):
//
//   vite build              -> dist/     the Tauri webview bundle
//   vite build --mode web   -> dist-web/ the bundle the Buffers server serves
//
// `pnpm dev` stays on the mock; `pnpm dev:web` runs the real web build against a
// locally running server, proxying the API so the browser still sees one origin
// (which is the whole reason the web build can use fetch() at all).
export default defineConfig(({ mode }) => {
  const web = mode === "web";
  const server = process.env.BUFFERS_SERVER ?? "http://127.0.0.1:8060";
  return {
    clearScreen: false,
    server: {
      // Tauri expects a fixed dev port; don't auto-increment. The web dev server
      // gets its own so both can run at once.
      port: web ? 1431 : 1430,
      strictPort: true,
      watch: { ignored: ["**/src-tauri/**"] },
      proxy: web
        ? {
            "/api": { target: server, changeOrigin: false },
            "/ping": { target: server, changeOrigin: false },
            "/login": { target: server, changeOrigin: false },
            "/logout": { target: server, changeOrigin: false },
          }
        : undefined,
    },
    build: { target: "es2022", outDir: web ? "dist-web" : "dist" },
  };
});
