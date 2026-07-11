// The keyboard-command registry. Every shortcut in the app is a command with a
// stable id, a human label, a group (for the Shortcuts tab), and default key
// bindings. Effective bindings live in state.keybindings (persisted); the
// keyboard handler matches a pressed combo against them and runs the command.

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
  | "find"
  | "replace"
  | "toggleWrap"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "devtools";

export interface Command {
  id: CommandId;
  label: string;
  group: string;
  /** Default bindings, as canonical combo strings (e.g. "Meta+KeyT"). */
  defaults: string[];
}

export const COMMANDS: Command[] = [
  // Tabs
  { id: "newTab", label: "New buffer", group: "Buffers", defaults: ["Meta+KeyT", "Meta+KeyN"] },
  { id: "closeTab", label: "Close buffer", group: "Buffers", defaults: ["Meta+KeyW"] },
  { id: "reopenTab", label: "Reopen closed buffer", group: "Buffers", defaults: ["Meta+Shift+KeyT"] },
  { id: "nextTab", label: "Next buffer", group: "Buffers", defaults: ["Meta+Shift+BracketRight", "Ctrl+Tab"] },
  { id: "prevTab", label: "Previous buffer", group: "Buffers", defaults: ["Meta+Shift+BracketLeft", "Ctrl+Shift+Tab"] },
  { id: "cycleTab", label: "Cycle buffers", group: "Buffers", defaults: ["Meta+Backquote"] },
  { id: "goTab1", label: "Go to buffer 1", group: "Buffers", defaults: ["Meta+Digit1"] },
  { id: "goTab2", label: "Go to buffer 2", group: "Buffers", defaults: ["Meta+Digit2"] },
  { id: "goTab3", label: "Go to buffer 3", group: "Buffers", defaults: ["Meta+Digit3"] },
  { id: "goTab4", label: "Go to buffer 4", group: "Buffers", defaults: ["Meta+Digit4"] },
  { id: "goTab5", label: "Go to buffer 5", group: "Buffers", defaults: ["Meta+Digit5"] },
  { id: "goTab6", label: "Go to buffer 6", group: "Buffers", defaults: ["Meta+Digit6"] },
  { id: "goTab7", label: "Go to buffer 7", group: "Buffers", defaults: ["Meta+Digit7"] },
  { id: "goTab8", label: "Go to buffer 8", group: "Buffers", defaults: ["Meta+Digit8"] },
  { id: "goLastTab", label: "Go to last buffer", group: "Buffers", defaults: ["Meta+Digit9"] },
  { id: "openSettings", label: "Open settings", group: "Buffers", defaults: ["Meta+Comma"] },

  // Files
  { id: "importFile", label: "Import file into a buffer", group: "Files", defaults: ["Meta+KeyO"] },
  { id: "exportFile", label: "Export buffer to a file", group: "Files", defaults: ["Meta+KeyS"] },

  // Editing
  { id: "find", label: "Find", group: "Editing", defaults: ["Meta+KeyF"] },
  { id: "replace", label: "Find & replace", group: "Editing", defaults: ["Meta+Alt+KeyF"] },

  // View
  { id: "toggleWrap", label: "Toggle line wrap", group: "View", defaults: ["Alt+KeyZ"] },
  { id: "zoomIn", label: "Bigger text", group: "View", defaults: ["Meta+Equal", "Meta+NumpadAdd"] },
  { id: "zoomOut", label: "Smaller text", group: "View", defaults: ["Meta+Minus", "Meta+NumpadSubtract"] },
  { id: "zoomReset", label: "Reset text size", group: "View", defaults: ["Meta+Digit0", "Meta+Numpad0"] },
  { id: "devtools", label: "Developer tools", group: "View", defaults: ["Meta+Alt+KeyI"] },
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

const MOD_SYMBOL: Record<string, string> = { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
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

/** Human-readable label for a combo, e.g. "Meta+Shift+Period" -> "⌘⇧.". */
export function comboLabel(combo: string): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  return parts.map((p) => MOD_SYMBOL[p] ?? p).join("") + keyLabel(key);
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
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) base[c.id] = v as string[];
    }
  }
  return base;
}
