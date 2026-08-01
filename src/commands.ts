// The keyboard-command registry. Every shortcut in the app is a command with a
// stable id, a human label, a group (for the Shortcuts tab), and default key
// bindings. Effective bindings live in state.keybindings (persisted); the
// keyboard handler matches a pressed combo against them and runs the command.
//
// Defaults are written against MOD — the primary modifier — which is Meta (⌘) on
// macOS and Ctrl elsewhere. Combo strings stay canonical ("Ctrl+KeyT"), so a
// binding persisted on one platform still parses on another; only the defaults
// differ. Bindings remain rebindable everywhere.

import { isMac, MOD } from "./platform";

export type CommandId =
  | "newTab"
  | "closeTab"
  | "reopenTab"
  | "nextTab"
  | "prevTab"
  | "cycleTab"
  | "goTab1"
  | "goTab2"
  | "goTab3"
  | "goTab4"
  | "goTab5"
  | "goTab6"
  | "goTab7"
  | "goTab8"
  | "goLastTab"
  | "openSettings"
  | "importFile"
  | "exportFile"
  | "pushCloud"
  | "find"
  | "replace"
  | "toggleWrap"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "keyboardMap"
  | "devtools"
  | "openRemote"
  | "pushNow";

export interface Command {
  id: CommandId;
  label: string;
  /** Compact label for the keyboard map, where a key is only so wide. The full
      `label` still shows in the Shortcuts tab and as the key's tooltip. */
  short?: string;
  group: string;
  /** Default bindings, as canonical combo strings (e.g. "Meta+KeyT"). */
  defaults: string[];
}

export const COMMANDS: Command[] = [
  // Tabs
  { id: "newTab", label: "New buffer", group: "Buffers", defaults: [`${MOD}+KeyT`, `${MOD}+KeyN`] },
  // Ctrl+F4 is the Windows close-document convention (and has been since MDI);
  // it sits alongside Ctrl+W rather than replacing it. No macOS equivalent —
  // ⌘F4 means nothing there, so the Mac keeps ⌘W alone.
  { id: "closeTab", label: "Close buffer", group: "Buffers", defaults: isMac ? [`${MOD}+KeyW`] : [`${MOD}+KeyW`, "Ctrl+F4"] },
  { id: "reopenTab", label: "Reopen closed buffer", short: "Reopen", group: "Buffers", defaults: [`${MOD}+Shift+KeyT`] },
  { id: "nextTab", label: "Next buffer", group: "Buffers", defaults: [`${MOD}+Shift+BracketRight`, "Ctrl+Tab"] },
  { id: "prevTab", label: "Previous buffer", short: "Prev buffer", group: "Buffers", defaults: [`${MOD}+Shift+BracketLeft`, "Ctrl+Shift+Tab"] },
  { id: "cycleTab", label: "Cycle buffers", short: "Cycle", group: "Buffers", defaults: [`${MOD}+Backquote`] },
  { id: "goTab1", label: "Go to buffer 1", short: "Buffer 1", group: "Buffers", defaults: [`${MOD}+Digit1`] },
  { id: "goTab2", label: "Go to buffer 2", short: "Buffer 2", group: "Buffers", defaults: [`${MOD}+Digit2`] },
  { id: "goTab3", label: "Go to buffer 3", short: "Buffer 3", group: "Buffers", defaults: [`${MOD}+Digit3`] },
  { id: "goTab4", label: "Go to buffer 4", short: "Buffer 4", group: "Buffers", defaults: [`${MOD}+Digit4`] },
  { id: "goTab5", label: "Go to buffer 5", short: "Buffer 5", group: "Buffers", defaults: [`${MOD}+Digit5`] },
  { id: "goTab6", label: "Go to buffer 6", short: "Buffer 6", group: "Buffers", defaults: [`${MOD}+Digit6`] },
  { id: "goTab7", label: "Go to buffer 7", short: "Buffer 7", group: "Buffers", defaults: [`${MOD}+Digit7`] },
  { id: "goTab8", label: "Go to buffer 8", short: "Buffer 8", group: "Buffers", defaults: [`${MOD}+Digit8`] },
  { id: "goLastTab", label: "Go to last buffer", short: "Last buffer", group: "Buffers", defaults: [`${MOD}+Digit9`] },
  { id: "openSettings", label: "Open settings", short: "Settings", group: "Buffers", defaults: [`${MOD}+Comma`] },

  // Files
  { id: "importFile", label: "Import file into a buffer", short: "Import", group: "Files", defaults: [`${MOD}+KeyO`] },
  { id: "exportFile", label: "Save buffer to a file", short: "Save", group: "Files", defaults: [`${MOD}+KeyS`] },
  // Cloud is the curated store: this pushes ONE buffer by its current name,
  // overwriting any Cloud entry of the same name. Nothing else is touched.
  { id: "pushCloud", label: "Push buffer to Cloud", short: "Cloud", group: "Files", defaults: [`${MOD}+Shift+KeyC`] },

  // Editing
  { id: "find", label: "Find", short: "Find", group: "Editing", defaults: [`${MOD}+KeyF`] },
  { id: "replace", label: "Find & replace", short: "Replace", group: "Editing", defaults: [`${MOD}+Alt+KeyF`] },

  // View
  { id: "toggleWrap", label: "Toggle line wrap", short: "Wrap", group: "View", defaults: ["Alt+KeyZ"] },
  { id: "zoomIn", label: "Bigger text", short: "Bigger", group: "View", defaults: [`${MOD}+Equal`, `${MOD}+NumpadAdd`] },
  { id: "zoomOut", label: "Smaller text", short: "Smaller", group: "View", defaults: [`${MOD}+Minus`, `${MOD}+NumpadSubtract`] },
  { id: "zoomReset", label: "Reset text size", short: "Reset", group: "View", defaults: [`${MOD}+Digit0`, `${MOD}+Numpad0`] },
  { id: "keyboardMap", label: "Keyboard map", short: "Keys", group: "View", defaults: [`${MOD}+KeyK`] },
  { id: "devtools", label: "Developer tools", short: "Dev tools", group: "View", defaults: [`${MOD}+Alt+KeyI`] },

  // Remote
  { id: "openRemote", label: "Remote buffers", short: "Remote", group: "Remote", defaults: [`${MOD}+Shift+KeyR`] },
  { id: "pushNow", label: "Push buffers to the server", short: "Push", group: "Remote", defaults: [] },
];

/** Group order for the Shortcuts tab (first-seen order in COMMANDS). */
export const COMMAND_GROUPS: string[] = [...new Set(COMMANDS.map((c) => c.group))];

export const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
]);

/** Encode a keydown as a canonical combo string, or null for a lone modifier. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  const parts: string[] = [];
  if (e.metaKey) parts.push("Meta");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.code);
  return parts.join("+");
}

/** True if the combo carries a "strong" modifier (fires even while typing). */
export function comboHasStrongMod(combo: string): boolean {
  return combo.split("+").some((p) => p === "Meta" || p === "Ctrl" || p === "Alt");
}

// macOS renders modifiers as glyphs, run together (⌘⇧T). Windows/Linux spell them
// out and join with "+" (Ctrl+Shift+T) — the convention users expect there.
const MOD_SYMBOL: Record<string, string> = isMac
  ? { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" }
  : { Meta: "Win", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
const CODE_SYMBOL: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↩",
  Escape: "⎋",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Space: "Space",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  NumpadAdd: "+",
  NumpadSubtract: "−",
  NumpadMultiply: "×",
  NumpadDivide: "÷",
  NumpadDecimal: ".",
  NumpadEnter: "↩",
};

function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  return CODE_SYMBOL[code] ?? code;
}

/** Human-readable label for a combo: "Meta+Shift+Period" -> "⌘⇧." on macOS,
 *  "Ctrl+Shift+Period" -> "Ctrl+Shift+." elsewhere. */
export function comboLabel(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((p) => MOD_SYMBOL[p] ?? p);
  return isMac ? mods.join("") + keyLabel(key) : [...mods, keyLabel(key)].join("+");
}

export function defaultKeybindings(): Record<CommandId, string[]> {
  const o = {} as Record<CommandId, string[]>;
  for (const c of COMMANDS) o[c.id] = [...c.defaults];
  return o;
}

/** Merge a persisted map over the defaults (so new commands get their default). */
export function mergeKeybindings(saved: unknown): Record<CommandId, string[]> {
  const base = defaultKeybindings();
  if (saved && typeof saved === "object") {
    const s = saved as Record<string, unknown>;
    for (const c of COMMANDS) {
      const v = s[c.id];
      // COPY, don't alias: the adopt step below pushes into these arrays, and
      // mutating the caller's object is a nasty surprise.
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) base[c.id] = [...(v as string[])];
    }
    // A saved config stores the FULL binding set, so a newly-added default stays
    // shadowed by an older snapshot forever. Adopt these for configs that
    // predate them — unless the user has since bound that combo elsewhere.
    // (Windows' Ctrl+F4 close; on macOS it's the ⌘W already there, so no-op.)
    for (const [id, combo] of [["closeTab", isMac ? `${MOD}+KeyW` : "Ctrl+F4"]] as const) {
      const usedElsewhere = (Object.entries(base) as [CommandId, string[]][]).some(
        ([cid, combos]) => cid !== id && combos.includes(combo)
      );
      if (!usedElsewhere && !base[id].includes(combo)) base[id].push(combo);
    }
  }
  return base;
}
