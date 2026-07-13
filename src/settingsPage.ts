import type { LangId, Settings, Theme } from "./types";
import { FONT_MAX, FONT_MIN } from "./state";
import { LANG_IDS, LANGS } from "./langs";
import { icons } from "./icons";

export interface SettingsHooks {
  get(): Settings;
  onTheme(t: Theme): void;
  onFontFamily(f: string): void;
  onFontSize(n: number): void;
  onWrapLines(v: boolean): void;
  onMinimap(v: boolean): void;
  onActiveLine(v: boolean): void;
  onLowercaseTabs(v: boolean): void;
  onTabsSide(side: "top" | "left"): void;
  onDefaultLanguage(l: LangId): void;
  onDevTools(v: boolean): void;
  onOpenKeybindings(): void;
}

export interface SettingsPage {
  el: HTMLElement;
  /** Re-read state into the controls. */
  sync(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function row(label: string, hint: string, control: HTMLElement): HTMLElement {
  const r = el("div", "setrow");
  const left = el("div", "setlabel");
  left.append(el("div", "setname", label), el("div", "sethint", hint));
  r.append(left, control);
  return r;
}

export function buildSettingsPage(hooks: SettingsHooks): SettingsPage {
  const root = el("div", "settings");
  const inner = el("div", "settings-inner");
  root.append(inner);
  inner.append(el("h1", "", "Settings"));

  const section = (title: string, ...rows: HTMLElement[]) => {
    const s = el("section", "setsection");
    s.append(el("h2", "", title), ...rows);
    inner.append(s);
  };

  // Theme segmented control
  const seg = el("div", "seg");
  const themeBtns = new Map<Theme, HTMLButtonElement>();
  for (const t of ["light", "dark", "system"] as Theme[]) {
    const b = el("button", "", t[0].toUpperCase() + t.slice(1));
    b.addEventListener("click", () => {
      hooks.onTheme(t);
      sync();
    });
    themeBtns.set(t, b);
    seg.append(b);
  }

  // Toggle switch factory.
  const makeSwitch = (read: () => boolean, write: (v: boolean) => void) => {
    const s = el("button", "switch");
    s.setAttribute("role", "switch");
    s.append(el("span", "knob"));
    s.addEventListener("click", () => {
      write(!read());
      sync();
    });
    return s;
  };
  // Tab position segmented control (top bar vs left sidebar).
  const tabSeg = el("div", "seg");
  const tabSideBtns = new Map<"top" | "left", HTMLButtonElement>();
  for (const [side, label] of [
    ["left", "Left"],
    ["top", "Top"],
  ] as ["top" | "left", string][]) {
    const b = el("button", "", label);
    b.addEventListener("click", () => {
      hooks.onTabsSide(side);
      sync();
    });
    tabSideBtns.set(side, b);
    tabSeg.append(b);
  }

  const wrapSw = makeSwitch(() => hooks.get().wrapLines, hooks.onWrapLines);
  const minimapSw = makeSwitch(() => hooks.get().minimap, hooks.onMinimap);
  const activeLineSw = makeSwitch(() => hooks.get().activeLine, hooks.onActiveLine);
  const lowerSw = makeSwitch(() => hooks.get().lowercaseTabs, hooks.onLowercaseTabs);
  const devToolsSw = makeSwitch(() => hooks.get().devTools, hooks.onDevTools);

  // Font family: free-text input (monospace stacks welcome), applied on change.
  const fontInput = el("input", "textinput") as HTMLInputElement;
  fontInput.spellcheck = false;
  fontInput.autocomplete = "off";
  const commitFont = () => {
    const v = fontInput.value.trim();
    if (v) hooks.onFontFamily(v);
    sync();
  };
  fontInput.addEventListener("change", commitFont);
  fontInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commitFont();
      fontInput.blur();
    }
  });

  // Font size stepper.
  const stepper = el("div", "stepper");
  const minus = el("button", "stepbtn");
  minus.innerHTML = "&minus;";
  const val = el("span", "stepval");
  const plus = el("button", "stepbtn");
  plus.innerHTML = icons.plus;
  const stepSize = (d: 1 | -1) => {
    const cur = hooks.get().fontSize;
    hooks.onFontSize(Math.max(FONT_MIN, Math.min(FONT_MAX, cur + d)));
    sync();
  };
  minus.addEventListener("click", () => stepSize(-1));
  plus.addEventListener("click", () => stepSize(1));
  stepper.append(minus, val, plus);

  // Default language: custom dropdown (no native selects in this design).
  const langWrap = el("div", "dropwrap");
  const langBtn = el("button", "dropbtn");
  const langLabel = el("span");
  langBtn.append(langLabel);
  langBtn.insertAdjacentHTML("beforeend", icons.chevron);
  langWrap.append(langBtn);
  let langPop: HTMLElement | null = null;
  const closeLangPop = () => {
    langPop?.remove();
    langPop = null;
    document.removeEventListener("mousedown", onDocDown, true);
  };
  const onDocDown = (e: MouseEvent) => {
    if (langPop && !langWrap.contains(e.target as Node)) closeLangPop();
  };
  langBtn.addEventListener("click", () => {
    if (langPop) {
      closeLangPop();
      return;
    }
    langPop = el("div", "droplist");
    for (const id of LANG_IDS) {
      const item = el("button", "dropitem" + (hooks.get().defaultLanguage === id ? " on" : ""));
      item.textContent = LANGS[id].label;
      item.addEventListener("click", () => {
        hooks.onDefaultLanguage(id);
        closeLangPop();
        sync();
      });
      langPop.append(item);
    }
    langWrap.append(langPop);
    document.addEventListener("mousedown", onDocDown, true);
  });

  const kbBtn = el("button", "linkbtn");
  kbBtn.innerHTML = `${icons.keyboard}<span>Configure shortcuts</span>${icons.chevron}`;
  kbBtn.addEventListener("click", () => hooks.onOpenKeybindings());

  section(
    "Appearance",
    row("Theme", "Light, dark, or follow the OS", seg),
    row("Font", "Editor font family (fixed-width recommended)", fontInput),
    row("Font size", "Base size in px — ⌘0 returns here", stepper)
  );

  section(
    "Editor",
    row("Wrap lines", "Soft-wrap long lines (good for prose) — ⌥Z", wrapSw),
    row("Minimap", "Tiny preview of the whole buffer on the right — click it to scroll", minimapSw),
    row("Highlight active line", "Shade the line the cursor is on", activeLineSw),
    row("Default language", "Syntax assumed for new buffers", langWrap),
    row("Lowercase tab titles", "Show buffer titles in all lowercase", lowerSw),
    row("Tab bar", "Tabs across the top, or down a resizable left sidebar", tabSeg)
  );

  section(
    "Keyboard",
    row("Keyboard shortcuts", "View and customize every key binding", kbBtn)
  );

  section(
    "Advanced",
    row("Enable developer tools", "Toggle the Web Inspector with ⌥⌘I", devToolsSw)
  );

  const setSwitch = (s: HTMLElement, on: boolean) => {
    s.classList.toggle("on", on);
    s.setAttribute("aria-checked", String(on));
  };

  function sync(): void {
    const s = hooks.get();
    for (const [t, b] of themeBtns) b.classList.toggle("on", s.theme === t);
    for (const [side, b] of tabSideBtns) b.classList.toggle("on", s.tabsSide === side);
    setSwitch(wrapSw, s.wrapLines);
    setSwitch(minimapSw, s.minimap);
    setSwitch(activeLineSw, s.activeLine);
    setSwitch(lowerSw, s.lowercaseTabs);
    setSwitch(devToolsSw, s.devTools);
    if (document.activeElement !== fontInput) fontInput.value = s.fontFamily;
    val.textContent = `${s.fontSize}px`;
    langLabel.textContent = LANGS[s.defaultLanguage].label;
  }
  sync();

  return { el: root, sync };
}
