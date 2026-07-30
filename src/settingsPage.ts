import type { LangId, Settings, Theme } from "./types";
import { FONT_MAX, FONT_MIN, hint } from "./state";
import { LANGS } from "./langs";
import { buildLangPicker } from "./langpicker";
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
  // Remote (server) — see remote.ts. The hooks validate; this page is dumb.
  onRemoteUrl(v: string): void;
  onRemoteUser(v: string): void;
  onRemoteHost(v: string): void;
  onRemoteToken(v: string): void;
  onRemotePush(v: boolean): void;
  /** Test the URL + token (a real authenticated GET); resolves to a message. */
  remoteTest(): Promise<string>;
  /** Push health for the status row. */
  remoteStatus(): { lastPushAt: number; lastError: string };
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
    const picker = buildLangPicker({
      current: hooks.get().defaultLanguage,
      onPick: (id) => {
        hooks.onDefaultLanguage(id);
        closeLangPop();
        sync();
      },
      onClose: () => {
        closeLangPop();
        langBtn.focus();
      },
    });
    langPop = picker.el;
    langWrap.append(langPop);
    document.addEventListener("mousedown", onDocDown, true);
    picker.focus();
  });

  const kbBtn = el("button", "linkbtn");
  kbBtn.innerHTML = `${icons.keyboard}<span>Configure shortcuts</span>${icons.chevron}`;
  kbBtn.addEventListener("click", () => hooks.onOpenKeybindings());

  // Remote: URL / user / host / token inputs (same commit-on-change/Enter
  // pattern as the font input), a publish toggle, and a test button.
  const makeText = (write: (v: string) => void, masked = false): HTMLInputElement => {
    const input = el("input", "textinput") as HTMLInputElement;
    input.spellcheck = false;
    input.autocomplete = "off";
    if (masked) input.type = "password";
    const commit = () => {
      write(input.value);
      sync();
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commit();
        input.blur();
      }
    });
    return input;
  };
  const urlInput = makeText(hooks.onRemoteUrl);
  urlInput.placeholder = "https://…  (empty = off)";
  const userInput = makeText(hooks.onRemoteUser);
  const hostInput = makeText(hooks.onRemoteHost);
  const tokenInput = makeText(hooks.onRemoteToken, true);
  const pushSw = makeSwitch(() => hooks.get().remotePush, hooks.onRemotePush);

  const testWrap = el("div", "remote-test");
  const testBtn = el("button", "kbreset", "Test connection");
  const testMsg = el("span", "remote-testmsg");
  testWrap.append(testBtn, testMsg);
  testBtn.addEventListener("click", () => {
    testBtn.disabled = true;
    testMsg.textContent = "Testing…";
    testMsg.classList.remove("err");
    void hooks.remoteTest().then((msg) => {
      testBtn.disabled = false;
      testMsg.textContent = msg;
      testMsg.classList.toggle("err", !msg.startsWith("OK"));
    });
  });

  const statusEl = el("div", "sethint remote-pushstatus");

  section(
    "Appearance",
    row("Theme", "Light, dark, or follow the OS", seg),
    row("Font", "Editor font family (fixed-width recommended)", fontInput),
    row("Font size", `Base size in px — ${hint("zoomReset")} returns here`, stepper)
  );

  section(
    "Editor",
    row("Wrap lines", `Soft-wrap long lines (good for prose) — ${hint("toggleWrap")}`, wrapSw),
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
    "Remote",
    row("Server URL", "Buffers server to publish to and read from", urlInput),
    row("User", "Account name on the server", userInput),
    row("This machine", "The name this machine publishes under", hostInput),
    row("Token", "Shared secret (sent as X-Buffers-Token)", tokenInput),
    row("Publish from this machine", "Push open buffers a few seconds after edits", pushSw),
    row("Connection", "Checks the URL and token with a real request", testWrap),
    statusEl
  );

  section(
    "Advanced",
    row("Enable developer tools", `Toggle the Web Inspector with ${hint("devtools")}`, devToolsSw)
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
    const remotePairs: [HTMLInputElement, string][] = [
      [urlInput, s.remoteUrl],
      [userInput, s.remoteUser],
      [hostInput, s.remoteHost],
      [tokenInput, s.remoteToken],
    ];
    for (const [input, value] of remotePairs) {
      if (document.activeElement !== input) input.value = value;
    }
    setSwitch(pushSw, s.remotePush);
    const st = hooks.remoteStatus();
    const parts: string[] = [];
    if (st.lastPushAt) parts.push(`Last push: ${new Date(st.lastPushAt).toLocaleTimeString()}`);
    if (st.lastError) parts.push(`Last error: ${st.lastError}`);
    statusEl.textContent = parts.join("  ·  ") || "No pushes yet this session.";
    statusEl.classList.toggle("err", !!st.lastError);
  }
  sync();

  return { el: root, sync };
}
