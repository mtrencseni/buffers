// Remote client logic: push this machine's open buffers to the Buffers server,
// and fetch every machine's buffers for the Remote tab. The HTTP itself lives
// in Rust (src-tauri/src/remote.rs) — the webview's CSP (default-src 'self')
// blocks fetch() to the server, and all IO goes through Rust anyway.
//
// Philosophy (do not design past it): pushes are one-way, under this machine's
// own hostname; reads are read-only. Nothing merges, syncs, or writes back.
//
// Failures are SILENT — offline is a normal state, not a toast. lastPushAt and
// lastError are surfaced only in the Remote tab and Settings.

import { invoke } from "./ipc";
import { state } from "./state";
import { bufferTitle } from "./title";
import type { Session } from "./types";

/** The server's host-name charset (a host becomes a path component there). */
export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Clean up a typed server URL: trim, drop trailing slashes, and assume https
    when no scheme was given, so "buffers.example.com" just works. An explicit
    scheme is left alone — typing http:// (or anything else) still means it. */
export function normalizeRemoteUrl(v: string): string {
  const t = v.trim().replace(/\/+$/, "");
  if (!t) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}

/** One buffer as the server stores it. ONLY name/language/text ever leave the
    machine — no paths, ids, cursor state, or the closed stack. */
export interface RemoteBuffer {
  name: string;
  language: string;
  text: string;
}

export interface RemoteHost {
  host: string;
  /** "cloud" = the curated Cloud store, "host" = a machine mirror. Trust this,
      never the name — only Cloud entries may be deleted from here. */
  kind?: "cloud" | "host";
  /** Unix seconds of the host's last push. */
  received_at: number;
  received_iso: string;
  buffers: RemoteBuffer[];
}

/** Shape of GET /api/v1/<user> — hosts newest first. */
export interface RemoteData {
  user: string;
  hosts: RemoteHost[];
}

/** Push health, shown in the Remote tab and Settings (never as a toast). */
export const remoteStatus = {
  /** Date.now() of the last successful push; 0 = never this session. */
  lastPushAt: 0,
  /** Last push/fetch failure message; empty when the last attempt succeeded. */
  lastError: "",
};

/** Whether reading the server can work at all (the Remote tab's gate). */
export function remoteConfigured(): boolean {
  return !!state.settings.remoteUrl;
}

function pushEnabled(): boolean {
  const s = state.settings;
  return !!(s.remoteUrl && s.remotePush && s.remoteHost);
}

/** Strip a session down to the exact push payload: open buffers only, each
    reduced to name/language/text. `name` is the resolved display title
    (the shared bufferTitle rule), so the server needs no naming logic. */
export function toPayload(session: Session): { buffers: RemoteBuffer[] } {
  return {
    buffers: session.buffers.map((b) => ({
      name: bufferTitle(b.text, b.bufferName),
      language: b.language,
      text: b.text,
    })),
  };
}

// Push machinery: every hot-exit flush schedules a push with its own, longer
// debounce; blur/hidden/pagehide (the same triggers that flush the editor,
// registered AFTER it — see initRemote's call site) push immediately.
const PUSH_IDLE_MS = 5000;
let pushTimer = 0;
/** The serialized payload waiting to go, or null when nothing is queued. */
let pending: string | null = null;
/** Is the queued payload empty? Tracked at queue time so pushPending doesn't
    re-parse it. */
let pendingEmpty = false;
/** The last payload the server accepted — an identical one is never re-sent
    (tab switches flush an unchanged session; don't spam the server). */
let lastPushed = "";
let inFlight = false;

/** Did this session start with buffers restored from local storage? A cold start
    that restored NOTHING must not automatically push an empty payload: that is
    the reinstalled-client failure the server's daily history exists to survive,
    and it is far more likely in a browser (iOS Safari evicts script-writable
    storage after 7 days idle) than on a desktop. The guard lifts the moment
    there is anything to push, so "I closed every tab" still publishes normally.
    An explicit Push now (forcePush) is never blocked — that one is deliberate. */
let restoredSomething = true;
export function noteRestoredSession(hadBuffers: boolean): void {
  restoredSomething = hadBuffers;
}

/** Called from the editor's sessionFlushed hook: queue a push after 5 s idle. */
export function schedulePush(session: Session): void {
  if (!pushEnabled()) return;
  const payload = toPayload(session);
  if (payload.buffers.length) restoredSomething = true;
  pending = JSON.stringify(payload);
  pendingEmpty = payload.buffers.length === 0;
  clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => void pushPending(), PUSH_IDLE_MS);
}

/** The manual push-now command: send the current session even if unchanged.
    Resolves to an error message, or "" on success (the caller may toast —
    a deliberate action deserves feedback; only AUTOMATIC pushes stay silent). */
export async function forcePush(session: Session): Promise<string> {
  if (!pushEnabled()) return "Remote push is off — configure it in Settings";
  pending = JSON.stringify(toPayload(session));
  pendingEmpty = false; // deliberate: an explicit push publishes whatever it is
  lastPushed = ""; // defeat the unchanged check
  clearTimeout(pushTimer);
  await pushPending();
  return remoteStatus.lastError;
}

async function pushPending(): Promise<void> {
  if (inFlight) return; // the running push re-checks pending when it lands
  const body = pending;
  if (!body || body === lastPushed || !pushEnabled()) return;
  if (pendingEmpty && !restoredSomething) return; // see noteRestoredSession
  inFlight = true;
  const s = state.settings;
  try {
    await invoke("remote_push", {
      url: s.remoteUrl,
      user: s.remoteUser,
      host: s.remoteHost,
      token: s.remoteToken,
      payload: JSON.parse(body),
    });
    lastPushed = body;
    remoteStatus.lastPushAt = Date.now();
    remoteStatus.lastError = "";
    // Newer state arrived while this one was in flight — send it shortly.
    // Only after a SUCCESS: a failed push is dropped, the next flush self-heals
    // (each push is a full snapshot; retrying here would loop while offline).
    if (pending !== body) {
      clearTimeout(pushTimer);
      pushTimer = window.setTimeout(() => void pushPending(), 250);
    }
  } catch (e) {
    remoteStatus.lastError = String(e);
  } finally {
    inFlight = false;
  }
}

/** Fetch every host's buffers (the Remote tab, and Settings' test button). */
export async function fetchRemote(): Promise<RemoteData> {
  const s = state.settings;
  return await invoke<RemoteData>("remote_fetch", {
    url: s.remoteUrl,
    user: s.remoteUser,
    token: s.remoteToken,
  });
}

/** The last successful fetch, kept on disk so the Remote tab still shows
    something with no network. A cache and nothing more: any successful fetch
    replaces it wholesale, and it is never merged into local buffers. */
export interface RemoteCache {
  /** Date.now() when this snapshot came off the server. */
  fetchedAt: number;
  data: RemoteData;
}

export async function loadRemoteCache(): Promise<RemoteCache | null> {
  try {
    const c = await invoke<RemoteCache | null>("load_remote_cache");
    // A hand-edited or half-written file must not take the tab down.
    if (c && typeof c.fetchedAt === "number" && Array.isArray(c.data?.hosts)) return c;
  } catch {
    /* unreadable cache is simply no cache */
  }
  return null;
}

/** Fire-and-forget: a cache that fails to write costs nothing. */
export async function saveRemoteCache(data: RemoteData): Promise<void> {
  try {
    await invoke("save_remote_cache", { cache: { fetchedAt: Date.now(), data } });
  } catch {
    /* ignore */
  }
}

/** Whether a Cloud push can even be attempted (URL + user; a missing or wrong
    token surfaces as the server's 401, which the caller toasts). */
export function cloudConfigured(): boolean {
  const s = state.settings;
  return !!(s.remoteUrl && s.remoteUser);
}

/** Add or overwrite ONE Cloud buffer. Resolves to true when it replaced an
    existing entry of the same name. Unlike the machine push this is
    user-initiated, so the caller reports failures instead of swallowing them. */
export async function cloudPush(buf: RemoteBuffer): Promise<boolean> {
  const s = state.settings;
  const res = await invoke<{ replaced?: boolean }>("cloud_push", {
    url: s.remoteUrl,
    user: s.remoteUser,
    token: s.remoteToken,
    name: buf.name,
    language: buf.language,
    text: buf.text,
  });
  return !!res?.replaced;
}

/** Remove ONE Cloud buffer by name. Already-gone (404) counts as done. */
export async function cloudDelete(name: string): Promise<void> {
  const s = state.settings;
  await invoke<void>("cloud_delete", {
    url: s.remoteUrl,
    user: s.remoteUser,
    token: s.remoteToken,
    name,
  });
}

/** Forget an entire machine host — every buffer and the server-side history.
    For retired hardware: a machine that is still running re-appears on its
    next push. Already-gone (404) counts as done; the server refuses the Cloud
    host (409), which surfaces as a clear message. */
export async function hostDelete(host: string): Promise<void> {
  const s = state.settings;
  await invoke<void>("host_delete", {
    url: s.remoteUrl,
    user: s.remoteUser,
    token: s.remoteToken,
    host,
  });
}

/** Install the immediate-push triggers. Call AFTER the Editor is constructed
    and main.ts's pagehide flush is registered: same-event listeners run in
    registration order, so the editor's flush (which queues the fresh payload
    via sessionFlushed) must be in place before these fire. */
export function initRemote(): void {
  const now = () => {
    clearTimeout(pushTimer);
    void pushPending();
  };
  window.addEventListener("blur", now);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") now();
  });
  window.addEventListener("pagehide", now);
}
