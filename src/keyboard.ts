import { comboFromEvent, comboHasStrongMod, type CommandId } from "./commands";
import { MOD } from "./platform";

// While editing a text field, these belong to the field (copy/cut/paste/select/
// undo/redo) even though they carry a strong modifier — never hijack them.
// Windows/Linux also spell redo Ctrl+Y. Exported (with labels) because they're
// real, usable shortcuts the keyboard map should show alongside the rebindable
// commands — they just live in the editor rather than the command registry.
export const NATIVE_EDIT_KEYS: { combo: string; label: string }[] = [
  { combo: `${MOD}+KeyC`, label: "Copy" },
  { combo: `${MOD}+KeyX`, label: "Cut" },
  { combo: `${MOD}+KeyV`, label: "Paste" },
  { combo: `${MOD}+KeyA`, label: "Select all" },
  { combo: `${MOD}+KeyZ`, label: "Undo" },
  { combo: `${MOD}+Shift+KeyZ`, label: "Redo" },
  { combo: "Ctrl+KeyY", label: "Redo" },
];

const NATIVE_EDIT = new Set(NATIVE_EDIT_KEYS.map((k) => k.combo));

export interface KeyboardConfig {
  /** Current combo → command lookup (rebuilt by the app when bindings change). */
  lookup(): Map<string, CommandId>;
  /** Run a command. Return false to let the key event through (no preventDefault). */
  run(id: CommandId): boolean | void;
}

export function initKeyboard(cfg: KeyboardConfig): void {
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const typing =
      !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    const combo = comboFromEvent(e);
    if (!combo) return;
    const id = cfg.lookup().get(combo);
    if (!id) return;

    // In a text field, only fire shortcuts that use a strong modifier — bare
    // keys (arrows, Space, Enter, Escape…) belong to the field, and so do the
    // native editing combos (⌘C/X/V/A/Z).
    if (typing && (!comboHasStrongMod(combo) || NATIVE_EDIT.has(combo))) return;

    const handled = cfg.run(id);
    if (handled !== false) e.preventDefault();
  });
}
