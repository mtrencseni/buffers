import type { LangId, Settings, Theme } from "./types";
import { DEFAULT_SYMBOLS, FONT_MAX, FONT_MIN, INDENT_MAX, INDENT_MIN, hint } from "./state";
import { LANGS } from "./langs";
import { comboLabel } from "./commands";
import { MOD } from "./platform";
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
  onIndentSize(n: number): void;
  onIndentTabs(v: boolean): void;
  onSymbols(list: string[]): void;
  onSelectAllIncludesTitle(v: boolean): void;
  onSearchAllBuffers(v: boolean): void;
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
  /** What this build can actually offer. The page renders what is true here
      rather than what the Settings type happens to contain — a browser has no
      Web Inspector, and a phone has no keys to rebind. */
  caps: SettingsCaps;
}

export interface SettingsCaps {
  /** Web build: the server IS the origin that served this page, so URL, user
      and token aren't settings — the login cookie is the credential, and those
      rows would only offer ways to break it. */
  fixedRemote: boolean;
  /** There is a keyboard worth configuring (false on touch devices). */
  keyboard: boolean;
  /** Tauri only — nothing in a browser to point a Web Inspector toggle at. */
  devTools: boolean;
  /** Web build: end this browser's session and return to the login page. */
  signOut?: () => void;
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

  // −/value/+ stepper factory. Returns the element plus a `set` for sync().
  const makeStepper = (
    read: () => number,
    write: (n: number) => void,
    min: number,
    max: number
  ) => {
    const wrap = el("div", "stepper");
    const minus = el("button", "stepbtn");
    minus.innerHTML = "&minus;";
    const val = el("span", "stepval");
    const plus = el("button", "stepbtn");
    plus.innerHTML = icons.plus;
    const step = (d: 1 | -1) => {
      write(Math.max(min, Math.min(max, read() + d)));
      sync();
    };
    minus.addEventListener("click", () => step(-1));
    plus.addEventListener("click", () => step(1));
    wrap.append(minus, val, plus);
    return { el: wrap, set: (text: string) => (val.textContent = text) };
  };

  const stepper = makeStepper(() => hooks.get().fontSize, hooks.onFontSize, FONT_MIN, FONT_MAX);
  const indentStepper = makeStepper(
    () => hooks.get().indentSize,
    hooks.onIndentSize,
    INDENT_MIN,
    INDENT_MAX
  );

  // Spaces vs real tab characters.
  const indentSeg = el("div", "seg");
  const indentBtns = new Map<boolean, HTMLButtonElement>();
  for (const [tabs, label] of [
    [false, "Spaces"],
    [true, "Tabs"],
  ] as [boolean, string][]) {
    const b = el("button", "", label);
    b.addEventListener("click", () => {
      hooks.onIndentTabs(tabs);
      sync();
    });
    indentBtns.set(tabs, b);
    indentSeg.append(b);
  }

  const searchAllSw = makeSwitch(() => hooks.get().searchAllBuffers, hooks.onSearchAllBuffers);
  const selectTitleSw = makeSwitch(
    () => hooks.get().selectAllIncludesTitle,
    hooks.onSelectAllIncludesTitle
  );

  // The ⌘U symbol list, edited as text: paste characters in, space-separated,
  // and the order you type is the order the stripe shows (so the ones you
  // reach for go first, where the low index keys are). Emptying it restores
  // the defaults rather than leaving ⌘U with nothing to offer.
  const symbolsInput = el("input", "textinput symbolinput") as HTMLInputElement;
  symbolsInput.spellcheck = false;
  symbolsInput.autocomplete = "off";
  const commitSymbols = () => {
    const list = symbolsInput.value.split(/\s+/).filter(Boolean);
    hooks.onSymbols(list.length ? list : [...DEFAULT_SYMBOLS]);
    sync();
  };
  symbolsInput.addEventListener("change", commitSymbols);
  symbolsInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commitSymbols();
      symbolsInput.blur();
    }
  });

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

  const signOutBtn = el("button", "kbreset", "Sign out");
  signOutBtn.addEventListener("click", () => hooks.caps.signOut?.());

  // Shortcuts appear in these hints only when there are shortcuts: hint() is
  // empty on a touch device, and a sentence built around a missing key reads
  // like a bug ("Base size in px —  returns here").
  const withKey = (id: string, withHint: (k: string) => string, without: string) => {
    const k = hint(id);
    return k ? withHint(k) : without;
  };

  const caps = hooks.caps;

  section(
    "Appearance",
    row("Theme", "Light, dark, or follow the OS", seg),
    row("Font", "Editor font family (fixed-width recommended)", fontInput),
    row(
      "Font size",
      withKey("zoomReset", (k) => `Base size in px — ${k} returns here`, "Base size in px"),
      stepper.el
    )
  );

  const editorRows = [
    row(
      "Wrap lines",
      withKey(
        "toggleWrap",
        (k) => `Soft-wrap long lines (good for prose) — ${k}`,
        "Soft-wrap long lines (good for prose)"
      ),
      wrapSw
    ),
    // The minimap is a hover-and-drag target; on touch the editor never shows
    // one whatever this says, so don't offer the switch.
    ...(caps.keyboard
      ? [
          row(
            "Minimap",
            "Tiny preview of the whole buffer on the right — click it to scroll",
            minimapSw
          ),
        ]
      : []),
    row("Highlight active line", "Shade the line the cursor is on", activeLineSw),
    row("Indent width", "Columns per indent level, and how wide a tab renders", indentStepper.el),
    row("Indent using", "What Tab inserts", indentSeg),
    // ⌘U is the only way into the symbol stripe, so on a device with no keyboard
    // this row would configure something you cannot invoke — same reasoning as
    // the minimap switch above. withKey covers the other case: the binding is
    // rebindable, and a hint built around a key the user has cleared would read
    // as a bug rather than as an absence.
    ...(caps.keyboard
      ? [
          row(
            "Symbols",
            withKey(
              "insertSymbol",
              (k) => `Offered by ${k} at the cursor, in this order — separate with spaces`,
              "Offered at the cursor, in this order — separate with spaces"
            ),
            symbolsInput
          ),
        ]
      : []),
    // ⌘A is a native-edit key, not a registry command, so there's no hint(id) to
    // ask — comboLabel keeps it platform-correct (Ctrl+A on Windows). Hidden on
    // touch for the same reason as Symbols: the OS's own Select All there never
    // comes through this code, so the switch would change nothing.
    ...(caps.keyboard
      ? [
          row(
            "Select title on Select All",
            `When off, ${comboLabel(`${MOD}+KeyA`)} in a plain-text or Markdown buffer that ` +
              "opens with a title (underlined, or starting with #) selects only what's below it — press it again to take the title too",
            selectTitleSw
          ),
        ]
      : []),
    row(
      "Search across buffers",
      withKey(
        "findInBuffers",
        (k) => `Let ${k} search every open buffer, not just this one`,
        "Search every open buffer, not just this one"
      ),
      searchAllSw
    ),
    row("Default language", "Syntax assumed for new buffers", langWrap),
    row("Lowercase tab titles", "Show buffer titles in all lowercase", lowerSw),
    row("Tab bar", "Tabs across the top, or down a resizable left sidebar", tabSeg),
  ];
  section("Editor", ...editorRows);

  if (caps.keyboard) {
    section("Keyboard", row("Keyboard shortcuts", "View and customize every key binding", kbBtn));
  }

  // In the web build the server is whoever served this page, so the only remote
  // decisions left are what this browser calls itself and whether it publishes.
  const client = caps.fixedRemote ? "browser" : "machine";
  const remoteRows: HTMLElement[] = [];
  if (!caps.fixedRemote) {
    remoteRows.push(
      row("Server URL", "Buffers server to publish to and read from", urlInput),
      row("User", "Account name on the server", userInput)
    );
  }
  remoteRows.push(
    row(
      caps.fixedRemote ? "This browser" : "This machine",
      caps.fixedRemote
        ? "The name this browser publishes under — every browser is its own client"
        : "The name this machine publishes under",
      hostInput
    )
  );
  if (!caps.fixedRemote) {
    remoteRows.push(row("Token", "Shared secret (sent as X-Buffers-Token)", tokenInput));
  }
  remoteRows.push(
    row(`Publish from this ${client}`, "Push open buffers a few seconds after edits", pushSw),
    row(
      "Connection",
      caps.fixedRemote ? "Checks the server with a real request" : "Checks the URL and token with a real request",
      testWrap
    ),
    statusEl
  );
  if (caps.signOut) {
    remoteRows.push(row("Session", "Forget the sign-in on this browser", signOutBtn));
  }
  section("Remote", ...remoteRows);

  if (caps.devTools) {
    section(
      "Advanced",
      row(
        "Developer mode",
        `Web Inspector (${hint("devtools")}) and the Inspect item in the right-click menu`,
        devToolsSw
      )
    );
  }

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
    setSwitch(searchAllSw, s.searchAllBuffers);
    setSwitch(selectTitleSw, s.selectAllIncludesTitle);
    setSwitch(lowerSw, s.lowercaseTabs);
    setSwitch(devToolsSw, s.devTools);
    for (const [tabs, b] of indentBtns) b.classList.toggle("on", s.indentTabs === tabs);
    if (document.activeElement !== fontInput) fontInput.value = s.fontFamily;
    if (document.activeElement !== symbolsInput) symbolsInput.value = s.symbols.join(" ");
    stepper.set(`${s.fontSize}px`);
    indentStepper.set(`${s.indentSize}`);
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
