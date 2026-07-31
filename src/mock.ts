// In-browser mock of the Rust commands, used only when running outside Tauri
// (plain `vite dev`). State and buffers persist to localStorage so the whole
// app — including hot exit — can be developed and tested in a browser.

function load(key: string): unknown {
  const raw = localStorage.getItem(key);
  if (raw) return JSON.parse(raw);
  // First run in the browser: seed a small demo session so the app (and the
  // README screenshot / `pnpm dev`) shows real content. Native app is unaffected.
  return key === "buffers-session" ? DEFAULT_SESSION : null;
}

const DEFAULT_SESSION = {
  buffers: [
    {
      id: 1,
      language: "markdown",
      anchor: 0,
      head: 0,
      scrollTop: 0,
      text: `# Release email — draft

Hey team,

**Buffers** is a scratch-pad editor: you open a tab, write an email or a
prompt, then _copy it out_. Text lives in tabs, not files — nothing is ever
"unsaved", because there's nothing to save.

- Multiple tabs, each a buffer (title = first line)
- Hot exit: everything comes back exactly as you left it
- Syntax highlighting, find & replace, a minimap
- Files are imported and exported, never linked

> Draft it here, paste it wherever it's going.
`,
    },
    {
      id: 2,
      language: "python",
      anchor: 0,
      head: 0,
      scrollTop: 0,
      text: `def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

print([fib(i) for i in range(10)])
`,
    },
    {
      id: 3,
      language: "plain",
      anchor: 0,
      head: 0,
      scrollTop: 0,
      text: "todo: reply to Sam\ntodo: book the room for Thursday\n",
    },
  ],
  activeId: 1,
  closed: [],
  zoomSize: 14,
};

function save(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value ?? null));
}

/** The Cloud store the stubs mutate. Seeded with a deliberately awkward name
    (slash + em dash + non-ASCII) — the server never treats names as paths, so
    neither should we. */
const cloudStore: { name: string; language: string; text: string; pushed_at: number }[] = [
  {
    name: "path/with — slashes",
    language: "plain",
    text: "A curated Cloud entry. Nothing expires here; it leaves when deleted.\n",
    pushed_at: Date.now() / 1000 - 3600,
  },
  {
    name: "release checklist",
    language: "markdown",
    text: "# Release\n\n- [x] tag\n- [ ] notes\n",
    pushed_at: Date.now() / 1000 - 7200,
  },
];

/** The machine mirrors the stubs serve — mutable so host_delete can actually
    remove one and the Remote tab's refresh/fallback paths can be exercised. */
const machineHosts: { host: string; agoSeconds: number; buffers: { name: string; language: string; text: string }[] }[] = [
  {
    host: "work-laptop",
    agoSeconds: 300,
    buffers: [
      {
        name: "Standup notes",
        language: "markdown",
        text: "# Standup notes\n\n- shipped the importer\n- next: the flaky test on CI\n",
      },
      {
        name: "query.sql",
        language: "sql",
        text: "SELECT host, COUNT(*) AS buffers\nFROM sessions\nGROUP BY host\nORDER BY buffers DESC;\n",
      },
    ],
  },
  {
    host: "home-desktop",
    agoSeconds: 86400 * 2,
    buffers: [
      {
        name: "fib.py",
        language: "python",
        text: "def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n",
      },
    ],
  },
];

export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case "load_state":
      return load("buffers-state") as T;
    case "save_state":
      save("buffers-state", args?.state);
      return undefined as T;
    case "load_buffers":
      return load("buffers-session") as T;
    case "save_buffers":
      save("buffers-session", args?.buffers);
      return undefined as T;
    case "read_file":
      return `mock contents of ${String(args?.path)}\n` as T;
    case "write_file":
      console.log("[mock] write_file", args?.path, `${String(args?.contents).length} chars`);
      return undefined as T;
    case "toggle_devtools":
    case "close_devtools":
    case "set_devmode": // Windows context-menu filter; nothing to mock
      return undefined as T;
    // Remote stubs: never reach the real server from the browser (it's
    // cross-origin and sends no CORS headers) — canned data drives the UI.
    // cloud_push/cloud_delete mutate cloudStore below, so the Cloud half of the
    // Remote tab behaves for real: overwrite-by-name, delete, refresh.
    case "machine_hostname":
      return "browser-mock" as T;
    case "remote_push":
      console.log(
        "[mock] remote_push",
        args?.host,
        `${(args?.payload as { buffers?: unknown[] })?.buffers?.length ?? 0} buffers`
      );
      return undefined as T;
    case "remote_ping":
      return undefined as T;
    // The remote cache stands in for .remote-cache.json; localStorage keeps it
    // across reloads so the offline path can actually be exercised here.
    case "load_remote_cache": {
      try {
        const raw = localStorage.getItem("mock-remote-cache");
        return (raw ? JSON.parse(raw) : null) as T;
      } catch {
        return null as T;
      }
    }
    case "save_remote_cache":
      localStorage.setItem("mock-remote-cache", JSON.stringify(args?.cache ?? null));
      return undefined as T;
    case "cloud_push": {
      const name = String(args?.name ?? "");
      if (!name) throw "HTTP 400 — a Cloud buffer needs a name";
      const i = cloudStore.findIndex((b) => b.name === name);
      const entry = {
        name,
        language: String(args?.language ?? "plain"),
        text: String(args?.text ?? ""),
        pushed_at: Date.now() / 1000,
      };
      const replaced = i >= 0;
      if (replaced) cloudStore[i] = entry;
      else cloudStore.push(entry);
      console.log("[mock] cloud_push", name, replaced ? "(replaced)" : "(new)");
      return { ok: true, name, replaced, buffers: cloudStore.length } as T;
    }
    case "cloud_delete": {
      const name = String(args?.name ?? "");
      const i = cloudStore.findIndex((b) => b.name === name);
      // A missing name is NOT an error here: the Rust command maps the server's
      // 404 to Ok (already gone is the outcome the caller wanted).
      if (i >= 0) cloudStore.splice(i, 1);
      console.log("[mock] cloud_delete", name, i >= 0 ? "(removed)" : "(already gone)");
      return undefined as T;
    }
    case "host_delete": {
      const host = String(args?.host ?? "");
      // Mirror the server's 409 for the Cloud host (and the Rust command's
      // message for it): the curated store has no one-shot wipe.
      if (host === "Cloud")
        throw "the Cloud store has no one-shot wipe — delete its buffers one by one";
      const i = machineHosts.findIndex((h) => h.host === host);
      // Already gone (404) is success, exactly like cloud_delete.
      if (i >= 0) machineHosts.splice(i, 1);
      console.log("[mock] host_delete", host, i >= 0 ? "(removed)" : "(already gone)");
      return undefined as T;
    }
    case "remote_fetch": {
      // Dev switch for the offline path: localStorage["mock-offline"] = "1"
      // makes every fetch fail the way a plane does, so the Remote tab's cached
      // rendering can actually be exercised in the browser.
      if (localStorage.getItem("mock-offline")) throw "cannot reach the server";
      const now = Date.now() / 1000;
      const iso = (ago: number) => new Date((now - ago) * 1000).toISOString();
      return {
        user: "mtrencseni",
        hosts: [
          {
            host: "Cloud",
            kind: "cloud",
            received_at: cloudStore.reduce((t, b) => Math.max(t, b.pushed_at), 0),
            received_iso: iso(0),
            buffers: cloudStore.map((b) => ({ ...b })),
          },
          ...machineHosts.map((h) => ({
            host: h.host,
            kind: "host",
            received_at: now - h.agoSeconds,
            received_iso: iso(h.agoSeconds),
            buffers: h.buffers.map((b) => ({ ...b })),
          })),
        ],
      } as T;
    }
    default:
      throw `unknown command ${cmd}`;
  }
}
