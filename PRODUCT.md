# Buffers — product description

This document explains what Buffers is, the concepts it's built on, and why
its interface behaves the way it does. For how it's built, see
[ARCHITECTURE.md](ARCHITECTURE.md); day-to-day engineering notes are in
[CLAUDE.md](CLAUDE.md).

## What this is

Buffers is a scratch-pad editor for text that's on its way somewhere else. The
moment it serves: you're about to write an email, a long chat message, a
commit message, a prompt for an LLM — and you want a real editor, not a
fragile compose box, but opening a "document" with a filename and a save
dialog is ceremony the text doesn't deserve. In Buffers you press ⌘T, write,
copy the result to wherever it's going, and either close the tab or leave it.
That's the entire loop.

The design follows Sublime Text's scratch behavior — hot exit, tabs that
never nag about saving — pared down to just that, with its own visual
identity rather than an imitation of Sublime.

Shortcuts are written mac-style throughout; on Windows every ⌘ is Ctrl.

## The buffer model

The central concept is the **buffer**: a piece of text that lives in a tab,
not in a file. Everything else follows from taking that seriously:

- **Nothing is ever "unsaved."** Buffers persist themselves continuously and
  invisibly. There is no save prompt, no dirty-dot on the tab, no "do you want
  to keep your changes?" dialog anywhere in the product. Quit, reboot, crash —
  on the next launch every buffer is back, with its cursor, scroll position,
  language and **undo history** intact: ⌘Z after a restart still walks back
  through yesterday's edits.
- **The title is the first line.** A buffer is named by its first non-empty
  line, live, as you type — the same way you'd skim a pile of notes. When you
  want a fixed name, pin one (the pin button in the status bar); pinned names
  stay put while the text changes.
- **Closing is cheap.** ⌘W closes a tab; ⌘⇧T brings it back — even across a
  restart. Closed buffers keep a short history (the last ten), so closing is
  tidying, not destroying.
- **Files are import and export, not open and save.** ⌘O — or dropping a
  file onto the window — copies a file's contents *into* a new buffer; ⌘S
  writes a buffer's contents *out*. After an import or a first save the
  buffer remembers the path — the status bar shows a link, and ⌘S writes
  straight back to it — but the relationship is one-way and severable (one
  click unlinks). Buffers never watches files, never reloads from disk, and
  never edits a file in place. The buffer is the original; the file is a
  copy.

## A tour of the product

### Writing

The editor is CodeMirror 6 dressed as Sublime: line numbers, a minimap with a
floating auto-hiding scrollbar, soft wrap (⌥Z toggles), bracket matching,
optional active-line highlight, and Sublime-style selection rendering down to
the whitespace dots that appear only inside a selection. Find (⌘F) searches as
you type; find-and-replace is ⌘⌥F; ⌃G goes to a line (`120`, `+20`, `50%`,
`12:4` all work). Text size adjusts like a browser (⌘+ / ⌘− / ⌘0). Indentation
is yours to set — width, and spaces or real tabs (four spaces out of the box).

The line-editing keys are Sublime's, and unlike most editors' they are *listed*:
toggle comment, delete, move and duplicate a line, indent and outdent are
ordinary commands in the Shortcuts tab and on the ⌘K keyboard map, so they can
be found and rebound like everything else.

The status bar counts words as well as characters — Buffers exists for text
that's about to become an email or a prompt, and words are the unit those are
measured in.

⌘U opens a stripe of characters right at the cursor — ✔ ✗ — → 😀 and whatever
else you put there in Settings — chosen with ←/→ or by typing the number under
the one you want. It's a stripe rather than a searchable palette because the
list is short and you picked it yourself: the fastest thing is to see all of it
and press one key. The system emoji picker already exists for everything else,
and this isn't trying to replace it.

⌘⇧F searches every open buffer at once, listing each hit under its buffer with
the line number, and Enter jumps there. It's off until you turn it on in
Settings (see "What Buffers is not").

Syntax highlighting covers 49 languages. The language is auto-detected from
the filename on import, and switchable any time from the status bar — the
picker is a sorted list driven from the keyboard, so changing a buffer's
language takes a couple of keystrokes. New buffers start in a default
language you choose in Settings (plain text out of the box).

### Organizing

Tabs run across the top, or down a resizable left sidebar if you keep many
buffers alive — a Settings toggle, not a mode. Drag to reorder; ⌘1 through
⌘8 jump to a tab by position, ⌘9 to the last; ⌘` cycles. Tab titles can be
displayed lowercase for a quieter strip. Settings, Shortcuts, and Remote open
as system tabs in the same strip rather than separate windows: one windowing
model.

### Remote — seeing your other machines

Buffers runs on several machines, and each machine's buffers are local to it.
The Remote system gives you eyes across them without turning into a sync
product. Its rules are strict on purpose:

- **Each machine publishes its own open buffers** to a small personal server,
  under its own hostname, a few seconds after you stop typing. Only the text,
  name, and language leave the machine — no file paths, no cursor positions.
  A machine can opt out of publishing in Settings and still read the others.
- **Everyone else's buffers are read-only.** The Remote tab (⌘⇧R, or the
  cloud button) lists your machines, their buffers, and a read-only preview
  with the editor's exact rendering — because it is the editor. You can copy
  a remote buffer's text or open it as a new local buffer. You cannot edit,
  delete, or push to another machine.
- **There is no merge.** If you want to continue work from the laptop on the
  desktop, you open the laptop's buffer locally and carry on — now it's a
  desktop buffer, published under the desktop's name. Continuity is a manual,
  visible act, so there is nothing to conflict and nothing to resolve.

Alongside the per-machine mirrors there's a **Cloud** store for buffers you
place there deliberately: push a buffer to Cloud and it stays until you
delete it, independent of any machine's open tabs. Machine mirrors answer
"what was I doing over there?"; Cloud answers "I want this available
everywhere until I say otherwise."

Offline is a normal state, not an error. Pushes fail silently and self-heal
on the next edit; the Remote tab shows the last fetched snapshot when the
server is unreachable; the only places connection health appears are the
Remote tab itself and Settings. The server is yours (a small self-hosted
service), authenticated with a single shared token you paste into Settings —
there are no accounts.

### In the browser

That server also hands out Buffers itself, so any device with a browser is a
machine: open the server's address, paste the token once, and you have the same
app — same editor, same tabs, same Remote tab — on a phone, a tablet, or a
borrowed laptop, with nothing installed. On iOS and Android, Add to Home Screen
makes it a standalone app.

It is a **client, not a viewer**. The browser keeps its own buffers locally and
publishes them under its own name exactly as a Mac or a PC does, so it appears
alongside them in the Remote tab. Two browsers are two machines — your phone and
your laptop's Chrome are separate clients, which is the point. Shortcuts follow
the browser's host: ⌘ on a Mac, Ctrl on Windows. On a phone there are none, so
the app stops advertising them and puts the actions in a bar under your thumb.

What a browser can't do it doesn't pretend to: an imported file is copied in
with no link back to it, and saving downloads a copy.

### Making it yours

Light and dark themes (dark is Sublime's Mariana palette), a font of your
choosing, and every keyboard shortcut rebindable in a Shortcuts tab. ⌘K opens
a drawn keyboard showing what each key does under each modifier layer.
Settings live in a tab like everything else and apply immediately.

## How it should feel

- **Zero ceremony.** Time from "I need to write something" to writing is one
  keystroke. Nothing between you and the text asks a question.
- **Trustworthy by silence.** The absence of save UI is a promise: the app is
  taking care of it. The promise is kept — buffers persist on every pause, on
  window blur, on close.
- **Keyboard-first.** Every action has a shortcut; the mouse is never
  required.
- **One design.** The same interface on macOS and Windows — bundled fonts,
  its own controls, no native-widget patchwork. Platform conventions apply to
  input (⌘ on Mac, Ctrl on Windows), not to appearance.

## Privacy and data

Everything lives in a few small JSON files in the app's own configuration
directory: your buffers, your settings, the window position, and a cached
copy of the last Remote fetch. Buffers writes nowhere else, except files you
explicitly export to. If the Remote system is configured, buffer text,
names, and languages go to the server you specified, and nothing else does;
leave the server URL empty and no network traffic ever occurs. The remote
token is stored in the settings file as plain text — it's a shared secret for
a personal server, deliberately not treated as a high-value credential.

## What Buffers is not

- **Not a file editor.** It will not open a project tree, watch a directory,
  or save-in-place. Files pass through it; they don't live in it.
- **Not a sync service.** Machines never write to each other's state. There
  is no conflict resolution because there is nothing to conflict.
- **Not a notes app.** No folders, no tags, no Markdown rendering. A buffer is
  working text, not an archive. (Cloud stretches this the furthest — it holds
  keepers — but it's a shelf, not a wiki. Searching across buffers stretches it
  too, which is why it's a setting you turn on rather than something the app
  assumes you want: it looks at the tabs you have open, not at a library.)
- **Not an IDE.** No completion, no linting, no terminals. Syntax coloring is
  as far as it goes.
