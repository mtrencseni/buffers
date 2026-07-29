# Buffers

A minimalist, **Sublime-style scratch-buffer editor**. For the moments you open
a new tab just to write — an email, a long Teams message, a prompt for Claude or
ChatGPT — then copy it out to wherever it's going.

Buffers are the point: text that lives in tabs, not files. Nothing is ever
"unsaved," because there's nothing to save.

> **v0.1 — macOS and Windows.** Fixed-width, keyboard-first, its own clean design.

## Download

[**⬇ macOS (Apple silicon)**](https://github.com/mtrencseni/buffers/releases/latest/download/Buffers-macos_arm64.dmg)
— a `.dmg` disk image; drag the app to Applications. The link always points at
the newest release.
([checksum](https://github.com/mtrencseni/buffers/releases/latest/download/Buffers-macos_arm64.dmg.sha256)
· [all releases](https://github.com/mtrencseni/buffers/releases))

[**⬇ Windows (x64)**](https://github.com/mtrencseni/buffers/releases/latest/download/Buffers-win_x64-portable.exe)
— no installer, just a single `.exe`. The link always points at the newest
release.
([checksum](https://github.com/mtrencseni/buffers/releases/latest/download/Buffers-win_x64-portable.exe.sha256)
· [all releases](https://github.com/mtrencseni/buffers/releases))

> The macOS build is signed with a *self-signed* certificate, so Gatekeeper will
> refuse it on any machine other than the one that built it — it isn't ready for
> general installation yet. The Windows `.exe` is unsigned, so SmartScreen warns.

![Buffers](docs/screenshot.png)

## What it does

- **Tabs are buffers.** Each tab holds a chunk of text; the tab title is its
  first line. Open as many as you like.
- **Hot exit.** Everything auto-saves and comes back exactly as you left it on
  the next launch — cursor, scroll, language and all. No save dialogs, ever.
  Closed a buffer by accident? **⌘⇧T** brings it back (even across restarts).
- **Import / export, not open / save.** **Open a file (⌘O)** copies its contents
  into a *new* buffer and forgets the file. **Save (⌘S)** writes the buffer out
  once — the buffer stays a buffer. Files and buffers are never linked.
- **Syntax highlighting** for 19 languages (Markdown, JS/TS, JSON, Python, C,
  C++, C#, Java, Kotlin, Rust, SQL, Bash, HTML, CSS, LaTeX, YAML, XML, plain),
  auto-detected on import and switchable from the status bar.
- **Editor essentials:** line numbers, **find & replace (⌘F / ⌘⌥F)**, a
  **minimap** with a Sublime-style overlay scrollbar (it floats over the minimap
  and auto-hides), soft line-wrap, optional active-line highlight, and adjustable
  text size (**⌘+ / ⌘− / ⌘0**).
- **Tabs your way:** across the **top** (default) or down a **resizable left
  sidebar** — either way, drag to reorder. Switch in Settings.
- **Polished:** light / dark (Sublime "Mariana") themes, fully **configurable
  keyboard shortcuts**, remembers its window size, opens at 80% of the screen the
  first time.

## Install & run

Requires [Node](https://nodejs.org) + [pnpm](https://pnpm.io) and the
[Rust toolchain](https://www.rust-lang.org/tools/install).

```sh
pnpm install
pnpm tauri dev      # run the native app with hot-reload
pnpm dev            # browser-only UI (buffers persist to localStorage)
pnpm tauri build    # macOS   → src-tauri/target/release/bundle/macos/Buffers.app
                    # Windows → src-tauri/target/release/bundle/nsis/*-setup.exe
```

On Windows you also need the [MSVC C++ build tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
(for the Rust linker) and the WebView2 runtime (preinstalled on Windows 11).

## Keyboard shortcuts

All rebindable in **Settings → Keyboard → Configure shortcuts**. Defaults below
are macOS; **on Windows every ⌘ is Ctrl** (⌘T → Ctrl+T, ⌥ → Alt):

| Keys | Action |
| --- | --- |
| ⌘T / ⌘N | New buffer |
| ⌘W | Close buffer |
| ⌘⇧T | Reopen closed buffer |
| ⌘⇧[ · ⌘⇧] · ⌃⇥ | Switch buffers |
| ⌘` | Cycle buffers |
| ⌘1…⌘8 · ⌘9 | Jump to buffer 1–8 · last buffer |
| ⌘O | Open / import a file into a new buffer |
| ⌘S | Save / export the buffer to a file |
| ⌘F / ⌘⌥F | Find / find & replace |
| ⌥Z | Toggle line wrap |
| ⌘+ ⌘− ⌘0 | Bigger / smaller / reset text size |
| ⌘, | Settings |
| ⌥⌘I | Developer tools (when enabled) |

## Privacy & data

Buffers live in a single JSON file in the app's own config dir
(`~/Library/Application Support/com.trencseni.buffers/` on macOS,
`%APPDATA%\com.trencseni.buffers\` on Windows). Buffers only ever writes there —
plus files you explicitly pick in an export dialog.

## Tech

Tauri 2 (Rust backend + WKWebView / WebView2) + vanilla TypeScript / Vite, with
[CodeMirror 6](https://codemirror.net) as the editor. A sibling project to
[Delight](https://github.com/mtrencseni/delight) — it reuses its shell (tabs,
settings, shortcuts, theming). See [CLAUDE.md](CLAUDE.md) for architecture and
cross-platform notes.
