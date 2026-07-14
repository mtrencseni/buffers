# CLAUDE.md — working on Buffers

Context for resuming development. User-facing overview is in [README.md](README.md).

## What this is

**Buffers** — a minimalist, Sublime-style scratch-buffer editor. The user opens
a tab to draft an email / Teams message / LLM prompt, then copies it out. So the
core model is **buffers, not files**: text lives in tabs and auto-persists;
files are only ever imported (copied in) or exported (copied out), never linked.

**v0.1: macOS.** It's a sibling of **Delight** (`~/Repositories/Delight`) and
reuses its shell verbatim — tabs, integrated titlebar, Settings + Shortcuts
system tabs, theming tokens, keybinding registry, window-state, toasts,
browser-mock testing. Same "delight" principle: snappy, keyboard-first, its own
single design (not native emulation), inline-SVG icons, bundled Inter font (UI)
+ Menlo (editor), everything scales via `rem`/editor-size CSS vars.

## Stack & commands

**Tauri 2** (Rust + WKWebView) + **vanilla TS / Vite** + **pnpm**, with
**CodeMirror 6** as the editor. Editor = one `EditorView`, many buffer states.

```sh
pnpm install
pnpm tauri dev            # native app + HMR
pnpm dev                  # browser-only against src/mock.ts (localStorage-backed)
pnpm tauri build          # → src-tauri/target/release/bundle/macos/Buffers.app
./node_modules/.bin/tsc   # typecheck
cd src-tauri && cargo check
```

Dev server runs on **:1430** (Delight uses :1420, so both can run at once).

## Shared with Delight — `editor-core.ts` / `editor-core.css` / `langs.ts`

These three files are the **single source of truth** for the editor look-and-feel
and are **symlinked into Delight** (`~/Repositories/Delight/src/`) for its
read-only code preview — so a fix to the selection layer, syntax colors, or
languages lands in both apps. `editor.ts` imports the shared CM pieces
(`highlight`, `sublimeSelection`, `selectionWhitespace`, `overlayScrollbar`,
`minimapExtension`) from `editor-core.ts`; `editor-core.css` holds the
`.edhost .cm-editor` styling + the `--ed-*`/`--syn-*` tokens (scoped to `.edhost`).

**Invariant — keep them dependency-closed:** `editor-core.ts` and `langs.ts` may
import **only** CodeMirror/Lezer packages (and `editor-core.css`), never `./state`,
`./ipc`, `./types`, etc. That's what lets Delight symlink them. `LangId` lives in
`langs.ts` (types.ts re-exports it) for the same reason. If you add an app-state
dependency here, Delight's build breaks. See Delight's CLAUDE.md for the Vite
`resolve.alias` that keeps CodeMirror a single instance across the symlink.

## Architecture

Frontend is the whole app; the Rust backend is tiny (persistence + file IO +
devtools). They talk over Tauri IPC (`invoke`). Outside Tauri, `src/ipc.ts`
routes `invoke` to `src/mock.ts` (localStorage), so the full UI — including hot
exit — runs and is testable in a browser. `isTauri` gates native-only calls.

### Frontend (`src/`)

| File | Role |
| --- | --- |
| `editor.ts` | **The heart.** `Editor` class: one CM6 `EditorView`, a `Map` of buffers (each owns an immutable `EditorState`). Tab switch swaps state into the view. Contains: hot-exit persistence state machine, the custom Sublime selection layer, selection-only whitespace decorations, syntax `HighlightStyle`, compartments for language / wrap / minimap, and the closed-buffer (reopen) stack. |
| `main.ts` | App shell: tab strip (buffer + system tabs) in either the **top bar** or a **resizable left sidebar** (`applyTabsLayout`), integrated titlebar, axis-aware tab drag-reorder, command handlers, native-menu event routing, import/export (dialog plugin), status bar (Ln/Col/chars + language picker), zoom (editor font size), theme toggle, restore/persist. |
| `langs.ts` | Language registry: id → label, CM syntax extension, file extensions (import auto-detect + export suffix). Official CM `lang-*` packages + `legacy-modes` for the rest. |
| `state.ts` | Global `state` (settings, zoomSize, keybindings), defaults, debounced `persist()` → `save_state` (settings.json; buffers persist separately). |
| `types.ts` | `Settings`, `BufferSnapshot`, `Session`, `LangId`, `Theme`. |
| `commands.ts` | Keyboard **command registry** + combo helpers (copied from Delight, Buffers' command set). Add a shortcut here. |
| `keyboard.ts` | Global keydown → combo → command dispatch; text-field guard + native-edit passthrough (⌘C/X/V/A/Z). |
| `keybindingsPage.ts`, `settingsPage.ts` | The Shortcuts / Settings tab UIs. |
| `icons.ts`, `theme.ts`, `toast.ts`, `ipc.ts`, `mock.ts` | Inline SVG icons; theme apply/observe; toasts; IPC wrapper + `isTauri`; browser mock. |
| `styles.css` | All styling. Theme tokens (light = One-Light-ish; dark = Sublime **Mariana**). CM overrides are prefixed `.edhost .cm-editor` to beat CM's adopted-stylesheet specificity. |

### Backend (`src-tauri/src/`)

| File | Commands / role |
| --- | --- |
| `lib.rs` | `run()`: registers plugins (**dialog**, **window-state**), the invoke handler, and `setup` (install menu, first-run 80% window sizing, macOS `setInspectable`). |
| `store.rs` | `load_state`/`save_state` (settings.json) and `load_buffers`/`save_buffers` (**`.buffers.json`** — the hot-exit session). Both atomic (write-tmp + rename) in `app_config_dir`. |
| `files.rs` | `read_file`/`write_file` — one-shot import/export IO (paths always come from a native dialog the user drove). |
| `devtools.rs` | `toggle_devtools`/`close_devtools` — WKWebView private `_inspector` on macOS; no-op elsewhere. |
| `menu.rs` | Native menu (File/Edit/View/Window). Custom items emit a **`menu`** event carrying the command id; `main.ts` routes it through the same handlers as the shortcuts. No key equivalents on custom items (they'd shadow the rebindable in-app shortcuts). |

## Key concepts

- **Buffer model:** `Editor.bufs: Map<id, {id, language, state: EditorState, scrollTop}>` + `order: number[]` + `activeId`. `activate(id)` **always** stashes the live view state first (see gotcha), then `view.setState(buf.state)`.
- **Hot-exit persistence** (`editor.ts`): `schedule()` marks dirty and sets a **1 s idle** timer plus a **10 s max-interval** backstop. `flush()` writes the whole session (`save_buffers`) — triggered immediately on window **blur**, `visibilitychange` hidden, tab new/close/switch/reorder, `pagehide`. `restore(session)` rebuilds buffers (ids reassigned; tracks which was active). Closed buffers go on a **≤10** reopen stack (persisted). Undo history is intentionally *not* persisted (CM history isn't cleanly serializable).
- **Custom selection layer** (`sublimeSelection`, `editor.ts`): draws Sublime-style hug + newline-nub selection with `RectangleMarker`s in a `layer()` below the text. Rows are grouped into visual-row bands and tiled **self-calibratingly**: the shared edge between adjacent rows is the rounded midpoint of their glyph-box centers, so boxes can't gap or overlap and no line-height metric is trusted for geometry (see gotchas — every metric-based variant broke). Plus `PAD` px horizontal breathing room.
- **Selection whitespace** (`selectionWhitespace` ViewPlugin): renders `·` for spaces and `→` for tabs, **only inside the selection** (Sublime `draw_white_space: selection`), clipped to the viewport.
- **Keybindings:** every shortcut is a `Command` in `commands.ts`; `main.ts` builds a combo→id map and dispatches. To add one: extend `CommandId` + `COMMANDS`, add a handler in `main.ts`'s `commandHandlers` (and a `menu.rs` item if it belongs in the menu).
- **Live settings:** language / wrap / minimap are CM **compartments** reconfigured across every buffer state when the setting changes (`applyWrap`, `applyMinimap`, `setLanguage`); font family/size are CSS vars (`--ed-font`, `--ed-size`).
- **Tab layout** (`main.ts applyTabsLayout`): `state.settings.tabsSide` = `"top"` (fills `.tabbar`) or `"left"` (fills a `.sidebar` with vertical rows). The shared pieces — `tabsEl`, `sysTabsEl`, and the `newBtn`/`themeBtn`/`devBtn`/`gearBtn` — are re-parented into whichever container is active; `#app` gets `.tabs-left`. Sidebar width = `state.settings.sidebarWidth` (drag `.sidebar-resize`, clamped `SIDEBAR_MIN..MAX`, persisted). `beginTabDrag` is **axis-aware** (X for top, Y for the sidebar). **Gotcha:** `applyTabsLayout` runs in `buildShell` *before* the editor exists, so it guards `renderTabstrip()` with `if (this.editor)` (init does the first render itself).
- **Overlay scrollbar** (`editor.ts`): the native vertical scrollbar is hidden in CSS (`::-webkit-scrollbar:vertical { width:0 }`) so it never reserves width and reflows wrapped text; a custom `.cm-vscroll` thumb is drawn over the minimap and auto-hides (Sublime-style). `.cm-scroller` also sets `overscroll-behavior-y: none` to kill the macOS rubber-band bounce (the bounce briefly summoned the native scrollbar → width flash → reflow).

## Testing / verification

- **Browser preview + mock is the harness.** `pnpm dev`, then drive via the
  browser tools. `window.__buffers` (set only when `!isTauri`) exposes the `App`
  for scripted checks.
- **Do NOT hijack the user's machine to test the native app** — no `osascript`
  frontmost, synthetic keystrokes, or full-screen `screencapture` (privacy).
  Verify native-only behavior via logs/state or ask the user.
- Typecheck + `cargo check` before building. Rebuild + relaunch
  (`pkill -x buffers; open .../Buffers.app`) so the user sees changes.

## Gotchas

- **WKWebView ignores `::selection` from adopted stylesheets.** CM injects its
  "hide native selection" rule that way, so WKWebView paints the OS selection
  *over* the text. Fixed by hiding the native selection from a **real** stylesheet
  (`styles.css`) and drawing our own selection layer below the text. (This is
  also why `drawSelection` is replaced entirely.)
- **`lineBlockAt().top` is NOT in the selection layer's coordinate space** — it's
  offset (~4 px) and reports a different height. Selection rects must be derived
  from `RectangleMarker.forRange` output (correct space), not from `lineBlockAt`.
- **Editor left gap = `margin-left`, NOT `padding-left`** on `.cm-content`. The
  selection layer's `forRange` anchors wrapped *continuation* rows to the content
  **box** left, but the *first* row to the glyph position. With `padding-left`
  those differ, so continuation rows of a wrapped selection jut left of the first;
  with `margin-left` the content box starts at the text, so every row shares one
  left edge. (This bit us once — don't switch it back to padding.)
- **CM's cached metrics (defaultLineHeight, height map) go stale when the editor
  font changes via a CSS var — and `requestMeasure()` does NOT reliably refresh
  them.** Symptoms: gutter numbers drift off their rows after ⌘+/⌘−, selection
  boxes land on the wrong pitch. The fix is twofold: font size/family are ALSO a
  CM theme in a compartment (`fontComp`/`fontTheme()` in editor.ts) and every
  font change goes through `applyFontConfig()` — a theme reconfigure is the only
  trigger that makes CM re-read styles and re-measure; and the selection layer
  derives ALL geometry from measured row rects (band midpoints), never from a
  line-height metric. Don't "simplify" either half back.
- **Throttled paint in the preview:** in a backgrounded preview tab, CM's
  `layer`/minimap only compute markers on a measure/rAF cycle, so the DOM often
  shows **0** selection/minimap elements until a paint is forced (take a
  screenshot). Verify geometry from the view model, then screenshot to confirm
  visually — don't trust an empty DOM query.
- **esbuild build script:** `pnpm-workspace.yaml` has `allowBuilds: esbuild:
  true` so esbuild's `install.js` runs; without it, `vite build` fails with a
  missing binary.
- **Always stash on `activate`** — even re-activating the same id (clicking the
  active tab, or after a compartment reconfigure). Skipping it reverts the buffer
  to a stale stored state and **loses edits**. (Fixed; don't reintroduce the
  `if (activeId !== id)` guard.)
- **Cursor stuck as arrow after Cmd-Tab (macOS):** a **known wry/WKWebView bug**
  ([wry#175](https://github.com/tauri-apps/wry/issues/175),
  [tauri#1526](https://github.com/tauri-apps/tauri/issues/1526)) — WKWebView
  doesn't re-hit-test the cursor on window activation, worst when alternating
  between two *co-located* windows (no mouseEntered → tracking area dormant). The
  only thing that refreshes WebKit's hover state is a **real re-layout** (the
  manual workarounds are "resize the window" or "toggle devtools"). So the fix
  (`nudge_relayout` in `lib.rs`, on `WindowEvent::Focused(true)`) automates that:
  a few 1px window-size round-trips over the activation window. This re-arms
  tracking (hover works again) and usually recomputes the stationary cursor.
  **Dead ends — do NOT re-add** (all tried across ~15 rounds, all removed):
  `setCursorIcon`, `[NSCursor set]`, CGEvents, posted `NSEvent` mouse-moved /
  mouseEntered, CGWarp, `setAcceptsMouseMovedEvents`, or touching
  `documentElement.style.cursor`. Every synthetic event makes WebKit re-hit-test
  from its *stale* hover state and stomp the cursor back to the arrow. Only a real
  re-layout works.
- **Icon:** `app-icon.png` is a 1024 canvas, 824×824 artwork at (100,100), with a
  **macOS-standard ~185 px corner radius applied by us** (the flaticon source is
  too square). Regenerate the set with `pnpm tauri icon app-icon.png`.

## Cross-platform status (Mac ✅ / Win / Linux)

Buffers is far more portable than Delight — the editor, tabs, settings,
shortcuts, persistence, import/export, minimap, syntax and themes are all pure
TS/CM6 + `std::fs`, so they **should work as-is** on Windows/Linux. Known
platform-specific bits to handle:

| Area | macOS | Windows | Linux | Notes |
| --- | --- | --- | --- | --- |
| Editor, buffers, hot-exit, tabs (top or left sidebar), overlay scrollbar, find, minimap, syntax, settings, shortcuts, window-state | ✅ | should work | should work | CM6 + `std::fs` + cross-platform plugins + pure-CSS layout. **Test first.** |
| Import/export dialogs (`tauri-plugin-dialog`) | ✅ | ✅ | ✅ | Cross-platform plugin. |
| Editor font | Menlo | falls back to **Consolas** | falls back to monospace | Stack is `<setting>, Menlo, Consolas, monospace`. Consider a better Linux default (e.g. "DejaVu Sans Mono"). |
| Keyboard shortcuts (`Meta`-based combos) | ✅ ⌘ | ⚠️ | ⚠️ | Defaults use `Meta` (= ⌘ on macOS, the Win/Super key elsewhere). Remap `Meta+*` → `Ctrl+*` on Win/Linux (defaults in `commands.ts`, or in `comboFromEvent`). Rebindable regardless. |
| Native menu (`menu.rs`) | ✅ | ⚠️ | ⚠️ | Tauri menus are cross-platform, but on Win/Linux the menu is in-window, not a global bar — verify layout and the app (Buffers) submenu placement. |
| Dev tools (`devtools.rs`) | ✅ private `_inspector` | ❌ stub | ❌ stub | Non-macOS returns no-op. For Win/Linux use wry's `open_devtools` (debug) or a plugin. Gated behind a setting, low priority. |
| Integrated titlebar + left-sidebar top inset (`titleBarStyle:"Overlay"`, `.native` class; `padding-left:80px` on `.tabbar` AND `.tabs-left .sidebar-head`) | ✅ | 🔴 wrong | 🔴 wrong | Overlay + the 80px traffic-light inset are macOS-only — in **both** tab layouts (top bar and the sidebar header). Gate the `.native` insets per-OS or use standard window chrome elsewhere. |
| **`beforeBuildCommand`** (`tauri.conf.json`) | ✅ | 🔴 breaks | 🔴 breaks | It runs `security unlock-keychain … ; pnpm build` — macOS-only shell. **Make it conditional (or move signing out) before building on Win/Linux.** |
| Code signing (`bundle.macOS.signingIdentity`) | self-signed cert | Authenticode (optional) | n/a | macOS uses the shared **"Delight Self Signed"** cert/keychain so folder-perms/Gatekeeper stay stable across rebuilds. |

**Approach for a new platform:** fix the 🔴 `beforeBuildCommand` first so it
builds, expect the fenced non-macOS stubs (devtools) to no-op, then handle the
titlebar and menu ⚠️ rows. Keep the "own design, not native emulation" rule.

## Conventions

Buffers *does* write files, but only on explicit export to a user-picked path
(never silently — different from Delight's read-only rule). Match the surrounding
style (vanilla TS, small modules, inline SVG). Commit only when asked; the user
checkpoints directly on `main`.
