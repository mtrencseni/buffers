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
// Legacy stream modes — a big bundle of languages that ships free with
// @codemirror/legacy-modes (no extra packages). StreamLanguage.define wraps each.
import { csharp, java, kotlin, scala, objectiveC, dart } from "@codemirror/legacy-modes/mode/clike";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { go } from "@codemirror/legacy-modes/mode/go";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { r } from "@codemirror/legacy-modes/mode/r";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript";
import { scheme } from "@codemirror/legacy-modes/mode/scheme";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { elm } from "@codemirror/legacy-modes/mode/elm";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { vb } from "@codemirror/legacy-modes/mode/vb";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { fortran } from "@codemirror/legacy-modes/mode/fortran";
import { pascal } from "@codemirror/legacy-modes/mode/pascal";
import { tcl } from "@codemirror/legacy-modes/mode/tcl";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";

/** Language id — keys of the registry below. Defined here (not types.ts) so this
    module stays dependency-closed and can be symlinked into sibling apps (Delight
    reuses it for its read-only code preview). types.ts re-exports it. */
export type LangId =
  | "plain"
  | "markdown"
  | "javascript"
  | "typescript"
  | "json"
  | "python"
  | "c"
  | "cpp"
  | "csharp"
  | "java"
  | "kotlin"
  | "scala"
  | "objectivec"
  | "dart"
  | "rust"
  | "go"
  | "ruby"
  | "perl"
  | "lua"
  | "swift"
  | "groovy"
  | "clojure"
  | "haskell"
  | "julia"
  | "elm"
  | "erlang"
  | "scheme"
  | "coffeescript"
  | "r"
  | "fortran"
  | "pascal"
  | "tcl"
  | "verilog"
  | "vhdl"
  | "sql"
  | "bash"
  | "powershell"
  | "html"
  | "css"
  | "latex"
  | "yaml"
  | "xml"
  | "toml"
  | "properties"
  | "dockerfile"
  | "cmake"
  | "vb"
  | "diff";

interface Lang {
  label: string;
  exts: string[];
  /** CM extension providing the syntax (null = plain text). */
  syntax: () => Extension | null;
}

const stream = (mode: Parameters<typeof StreamLanguage.define>[0]) => () => StreamLanguage.define(mode);

export const LANGS: Record<LangId, Lang> = {
  plain: { label: "Plain text", exts: ["txt", "text", "log", "me", "nfo"], syntax: () => null },
  markdown: { label: "Markdown", exts: ["md", "markdown", "mdown", "mkd"], syntax: () => markdown() },
  javascript: { label: "JavaScript", exts: ["js", "mjs", "cjs", "jsx"], syntax: () => javascript({ jsx: true }) },
  typescript: { label: "TypeScript", exts: ["ts", "tsx", "mts", "cts"], syntax: () => javascript({ typescript: true, jsx: true }) },
  json: { label: "JSON", exts: ["json", "jsonc", "json5", "webmanifest"], syntax: () => json() },
  python: { label: "Python", exts: ["py", "pyw", "pyi"], syntax: () => python() },
  c: { label: "C", exts: ["c", "h"], syntax: () => cpp() },
  cpp: { label: "C++", exts: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"], syntax: () => cpp() },
  csharp: { label: "C#", exts: ["cs"], syntax: stream(csharp) },
  java: { label: "Java", exts: ["java"], syntax: stream(java) },
  kotlin: { label: "Kotlin", exts: ["kt", "kts"], syntax: stream(kotlin) },
  scala: { label: "Scala", exts: ["scala", "sc"], syntax: stream(scala) },
  objectivec: { label: "Objective-C", exts: ["m", "mm"], syntax: stream(objectiveC) },
  dart: { label: "Dart", exts: ["dart"], syntax: stream(dart) },
  rust: { label: "Rust", exts: ["rs"], syntax: () => rust() },
  go: { label: "Go", exts: ["go"], syntax: stream(go) },
  ruby: { label: "Ruby", exts: ["rb", "gemspec", "podspec", "ru"], syntax: stream(ruby) },
  perl: { label: "Perl", exts: ["pl", "pm", "t"], syntax: stream(perl) },
  lua: { label: "Lua", exts: ["lua"], syntax: stream(lua) },
  swift: { label: "Swift", exts: ["swift"], syntax: stream(swift) },
  groovy: { label: "Groovy", exts: ["groovy", "gradle", "gvy"], syntax: stream(groovy) },
  clojure: { label: "Clojure", exts: ["clj", "cljs", "cljc", "edn"], syntax: stream(clojure) },
  haskell: { label: "Haskell", exts: ["hs"], syntax: stream(haskell) },
  julia: { label: "Julia", exts: ["jl"], syntax: stream(julia) },
  elm: { label: "Elm", exts: ["elm"], syntax: stream(elm) },
  erlang: { label: "Erlang", exts: ["erl", "hrl"], syntax: stream(erlang) },
  scheme: { label: "Scheme", exts: ["scm", "ss"], syntax: stream(scheme) },
  coffeescript: { label: "CoffeeScript", exts: ["coffee"], syntax: stream(coffeeScript) },
  r: { label: "R", exts: ["r"], syntax: stream(r) },
  fortran: { label: "Fortran", exts: ["f", "for", "f90", "f95"], syntax: stream(fortran) },
  pascal: { label: "Pascal", exts: ["pas", "pp"], syntax: stream(pascal) },
  tcl: { label: "Tcl", exts: ["tcl"], syntax: stream(tcl) },
  verilog: { label: "Verilog", exts: ["v", "sv", "svh"], syntax: stream(verilog) },
  vhdl: { label: "VHDL", exts: ["vhd", "vhdl"], syntax: stream(vhdl) },
  sql: { label: "SQL", exts: ["sql"], syntax: () => sql() },
  bash: { label: "Shell", exts: ["sh", "bash", "zsh", "fish", "ksh", "bashrc", "zshrc", "profile"], syntax: stream(shell) },
  powershell: { label: "PowerShell", exts: ["ps1", "psm1", "psd1"], syntax: stream(powerShell) },
  html: { label: "HTML", exts: ["html", "htm", "xhtml"], syntax: () => html() },
  css: { label: "CSS", exts: ["css"], syntax: () => css() },
  latex: { label: "LaTeX", exts: ["tex", "sty", "cls"], syntax: stream(stex) },
  yaml: { label: "YAML", exts: ["yml", "yaml"], syntax: stream(yaml) },
  xml: { label: "XML", exts: ["xml", "svg", "plist", "xsl", "xsd", "rss", "wsdl"], syntax: stream(xml) },
  toml: { label: "TOML", exts: ["toml"], syntax: stream(toml) },
  properties: { label: "Properties", exts: ["properties", "ini", "cfg", "conf", "gitconfig", "editorconfig", "env"], syntax: stream(properties) },
  dockerfile: { label: "Dockerfile", exts: ["dockerfile"], syntax: stream(dockerFile) },
  cmake: { label: "CMake", exts: ["cmake"], syntax: stream(cmake) },
  vb: { label: "Visual Basic", exts: ["vb", "vbs", "bas"], syntax: stream(vb) },
  diff: { label: "Diff", exts: ["diff", "patch"], syntax: stream(diff) },
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
