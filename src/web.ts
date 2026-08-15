// The web build's backend: the same command surface Rust implements, answered
// by fetch() against the very server that served this page.
//
// Same-origin is the whole trick. The desktop app must route HTTP through Rust
// because the webview's CSP (default-src 'self') blocks fetch() to a
// user-configured server — but here 'self' IS the server, so the frontend calls
// the API directly and there is no CORS, no configured URL, and no token in JS.
//
// Auth is the session cookie the server set at /login: HttpOnly, so this code
// cannot read it and neither can anything else that gets injected. A 401 is
// therefore never something to fix by re-sending a credential — it means the
// session went away, which only happens if the server's token was rotated.
//
// The session lives in IndexedDB (idb.ts) and settings in localStorage; see
// idb.ts for why they differ.

import { kvGet, kvSet } from "./idb";

const SETTINGS_KEY = "buffers-state";

/** Set once a call comes back 401. main.ts only acts on it at BOOT (redirect to
    /login, nothing to lose yet) — mid-session it surfaces as a normal error in
    Settings and the Remote tab, because navigating away from a live editor to
    fix a background push is a worse trade than showing the message. */
export let authExpired = false;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Offline, DNS, server down — one message, like the Rust client's.
    throw "cannot reach the server";
  }
  if (res.status === 401) {
    authExpired = true;
    throw "not signed in — reload the page to sign in again";
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* a non-JSON error body says nothing useful */
    }
    throw detail ? `HTTP ${res.status} — ${detail}` : `HTTP ${res.status}`;
  }
  try {
    return (await res.json()) as T;
  } catch {
    return undefined as T;
  }
}

/** Who the server thinks we are, or why it won't say. Called once at boot:
    "unauth" is the only answer that justifies bouncing to /login — being
    offline must never throw away a session that is sitting in IndexedDB. */
export async function whoami(): Promise<
  { status: "ok"; user: string } | { status: "unauth" | "offline" }
> {
  try {
    const r = await call<{ user: string }>("GET", "/api/whoami");
    return { status: "ok", user: r.user };
  } catch {
    return { status: authExpired ? "unauth" : "offline" };
  }
}

/** This browser's name on the server, generated once and then kept in settings
    (remoteHost) like a machine's hostname. Two browsers on one laptop are two
    clients — that is the intent — so the random tag is what keeps them apart.
    Must satisfy the server's HOST_RE, which is why everything is lowercased
    and the tag is hex. */
function clientName(): string {
  const ua = navigator.userAgent;
  const plat = /iPhone/.test(ua)
    ? "iphone"
    : /iPad/.test(ua)
      ? "ipad"
      : /Android/.test(ua)
        ? "android"
        : /Mac/.test(ua)
          ? "mac"
          : /Windows/.test(ua)
            ? "win"
            : /Linux/.test(ua)
              ? "linux"
              : "browser";
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  const tag = [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `web-${plat}-${tag}`;
}

const enc = encodeURIComponent;

export async function webInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const user = enc(String(args?.user ?? ""));
  switch (cmd) {
    // ---- persistence ---------------------------------------------------------
    case "load_state": {
      const raw = localStorage.getItem(SETTINGS_KEY);
      try {
        return (raw ? JSON.parse(raw) : null) as T;
      } catch {
        return null as T;
      }
    }
    case "save_state":
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(args?.state ?? null));
      } catch {
        /* quota; the next change retries */
      }
      return undefined as T;
    case "load_buffers":
      return (await kvGet<T>("session")) as T;
    case "save_buffers":
      await kvSet("session", args?.buffers);
      return undefined as T;
    case "load_remote_cache":
      return (await kvGet<T>("remote-cache")) as T;
    case "save_remote_cache":
      await kvSet("remote-cache", args?.cache);
      return undefined as T;

    // ---- remote --------------------------------------------------------------
    // url and token arrive from remote.ts and are deliberately ignored: the
    // origin is the server, and the cookie is the credential.
    case "machine_hostname":
      return clientName() as T;
    case "remote_ping":
      await call<unknown>("GET", "/ping");
      return undefined as T;
    case "remote_push":
      await call<unknown>("PUT", `/api/v1/${user}/${enc(String(args?.host ?? ""))}`, args?.payload);
      return undefined as T;
    case "remote_fetch":
      return await call<T>("GET", `/api/v1/${user}`);
    case "cloud_push":
      return await call<T>("POST", `/api/v1/${user}/cloud`, {
        name: args?.name,
        language: args?.language,
        text: args?.text,
      });
    case "cloud_delete":
      // Already gone (404) is the outcome the caller wanted — same rule the Rust
      // command follows, so the two clients behave identically.
      try {
        await call<unknown>("DELETE", `/api/v1/${user}/cloud`, { name: args?.name });
      } catch (e) {
        if (!String(e).startsWith("HTTP 404")) throw e;
      }
      return undefined as T;
    case "host_delete":
      try {
        await call<unknown>("DELETE", `/api/v1/${user}/${enc(String(args?.host ?? ""))}`);
      } catch (e) {
        if (!String(e).startsWith("HTTP 404")) throw e;
      }
      return undefined as T;

    // ---- no filesystem, no native window ------------------------------------
    // Import and export are handled in main.ts with browser APIs instead; these
    // exist so a stray call fails loudly rather than silently doing nothing.
    case "read_file":
    case "write_file":
      throw "the browser has no file system — use Import / Save";
    case "toggle_devtools":
    case "close_devtools":
    case "set_devmode":
    case "show_main_window":
      return undefined as T;
    case "take_open_file":
      return null as T;
    default:
      throw `unknown command ${cmd}`;
  }
}
