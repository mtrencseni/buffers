# CLAUDE.md — working on Buffers

Context for resuming development. User-facing overview is in [README.md](README.md).

## What this is

**Buffers** — a minimalist, Sublime-style scratch-buffer editor. The user opens
a tab to draft an email / Teams message / LLM prompt, then copies it out. So the
core model is **buffers, not files**: text lives in tabs and auto-persists;
files are only ever imported (copied in) or exported (copied out), never linked.

**v0.1: macOS + Windows** (see Cross-platform status). It's a sibling of
**Delight** (`~/Repositories/Delight`) and
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
| `main.ts` | App shell: tab strip (buffer + system tabs) in either the **top bar** or a **resizable left sidebar** (`applyTabsLayout`), the **action toolbar** (`actionsEl`), integrated titlebar, axis-aware tab drag-reorder, command handlers, native-menu event routing, import/export (dialog plugin), status bar (Ln/Col/chars + language picker), zoom (editor font size), theme toggle, restore/persist. |
| `langs.ts` | Language registry: id → label, CM syntax extension, file extensions (import auto-detect + export suffix). Official CM `lang-*` packages + `legacy-modes` for the rest. |
| `state.ts` | Global `state` (settings, zoomSize, keybindings), defaults, debounced `persist()` → `save_state` (settings.json; buffers persist separately). |
| `types.ts` | `Settings`, `BufferSnapshot`, `Session`, `LangId`, `Theme`. |
| `commands.ts` | Keyboard **command registry** + combo helpers (copied from Delight, Buffers' command set). Add a shortcut here. |
| `keyboard.ts` | Global keydown → combo → command dispatch; text-field guard + native-edit passthrough (⌘C/X/V/A/Z). |
| `keybindingsPage.ts`, `settingsPage.ts` | The Shortcuts / Settings tab UIs. Settings includes the Remote section (URL / user / host / token / publish toggle / test button). |
| `remote.ts` | Remote client logic: `toPayload` (open buffers stripped to `name`/`language`/`text` — nothing else ever leaves the machine), debounced push (5 s after each hot-exit flush, immediate on blur/hidden/pagehide, unchanged payloads skipped), `fetchRemote`, `remoteStatus` (failures are silent — surfaced only in the Remote tab and Settings), plus the **Cloud** half: `cloudPush` (one buffer, add-or-overwrite by name, resolves `replaced`) / `cloudDelete` / `cloudConfigured`, `loadRemoteCache`/`saveRemoteCache`, and `normalizeRemoteUrl` (assumes `https://` when no scheme is typed). HTTP lives in Rust: the CSP (`default-src 'self'`) blocks webview fetch() to the server. |
| `remotePage.ts` | The Remote system tab: host list → buffer list → read-only CM preview. Exactly two actions (copy text, open as local buffer) — remote buffers are never written back. The one exception is **Cloud** rows (`kind === "cloud"`), which carry a `×` delete behind an inline two-click confirm (arm → "Delete?", auto-disarms after 4 s); machine mirrors have none. |
| `langpicker.ts` | The language droplist, shared by the status bar and Settings so they can't drift: labels sorted A→Z and full keyboard control — ↑/↓, Home/End, PageUp/Down, Enter, Esc, and type-ahead (repeating a letter cycles its entries; two quick letters narrow). The caller owns opening/closing and outside-click dismissal. |
| `title.ts` | `bufferTitle()` — THE display-name rule (pinned name, else first non-empty line), shared by editor.ts and remote.ts so the pushed `name` matches the tab title. Not in editor-core.ts (that must stay dependency-closed for Delight). |
| `platform.ts` | `isMac` + `MOD` (the primary modifier: `Meta` on macOS, `Ctrl` elsewhere). **The only place the frontend branches on OS** — commands, keyboard, state and main all read it. |
| `icons.ts`, `theme.ts`, `toast.ts`, `ipc.ts`, `mock.ts` | Inline SVG icons; theme apply/observe; toasts; IPC wrapper + `isTauri`; browser mock. |
| `styles.css` | All styling. Theme tokens (light = One-Light-ish; dark = Sublime **Mariana**). CM overrides are prefixed `.edhost .cm-editor` to beat CM's adopted-stylesheet specificity. |

### Backend (`src-tauri/src/`)

| File | Commands / role |
| --- | --- |
| `lib.rs` | `run()`: registers plugins (**dialog**, **window-state**), the invoke handler, and `setup` (install menu, first-run 80% window sizing, macOS `setInspectable`). |
| `store.rs` | `load_state`/`save_state` (settings.json), `load_buffers`/`save_buffers` (**`.buffers.json`** — the hot-exit session) and `load_remote_cache`/`save_remote_cache` (**`.remote-cache.json`** — the last successful Remote fetch). All atomic (write-tmp + rename) in `app_config_dir`. |
| `files.rs` | `read_file`/`write_file` — one-shot import/export IO (paths always come from a native dialog the user drove). |
| `remote.rs` | Stateless HTTP to the Buffers server (see server/): `remote_push`/`remote_fetch`/`remote_ping`/`cloud_push`/`cloud_delete` (reqwest + rustls, 10 s timeout, no retries — each push is a full snapshot) and `machine_hostname` (sanitized to the server's host charset). `cloud_delete` maps the server's **404 to `Ok`** — already-gone is the outcome the caller wanted; `cloud_push` returns the server's JSON so the UI can say "Pushed" vs "Replaced". Settings/scheduling live in the frontend (remote.ts). Never log the token or request URLs. |
| `devtools.rs` | `toggle_devtools`/`close_devtools` — WKWebView private `_inspector` on macOS; Tauri's `open/close_devtools` (WebView2/WebKitGTK) elsewhere. |
| `menu.rs` | Native menu (File/Edit/View/Window). Custom items emit a **`menu`** event carrying the command id; `main.ts` routes it through the same handlers as the shortcuts. No key equivalents on custom items (they'd shadow the rebindable in-app shortcuts). |

## Key concepts

- **Buffer model:** `Editor.bufs: Map<id, {id, language, state: EditorState, scrollTop}>` + `order: number[]` + `activeId`. `activate(id)` **always** stashes the live view state first (see gotcha), then `view.setState(buf.state)`.
- **Hot-exit persistence** (`editor.ts`): `schedule()` marks dirty and sets a **1 s idle** timer plus a **10 s max-interval** backstop. `flush()` writes the whole session (`save_buffers`) — triggered immediately on window **blur**, `visibilitychange` hidden, tab new/close/switch/reorder, `pagehide`. `restore(session)` rebuilds buffers (ids reassigned; tracks which was active). Closed buffers go on a **≤10** reopen stack (persisted). Undo history is intentionally *not* persisted (CM history isn't cleanly serializable).
- **Remote (server) client** — one-way by design: this machine PUSHes its open buffers under its own hostname; other machines' buffers are READ-only (copy locally by hand; no syncing, ever). Push piggybacks on the hot-exit flush via the optional `sessionFlushed` hook on `EditorHost` (`remote.ts` adds its own 5 s debounce and skips unchanged payloads, so tab switches don't push). `initRemote()` must run AFTER the Editor is constructed — its immediate-push listeners rely on the editor's flush listeners (same events) having registered first. `remoteHost` is seeded from `machine_hostname()` when empty; the token sits in settings.json in plaintext deliberately (shared-secret, not a hardened credential — no keychain). Commands: `openRemote` (⌘⇧R), `pushNow` (unbound), `pushCloud` (⌘⇧C). GOTCHA: new settings must be added to `restoreSettings()`'s allowlist in main.ts or they silently don't persist.
- **Remote is a live view with an offline cache.** The fetched data lives in the Remote page's closure — every open re-fetches, and closing the tab drops it. On top of that, each successful fetch is written to `.remote-cache.json`, and opening the tab paints that snapshot *before* the network call, so with no connection you still get the last known hosts, buffers and text (Copy and "Open as buffer" work off it). The toolbar then reads e.g. `cannot reach the server · cached, 5 min ago`; the marker is also set when a live fetch fails, because a host row's own "5 min ago" is the server's last-received time and can look fresher than the data really is. **This is the one place other machines' text lands on disk here** — a deliberate exception to "remote buffers stay remote", justified because it's a cache: any successful fetch replaces it wholesale, and nothing is ever merged into a local buffer.
- **Cloud vs a machine mirror** — the server serves both from one list, told apart by the `kind` field (**never** by matching the host name "Cloud"). A *machine* mirrors itself: it PUTs all its open buffers wholesale every few seconds, so closing a buffer removes it. *Cloud* is curated: `pushCloud` POSTs exactly ONE buffer under its current display title, same name overwrites, nothing expires, and entries leave only via the `×` in the Remote tab. Cloud buffers are never edited in place and never sync back down — to keep working on one you "Open as buffer", which makes an ordinary local copy. Pushing after renaming a buffer therefore creates a SECOND Cloud entry; that's intended, not a bug.
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
- **Windows + Claude Desktop: launch the built exe via `explorer.exe <path>`,
  never directly from the assistant's shell.** The Claude desktop app is
  MSIX-packaged; child processes inherit its package identity, and Windows
  **redirects their `%APPDATA%` writes** into
  `AppData\Local\Packages\Claude_*\LocalCache\Roaming\` (and reads come from
  that overlay too). A directly-spawned Buffers therefore persists to a
  *different* settings.json/.buffers.json than the user's own launches — it
  looks exactly like "persistence is broken" (fresh defaults for one side,
  data seemingly lost). `explorer.exe` launches escape the package context.
  This bit us once (2026-07-14): the user's real work sat in the LocalCache
  copy and had to be merged back via a scheduled task (schtasks runs
  unpackaged — also the trick for reading/writing the *real* AppData from the
  assistant's shell). A stale sandbox copy may still exist in LocalCache;
  ignore it, it's inert unless something is launched packaged again.
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
- **The window starts hidden and the frontend reveals it** — three pieces that
  must stay in sync, or launch shows the webview's white default background for
  a few hundred ms (ugly, especially on the dark theme): `visible: false` in
  `tauri.conf.json`; `main.ts` calling `show_main_window` at the end of `init()`
  after a double-rAF (first frame composited); and the window-state plugin
  restoring `StateFlags::all().difference(VISIBLE)` — restoring VISIBLE would
  re-show the window during Rust setup, before the page loads. A 3 s failsafe
  thread in `lib.rs` shows the window if the frontend dies before revealing it —
  if the app ever comes up blank-then-visible-late, suspect a JS error at boot.
  Don't add early `return`s to `init()` above the reveal.
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

## Platform partitioning — the rule

**Every OS difference lives in exactly one of these five seams. Never anywhere else.**
No `if (mac) … else …` sprinkled through feature code, and no platform's settings
sitting in a shared file where the other platform has to override them back.

| Seam | Holds | Example |
| --- | --- | --- |
| `src/platform.ts` | The **only** OS branch in the frontend: `isMac`, `MOD`. | Shortcut defaults, label style, default font. |
| `.mac` class on `:root` | CSS that only applies to macOS chrome. `main.ts` adds it when `isMac`. | `:root.native.mac .tabbar` traffic-light inset. |
| `#[cfg(target_os = …)]` | Rust that only compiles on one OS. | `menu.rs` (macOS-only menu), `devtools.rs` (two inspectors), `nudge_relayout`. |
| `tauri.<os>.conf.json` | Per-OS Tauri config, merged over `tauri.conf.json`. | `macos` → `targets:["app"]` + signing identity; `windows` → `targets:["nsis"]`. |
| `scripts/prebuild.mjs` | Platform-specific *build* steps, branched on `os.platform()`. | macOS keychain unlock. |

`tauri.conf.json` itself must stay **platform-neutral** — anything that only means
something on one OS belongs in that OS's file. Two documented exceptions live in
the base `app.windows` block: `titleBarStyle: "Overlay"` and `hiddenTitle`, which
Tauri defines as macOS-only keys and **ignores** elsewhere (verified: the Windows
build gets standard chrome). They stay in the base because Tauri merges the
per-platform configs with JSON Merge Patch, where **arrays are replaced wholesale** —
overriding one key of `app.windows` would mean duplicating the whole window object
into the macOS file, and the two copies would drift.

Consequence worth knowing: **keybindings are per-machine**, not portable. A binding
saved on the Mac is stored as `Meta+KeyT` in that machine's `settings.json`; the
canonical string still *parses* on Windows, it just wouldn't fire (the Win key).
Fresh installs get the right defaults, so this only bites if you copy a settings.json
between machines.

## Cross-platform status (Mac ✅ / Win ✅ / Linux)

Windows is ported and builds (NSIS installer). Linux is untouched but should be
close — everything platform-specific is now funnelled through **one frontend
module (`platform.ts` → `isMac` / `MOD`)**, `#[cfg]` blocks in Rust, and
per-platform Tauri configs. Where the two platforms differ:

| Area | macOS | Windows | Linux | Notes |
| --- | --- | --- | --- | --- |
| Editor, buffers, hot-exit, tabs (top or left sidebar), overlay scrollbar, find, minimap, syntax, settings, shortcuts, window-state, import/export dialogs | ✅ | ✅ | should work | CM6 + `std::fs` + cross-platform plugins + pure-CSS layout. |
| Primary modifier | ⌘ (`Meta`) | Ctrl | Ctrl | `MOD` in `platform.ts`; `commands.ts` defaults and `keyboard.ts`'s native-edit passthrough are both written against it. Combo strings stay canonical, so a binding saved on one OS still parses on the other. |
| Shortcut labels (`comboLabel`) | glyphs, run together (⌘⇧T) | words, "+"-joined (Ctrl+Shift+T) | same as Win | Never hand-write a shortcut into UI text — call `hint(id)` (`state.ts`), which is platform-correct *and* rebind-aware. |
| Editor font default | Menlo | **Consolas** | falls back to monospace | `state.ts` picks per-platform; stack is `<setting>, Menlo, Consolas, monospace`. Consider a better Linux default (e.g. "DejaVu Sans Mono"). |
| Titlebar | integrated (`titleBarStyle:"Overlay"`), 80px traffic-light inset | standard window chrome, no inset | same as Win | The inset CSS is gated on **`:root.native.mac`** (both `.tabbar` and `.tabs-left .sidebar-head`). `main.ts` adds `.mac` when `isMac`. `titleBarStyle`/`hiddenTitle` are macOS-only keys — Tauri ignores them elsewhere. |
| Native menu (`menu.rs`) | global bar (outside the window) | **none** — no menu installed | none | A Win32/GTK menu bar is drawn *inside* the window in the OS's own colors and **no API themes it** (only owner-draw hacks), so it would sit as a grey strip across a Mariana-dark window. `install()` is a no-op off macOS; the same actions live in the in-app toolbar instead. Don't "restore" it. |
| Action toolbar (`actionsEl`, `main.ts`) | present (redundant with the menu, but consistent) | the menu's replacement | same as Win | Import / Export / Close buffer / Find / Find & replace, built from the same `commandHandlers`, tooltips via `hint(id)`. Top bar: right of **+**, `margin-left` sets it off. Sidebar: left of **+**, left-justified, and it **wraps** (the head can be dragged to 140px, narrower than the 6 buttons). |
| Dev tools (`devtools.rs`) | private WKWebView `_inspector` | ✅ Tauri `open/close_devtools` (WebView2) | ✅ same | Both behind one pair of commands. The `devtools` Cargo feature keeps it in release. |
| Bundle target | `app` + signing (`tauri.macos.conf.json`) | **`nsis`** (`tauri.windows.conf.json`) | n/a yet | Neither is in the base config. A Linux port adds `tauri.linux.conf.json` with `deb`/`appimage`. |
| Build hook (`beforeBuildCommand`) | unlocks the signing keychain | no-op | no-op | Now just `pnpm build`; the macOS `security unlock-keychain` moved into **`scripts/prebuild.mjs`**, which checks `os.platform()`. Keep platform shell out of `tauri.conf.json`. |
| Code signing | self-signed "Delight Self Signed" cert | unsigned (Authenticode optional) | n/a | SmartScreen will warn on the unsigned Windows installer — expected. |

**Approach for a new platform:** put the branch in `platform.ts` / a `#[cfg]` /
a `tauri.<os>.conf.json` — never a new hardcoded ⌘ or an inline shell command.
Keep the "own design, not native emulation" rule.

## Conventions

Buffers *does* write files, but only on explicit export to a user-picked path
(never silently — different from Delight's read-only rule). Match the surrounding
style (vanilla TS, small modules, inline SVG). Commit only when asked; the user
checkpoints directly on `main`.
