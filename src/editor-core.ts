// Shared, dependency-closed editor internals: the syntax HighlightStyle, the
// custom Sublime-style selection layer, selection-only whitespace decorations,
// the overlay scrollbar, and the minimap helper. These import ONLY CodeMirror
// packages (no app state / types), so the module can be SYMLINKED into sibling
// apps — Delight reuses it verbatim for its read-only code preview, meaning any
// fix here (e.g. to the selection geometry) lands in both apps at once.
//
// The matching CSS (.cm-editor rules + theme tokens) lives in editor-core.css,
// imported here so it travels with the symlink too.

import { EditorSelection, RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  layer,
  RectangleMarker,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { showMinimap } from "@replit/codemirror-minimap";
import "./editor-core.css";

// Syntax colors map to CSS classes (editor-core.css themes them via tokens), so
// highlighting follows light/dark automatically.
export const highlight = HighlightStyle.define([
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
// and arrows, but only inside the current selection (editor-core.css draws them).
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

export const selectionWhitespace = ViewPlugin.fromClass(
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
// out. The native scroller scrollbar is hidden (editor-core.css) so nothing
// reserves width — that stops the text reflowing when content grows past one
// screen.
export const overlayScrollbar = ViewPlugin.fromClass(
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

/** The Sublime-style minimap extension (always on; callers gate it themselves). */
export function minimapExtension(): Extension {
  return showMinimap.of({
    create: () => ({ dom: document.createElement("div") }),
    displayText: "characters",
    showOverlay: "always",
  });
}

// Sublime-style selection rectangles: hug the selected text and extend by a
// small sliver where the newline is included — instead of CM's default
// full-width interior lines. Drawn as a layer below the text; the native
// selection is hidden in editor-core.css (WKWebView ignores CM's adopted-sheet
// rule).
export const sublimeSelection = layer({
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
