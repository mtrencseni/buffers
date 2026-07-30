import { invoke } from "./ipc";
import { comboLabel } from "./commands";
import { isMac } from "./platform";
import type { Settings } from "./types";

export const FONT_MIN = 9;
export const FONT_MAX = 32;
export const SIDEBAR_MIN = 140;
export const SIDEBAR_MAX = 420;

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
    lowercaseTabs: false,
    tabsSide: "top",
    sidebarWidth: 200,
    defaultLanguage: "plain",
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

/** The current first binding for a command, formatted for the platform — "⌘T" on
 *  macOS, "Ctrl+T" on Windows/Linux. Empty if the command has no binding. Use it
 *  instead of hand-writing a shortcut into any user-visible string. */
export function hint(id: string): string {
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
