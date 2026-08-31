// The ⌘U symbol stripe: a horizontal row of characters that opens at the
// caret, for the ✔ / — / → / 😀 you want mid-sentence and can't type.
//
// It's a stripe rather than a grid or a searchable palette on purpose. The
// list is short and you chose it yourself in Settings, so the fastest thing is
// to see all of it at once and press one key: ← / → to walk, or the index of
// the one you want. Anything bigger would be the system emoji picker, which
// already exists and which this is deliberately not competing with.

/** How many entries get a typeable index (1…9 then 0). Beyond that the arrows
    still reach everything — an index key would need a second keystroke, at
    which point walking there is no slower. */
const INDEXED = 10;

export interface SymbolStripeOpts {
  symbols: string[];
  /** The caret's client rect, from EditorView.coordsAtPos — the stripe opens
      under it (or above, when there's no room below). Null centers it. */
  at: { left: number; top: number; bottom: number } | null;
  onPick(symbol: string): void;
  onClose(): void;
}

export interface SymbolStripe {
  el: HTMLElement;
  /** Give it the keyboard. Call after inserting it in the document. */
  focus(): void;
}

/** The index key for slot `i` — 1…9, then 0 for the tenth. */
function indexKey(i: number): string | null {
  if (i >= INDEXED) return null;
  return String((i + 1) % 10);
}

export function buildSymbolStripe(opts: SymbolStripeOpts): SymbolStripe {
  const stripe = document.createElement("div");
  stripe.className = "symstripe";
  // Focusable so it owns the keyboard; -1 keeps it out of the tab order.
  stripe.tabIndex = -1;

  const items = opts.symbols.map((sym, i) => {
    const b = document.createElement("button");
    b.className = "symitem";
    b.tabIndex = -1;
    const glyph = document.createElement("span");
    glyph.className = "symglyph";
    glyph.textContent = sym;
    b.append(glyph);
    const key = indexKey(i);
    if (key) {
      const badge = document.createElement("span");
      badge.className = "symindex";
      badge.textContent = key;
      b.append(badge);
    }
    b.title = key ? `${sym}  (${key})` : sym;
    stripe.append(b);
    return b;
  });

  let active = 0;
  const setActive = (i: number): void => {
    if (!items.length) return;
    const next = Math.max(0, Math.min(items.length - 1, i));
    items[active]?.classList.remove("active");
    active = next;
    items[active].classList.add("active");
    items[active].scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  items.forEach((b, i) => {
    b.addEventListener("click", () => opts.onPick(opts.symbols[i]));
    b.addEventListener("mousemove", () => setActive(i));
  });

  // The stripe owns every key while it's open — nothing here should reach the
  // global shortcut handler underneath.
  stripe.addEventListener("keydown", (e) => {
    e.stopPropagation();
    const n = items.length;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        opts.onClose();
        return;
      case "ArrowRight":
        e.preventDefault();
        setActive((active + 1) % n);
        return;
      case "ArrowLeft":
        e.preventDefault();
        setActive((active - 1 + n) % n);
        return;
      // ↑/↓ do the same as ←/→: the stripe is one row, and reaching for the
      // wrong axis shouldn't be a dead key.
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
      case "Enter":
      case " ":
        e.preventDefault();
        if (opts.symbols[active]) opts.onPick(opts.symbols[active]);
        return;
    }
    // Index keys. Never with a modifier — ⌘W must still close the buffer
    // rather than count as "slot 10".
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
    for (let i = 0; i < items.length; i++) {
      if (indexKey(i) === e.key) {
        e.preventDefault();
        opts.onPick(opts.symbols[i]);
        return;
      }
    }
  });

  setActive(0);

  return {
    el: stripe,
    focus: () => {
      place(stripe, opts.at);
      stripe.focus({ preventScroll: true });
      items[active]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
  };
}

/** Put the stripe under the caret, flipping above it when the window bottom is
    closer than the stripe is tall, and clamping so a long list can't run off
    either edge. Must run after the element is in the document — it measures. */
function place(stripe: HTMLElement, at: SymbolStripeOpts["at"]): void {
  const GAP = 6;
  const MARGIN = 8;
  const box = stripe.getBoundingClientRect();
  if (!at) {
    stripe.style.left = `${Math.max(MARGIN, (window.innerWidth - box.width) / 2)}px`;
    stripe.style.top = `${Math.max(MARGIN, (window.innerHeight - box.height) / 2)}px`;
    return;
  }
  const below = at.bottom + GAP;
  const top = below + box.height + MARGIN <= window.innerHeight ? below : at.top - GAP - box.height;
  const left = Math.min(
    Math.max(MARGIN, at.left - box.width / 2),
    Math.max(MARGIN, window.innerWidth - box.width - MARGIN)
  );
  stripe.style.left = `${left}px`;
  stripe.style.top = `${Math.max(MARGIN, top)}px`;
}
