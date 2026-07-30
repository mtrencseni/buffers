// The language droplist, shared by the status bar (this buffer's language) and
// Settings (the default for new buffers) so the two can't drift apart.
//
// Two things it gets right that a plain list of <button>s doesn't: the ~50
// languages are ordered A→Z by label, and it's fully keyboard-driven — ↑/↓,
// Home/End, Enter, Esc, and type-ahead, where pressing "p" walks Pascal →
// Perl → Plain text → PowerShell → Properties → Python. Typing two letters
// quickly ("py") narrows instead of cycling, the way a native list behaves.

import { LANG_IDS, LANGS, type LangId } from "./langs";

/** How long a keystroke stays part of the current type-ahead prefix. */
const TYPE_AHEAD_MS = 800;

export interface LangPickerOpts {
  /** Highlighted as the current choice, and where the keyboard starts. */
  current: LangId;
  /** Extra class for the droplist (the status bar's opens upward: "up"). */
  cls?: string;
  onPick(id: LangId): void;
  /** Escape — the caller closes and restores focus however it likes. */
  onClose(): void;
}

export interface LangPicker {
  el: HTMLElement;
  /** Give it the keyboard. Call after inserting it in the document. */
  focus(): void;
}

export function buildLangPicker(opts: LangPickerOpts): LangPicker {
  const pop = document.createElement("div");
  pop.className = "droplist" + (opts.cls ? ` ${opts.cls}` : "");
  // Focusable so it can own the keyboard; -1 keeps it out of the tab order.
  pop.tabIndex = -1;

  const ids = [...LANG_IDS].sort((a, b) => LANGS[a].label.localeCompare(LANGS[b].label));
  const labels = ids.map((id) => LANGS[id].label.toLowerCase());
  const items = ids.map((id) => {
    const b = document.createElement("button");
    b.className = "dropitem" + (id === opts.current ? " on" : "");
    b.textContent = LANGS[id].label;
    b.tabIndex = -1; // arrows drive the list; Tab shouldn't walk 50 buttons
    pop.append(b);
    return b;
  });

  let active = Math.max(0, ids.indexOf(opts.current));
  const setActive = (i: number): void => {
    if (i < 0 || i >= items.length) return;
    items[active]?.classList.remove("active");
    active = i;
    const el = items[active];
    el.classList.add("active");
    el.scrollIntoView({ block: "nearest" });
  };

  /** First entry whose label starts with `prefix`, searching AFTER `from` and
      wrapping. -1 when nothing matches (the keystroke is then ignored). */
  const find = (prefix: string, from: number): number => {
    for (let k = 1; k <= labels.length; k++) {
      const i = (from + k) % labels.length;
      if (labels[i].startsWith(prefix)) return i;
    }
    return -1;
  };

  let typed = "";
  let typedAt = 0;

  items.forEach((b, i) => {
    b.addEventListener("click", () => opts.onPick(ids[i]));
    b.addEventListener("mousemove", () => setActive(i));
  });

  pop.addEventListener("keydown", (e) => {
    // The list owns every key while it's open — nothing here should reach the
    // global shortcut handler underneath.
    e.stopPropagation();
    const n = items.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((active + 1) % n);
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive((active - 1 + n) % n);
        return;
      case "Home":
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(n - 1);
        return;
      case "PageDown":
        e.preventDefault();
        setActive(Math.min(n - 1, active + 8));
        return;
      case "PageUp":
        e.preventDefault();
        setActive(Math.max(0, active - 8));
        return;
      case "Enter":
        e.preventDefault();
        opts.onPick(ids[active]);
        return;
      case "Escape":
        e.preventDefault();
        opts.onClose();
        return;
    }
    // Type-ahead. Single printable characters only, and never with a modifier
    // (⌘W must still close the buffer rather than hunt for a language).
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
    const ch = e.key.toLowerCase();
    if (ch === " ") return;
    e.preventDefault();
    const now = Date.now();
    const continuing = now - typedAt < TYPE_AHEAD_MS && typed !== "";
    typedAt = now;
    // A different key while still typing extends the prefix and re-searches
    // from the top; anything else (a repeat, or a fresh start) cycles to the
    // next entry under that letter.
    if (continuing && ch !== typed[typed.length - 1]) {
      const next = typed + ch;
      const i = find(next, -1);
      if (i >= 0) {
        typed = next;
        setActive(i);
        return;
      }
    }
    typed = ch;
    const i = find(ch, active);
    if (i >= 0) setActive(i);
  });

  setActive(active);
  return {
    el: pop,
    focus: () => {
      pop.focus({ preventScroll: true });
      items[active]?.scrollIntoView({ block: "nearest" });
    },
  };
}
