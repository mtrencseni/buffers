import { invoke } from "./ipc";
import type { Settings } from "./types";

export const FONT_MIN = 9;
export const FONT_MAX = 32;

export const state = {
  settings: {
    theme: "system",
    fontFamily: "Menlo",
    fontSize: 13,
    wrapLines: true,
    minimap: true,
    activeLine: false,
    lowercaseTabs: false,
    defaultLanguage: "plain",
    devTools: false,
  } as Settings,
  /** Current editor font size (⌘+/⌘− adjust; ⌘0 resets to settings.fontSize). */
  zoomSize: 13,
  // Effective keyboard bindings: command id -> combo strings. Seeded from
  // defaults at startup (see main.ts), then user-editable in the Shortcuts tab.
  keybindings: {} as Record<string, string[]>,
};

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
