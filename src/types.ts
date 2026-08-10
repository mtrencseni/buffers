import type { LangId } from "./langs";

export type Theme = "light" | "dark" | "system";

/** Language id lives in langs.ts (keeps that module dependency-closed); re-export
    it here so the rest of the app keeps importing it from types. */
export type { LangId };

export interface Settings {
  theme: Theme;
  /** Editor font stack; Menlo by default (what Sublime uses on macOS). */
  fontFamily: string;
  /** Base editor font size in px — ⌘0 returns here. */
  fontSize: number;
  /** Soft-wrap long lines (prose default: on). */
  wrapLines: boolean;
  /** Sublime-style minimap on the right (click to scroll). */
  minimap: boolean;
  /** Highlight the line the cursor is on. */
  activeLine: boolean;
  /** One indent level, in columns — Tab inserts this much, and a literal tab
      renders this wide. */
  indentSize: number;
  /** Indent with real tab characters instead of spaces. */
  indentTabs: boolean;
  /** Show tab names in all lowercase. */
  lowercaseTabs: boolean;
  /** Tabs across the top (default) or down a resizable left sidebar. */
  tabsSide: "top" | "left";
  /** Width (px) of the left tab sidebar when tabsSide === "left". */
  sidebarWidth: number;
  /** Language assumed for brand-new buffers. */
  defaultLanguage: LangId;
  /** Let ⌘⇧F search every open buffer, not just the active one. Off by default:
      a buffer is working text, not an archive (see PRODUCT.md), so the pile of
      open tabs only becomes searchable when you ask for it. */
  searchAllBuffers: boolean;
  /** Enable the Web Inspector (⌥⌘I). */
  devTools: boolean;
  /** Base URL of the Buffers server. Empty disables remote entirely. */
  remoteUrl: string;
  remoteUser: string;
  /** This machine's name on the server. Must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ */
  remoteHost: string;
  remoteToken: string;
  /** Does this machine publish? Reading works either way. */
  remotePush: boolean;
}

/** One scratch buffer (== one tab). Text lives in the CM state; this is the
    serialized form used for hot-exit persistence. */
export interface BufferSnapshot {
  id: number;
  text: string;
  language: LangId;
  /** Selection (anchor/head offsets into the text). */
  anchor: number;
  head: number;
  scrollTop: number;
  /** Display name. Empty ⇒ the name follows the buffer's first line. Set when the
      name is pinned, or from the file name on import/save. */
  bufferName?: string;
  /** When true the name is frozen (no longer tracks the first line). */
  namePinned?: boolean;
  /** Full path of the linked file, or empty for an unsaved/unlinked buffer. When
      set, ⌘S saves straight there; unlinking clears it so ⌘S prompts again. */
  filePath?: string;
  /** Serialized CodeMirror undo history (historyField.toJSON), so ⌘Z still
      reaches yesterday's edits after a restart. Absent for buffers saved before
      this existed, and for ones too large to be worth the file size — restore
      falls back to a fresh history, which is what always used to happen. */
  history?: unknown;
}

export interface Session {
  buffers: BufferSnapshot[];
  activeId: number | null;
  /** Recently closed buffers, most recent last (⌘⇧T reopens). */
  closed: BufferSnapshot[];
  /** Current editor font size (zoom level), persisted separately from the
      configured default so ⌘0 can return to the setting. */
  zoomSize?: number;
}
