# Buffers — architecture

How Buffers is built and why. Read this once for the mental model, then work
with [CLAUDE.md](CLAUDE.md), which holds the per-file tables and the
accumulated gotchas. The product itself is described in
[PRODUCT.md](PRODUCT.md).

## The shape of the system

Buffers is a Tauri 2 application with an unusual weight distribution: the
TypeScript frontend *is* the app, and the Rust backend is deliberately thin —
persistence, one-shot file reads and writes, HTTP to the remote server,
devtools, and the macOS menu. There is no domain logic in Rust. The frontend
owns the schema of everything it stores; the backend receives opaque JSON and
writes it atomically. This keeps the interesting code in one language and one
place, and makes the backend nearly maintenance-free.

The two sides talk over Tauri IPC. Outside Tauri (plain `pnpm dev`),
`src/ipc.ts` routes every `invoke` to `src/mock.ts`, which persists to
localStorage and fakes the remote server with canned data — so the entire
app, including hot exit and the Remote tab, runs and is testable in an
ordinary browser.

## The editor: one view, many states

The single most important design decision is how buffers relate to the
editor. There is exactly one CodeMirror `EditorView` in the app. Each buffer
owns an immutable `EditorState` — text, selection, undo history, language
configuration. Switching tabs swaps the active buffer's state into the view.

This shape is what makes tab switching instant and undo per-buffer for free:
CodeMirror states are persistent data structures designed to be held and
swapped. The price is one strict invariant: **the view holds the live truth
for the active buffer**, so before anything reads or replaces a buffer's
state, the view's current state must be stashed back into it. That stash
happens unconditionally on every activation — even re-activating the same
buffer — because skipping it reverts the buffer to a stale snapshot and loses
edits. This bit us once; the reasoning is preserved in CLAUDE.md.

Live settings — language, wrap, minimap, active line, font — are CodeMirror
*compartments*, reconfigured across every buffer's state when a setting
changes. Font changes go through a compartment too, not just CSS: a theme
reconfigure is the only trigger that reliably makes CodeMirror re-measure
line heights, and stale metrics desync the gutter from the text.

The Sublime look is not a theme on top of stock CodeMirror. The selection
layer is custom (WKWebView ignores the `::selection` styling CodeMirror
injects, so selections are drawn as our own positioned rectangles below the
text), the scrollbar is a custom overlay that floats over the minimap and
auto-hides, and whitespace dots render only inside selections. These pieces
live in `editor-core.ts`, which exists under a constraint described next.

## The shared-editor contract

Delight, the sibling file manager, renders its read-only code preview with
Buffers' editor — it re-exports `editor-core.ts` and `langs.ts` directly from
this repo's source. That linkage imposes one rule here: **those two modules
must stay dependency-closed.** They may import CodeMirror packages and their
own CSS, and nothing else — no `./state`, no `./types`, no app code. The
moment one of them touches app state, Delight's build breaks. When a piece of
editor behavior needs app context (as the title rule did), it moves to a
separate module (`title.ts`) rather than into `editor-core.ts`.

## Hot exit

Persistence is a small state machine in `editor.ts`, not a framework:

- Any change marks the session dirty and starts a **1-second idle timer**; a
  **10-second backstop** guarantees a write even during continuous typing.
- `flush()` serializes the whole session — every buffer's text, selection,
  scroll position, language, name metadata, plus the closed-buffer stack —
  and hands it to the backend, which writes `.buffers.json` atomically
  (write-temp-then-rename, so a crash mid-write can never corrupt it).
- Deliberate moments flush immediately rather than waiting for the timer:
  window blur (the copy-paste-into-another-app moment), the window being
  hidden or closed, and every tab create/close/switch/reorder.

Restore rebuilds each buffer's `EditorState` from the snapshot. Buffer ids
are session-local and reassigned on restore. Undo history is intentionally
not persisted — CodeMirror's history isn't cleanly serializable, and losing
undo across a restart is an acceptable trade against a fragile format.

## The remote subsystem

Remote is split along the same line as everything else: policy in the
frontend, plumbing in Rust.

**Rust (`remote.rs`)** provides a handful of stateless commands — push a
host's buffers, add or delete a Cloud buffer, forget a whole machine host,
fetch everything, ping, report the machine's hostname — using reqwest with
rustls (no OpenSSL build dependency on Windows), a 10-second timeout, and no
retries. The HTTP must live in
Rust: the webview's content-security policy is `default-src 'self'`, which
blocks `fetch()` to a user-configured server, and a CSP can't be loosened
for a URL chosen at runtime. Error mapping strips URLs and never logs the
token.

**The frontend (`remote.ts`)** decides when and what:

- *What leaves the machine* is decided in one function: each open buffer is
  reduced to name, language, and text. File paths, buffer ids, cursor and
  scroll state, and the closed stack never leave. The name is resolved
  through the same `title.ts` rule the tab strip uses, so the server needs no
  naming logic.
- *When* piggybacks on hot exit: every real flush also queues a push with its
  own 5-second debounce, and the same blur/hidden/close triggers push
  immediately. A serialized copy of the last accepted payload guards against
  no-op pushes — switching tabs flushes an unchanged session, and those must
  not hit the network.
- *Failure is silent by policy.* A push that fails is dropped, not retried;
  since every push is a complete snapshot, the next one heals whatever was
  missed. Connection state surfaces only in the Remote tab and Settings —
  offline is not a toast.
- The last successful fetch is cached to disk, so the Remote tab renders
  the previous snapshot when the server is unreachable.

The server itself is a separate small Flask service (`server/` in this repo,
deployed independently): filesystem storage, one file per host, a shared
token, daily history snapshots as protection against a fresh install pushing
an empty session over a machine's good state. Machine hostnames are
sanitized in Rust to the server's allowed charset, because a host name
becomes a path component on the server.

## The keyboard system

Identical in design to Delight's, because it was copied from there: every
shortcut is a `Command` in a registry (`commands.ts`), one global keydown
handler encodes events into canonical combo strings and dispatches through
the user's bindings, and the Shortcuts tab, the ⌘K keyboard map, and every
tooltip render from that same table. Adding a shortcut is one registry entry
plus one handler; nothing else needs to know.

## Platform partitioning

Every OS difference lives in one of five seams — `platform.ts` (`isMac`,
`MOD`; the only OS branch in the frontend), the `.mac` root CSS class,
Rust `#[cfg]` blocks, per-OS `tauri.<os>.conf.json` overlays, and
`scripts/prebuild.mjs` — and nowhere else. The most visible consequence:
macOS gets a real menu bar, Windows gets none (a Win32 menu draws in system
colors inside the window and can't be themed; rather than show a grey strip
across a dark app, the same actions live in the in-app toolbar). CLAUDE.md
carries the full per-platform table.

## Persistence inventory

Everything is JSON in the app's config directory; the files Buffers writes
itself are written atomically:

| File | Contents | Written |
| --- | --- | --- |
| `.buffers.json` | The session: all buffers + closed stack | hot exit (above) |
| `settings.json` | Settings, keybindings, zoom | debounced on change |
| `.window-state.json` | Window bounds | on focus loss (plugin) |
| `.remote-cache.json` | Last successful Remote fetch | after each fetch |

One trap that recurs: `restoreSettings()` in `main.ts` is a per-field
allowlist. A new setting that isn't added there will accept values, work all
session, and silently reset on restart.

## Testing

The browser mock is the first-line harness: `pnpm dev`, drive the UI, and
script assertions against `window.__buffers` (the app object, exposed only
outside Tauri). Hot exit works against localStorage; the Remote tab works
against canned hosts. `tsc` and `cargo check` gate every change; the Rust
unit tests cover the pure logic (hostname sanitizing).

What the mock can't verify: real IPC, the native menu, actual network
behavior against the server (test with the real app plus `curl` against the
server's API), and WebKit rendering quirks — several of the editor's custom
pieces exist precisely because WKWebView differs from Chrome, so visual
verification on macOS matters.

## Sharp edges

CLAUDE.md's Gotchas section is the full list; these are the ones that cost
the most when forgotten:

- Skipping the stash on activation (loses edits — don't "optimize" the
  same-id case back in).
- Adding an app import to `editor-core.ts` or `langs.ts` (breaks Delight's
  build, sometimes only at its next `tsc`).
- Adding a setting without extending the `restoreSettings()` allowlist
  (silently fails to persist).
- Trusting CodeMirror's cached line metrics after a font change (route
  changes through the font compartment, not bare CSS).
