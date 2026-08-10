// Find across every open buffer — the one place Buffers looks at the whole pile
// of tabs at once. It is deliberately not a notes-app search: no index, no
// history, no results tab. You type, you see which buffers contain the text and
// where, you press Enter, and the overlay is gone; the result is a normal jump
// to that buffer with the match selected. Off unless Settings → Editor →
// "Search across buffers" is on (see PRODUCT.md, "Not a notes app").
//
// The interaction mirrors langpicker.ts: one focusable element owns the
// keyboard, ↑/↓ walk the rows, Enter picks, Esc closes.

export interface FindAllBuffer {
  id: number;
  title: string;
  text: string;
}

export interface FindAllOpts {
  /** Every open buffer, in tab order. Read once, when the overlay opens. */
  buffers: FindAllBuffer[];
  /** Pre-fill the query (the current selection makes a good starting point). */
  initial?: string;
  /** Jump to a match: buffer id and the document offsets to select. */
  onPick(id: number, from: number, to: number): void;
  onClose(): void;
}

export interface FindAll {
  el: HTMLElement;
  focus(): void;
}

/** Per buffer, and overall, how many matches are listed. A search that hits
    thousands of times is a search you should narrow, and rendering them all
    would just make the overlay slow. Truncation is always stated, never silent. */
const MAX_PER_BUFFER = 50;
const MAX_TOTAL = 300;
/** How much of the matching line to show, centered on the match. */
const SNIPPET = 120;

interface Hit {
  bufId: number;
  title: string;
  line: number;
  /** Document offsets of the match. */
  from: number;
  to: number;
  /** The matching line, trimmed to a window around the match. */
  before: string;
  match: string;
  after: string;
}

/** Every occurrence of `query` (case-insensitive) across `buffers`, capped. */
function search(buffers: FindAllBuffer[], query: string): { hits: Hit[]; capped: boolean } {
  const q = query.toLowerCase();
  const hits: Hit[] = [];
  let capped = false;
  for (const buf of buffers) {
    let inThis = 0;
    let offset = 0;
    // CodeMirror normalizes line endings, so the doc is always \n-separated and
    // splitting keeps offsets exact.
    for (const [i, line] of buf.text.split("\n").entries()) {
      const lower = line.toLowerCase();
      for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
        if (inThis >= MAX_PER_BUFFER || hits.length >= MAX_TOTAL) {
          capped = true;
          break;
        }
        // Center the snippet on the match rather than always starting at the
        // line's beginning: a hit 300 characters in should still be visible.
        const pad = Math.max(0, Math.floor((SNIPPET - q.length) / 2));
        const start = Math.max(0, at - pad);
        const end = Math.min(line.length, at + q.length + pad);
        hits.push({
          bufId: buf.id,
          title: buf.title,
          line: i + 1,
          from: offset + at,
          to: offset + at + query.length,
          before: (start > 0 ? "…" : "") + line.slice(start, at),
          match: line.slice(at, at + query.length),
          after: line.slice(at + query.length, end) + (end < line.length ? "…" : ""),
        });
        inThis++;
      }
      offset += line.length + 1; // +1 for the newline that split() removed
      if (inThis >= MAX_PER_BUFFER || hits.length >= MAX_TOTAL) break;
    }
  }
  return { hits, capped };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function buildFindAll(opts: FindAllOpts): FindAll {
  const overlay = el("div", "findall-overlay");
  const panel = el("div", "findall");
  const head = el("div", "findall-head");
  const input = el("input", "findall-input") as HTMLInputElement;
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = "Find in all buffers";
  const count = el("div", "findall-count");
  head.append(input, count);
  const list = el("div", "findall-list");
  panel.append(head, list);
  overlay.append(panel);

  let hits: Hit[] = [];
  let rows: HTMLElement[] = [];
  let active = -1;

  const setActive = (i: number): void => {
    if (!rows.length) return;
    const next = Math.max(0, Math.min(rows.length - 1, i));
    rows[active]?.classList.remove("active");
    active = next;
    rows[active].classList.add("active");
    rows[active].scrollIntoView({ block: "nearest" });
  };

  const render = (): void => {
    const query = input.value;
    list.replaceChildren();
    rows = [];
    active = -1;
    if (!query) {
      hits = [];
      count.textContent = `${opts.buffers.length} buffer${opts.buffers.length === 1 ? "" : "s"}`;
      return;
    }
    const result = search(opts.buffers, query);
    hits = result.hits;
    if (!hits.length) {
      count.textContent = "No matches";
      list.append(el("div", "findall-empty", "Nothing in any open buffer."));
      return;
    }
    const bufCount = new Set(hits.map((h) => h.bufId)).size;
    count.textContent =
      `${hits.length}${result.capped ? "+" : ""} in ${bufCount} buffer${bufCount === 1 ? "" : "s"}` +
      (result.capped ? " · showing the first matches" : "");

    const frag = document.createDocumentFragment();
    let lastBuf: number | null = null;
    for (const hit of hits) {
      // One header per buffer — the hits are already grouped, since the search
      // walks buffers in tab order.
      if (hit.bufId !== lastBuf) {
        lastBuf = hit.bufId;
        const n = hits.filter((h) => h.bufId === hit.bufId).length;
        const group = el("div", "findall-group");
        group.append(el("span", "findall-gtitle", hit.title), el("span", "findall-gcount", String(n)));
        frag.append(group);
      }
      const row = el("button", "findall-row");
      row.tabIndex = -1;
      const ln = el("span", "findall-ln", String(hit.line));
      const text = el("span", "findall-text");
      // Built from text nodes, never innerHTML — this is arbitrary buffer content.
      text.append(
        document.createTextNode(hit.before),
        el("mark", "", hit.match),
        document.createTextNode(hit.after)
      );
      row.append(ln, text);
      row.addEventListener("click", () => opts.onPick(hit.bufId, hit.from, hit.to));
      row.addEventListener("mousemove", () => setActive(rows.indexOf(row)));
      rows.push(row);
      frag.append(row);
    }
    list.append(frag);
    setActive(0);
  };

  input.addEventListener("input", render);

  // The overlay owns every key while it's open — nothing here should reach the
  // global shortcut handler underneath (⌘W must not close the buffer).
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation();
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        opts.onClose();
        return;
      case "ArrowDown":
        e.preventDefault();
        setActive(active + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive(active - 1);
        return;
      case "PageDown":
        e.preventDefault();
        setActive(active + 8);
        return;
      case "PageUp":
        e.preventDefault();
        setActive(active - 8);
        return;
      // Home/End are deliberately not bound: focus is in the query field, and
      // there they mean "jump to the ends of what I'm typing".
      case "Enter": {
        e.preventDefault();
        const hit = hits[active];
        if (hit) opts.onPick(hit.bufId, hit.from, hit.to);
        return;
      }
    }
  });

  // Clicking outside the panel dismisses, like the language picker.
  overlay.addEventListener("mousedown", (e) => {
    if (!panel.contains(e.target as Node)) opts.onClose();
  });

  if (opts.initial) input.value = opts.initial;
  render();

  return {
    el: overlay,
    focus: () => {
      input.focus({ preventScroll: true });
      input.select();
    },
  };
}
