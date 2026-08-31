import { invoke } from "./ipc";
import { comboLabel } from "./commands";
import { isMac, isTouch } from "./platform";
import type { Settings } from "./types";

export const FONT_MIN = 9;
export const FONT_MAX = 32;
export const SIDEBAR_MIN = 140;
export const SIDEBAR_MAX = 420;
export const INDENT_MIN = 1;
export const INDENT_MAX = 8;

/** What the ⌘U stripe offers out of the box: the marks and arrows that come up
    in prose and commit messages, and a small run of faces. Everything here is a
    character you can't type but might want mid-sentence — which is the whole
    test for whether something belongs in this list. */
export const DEFAULT_SYMBOLS = [
  "✔",
  "✗",
  "—",
  "←",
  "→",
  "⟶",
  "⟵",
  "😀",
  "😁",
  "😂",
  "😐",
  "😢",
];

export const state = {
  settings: {
    theme: "system",
    // Sublime's macOS default; Windows/Linux don't have Menlo, so start on the
    // platform's usual fixed-width face (the CSS stack falls back either way).
    fontFamily: isMac ? "Menlo" : "Consolas",
    fontSize: 13,
    wrapLines: true,
    minimap: true,
    activeLine: false,
    indentSize: 4,
    indentTabs: false,
    symbols: [...DEFAULT_SYMBOLS],
    lowercaseTabs: false,
    tabsSide: "top",
    sidebarWidth: 200,
    defaultLanguage: "plain",
    searchAllBuffers: false,
    devTools: false,
    remoteUrl: "",
    remoteUser: "mtrencseni",
    remoteHost: "", // seeded from machine_hostname() at startup when empty
    remoteToken: "",
    remotePush: true,
  } as Settings,
  /** Current editor font size (⌘+/⌘− adjust; ⌘0 resets to settings.fontSize). */
  zoomSize: 13,
  // Effective keyboard bindings: command id -> combo strings. Seeded from
  // defaults at startup (see main.ts), then user-editable in the Shortcuts tab.
  keybindings: {} as Record<string, string[]>,
};

/** Whether the minimap should actually render. THE rule, so the editor and the
 *  Remote preview can't drift: it is a hover-and-drag target that eats width a
 *  phone hasn't got, and the overlay scrollbar it pairs with is mouse-only — so
 *  a touch device never gets one, whatever the setting says. (The setting is
 *  left alone rather than forced off: the same account on a desktop still
 *  wants it, and Settings hides the switch on touch anyway.) */
export function minimapOn(): boolean {
  return state.settings.minimap && !isTouch;
}

/** The current first binding for a command, formatted for the platform — "⌘T" on
 *  macOS, "Ctrl+T" on Windows/Linux. Empty if the command has no binding, and
 *  always empty on a touch device (there is no keyboard to advertise). Use it
 *  instead of hand-writing a shortcut into any user-visible string — every
 *  caller then degrades correctly on a phone for free. */
export function hint(id: string): string {
  if (isTouch) return "";
  const combo = state.keybindings[id]?.[0];
  return combo ? comboLabel(combo) : "";
}

let saveTimer: number | undefined;

/** Debounced write of the app settings (buffers persist separately; buffers.ts). */
export function persist(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    invoke("save_state", {
      state: {
        settings: state.settings,
        zoomSize: state.zoomSize,
        keybindings: state.keybindings,
      },
    }).catch(() => {});
  }, 250);
}
