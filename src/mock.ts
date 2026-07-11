// In-browser mock of the Rust commands, used only when running outside Tauri
// (plain `vite dev`). State and buffers persist to localStorage so the whole
// app — including hot exit — can be developed and tested in a browser.

function load(key: string): unknown {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

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
