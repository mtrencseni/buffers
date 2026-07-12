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

// Sublime-style overlay scrollbar: a thin thumb drawn OVER the minimap (right
// edge) that only appears while scrolling or hovering the minimap, then fades
// out. The native scroller scrollbar is hidden (styles.css) so nothing reserves
// width — that stops the text reflowing when content grows past one screen.
const overlayScrollbar = ViewPlugin.fromClass(
  class {
    private thumb: HTMLDivElement;
    private scroller: HTMLElement;
    private host: HTMLElement;
    private hideTimer = 0;
    private dragging = false;
    private dragStartY = 0;
    private dragStartTop = 0;

    constructor(view: EditorView) {
      this.scroller = view.scrollDOM;
      // .cm-editor is position:relative and does not scroll — anchor the thumb
      // there so it stays put while the content scrolls underneath.
      this.host = this.scroller.parentElement ?? this.scroller;
      this.thumb = document.createElement("div");
      this.thumb.className = "cm-vscroll";
      this.host.appendChild(this.thumb);

      this.onScroll = this.onScroll.bind(this);
      this.onHover = this.onHover.bind(this);
      this.onDown = this.onDown.bind(this);
      this.onMove = this.onMove.bind(this);
      this.onUp = this.onUp.bind(this);

      this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
      this.scroller.addEventListener("mousemove", this.onHover, { passive: true });
      this.thumb.addEventListener("pointerdown", this.onDown);
      this.thumb.addEventListener("pointerenter", () => this.show());
      this.thumb.addEventListener("pointerleave", () => this.scheduleHide());
      this.layout();
    }

    update(u: ViewUpdate) {
      if (u.geometryChanged || u.viewportChanged || u.docChanged) this.layout();
    }

    /** Size + place the thumb from the current scroll metrics. */
    private layout() {
      const { scrollHeight, clientHeight, scrollTop } = this.scroller;
      const overflow = scrollHeight - clientHeight;
      if (overflow <= 1) {
        this.thumb.style.display = "none";
        return;
      }
      this.thumb.style.display = "";
      const track = clientHeight;
      const h = Math.max(28, (clientHeight / scrollHeight) * track);
      const top = (scrollTop / overflow) * (track - h);
      this.thumb.style.height = `${Math.round(h)}px`;
      this.thumb.style.transform = `translateY(${Math.round(top)}px)`;
    }

    private show() {
      window.clearTimeout(this.hideTimer);
      this.thumb.classList.add("is-visible");
    }
    private scheduleHide() {
      if (this.dragging) return;
      window.clearTimeout(this.hideTimer);
      this.hideTimer = window.setTimeout(() => this.thumb.classList.remove("is-visible"), 900);
    }

    private onScroll() {
      this.layout();
      this.show();
      this.scheduleHide();
    }
    /** Hovering the minimap zone (right strip) reveals the scrollbar, like Sublime. */
    private onHover(e: MouseEvent) {
      const r = this.scroller.getBoundingClientRect();
      if (r.right - e.clientX <= 130) {
        this.show();
        this.scheduleHide();
      }
    }

    private onDown(e: PointerEvent) {
      e.preventDefault();
      this.dragging = true;
      this.dragStartY = e.clientY;
      this.dragStartTop = this.scroller.scrollTop;
      this.thumb.setPointerCapture(e.pointerId);
      this.thumb.addEventListener("pointermove", this.onMove);
      this.thumb.addEventListener("pointerup", this.onUp);
      this.show();
    }
    private onMove(e: PointerEvent) {
      if (!this.dragging) return;
      const { scrollHeight, clientHeight } = this.scroller;
      const overflow = scrollHeight - clientHeight;
      const track = clientHeight;
      const h = Math.max(28, (clientHeight / scrollHeight) * track);
      const dy = e.clientY - this.dragStartY;
      this.scroller.scrollTop = this.dragStartTop + (dy * overflow) / (track - h);
    }
    private onUp(e: PointerEvent) {
      this.dragging = false;
      this.thumb.releasePointerCapture(e.pointerId);
      this.thumb.removeEventListener("pointermove", this.onMove);
      this.thumb.removeEventListener("pointerup", this.onUp);
      this.scheduleHide();
    }

    destroy() {
      window.clearTimeout(this.hideTimer);
      this.scroller.removeEventListener("scroll", this.onScroll);
      this.scroller.removeEventListener("mousemove", this.onHover);
      this.thumb.remove();
    }
  }
);

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
    // A line-height ESTIMATE only — used to classify row adjacency and to size
    // isolated single rows; all interior geometry is derived from the measured
    // rows themselves (see the band pass below), so a stale/wrong metric can't
    // misplace boxes. Computed style first (CM's cached defaultLineHeight goes
    // stale when zoom changes the font via a CSS var); handle px AND unitless.
    const cs = getComputedStyle(view.contentDOM);
    const fontPx = parseFloat(cs.fontSize) || 13;
    let lh = parseFloat(cs.lineHeight);
    if (!lh || Number.isNaN(lh)) lh = view.defaultLineHeight;
    else if (lh < fontPx * 0.5) lh *= fontPx; // unitless multiplier (e.g. "1.3")
    lh = Math.min(Math.max(lh, fontPx), fontPx * 3);
    const sliver = Math.max(3, fontPx * 0.35); // the "\n is selected" nub
    const PAD = 2; // horizontal breathing room around the text (Sublime-like)

    // forRange rows are in the layer's coordinate space (unlike lineBlockAt,
    // which is offset). Collect the raw glyph rects; the vertical snap-and-tile
    // happens in a second pass below.
    const rows: { top: number; h: number; left: number; width: number }[] = [];
    const add = (m: RectangleMarker, opts: { last: boolean; newline: boolean; empty: boolean }) => {
      const left = Math.round(m.left - PAD);
      // forRange MERGES the full-width interior rows of a wrapped selection into
      // one tall rectangle. Split any such rect back into its rows (they're all
      // full-width, so this reconstructs them exactly) — otherwise a line that
      // wraps to ≥3 rows draws one box and leaves the middle rows unhighlighted.
      const n = opts.empty ? 1 : Math.max(1, Math.round(m.height / lh));
      const rowH = m.height / n;
      for (let i = 0; i < n; i++) {
        const lastSub = i === n - 1;
        let width: number;
        if (opts.empty) {
          width = sliver + PAD;
        } else {
          // width can be null ("extends rightward"); never collapse to 0 —
          // over-cover to the content edge (the scroller clips the excess).
          width = (m.width ?? view.contentDOM.clientWidth) + PAD * 2;
          if (opts.last && lastSub && opts.newline) width += sliver;
        }
        rows.push({ top: m.top + i * rowH, h: rowH, left, width: Math.round(width) });
      }
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

    // Tile the boxes using only the measured rows themselves. Group glyph rects
    // into visual-row bands (by vertical center), then within each contiguous
    // run place the shared edge between neighbors at the rounded MIDPOINT of
    // their centers: bottom(i) === top(i+1) by construction (no seam to show
    // background, no overlap to double the translucent fill), and each box stays
    // centered on its own measured text. No pitch assumption — earlier versions
    // that derived positions from a line-height metric (grid/chaining) broke
    // whenever that metric disagreed with the real layout (zoom, stale caches).
    if (!rows.length) return out;
    rows.sort((a, b) => a.top - b.top || a.left - b.left);
    const bands: { center: number; items: typeof rows }[] = [];
    for (const r of rows) {
      const c = r.top + r.h / 2;
      const last = bands[bands.length - 1];
      if (last && Math.abs(c - last.center) < 3) last.items.push(r);
      else bands.push({ center: c, items: [r] });
    }
    for (let i = 0; i < bands.length; ) {
      let j = i;
      while (j + 1 < bands.length && bands[j + 1].center - bands[j].center < lh * 1.6) j++;
      const run = bands.slice(i, j + 1); // one contiguous stack of rows
      const pitchTop = run.length > 1 ? run[1].center - run[0].center : lh;
      const pitchBot = run.length > 1 ? run[run.length - 1].center - run[run.length - 2].center : lh;
      let prevEdge = Math.round(run[0].center - pitchTop / 2);
      for (let k = 0; k < run.length; k++) {
        const edge =
          k < run.length - 1
            ? Math.round((run[k].center + run[k + 1].center) / 2)
            : Math.round(run[k].center + pitchBot / 2);
        const h = Math.max(1, edge - prevEdge);
        for (const it of run[k].items) out.push(new RectangleMarker(CLS, it.left, prevEdge, it.width, h));
        prevEdge = edge;
      }
      i = j + 1;
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
