// Which shell the frontend is running in. This is a platform seam in the sense
// ARCHITECTURE.md means it: every "am I in Tauri or a browser" branch reads from
// here, so `grep isWeb src/` finds all of them.
//
//   tauri — the desktop app. IPC to Rust, native menu, real files.
//   web   — served BY the Buffers server (server/web). Same-origin fetch() for
//           the API, IndexedDB for the session, a cookie for auth.
//   mock  — plain `pnpm dev`. mock.ts answers every command with canned data.
//
// The web build is chosen at BUILD time (`vite build --mode web`), never sniffed
// at runtime: a bundle opened from the wrong place must not decide it owns a
// server session, and `pnpm dev` must keep getting the mock.
//
// Keep this dependency-free — platform.ts is, and this sits beside it.

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Built by `vite build --mode web` and served by the Buffers server. */
export const isWeb = !isTauri && import.meta.env.MODE === "web";

/** Plain `pnpm dev` in a browser: mock.ts stands in for the whole backend. */
export const isMock = !isTauri && !isWeb;

/** Any browser (web build or mock) — i.e. no Rust, no real filesystem. */
export const isBrowser = !isTauri;
