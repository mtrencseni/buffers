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
  /** Show tab names in all lowercase. */
  lowercaseTabs: boolean;
  /** Tabs across the top (default) or down a resizable left sidebar. */
  tabsSide: "top" | "left";
  /** Width (px) of the left tab sidebar when tabsSide === "left". */
  sidebarWidth: number;
  /** Language assumed for brand-new buffers. */
  defaultLanguage: LangId;
  /** Enable the Web Inspector (⌥⌘I). */
  devTools: boolean;
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
