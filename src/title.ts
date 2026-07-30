// The ONE display-name rule for a buffer, shared by editor.ts (tab titles) and
// remote.ts (the name pushed to the server), so nothing downstream re-derives
// it differently. Pure — no app or CodeMirror imports.
//
// Not in editor-core.ts on purpose: that module is dependency-closed (CodeMirror
// imports only) because Delight symlinks it.

/** A set `bufferName` wins (pinned name, or a file's name); otherwise the first
    non-empty line among the first 20, capped at 32 chars; "untitled" if blank. */
export function bufferTitle(text: string, bufferName?: string): string {
  if (bufferName) return bufferName;
  let pos = 0;
  for (let i = 0; i < 20 && pos <= text.length; i++) {
    const nl = text.indexOf("\n", pos);
    const line = (nl === -1 ? text.slice(pos) : text.slice(pos, nl)).trim();
    if (line) return line.length > 32 ? line.slice(0, 32) + "…" : line;
    if (nl === -1) break;
    pos = nl + 1;
  }
  return "untitled";
}
