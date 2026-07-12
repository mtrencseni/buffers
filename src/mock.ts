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
- Import a file with ⌘O, export with ⌘S — never linked

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
      return undefined as T;
    default:
      throw `unknown command ${cmd}`;
  }
}
