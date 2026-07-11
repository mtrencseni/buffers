// The editor core: one CodeMirror 6 EditorView, many buffers. Each buffer owns
// an immutable EditorState (so undo history, selection and text survive tab
// switches); switching tabs swaps the state into the single view. Hot-exit
// persistence (Sublime-style) lives here too: buffers auto-save debounced and
// come back exactly as they were — no save prompts, ever.

import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  layer,
  lineNumbers,
  RectangleMarker,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { highlightSelectionMatches, openSearchPanel, search } from "@codemirror/search";
import { showMinimap } from "@replit/codemirror-minimap";
import { invoke } from "./ipc";
import { state } from "./state";
import { isLangId, LANGS } from "./langs";
import type { BufferSnapshot, LangId, Session } from "./types";

// Syntax colors map to CSS classes (styles.css themes them via tokens), so
// highlighting follows light/dark automatically.
const highlight = HighlightStyle.define([
  { tag: tags.keyword, class: "tok-kw" },
  { tag: [tags.string, tags.special(tags.string)], class: "tok-str" },
  { tag: [tags.comment, tags.blockComment, tags.lineComment], class: "tok-com" },
  { tag: [tags.number, tags.integer, tags.float], class: "tok-num" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: "tok-fn" },
  { tag: [tags.typeName, tags.className, tags.namespace], class: "tok-type" },
  { tag: [tags.propertyName, tags.attributeName], class: "tok-prop" },
  { tag: [tags.bool, tags.atom, tags.null, tags.self], class: "tok-atom" },
  { tag: [tags.operator, tags.definitionOperator], class: "tok-op" },
  { tag: tags.heading, class: "tok-heading" },
  { tag: tags.emphasis, class: "tok-em" },
  { tag: tags.strong, class: "tok-strong" },
  { tag: [tags.link, tags.url], class: "tok-link" },
  { tag: [tags.meta, tags.processingInstruction], class: "tok-meta" },
  { tag: tags.regexp, class: "tok-regex" },
]);

// Sublime-style "draw_white_space: selection": spaces/tabs become visible dots
// and arrows, but only inside the current selection (styles.css draws them).
const SPACE_DECO = Decoration.mark({ class: "cm-selSpace" });
const TAB_DECO = Decoration.mark({ class: "cm-selTab" });

function selectionWhitespaceDecos(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const r of view.state.selection.ranges) {
    if (r.empty) continue;
    // Clip to the viewport so huge selections stay cheap.
    const from = Math.max(r.from, view.viewport.from);
    const to = Math.min(r.to, view.viewport.to);
    if (from >= to) continue;
    const text = view.state.doc.sliceString(from, to);
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === " ") b.add(from + i, from + i + 1, SPACE_DECO);
      else if (ch === "\t") b.add(from + i, from + i + 1, TAB_DECO);
    }
  }
  return b.finish();
}

const selectionWhitespace = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = selectionWhitespaceDecos(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = selectionWhitespaceDecos(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

/** Active-line highlight (line + gutter) for the current setting (empty = off). */
function activeLineExt(): Extension {
  if (!state.settings.activeLine) return [];
  return [highlightActiveLine(), highlightActiveLineGutter()];
}

/** The minimap extension for the current setting (empty = disabled). */
function minimapExt(): Extension {
  if (!state.settings.minimap) return [];
  return showMinimap.of({
    create: () => ({ dom: document.createElement("div") }),
    displayText: "characters",
    showOverlay: "always",
  });
}

// Sublime-style selection rectangles: hug the selected text and extend by a
// small sliver where the newline is included — instead of CM's default
// full-width interior lines. Drawn as a layer below the text; the native
// selection is hidden in styles.css (WKWebView ignores CM's adopted-sheet rule).
const sublimeSelection = layer({
  above: false,
  class: "cm-bufSelectionLayer",
  update: (u) => u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged,
  markers(view) {
    const out: RectangleMarker[] = [];
    const CLS = "cm-selectionBackground";
    const lh = view.defaultLineHeight;
    const sliver = Math.max(3, view.defaultCharacterWidth * 0.55); // the "\n is selected" nub
    const PAD = 2; // horizontal breathing room around the text (Sublime-like)

    // forRange rows are in the layer's coordinate space (unlike lineBlockAt,
    // which is offset). Collect each visual row's raw (fractional) top plus its
    // horizontal box; the vertical snap-and-tile happens in a second pass below.
    const rows: { top: number; left: number; width: number }[] = [];
    const add = (m: RectangleMarker, opts: { last: boolean; newline: boolean; empty: boolean }) => {
      const top = m.top - (lh - m.height) / 2; // grow to full line height, centered
      const left = Math.round(m.left - PAD);
      let width: number;
      if (opts.empty) {
        width = sliver + PAD;
      } else {
        width = (m.width ?? 0) + PAD * 2;
        if (opts.last && opts.newline) width += sliver;
      }
      rows.push({ top, left, width: Math.round(width) });
    };

    for (const r of view.state.selection.ranges) {
      if (r.empty) continue;
      const from = Math.max(r.from, view.viewport.from);
      const to = Math.min(r.to, view.viewport.to);
      if (from > to) continue;
      let pos = from;
      for (;;) {
        const line = view.state.doc.lineAt(pos);
        const segTo = Math.min(to, line.to);
        const hasNewline = line.to < to; // selection continues onto the next line

        if (segTo > pos) {
          const raw = RectangleMarker.forRange(view, CLS, EditorSelection.range(pos, segTo));
          let lastIdx = 0;
          for (let i = 1; i < raw.length; i++) if (raw[i].top > raw[lastIdx].top) lastIdx = i;
          raw.forEach((m, i) => add(m, { last: i === lastIdx, newline: hasNewline, empty: false }));
        } else if (hasNewline) {
          // Empty selected line: just the newline nub.
          const raw = RectangleMarker.forRange(view, CLS, EditorSelection.range(pos, pos));
          if (raw.length) add(raw[0], { last: true, newline: true, empty: true });
        }

        if (line.to >= to) break;
        pos = line.to + 1;
      }
    }

    // Snap to the pixel grid by CHAINING: each row that is vertically contiguous
    // with the one above takes its top from that row's snapped bottom, so they
    // share the exact same boundary pixel — no gap, and no overlap either. (An
    // overlap would paint a *darker* seam since the selection fill is translucent;
    // a gap shows the background through. Per-row independent rounding produced
    // both, because glyph measurements aren't spaced by exactly `lh`.)
    rows.sort((a, b) => a.top - b.top);
    let prevBottom: number | null = null;
    let prevRawBottom = 0;
    for (const row of rows) {
      const contiguous = prevBottom != null && Math.abs(row.top - prevRawBottom) < lh * 0.5;
      const top = contiguous ? (prevBottom as number) : Math.round(row.top);
      const bottom = Math.max(top + 1, Math.round(row.top + lh));
      out.push(new RectangleMarker(CLS, row.left, top, row.width, bottom - top));
      prevBottom = bottom;
      prevRawBottom = row.top + lh;
    }
    return out;
  },
});

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

  // Hot-exit persistence state machine.
  private dirty = false;
  private idleTimer = 0;
  private maxTimer = 0;

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
      sublimeSelection,
      indentOnInput(),
      bracketMatching(),
      this.activeLineComp.of(activeLineExt()),
      highlightSelectionMatches(),
      selectionWhitespace,
      // Sublime-style minimap: a tiny render of the whole buffer on the right;
      // click or drag it to scroll. Gated behind a setting (applyMinimap).
      this.minimapComp.of(minimapExt()),
      search({ top: true }),
      syntaxHighlighting(highlight),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      this.langComp.of(syntax ?? []),
      this.wrapComp.of(state.settings.wrapLines ? EditorView.lineWrapping : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          this.schedule();
          this.host.titlesChanged();
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
    // setState resets scroll; restore after layout.
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
