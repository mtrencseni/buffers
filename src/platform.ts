// Platform detection. Keep this dependency-free — commands.ts and state.ts both
// import it, and it must work in the browser mock as well as under Tauri.

const ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
const plat = ua?.platform ?? navigator.platform ?? "";

/** True on macOS. Drives the modifier key (⌘ vs Ctrl), the traffic-light inset,
 *  the shortcut labels, the default editor font and the native menu shape. */
export const isMac = /mac/i.test(plat);

/** The primary shortcut modifier: ⌘ on macOS, Ctrl everywhere else. */
export const MOD = isMac ? "Meta" : "Ctrl";
