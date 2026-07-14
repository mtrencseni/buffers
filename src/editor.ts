// The editor core: one CodeMirror 6 EditorView, many buffers. Each buffer owns
// an immutable EditorState (so undo history, selection and text survive tab
// switches); switching tabs swaps the state into the single view. Hot-exit
// persistence (Sublime-style) lives here too: buffers auto-save debounced and
// come back exactly as they were — no save prompts, ever.

import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search } from "@codemirror/search";
import { invoke } from "./ipc";
import { state } from "./state";
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
import type { BufferSnapshot, LangId, Session } from "./types";

/** Active-line highlight (line + gutter) for the current setting (empty = off). */
function activeLineExt(): Extension {
  if (!state.settings.activeLine) return [];
  return [highlightActiveLine(), highlightActiveLineGutter()];
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

/** The minimap extension for the current setting (empty = disabled). */
function minimapExt(): Extension {
  return state.settings.minimap ? minimapExtension() : [];
}


interface Buf {
  id: number;
  language: LangId;
  state: EditorState;
  scrollTop: number;
}

export interface EditorHost {
  /** A buffer's first line (== tab title) may have changed. */
  titlesChanged(): void;
  /** Cursor moved / doc changed — refresh the status bar. */
  statusChanged(): void;
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
      syntaxHighlighting(highlight),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      this.langComp.of(syntax ?? []),
      this.wrapComp.of(state.settings.wrapLines ? EditorView.lineWrapping : []),
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

  private mkState(text: string, language: LangId, anchor = 0, head = 0): EditorState {
    const len = text.length;
    return EditorState.create({
      doc: text,
      selection: EditorSelection.single(Math.min(anchor, len), Math.min(head, len)),
      extensions: this.extensions(language),
    });
  }

  // ---- buffer lifecycle ---------------------------------------------------------

  /** Create a new empty buffer and activate it. Returns its id. */
  newBuffer(text = "", language?: LangId): number {
    const id = this.nextId++;
    const lang = language ?? state.settings.defaultLanguage;
    this.bufs.set(id, { id, language: lang, state: this.mkState(text, lang), scrollTop: 0 });
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
      state: this.mkState(snap.text, snap.language, snap.anchor, snap.head),
      scrollTop: snap.scrollTop,
    });
    this.order.push(id);
    this.activate(id);
    this.schedule();
    this.flush(); // reopening is deliberate — persist right away
    return true;
  }

  /** Switch the view to buffer `id` (stashing the current one's state first). */
  activate(id: number): void {
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
    requestAnimationFrame(() => {
      this.view.scrollDOM.scrollTop = buf.scrollTop;
    });
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

  /** Tab title: the buffer's first non-empty line ("untitled" when blank). */
  title(id: number): string {
    const doc = this.docOf(id);
    if (!doc) return "untitled";
    const lines = Math.min(doc.lines, 20); // don't scan huge docs for a title
    for (let i = 1; i <= lines; i++) {
      const line = doc.line(i).text.trim();
      if (line) return line.length > 60 ? line.slice(0, 60) + "…" : line;
    }
    return "untitled";
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

  /** Line / column / selection info for the status bar. */
  status(): { line: number; col: number; chars: number; selected: number } {
    const st = this.view.state;
    const main = st.selection.main;
    const line = st.doc.lineAt(main.head);
    return {
      line: line.number,
      col: main.head - line.from + 1,
      chars: st.doc.length,
      selected: main.to - main.from,
    };
  }

  openFind(): void {
    openSearchPanel(this.view);
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
    return {
      id: buf.id,
      text: st.doc.toString(),
      language: buf.language,
      anchor: sel.anchor,
      head: sel.head,
      scrollTop: buf.id === this.activeId ? this.view.scrollDOM.scrollTop : buf.scrollTop,
    };
  }

  private session(): Session {
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
    void invoke("save_buffers", { buffers: this.session() }).catch(() => {});
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
        state: this.mkState(raw.text, lang, raw.anchor ?? 0, raw.head ?? 0),
        scrollTop: typeof raw.scrollTop === "number" ? raw.scrollTop : 0,
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
