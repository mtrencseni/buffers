// A two-call key/value store on IndexedDB. The web build keeps its session here
// — the browser's answer to .buffers.json.
//
// Why not localStorage, which the browser mock uses? Two things that only bite
// in real use: the ~5 MB origin quota is reachable now that buffers carry their
// undo history, and localStorage writes are SYNCHRONOUS — the hot-exit flush
// fires a second after you stop typing, and a multi-megabyte synchronous write
// on the main thread is a visible stall on a phone.
//
// Settings stay in localStorage (see web.ts): they are tiny, and a synchronous
// read at startup keeps the boot path simple.
//
// If IndexedDB is missing or refuses to open (private windows have historically
// done both), every call falls back to localStorage. Degrading to the smaller
// store beats losing the session outright.

const DB_NAME = "buffers";
const STORE = "kv";
const LS_PREFIX = "buffers-idb:";

let dbp: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // Another tab holding an old version open would otherwise hang the boot.
    req.onblocked = () => resolve(null);
  });
}

function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbp ??= openDb();
  return dbp;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const d = await db();
  if (!d) {
    const raw = localStorage.getItem(LS_PREFIX + key);
    try {
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const d = await db();
  if (!d) {
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value ?? null));
    } catch {
      /* quota — the next flush tries again */
    }
    return;
  }
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, "readwrite");
      // Structured-clone the value by hand: CodeMirror's serialized history is
      // plain JSON, but a stray non-cloneable field would otherwise throw
      // asynchronously and take the flush down with it.
      tx.objectStore(STORE).put(JSON.parse(JSON.stringify(value ?? null)), key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Ask the browser to exempt this origin from eviction. iOS Safari clears
    script-writable storage after 7 days without interaction, which would leave
    a cold start with no session at all. Best-effort: the answer is advisory,
    and an installed (Add to Home Screen) app is exempt regardless. */
export function requestPersistence(): void {
  void navigator.storage?.persist?.().catch(() => {});
}
