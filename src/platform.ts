// Platform detection. Keep this dependency-free — commands.ts and state.ts both
// import it, and it must work in the browser mock and the web build as well as
// under Tauri.

const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
const plat = ua?.platform ?? navigator.platform ?? "";

/** True on macOS. Drives the modifier key (⌘ vs Ctrl), the traffic-light inset,
 *  the shortcut labels, the default editor font and the native menu shape.
 *
 *  In the web build this reads the BROWSER's host, which is exactly right: Mac
 *  Chrome gets ⌘ bindings and ⌘-shaped labels, Windows Chrome gets Ctrl. (An
 *  iPad reports "MacIntel", so a paired Magic Keyboard gets ⌘ too — also right;
 *  the shortcut *UI* is hidden there by isTouch below.) */
export const isMac = /mac/i.test(plat);

/** The primary shortcut modifier: ⌘ on macOS, Ctrl everywhere else. */
export const MOD = isMac ? "Meta" : "Ctrl";

/** Touch-primary device: a phone or tablet, where there is no keyboard to hint
 *  at. Everything that *displays* a shortcut hides itself when this is true —
 *  the tooltips' "(⌘T)" suffixes, the Shortcuts tab, the ⌘K keyboard map.
 *
 *  The key HANDLER stays installed regardless, so an iPad with a keyboard (or a
 *  phone with one paired) still works. What goes away is the UI that would
 *  otherwise promise keys the device doesn't have. */
export const isTouch =
  typeof matchMedia === "function" &&
  matchMedia("(pointer: coarse)").matches &&
  navigator.maxTouchPoints > 0;
