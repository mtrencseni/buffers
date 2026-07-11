# Buffers

A minimalist, **Sublime-style scratch-buffer editor**. For the moments you open
a new tab just to write — an email, a long Teams message, a prompt for Claude or
ChatGPT — then copy it out to wherever it's going.

Buffers are the point: text that lives in tabs, not files. Nothing is ever
"unsaved," because there's nothing to save.

> **v0.1 — macOS.** Fixed-width, keyboard-first, its own clean design.

<!-- Add a screenshot here once you have one: ![Buffers](docs/screenshot.png) -->

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
  **minimap** you can click to scroll, soft line-wrap, and adjustable text size
  (**⌘+ / ⌘− / ⌘0**).
- **Polished:** light / dark (Sublime "Mariana") themes, fully **configurable
  keyboard shortcuts**, drag-to-reorder tabs, remembers its window size, opens
  at 80% of the screen the first time.

## Install & run

Requires [Node](https://nodejs.org) + [pnpm](https://pnpm.io) and the
[Rust toolchain](https://www.rust-lang.org/tools/install).

```sh
pnpm install
pnpm tauri dev      # run the native app with hot-reload
pnpm dev            # browser-only UI (buffers persist to localStorage)
pnpm tauri build    # → src-tauri/target/release/bundle/macos/Buffers.app
```

## Keyboard shortcuts

All rebindable in **Settings → Keyboard → Configure shortcuts**. Defaults:

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
(`~/Library/Application Support/com.trencseni.buffers/`). Buffers only ever
writes there — plus files you explicitly pick in an export dialog.

## Tech

Tauri 2 (Rust backend + WKWebView) + vanilla TypeScript / Vite, with
[CodeMirror 6](https://codemirror.net) as the editor. A sibling project to
[Delight](https://github.com/mtrencseni/delight) — it reuses its shell (tabs,
settings, shortcuts, theming). See [CLAUDE.md](CLAUDE.md) for architecture and
cross-platform notes.
