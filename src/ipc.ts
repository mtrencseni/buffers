import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isTauri, isWeb } from "./target";

export { isTauri };

let mock: Promise<typeof import("./mock")> | null = null;
let web: Promise<typeof import("./web")> | null = null;

/** Invoke a backend command. Three backends answer, one surface: Rust under
 *  Tauri, the server itself in the web build (web.ts), a canned filesystem in
 *  plain `pnpm dev` (mock.ts). Both browser backends are loaded lazily so the
 *  desktop bundle never pays for them. */
export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return tauriInvoke<T>(cmd, args);
  if (isWeb) {
    web ??= import("./web");
    return web.then((m) => m.webInvoke<T>(cmd, args));
  }
  mock ??= import("./mock");
  return mock.then((m) => m.mockInvoke<T>(cmd, args));
}

/** Subscribe to a backend event. No-op outside Tauri (neither browser backend
 *  emits any — there is no menu and no second instance to hear from). */
export function onEvent<T>(name: string, cb: (payload: T) => void): void {
  if (!isTauri) return;
  void import("@tauri-apps/api/event").then((m) =>
    m.listen<T>(name, (e) => cb(e.payload))
  );
}
