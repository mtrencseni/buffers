// Language registry: id -> label, syntax extension, and file extensions (used
// to pick a language on import and suggest one on export). Official CM6
// packages where they exist; legacy stream modes for the rest.

import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { csharp, java, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import type { LangId } from "./types";

interface Lang {
  label: string;
  exts: string[];
  /** CM extension providing the syntax (null = plain text). */
  syntax: () => Extension | null;
}

export const LANGS: Record<LangId, Lang> = {
  plain: { label: "Plain text", exts: ["txt"], syntax: () => null },
  markdown: { label: "Markdown", exts: ["md", "markdown"], syntax: () => markdown() },
  javascript: { label: "JavaScript", exts: ["js", "mjs", "cjs", "jsx"], syntax: () => javascript({ jsx: true }) },
  typescript: { label: "TypeScript", exts: ["ts", "tsx"], syntax: () => javascript({ typescript: true, jsx: true }) },
  json: { label: "JSON", exts: ["json"], syntax: () => json() },
  python: { label: "Python", exts: ["py"], syntax: () => python() },
  c: { label: "C", exts: ["c", "h"], syntax: () => cpp() },
  cpp: { label: "C++", exts: ["cpp", "cc", "cxx", "hpp", "hh"], syntax: () => cpp() },
  csharp: { label: "C#", exts: ["cs"], syntax: () => StreamLanguage.define(csharp) },
  java: { label: "Java", exts: ["java"], syntax: () => StreamLanguage.define(java) },
  kotlin: { label: "Kotlin", exts: ["kt", "kts"], syntax: () => StreamLanguage.define(kotlin) },
  rust: { label: "Rust", exts: ["rs"], syntax: () => rust() },
  sql: { label: "SQL", exts: ["sql"], syntax: () => sql() },
  bash: { label: "Bash", exts: ["sh", "bash", "zsh"], syntax: () => StreamLanguage.define(shell) },
  html: { label: "HTML", exts: ["html", "htm"], syntax: () => html() },
  css: { label: "CSS", exts: ["css"], syntax: () => css() },
  latex: { label: "LaTeX", exts: ["tex"], syntax: () => StreamLanguage.define(stex) },
  yaml: { label: "YAML", exts: ["yml", "yaml"], syntax: () => StreamLanguage.define(yaml) },
  xml: { label: "XML", exts: ["xml", "svg", "plist"], syntax: () => StreamLanguage.define(xml) },
};

export const LANG_IDS = Object.keys(LANGS) as LangId[];

export function isLangId(v: unknown): v is LangId {
  return typeof v === "string" && v in LANGS;
}

/** Language for a filename, by extension (plain when unknown). */
export function langForFilename(name: string): LangId {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  for (const id of LANG_IDS) {
    if (LANGS[id].exts.includes(ext)) return id;
  }
  return "plain";
}

/** Suggested file extension when exporting a buffer of this language. */
export function extForLang(id: LangId): string {
  return LANGS[id].exts[0] ?? "txt";
}
