// The editor core: one CodeMirror 6 EditorView, many buffers. Each buffer owns
// an immutable EditorState (so undo history, selection and text survive tab
// switches); switching tabs swaps the state into the single view. Hot-exit
// persistence (Sublime-style) lives here too: buffers auto-save debounced and
// come back exactly as they were — no save prompts, ever.

import { Compartment, EditorSelection, EditorState, type Extension, type Text } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type Command,
} from "@codemirror/view";
import {
  copyLineDown,
  copyLineUp,
  defaultKeymap,
  deleteLine,
  history,
  historyField,
  historyKeymap,
  indentLess,
  indentMore,
  indentWithTab,
  moveLineDown,
  moveLineUp,
  toggleComment,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import {
  closeSearchPanel,
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import { invoke } from "./ipc";
import { minimapOn, state } from "./state";
import { isLangId, LANGS } from "./langs";
// The syntax highlight, custom selection layer, selection-whitespace, overlay
// scrollbar and minimap live in editor-core.ts (dependency-closed, symlinked
// into Delight so its read-only code preview stays identical to Buffers).
import {
  highlight,
  minimapExtension,
  overlayScrollbar,
  selectionWhitespace,
  sublimeSelection,
} from "./editor-core";
import { bufferTitle } from "./title";
import type { BufferSnapshot, LangId, Session } from "./types";

/** Active-line highlight (line + gutter) for the current setting (empty = off). */
function activeLineExt(): Extension {
  if (!state.settings.activeLine) return [];
  return [highlightActiveLine(), highlightActiveLineGutter()];
}

/** Find-as-you-type: as the query changes in the find panel, jump the selection
    to the first match at/after where the panel was opened (wrapping to the top),
    instead of waiting for Enter. The find input keeps focus — only the editor's
    selection + scroll move. */
function incrementalSearch(): Extension {
  let anchor = 0;
  let wasOpen = false;
  return EditorView.updateListener.of((update) => {
    const open = searchPanelOpen(update.state);
    // Remember the cursor position the moment the panel opens, so typing more
    // characters keeps searching from there rather than skipping ahead.
    if (open && !wasOpen) anchor = update.startState.selection.main.from;
    wasOpen = open;
    if (!open) return;
    for (const tr of update.transactions) {
      const eff = tr.effects.find((e) => e.is(setSearchQuery));
      if (!eff) continue;
      const query = eff.value;
      if (!query.valid) continue; // empty or invalid regexp → nothing to jump to
      const at = anchor <= update.state.doc.length ? anchor : 0;
      // NB: a SearchCursor that finds nothing reports done=true but leaves its
      // `value` at the initial {0,0} — so check `done`, don't lean on `value`.
      const firstFrom = (from: number, to?: number) => {
        const r = query.getCursor(update.state, from, to).next();
        return r.done ? null : r.value;
      };
      const hit = firstFrom(at) ?? firstFrom(0, at); // at/after anchor, else wrap to top
      if (!hit) continue;
      const { from, to } = hit;
      const view = update.view;
      // Can't dispatch during an update; defer a microtask.
      queueMicrotask(() =>
        view.dispatch({
          selection: { anchor: from, head: to },
          scrollIntoView: true,
          userEvent: "select.search",
        })
      );
    }
  });
}

/** Editor font as a CM theme. The visual styling also exists in styles.css via
    the --ed-font/--ed-size vars; this mirrors it so that font changes go through
    a compartment RECONFIGURE — the only reliable way to make CM re-read styles
    and refresh its cached metrics (requestMeasure alone provably does not:
    stale line heights desynced the gutter and selection layer after zoom). */
function fontTheme(): Extension {
  return EditorView.theme({
    "&": { fontSize: `${state.zoomSize}px` },
    ".cm-scroller": { fontFamily: `${state.settings.fontFamily}, Menlo, Consolas, monospace` },
  });
}

/** The minimap extension for the current setting (empty = disabled); the rule
    itself is `minimapOn()` in state.ts, shared with the Remote preview. */
function minimapExt(): Extension {
  return minimapOn() ? minimapExtension() : [];
}

/** Indent width and tabs-vs-spaces, for the current settings. `indentUnit` is
    what Tab and the auto-indenter insert; `tabSize` is how wide an existing tab
    character renders. They're driven from one setting so an imported file that
    already uses tabs lines up with the indentation you add to it. */
function indentExt(): Extension {
  const n = state.settings.indentSize;
  return [indentUnit.of(state.settings.indentTabs ? "\t" : " ".repeat(n)), EditorState.tabSize.of(n)];
}

/** Editing commands Buffers owns as REBINDABLE commands (see commands.ts)
    instead of leaving them buried in CodeMirror's defaultKeymap, where they
    were invisible in the Shortcuts tab and the ⌘K keyboard map. The ids match
    their CommandId; main.ts dispatches them through Editor.run(). */
export type EditorCommandId =
  | "toggleComment"
  | "deleteLine"
  | "moveLineUp"
  | "moveLineDown"
  | "duplicateLineUp"
  | "duplicateLineDown"
  | "indentMore"
  | "indentLess"
  | "gotoLine";

// Wrapped rather than referenced directly: several of these are StateCommands
// (they take {state, dispatch}, not a view), and one uniform signature keeps
// the dispatch site in main.ts from caring which is which.
export const EDITOR_COMMANDS: Record<EditorCommandId, (view: EditorView) => boolean> = {
  toggleComment: (v) => toggleComment(v),
  deleteLine: (v) => deleteLine(v),
  moveLineUp: (v) => moveLineUp(v),
  moveLineDown: (v) => moveLineDown(v),
  duplicateLineUp: (v) => copyLineUp(v),
  duplicateLineDown: (v) => copyLineDown(v),
  indentMore: (v) => indentMore(v),
  indentLess: (v) => indentLess(v),
  gotoLine: (v) => gotoLine(v),
};

// The same commands as CM knows them, for pruning the stock keymap below.
// Identity matters here, so these are the originals, not the wrappers above.
const OWNED_BY_REGISTRY: unknown[] = [
  toggleComment,
  deleteLine,
  moveLineUp,
  moveLineDown,
  copyLineUp,
  copyLineDown,
  indentMore,
  indentLess,
];

/** defaultKeymap minus the bindings the command registry now owns. Without this
    CM would keep answering the hardcoded key after a rebind — the old key would
    still work and the new one would fire twice. (gotoLine isn't listed: it ships
    in searchKeymap, which Buffers doesn't install.) */
const baseKeymap = defaultKeymap.filter((b) => !OWNED_BY_REGISTRY.includes(b.run));

/** Words in a document: runs of non-whitespace, which is the count people mean
    when they're drafting prose. Walks the Text in chunks so a large buffer never
    has to be materialized as a single string. */
function countWords(doc: Text): number {
  let words = 0;
  let inWord = false;
  const iter = doc.iter();
  while (!iter.next().done) {
    const chunk = iter.value;
    for (let i = 0; i < chunk.length; i++) {
      const space = chunk.charCodeAt(i) <= 32;
      if (!space && !inWord) words++;
      inWord = !space;
    }
  }
  return words;
}

/** Above this many characters a buffer's undo history isn't persisted: history
    events hold the text they changed, so on a big document they'd dominate
    .buffers.json for little benefit. The buffer itself still restores. */
const HISTORY_DOC_MAX = 256 * 1024;


interface Buf {
  id: number;
  language: LangId;
  state: EditorState;
  scrollTop: number;
  /** See BufferSnapshot: pinned display name, its pin flag, and the linked file. */
  bufferName: string;
  namePinned: boolean;
  filePath: string;
}

/** Optional metadata to seed a new buffer with (import: name + pinned + path). */
export interface BufMeta {
  bufferName?: string;
  namePinned?: boolean;
  filePath?: string;
}

export interface EditorHost {
  /** A buffer's first line (== tab title) may have changed. */
  titlesChanged(): void;
  /** Cursor moved / doc changed — refresh the status bar. */
  statusChanged(): void;
  /** The session was just written to disk (flush() only fires on real changes).
      The remote push piggybacks on this — see remote.ts. */
  sessionFlushed?(s: Session): void;
}

const CLOSED_MAX = 10;
const IDLE_MS = 1000; // save this long after the last keystroke…
const MAX_MS = 10000; // …but never let continuous typing outrun this backstop

export class Editor {
  readonly view: EditorView;
  private bufs = new Map<number, Buf>();
  private order: number[] = [];
  private activeId = -1;
  private closed: BufferSnapshot[] = [];
  private nextId = 1;
  private host: EditorHost;

  private langComp = new Compartment();
  private wrapComp = new Compartment();
  private minimapComp = new Compartment();
  private activeLineComp = new Compartment();
  private fontComp = new Compartment();
  private indentComp = new Compartment();

  // Word count, memoized on the Text object: cursor movement re-renders the
  // status bar constantly and must not re-count, but Text is immutable so a
  // changed doc is always a different object.
  private wordsDoc: Text | null = null;
  private words = 0;

  // Hot-exit persistence state machine.
  private dirty = false;
  private idleTimer = 0;
  private maxTimer = 0;
  private remeasureTimer = 0;

  constructor(parent: HTMLElement, host: EditorHost) {
    this.host = host;
    this.view = new EditorView({ parent });

    // Any interaction that leaves the app (the copy-paste-into-Teams moment)
    // flushes immediately; so does backgrounding or closing the window.
    window.addEventListener("blur", () => this.flush());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flush();
    });
  }

  // ---- extensions -------------------------------------------------------------

  private extensions(language: LangId): Extension[] {
    const syntax = LANGS[language].syntax();
    return [
      lineNumbers(),
      highlightSpecialChars(),
      history(),
      // Draw the cursor as a CM-managed DOM element (its selection layer is hidden
      // in styles.css; the custom sublimeSelection layer paints selections). This
      // replaces the native contentEditable caret, which in WKWebView left a "ghost"
      // vertical bar at the old position after deleting the last char on a line.
      drawSelection(),
      sublimeSelection,
      // Mobile keyboards treat a code buffer like prose otherwise: iOS
      // capitalizes the first word of every line and "corrects" identifiers.
      EditorView.contentAttributes.of({
        autocapitalize: "off",
        autocorrect: "off",
        spellcheck: "false",
      }),
      indentOnInput(),
      bracketMatching(),
      this.activeLineComp.of(activeLineExt()),
      highlightSelectionMatches(),
      selectionWhitespace,
      // Sublime-style minimap: a tiny render of the whole buffer on the right;
      // click or drag it to scroll. Gated behind a setting (applyMinimap).
      this.minimapComp.of(minimapExt()),
      overlayScrollbar,
      this.fontComp.of(fontTheme()),
      search({ top: true }),
      incrementalSearch(),
      // Esc closes the find panel. CM only provides this via searchKeymap (whose
      // other keys would clash with Buffers' own shortcuts), so bind just Esc — in
      // the search-panel scope so it fires while the find input is focused, and in
      // the editor scope for when focus is back in the text.
      keymap.of([{ key: "Escape", run: closeSearchPanel, scope: "editor search-panel" }]),
      syntaxHighlighting(highlight),
      keymap.of([...baseKeymap, ...historyKeymap, indentWithTab]),
      this.langComp.of(syntax ?? []),
      this.wrapComp.of(state.settings.wrapLines ? EditorView.lineWrapping : []),
      this.indentComp.of(indentExt()),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          this.schedule();
          this.host.titlesChanged();
          // Typing can push a line into wrapping; re-measure so the gutter (and
          // everything below) doesn't sit on the stale 1-row estimate. Debounced
          // so it never runs mid-keystroke.
          clearTimeout(this.remeasureTimer);
          this.remeasureTimer = window.setTimeout(() => this.remeasureVisibleLines(), 120);
        }
        if (u.docChanged || u.selectionSet) this.host.statusChanged();
      }),
    ];
  }

  private mkState(
    text: string,
    language: LangId,
    anchor = 0,
    head = 0,
    history?: unknown
  ): EditorState {
    const len = text.length;
    const selection = EditorSelection.single(Math.min(anchor, len), Math.min(head, len));
    const extensions = this.extensions(language);
    // A persisted undo history restores through fromJSON, which needs the doc and
    // selection in the same call (the history's changes are positions into that
    // doc). Anything malformed — an older session, a hand-edited file — falls
    // back to a fresh state rather than losing the text.
    if (history) {
      try {
        return EditorState.fromJSON(
          { doc: text, selection: selection.toJSON(), history },
          { extensions },
          { history: historyField }
        );
      } catch {}
    }
    return EditorState.create({ doc: text, selection, extensions });
  }

  // ---- buffer lifecycle ---------------------------------------------------------

  /** Create a new empty buffer and activate it. Returns its id. `meta` seeds the
      name/pin/path (used by import). Defaults: name empty (follows first line),
      not pinned, no file. */
  newBuffer(text = "", language?: LangId, meta?: BufMeta): number {
    const id = this.nextId++;
    const lang = language ?? state.settings.defaultLanguage;
    this.bufs.set(id, {
      id,
      language: lang,
      state: this.mkState(text, lang),
      scrollTop: 0,
      bufferName: meta?.bufferName ?? "",
      namePinned: meta?.namePinned ?? false,
      filePath: meta?.filePath ?? "",
    });
    this.order.push(id);
    this.activate(id);
    this.schedule();
    return id;
  }

  /** Close a buffer (its content goes onto the reopen stack). */
  closeBuffer(id: number): void {
    const buf = this.bufs.get(id);
    if (!buf || this.order.length <= 1) return; // never close the last buffer
    this.stash(id);
    this.closed.push(this.snapshot(buf));
    if (this.closed.length > CLOSED_MAX) this.closed.shift();
    this.bufs.delete(id);
    const i = this.order.indexOf(id);
    this.order.splice(i, 1);
    if (this.activeId === id) this.activate(this.order[Math.min(i, this.order.length - 1)]);
    this.schedule();
    this.flush(); // closing is deliberate — persist right away
  }

  /** ⌘⇧T: bring back the most recently closed buffer. */
  reopenClosed(): boolean {
    const snap = this.closed.pop();
    if (!snap) return false;
    const id = this.nextId++;
    this.bufs.set(id, {
      id,
      language: snap.language,
      state: this.mkState(snap.text, snap.language, snap.anchor, snap.head, snap.history),
      scrollTop: snap.scrollTop,
      bufferName: snap.bufferName ?? "",
      namePinned: snap.namePinned ?? false,
      filePath: snap.filePath ?? "",
    });
    this.order.push(id);
    this.activate(id);
    this.schedule();
    this.flush(); // reopening is deliberate — persist right away
    return true;
  }

  /** Switch the view to buffer `id` (stashing the current one's state first).
      `restoreScroll` is false when the caller is about to scroll somewhere else
      itself — see reveal(), which would otherwise be undone by the restore. */
  activate(id: number, restoreScroll = true): void {
    const buf = this.bufs.get(id);
    if (!buf) return;
    // Always stash: the view holds the live truth for the active buffer, and
    // re-activating the same id must never revert to a stale stored state
    // (e.g. clicking the already-active tab, or after a settings reconfigure).
    this.stash(this.activeId);
    this.activeId = id;
    this.view.setState(buf.state);
    // setState resets scroll; restore after layout. Also force a re-measure —
    // the swapped-in state may carry stale geometry (heights measured under a
    // different font size / content width), which desyncs the gutter and
    // selection layer until CM re-reads the DOM.
    this.view.requestMeasure();
    if (restoreScroll) {
      requestAnimationFrame(() => {
        this.view.scrollDOM.scrollTop = buf.scrollTop;
      });
    }
    this.view.focus();
    this.host.statusChanged();
    this.schedule(); // the active tab is part of the session
  }

  /** Write the live view state back into the (possibly former) active buffer. */
  private stash(id: number): void {
    const buf = this.bufs.get(id);
    if (!buf) return;
    buf.state = this.view.state;
    buf.scrollTop = this.view.scrollDOM.scrollTop;
  }

  cycle(d: 1 | -1): void {
    const i = this.order.indexOf(this.activeId);
    if (i < 0) return;
    const n = this.order.length;
    this.activate(this.order[(i + d + n) % n]);
  }

  /** Adopt a new tab order (from drag-reorder); unknown ids are ignored. */
  reorder(ids: number[]): void {
    const next = ids.filter((id) => this.bufs.has(id));
    if (next.length !== this.order.length) return;
    this.order = next;
    this.schedule();
  }

  // ---- accessors ----------------------------------------------------------------

  ids(): number[] {
    return [...this.order];
  }

  active(): number {
    return this.activeId;
  }

  hasClosed(): boolean {
    return this.closed.length > 0;
  }

  /** Display name (tab / sidebar): the shared bufferTitle rule — a set
      `bufferName` wins, else the first non-empty line (see title.ts). */
  title(id: number): string {
    const doc = this.docOf(id);
    if (!doc) return "untitled";
    // Only hand the rule the lines it may scan — never a whole huge doc
    // (this runs on every keystroke via titlesChanged).
    const prefix = doc.sliceString(0, doc.line(Math.min(doc.lines, 20)).to);
    return bufferTitle(prefix, this.bufs.get(id)?.bufferName);
  }

  // ---- name / file metadata ----------------------------------------------------

  /** Name/pin/file state for the given buffer (active by default), for the UI. */
  meta(id = this.activeId): { name: string; pinned: boolean; filePath: string } {
    const buf = this.bufs.get(id);
    return {
      name: this.title(id),
      pinned: !!buf?.namePinned,
      filePath: buf?.filePath ?? "",
    };
  }

  /** Pin the current display name so it stops tracking the first line. */
  pinName(id = this.activeId): void {
    const buf = this.bufs.get(id);
    if (!buf) return;
    buf.bufferName = this.title(id); // freeze whatever's shown now
    buf.namePinned = true;
    this.schedule();
    this.host.titlesChanged();
  }

  /** Unpin: clear the frozen name so it follows the first line again. */
  unpinName(id = this.activeId): void {
    const buf = this.bufs.get(id);
    if (!buf) return;
    buf.bufferName = "";
    buf.namePinned = false;
    this.schedule();
    this.host.titlesChanged();
  }

  /** Link the buffer to a file: pin its name to the file name and remember the
      path (import, and save-as). */
  setFileInfo(id: number, name: string, path: string): void {
    const buf = this.bufs.get(id);
    if (!buf) return;
    buf.bufferName = name;
    buf.namePinned = true;
    buf.filePath = path;
    this.schedule();
    this.host.titlesChanged();
  }

  /** The id of an open buffer linked to `path`, or null — so opening a file that's
      already open just switches to it instead of duplicating it. */
  idForPath(path: string): number | null {
    for (const buf of this.bufs.values()) if (buf.filePath && buf.filePath === path) return buf.id;
    return null;
  }

  /** Drop the file link (name/pin stay); ⌘S will prompt for a location again. */
  unlink(id = this.activeId): void {
    const buf = this.bufs.get(id);
    if (!buf) return;
    buf.filePath = "";
    this.schedule();
    this.host.statusChanged();
  }

  private docOf(id: number) {
    if (id === this.activeId) return this.view.state.doc;
    return this.bufs.get(id)?.state.doc;
  }

  language(id = this.activeId): LangId {
    return this.bufs.get(id)?.language ?? "plain";
  }

  setLanguage(lang: LangId): void {
    const buf = this.bufs.get(this.activeId);
    if (!buf || buf.language === lang) return;
    buf.language = lang;
    const syntax = LANGS[lang].syntax();
    this.view.dispatch({ effects: this.langComp.reconfigure(syntax ?? []) });
    this.schedule();
    this.host.statusChanged();
  }

  /** Active buffer's full text (for export). */
  activeText(): string {
    return this.view.state.doc.toString();
  }

  /** The selected text, when it's a plausible search query — one short line.
      Seeds the find-in-all-buffers box the way a find panel prefills. */
  selectedText(): string {
    const main = this.view.state.selection.main;
    if (main.empty || main.to - main.from > 100) return "";
    const text = this.view.state.sliceDoc(main.from, main.to);
    return text.includes("\n") ? "" : text;
  }

  /** Line / column / size / selection info for the status bar. */
  status(): { line: number; col: number; words: number; chars: number; selected: number } {
    const st = this.view.state;
    const main = st.selection.main;
    const line = st.doc.lineAt(main.head);
    if (this.wordsDoc !== st.doc) {
      this.wordsDoc = st.doc;
      this.words = countWords(st.doc);
    }
    return {
      line: line.number,
      col: main.head - line.from + 1,
      words: this.words,
      chars: st.doc.length,
      selected: main.to - main.from,
    };
  }

  openFind(): void {
    openSearchPanel(this.view);
  }

  /** Run one of the CodeMirror editing commands the registry owns (see
      EDITOR_COMMANDS). Returns false when CM declined it, which lets the
      keyboard layer fall through to the browser's own handling. */
  run(id: EditorCommandId): boolean {
    this.view.focus();
    return EDITOR_COMMANDS[id](this.view);
  }

  /** Every buffer's text, in tab order — for searching across all of them. */
  all(): { id: number; title: string; text: string }[] {
    return this.order.map((id) => ({
      id,
      title: this.title(id),
      text: this.docOf(id)?.toString() ?? "",
    }));
  }

  /** Switch to `id` and put the selection on [from, to), scrolled into view —
      how a cross-buffer search result is opened. */
  reveal(id: number, from: number, to: number): void {
    // Suppress the saved-scroll restore: it lands on the next frame and would
    // otherwise scroll the match straight back off screen. Selecting
    // synchronously also means the match is selected whether or not that frame
    // ever arrives (a backgrounded window doesn't run rAF).
    this.activate(id, false);
    const len = this.view.state.doc.length;
    this.view.dispatch({
      selection: { anchor: Math.min(from, len), head: Math.min(to, len) },
      scrollIntoView: true,
      userEvent: "select.search",
    });
    this.view.focus();
  }

  /** Toggle soft wrap across every buffer (setting changed). */
  applyWrap(): void {
    const ext = state.settings.wrapLines ? EditorView.lineWrapping : [];
    this.view.dispatch({ effects: this.wrapComp.reconfigure(ext) });
    for (const buf of this.bufs.values()) {
      if (buf.id === this.activeId) continue;
      buf.state = buf.state.update({ effects: this.wrapComp.reconfigure(ext) }).state;
    }
  }

  /** Apply the indent width / tabs-vs-spaces setting across every buffer. */
  applyIndent(): void {
    this.view.dispatch({ effects: this.indentComp.reconfigure(indentExt()) });
    for (const buf of this.bufs.values()) {
      if (buf.id === this.activeId) continue;
      buf.state = buf.state.update({ effects: this.indentComp.reconfigure(indentExt()) }).state;
    }
  }

  /** Show/hide the minimap across every buffer (setting changed). */
  applyMinimap(): void {
    this.view.dispatch({ effects: this.minimapComp.reconfigure(minimapExt()) });
    for (const buf of this.bufs.values()) {
      if (buf.id === this.activeId) continue;
      buf.state = buf.state.update({ effects: this.minimapComp.reconfigure(minimapExt()) }).state;
    }
  }

  /** Font size (zoom) or family changed: reconfigure the font theme across every
      buffer so CM re-reads styles and refreshes its cached line-height metrics. */
  applyFontConfig(): void {
    this.view.dispatch({ effects: this.fontComp.reconfigure(fontTheme()) });
    for (const buf of this.bufs.values()) {
      if (buf.id === this.activeId) continue;
      buf.state = buf.state.update({ effects: this.fontComp.reconfigure(fontTheme()) }).state;
    }
    // The new font paints on later frames, and CM only re-measures wrapped-line
    // heights on a measure pass — until then the height map keeps its 1-row
    // ESTIMATE for lines that now wrap, so the gutter numbers and everything
    // below sit at the wrong offset. In WKWebView the corrective pass can be very
    // late (natively it looked permanent). Force several measures as the font
    // settles; each reads the DOM heights and rewrites the height map.
    requestAnimationFrame(() => this.remeasureVisibleLines());
    for (const ms of [50, 150, 350, 650]) window.setTimeout(() => this.remeasureVisibleLines(), ms);
  }

  /** Force CM to measure the real height of every VISIBLE line, so a line that
      now wraps stops being estimated as 1 row (which desyncs the gutter numbers
      and everything below). coordsAtPos on each line's ends is what does it —
      the same thing that "fixes it when you start a selection". lineNumbers'
      gutter reads the height map, so it re-lays-out with the corrected heights. */
  private remeasureVisibleLines(): void {
    // coordsAtPos must be called DIRECTLY (synchronously) — the same call inside
    // a requestMeasure read does NOT update the height map / gutter (verified).
    const v = this.view;
    const from = v.state.doc.lineAt(v.viewport.from).number;
    const to = v.state.doc.lineAt(v.viewport.to).number;
    for (let ln = from; ln <= to; ln++) {
      const line = v.state.doc.line(ln);
      v.coordsAtPos(line.from);
      if (line.length) v.coordsAtPos(line.to);
    }
  }

  /** Turn the active-line highlight on/off across every buffer (setting changed). */
  applyActiveLine(): void {
    this.view.dispatch({ effects: this.activeLineComp.reconfigure(activeLineExt()) });
    for (const buf of this.bufs.values()) {
      if (buf.id === this.activeId) continue;
      buf.state = buf.state.update({ effects: this.activeLineComp.reconfigure(activeLineExt()) }).state;
    }
  }

  // ---- hot-exit persistence -------------------------------------------------------

  private snapshot(buf: Buf): BufferSnapshot {
    const st = buf.id === this.activeId ? this.view.state : buf.state;
    const sel = st.selection.main;
    // One toJSON yields both the text and the serialized undo history, so a
    // flush doesn't stringify the document twice.
    const json = st.toJSON({ history: historyField });
    const text: string = json.doc;
    return {
      id: buf.id,
      text,
      history: text.length <= HISTORY_DOC_MAX ? json.history : undefined,
      language: buf.language,
      anchor: sel.anchor,
      head: sel.head,
      scrollTop: buf.id === this.activeId ? this.view.scrollDOM.scrollTop : buf.scrollTop,
      bufferName: buf.bufferName,
      namePinned: buf.namePinned,
      filePath: buf.filePath,
    };
  }

  /** The full serialized session. Public for the manual push-now command. */
  session(): Session {
    return {
      buffers: this.order
        .map((id) => this.bufs.get(id))
        .filter((b): b is Buf => !!b)
        .map((b) => this.snapshot(b)),
      activeId: this.activeId,
      closed: this.closed,
      zoomSize: state.zoomSize,
    };
  }

  /** Mark dirty; save after 1s idle, or 10s at the latest while typing. */
  schedule(): void {
    this.dirty = true;
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.flush(), IDLE_MS);
    if (!this.maxTimer) {
      this.maxTimer = window.setTimeout(() => this.flush(), MAX_MS);
    }
  }

  /** Write the session out now (no-op when nothing changed). */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    clearTimeout(this.idleTimer);
    clearTimeout(this.maxTimer);
    this.maxTimer = 0;
    const s = this.session();
    void invoke("save_buffers", { buffers: s }).catch(() => {});
    this.host.sessionFlushed?.(s);
  }

  /** Restore the previous session (or start with one empty buffer). */
  restore(saved: unknown): void {
    const s = saved as Partial<Session> | null;
    const list = Array.isArray(s?.buffers) ? s!.buffers : [];
    let activate = -1; // ids are reassigned on restore; track the active one
    for (const raw of list) {
      if (typeof raw?.text !== "string") continue;
      const lang: LangId = isLangId(raw.language) ? raw.language : "plain";
      const id = this.nextId++;
      this.bufs.set(id, {
        id,
        language: lang,
        state: this.mkState(raw.text, lang, raw.anchor ?? 0, raw.head ?? 0, raw.history),
        scrollTop: typeof raw.scrollTop === "number" ? raw.scrollTop : 0,
        bufferName: typeof raw.bufferName === "string" ? raw.bufferName : "",
        namePinned: raw.namePinned === true,
        filePath: typeof raw.filePath === "string" ? raw.filePath : "",
      });
      this.order.push(id);
      if (raw.id === s?.activeId) activate = id;
    }
    this.closed = Array.isArray(s?.closed)
      ? s!.closed.filter((c) => typeof c?.text === "string").slice(-CLOSED_MAX)
      : [];
    if (this.order.length === 0) {
      this.newBuffer();
      this.dirty = false;
      return;
    }
    this.activate(activate >= 0 ? activate : this.order[0]);
  }
}
