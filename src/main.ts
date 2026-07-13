import "./styles.css";
import { invoke, isTauri, onEvent } from "./ipc";
import { FONT_MAX, FONT_MIN, SIDEBAR_MAX, SIDEBAR_MIN, persist, state } from "./state";
import type { LangId, Theme } from "./types";
import { Editor } from "./editor";
import { initKeyboard } from "./keyboard";
import { COMMANDS, mergeKeybindings, type CommandId } from "./commands";
import { applyTheme, effectiveTheme, onThemeChange } from "./theme";
import { toast } from "./toast";
import { icons } from "./icons";
import { buildSettingsPage, type SettingsPage } from "./settingsPage";
import { buildKeybindingsPage, type KeybindingsPage } from "./keybindingsPage";
import { extForLang, isLangId, langForFilename, LANG_IDS, LANGS } from "./langs";

type SysTab = "settings" | "keybindings";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class App {
  tabsEl = el("div", "tabs");
  sysTabsEl = el("div", "systabs");
  contentEl = el("div", "content");
  themeBtn = el("button", "tbtn");
  devBtn = el("button", "tbtn");
  newBtn = el("button", "tbtn");
  gearBtn = el("button", "tbtn");
  // Top-tabs container and the left-sidebar container; only one is populated at a
  // time (see applyTabsLayout). The sidebar has a resize handle on its right edge.
  tabbar = el("div", "tabbar");
  sidebar = el("div", "sidebar");
  sidebarResize = el("div", "sidebar-resize");

  editorWrap = el("div", "tabview editorview");
  editorHost = el("div", "edhost");
  statusLeft = el("span", "statusinfo");
  langBtn = el("button", "langbtn");
  langPop: HTMLElement | null = null;

  editor!: Editor;
  settingsView: { el: HTMLElement; page: SettingsPage } | null = null;
  kbView: { el: HTMLElement; page: KeybindingsPage } | null = null;
  /** Which system tab is showing, or null when a buffer tab is active. */
  activeSys: SysTab | null = null;

  private comboMap = new Map<string, CommandId>();
  private commandHandlers: Record<CommandId, () => boolean | void> = {} as any;

  async init(): Promise<void> {
    const [saved, session] = await Promise.all([
      invoke<any>("load_state").catch(() => null),
      invoke<any>("load_buffers").catch(() => null),
    ]);
    this.restoreSettings(saved);
    state.keybindings = mergeKeybindings(saved?.keybindings);

    applyTheme(state.settings.theme);
    this.buildShell();
    this.applyFont();

    this.editor = new Editor(this.editorHost, {
      titlesChanged: () => this.syncTitles(),
      statusChanged: () => this.syncStatus(),
    });
    this.editor.restore(session);
    this.renderTabstrip();
    this.syncStatus();

    this.commandHandlers = {
      newTab: () => {
        this.editor.newBuffer();
        this.showBuffers();
        this.renderTabstrip();
      },
      closeTab: () => this.closeActiveTab(),
      reopenTab: () => {
        if (this.editor.reopenClosed()) {
          this.showBuffers();
          this.renderTabstrip();
        } else {
          toast("Nothing to reopen");
        }
      },
      nextTab: () => this.cycleTab(1),
      prevTab: () => this.cycleTab(-1),
      cycleTab: () => this.cycleTab(1),
      goTab1: () => this.goToTab(0),
      goTab2: () => this.goToTab(1),
      goTab3: () => this.goToTab(2),
      goTab4: () => this.goToTab(3),
      goTab5: () => this.goToTab(4),
      goTab6: () => this.goToTab(5),
      goTab7: () => this.goToTab(6),
      goTab8: () => this.goToTab(7),
      goLastTab: () => this.goToTab(-1),
      openSettings: () => this.openSys("settings"),
      importFile: () => void this.importFile(),
      exportFile: () => void this.exportFile(),
      find: () => {
        this.showBuffers();
        this.editor.openFind();
      },
      replace: () => {
        this.showBuffers();
        this.editor.openFind();
      },
      toggleWrap: () => this.toggleWrap(),
      zoomIn: () => this.zoomStep(1),
      zoomOut: () => this.zoomStep(-1),
      zoomReset: () => this.setZoom(state.settings.fontSize, true),
      devtools: () => {
        if (state.settings.devTools) void invoke("toggle_devtools").catch(() => {});
      },
    };
    this.rebuildComboMap();
    initKeyboard({
      lookup: () => this.comboMap,
      run: (id) => this.commandHandlers[id]?.(),
    });

    // Native menu items route through the same handlers as the shortcuts.
    onEvent<string>("menu", (id) => this.commandHandlers[id as CommandId]?.());

    // Drop files onto the window → import each into a new buffer (like ⌘O).
    this.setupFileDrop();

    // Last-resort flush when the window goes away.
    window.addEventListener("pagehide", () => this.editor.flush());
    requestAnimationFrame(() => this.fitTabTitles());

    // Browser-only test hook (used by the preview harness alongside mock.ts).
    if (!isTauri) (window as any).__buffers = this;
  }

  private restoreSettings(saved: any): void {
    const s = saved?.settings;
    if (s) {
      if (["light", "dark", "system"].includes(s.theme)) state.settings.theme = s.theme;
      if (typeof s.fontFamily === "string" && s.fontFamily.trim()) state.settings.fontFamily = s.fontFamily;
      if (typeof s.fontSize === "number") state.settings.fontSize = clamp(s.fontSize, FONT_MIN, FONT_MAX);
      if (typeof s.wrapLines === "boolean") state.settings.wrapLines = s.wrapLines;
      if (typeof s.minimap === "boolean") state.settings.minimap = s.minimap;
      if (typeof s.lowercaseTabs === "boolean") state.settings.lowercaseTabs = s.lowercaseTabs;
      if (s.tabsSide === "left" || s.tabsSide === "top") state.settings.tabsSide = s.tabsSide;
      if (typeof s.sidebarWidth === "number")
        state.settings.sidebarWidth = clamp(s.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX);
      if (isLangId(s.defaultLanguage)) state.settings.defaultLanguage = s.defaultLanguage;
      if (typeof s.devTools === "boolean") state.settings.devTools = s.devTools;
    }
    state.zoomSize =
      typeof saved?.zoomSize === "number"
        ? clamp(saved.zoomSize, FONT_MIN, FONT_MAX)
        : state.settings.fontSize;
  }

  // ---- shell -----------------------------------------------------------------

  private buildShell(): void {
    const root = document.getElementById("app")!;
    if (isTauri) document.documentElement.classList.add("native");

    this.newBtn.innerHTML = icons.plus;
    this.newBtn.title = "New buffer (⌘T)";
    this.newBtn.addEventListener("click", () => this.commandHandlers.newTab());

    this.themeBtn.addEventListener("click", () => this.toggleTheme());
    onThemeChange(() => this.syncThemeBtn());

    this.devBtn.innerHTML = icons.code;
    this.devBtn.title = "Developer tools (⌥⌘I)";
    this.devBtn.addEventListener("click", () => void invoke("toggle_devtools").catch(() => {}));

    this.gearBtn.innerHTML = icons.gear;
    this.gearBtn.title = "Settings (⌘,)";
    this.gearBtn.addEventListener("click", () => this.openSys("settings"));

    this.sidebarResize.addEventListener("mousedown", (e) => this.beginSidebarResize(e));

    // Editor view: the CodeMirror host + a status bar underneath.
    const statusBar = el("div", "statusbar");
    this.langBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleLangPop();
    });
    statusBar.append(this.statusLeft, this.langBtn);
    this.editorWrap.append(this.editorHost, statusBar);
    this.editorWrap.classList.add("active");
    this.contentEl.append(this.editorWrap);

    root.append(this.tabbar, this.sidebar, this.contentEl);
    this.applyTabsLayout();
    this.syncThemeBtn();
    this.syncDevBtn();
    new ResizeObserver(() => this.fitTabTitles()).observe(this.tabbar);
    window.addEventListener("resize", () => this.fitTabTitles());
  }

  /** Place the shared tab pieces into the top bar or the left sidebar, per the
      tabsSide setting. Called at startup and whenever the setting changes. */
  applyTabsLayout(): void {
    const left = state.settings.tabsSide === "left";
    document.getElementById("app")!.classList.toggle("tabs-left", left);
    if (left) {
      const head = el("div", "sidebar-head");
      head.setAttribute("data-tauri-drag-region", "");
      head.append(this.newBtn);
      const controls = el("div", "sidebar-controls");
      controls.append(this.themeBtn, this.devBtn, this.gearBtn);
      this.sidebar.replaceChildren(head, this.tabsEl, this.sysTabsEl, controls, this.sidebarResize);
      this.sidebar.style.width = `${state.settings.sidebarWidth}px`;
      this.tabbar.replaceChildren();
    } else {
      const spacer = el("div", "flexspace");
      spacer.setAttribute("data-tauri-drag-region", "");
      this.tabbar.setAttribute("data-tauri-drag-region", "");
      this.tabbar.append(
        this.tabsEl,
        this.newBtn,
        spacer,
        this.sysTabsEl,
        this.themeBtn,
        this.devBtn,
        this.gearBtn
      );
      this.sidebar.replaceChildren();
      this.sidebar.style.width = "";
    }
    // buildShell() runs this before the editor exists; init() renders the strip
    // itself afterwards. Only re-render here for runtime setting changes.
    if (this.editor) this.renderTabstrip();
  }

  private beginSidebarResize(e: MouseEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = this.sidebar.getBoundingClientRect().width;
    document.body.classList.add("col-resizing");
    const move = (ev: MouseEvent) => {
      const w = clamp(startW + (ev.clientX - startX), SIDEBAR_MIN, SIDEBAR_MAX);
      state.settings.sidebarWidth = Math.round(w);
      this.sidebar.style.width = `${state.settings.sidebarWidth}px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("col-resizing");
      persist();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  private applyFont(): void {
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--ed-font", `${state.settings.fontFamily}, Menlo, Consolas, monospace`);
    rootStyle.setProperty("--ed-size", `${state.zoomSize}px`);
    // ABSOLUTE (px) line height, shared by content and gutter. A unitless 1.3
    // resolves against each element's own font-size, so the smaller-font gutter
    // got a shorter line box than the content and its numbers drifted fractionally
    // over long wrapped lines. Integer px locks them together.
    rootStyle.setProperty("--ed-line-height", `${Math.round(state.zoomSize * 1.3)}px`);
    // Route the change through CM as a theme reconfigure so it re-reads styles
    // and re-measures line heights (requestMeasure alone isn't a reliable trigger).
    this.editor?.applyFontConfig();
  }

  // ---- tabs ------------------------------------------------------------------

  private title(id: number): string {
    const t = this.editor.title(id);
    return state.settings.lowercaseTabs ? t.toLowerCase() : t;
  }

  renderTabstrip(): void {
    const frag = document.createDocumentFragment();
    for (const id of this.editor.ids()) {
      const t = el("div", "tab" + (this.activeSys === null && id === this.editor.active() ? " active" : ""));
      t.dataset.bufId = String(id);
      const title = el("span", "tabtitle");
      title.textContent = this.title(id);
      const close = el("span", "tabclose");
      close.innerHTML = icons.close;
      close.title = "Close buffer (⌘W)";
      t.append(title, close);
      t.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest(".tabclose")) return;
        // Default mousedown moves focus out of the editor AFTER activate()
        // focused it (divs aren't focusable → body), killing keyboard input.
        e.preventDefault();
        this.activateBuffer(id);
        this.beginTabDrag(e, t);
      });
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeBufferTab(id);
      });
      t.addEventListener("auxclick", (e) => {
        if (e.button === 1) this.closeBufferTab(id);
      });
      frag.append(t);
    }
    this.tabsEl.replaceChildren(frag);

    const sysFrag = document.createDocumentFragment();
    for (const kind of ["settings", "keybindings"] as SysTab[]) {
      const view = kind === "settings" ? this.settingsView : this.kbView;
      if (!view) continue;
      const t = el("div", "tab" + (this.activeSys === kind ? " active" : ""));
      const title = el("span", "tabtitle");
      title.textContent = kind === "settings" ? "Settings" : "Shortcuts";
      const close = el("span", "tabclose");
      close.innerHTML = icons.close;
      t.append(title, close);
      t.addEventListener("mousedown", (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest(".tabclose")) return;
        this.openSys(kind);
      });
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeSys(kind);
      });
      sysFrag.append(t);
    }
    this.sysTabsEl.replaceChildren(sysFrag);
    this.fitTabTitles();
  }

  /** Update tab titles in place (cheap — runs on every doc change). */
  syncTitles(): void {
    for (const t of this.tabsEl.querySelectorAll<HTMLElement>(".tab")) {
      const id = Number(t.dataset.bufId);
      const title = t.querySelector<HTMLElement>(".tabtitle");
      const want = this.title(id);
      if (title && title.textContent !== want) title.textContent = want;
    }
  }

  private syncActiveTabClass(): void {
    for (const t of this.tabsEl.querySelectorAll<HTMLElement>(".tab")) {
      t.classList.toggle(
        "active",
        this.activeSys === null && Number(t.dataset.bufId) === this.editor.active()
      );
    }
    const sysEls = this.sysTabsEl.querySelectorAll<HTMLElement>(".tab");
    const kinds: SysTab[] = [];
    if (this.settingsView) kinds.push("settings");
    if (this.kbView) kinds.push("keybindings");
    sysEls.forEach((e, i) => e.classList.toggle("active", this.activeSys === kinds[i]));
  }

  activateBuffer(id: number): void {
    this.activeSys = null;
    this.editor.activate(id);
    this.showView();
    this.syncActiveTabClass();
  }

  private showBuffers(): void {
    if (this.activeSys !== null) {
      this.activeSys = null;
      this.showView();
      this.syncActiveTabClass();
      this.editor.view.focus();
    }
  }

  private closeBufferTab(id: number): void {
    this.editor.closeBuffer(id);
    this.renderTabstrip();
    this.syncStatus();
  }

  /** ⌘W: close whatever is active — a system tab or the active buffer. */
  private closeActiveTab(): void {
    if (this.activeSys !== null) {
      this.closeSys(this.activeSys);
      return;
    }
    this.closeBufferTab(this.editor.active());
  }

  /** Jump to the Nth buffer tab (0-based; -1 = last). Out of range: no-op. */
  goToTab(index: number): void {
    const ids = this.editor.ids();
    if (ids.length === 0) return;
    const id = index < 0 ? ids[ids.length - 1] : ids[index];
    if (id === undefined) return;
    this.activateBuffer(id);
  }

  cycleTab(d: 1 | -1): void {
    // Cycle only through buffer tabs — skip the Settings / Shortcuts system tabs.
    // From a system tab this advances from the last-active buffer, leaving it.
    const ids = this.editor.ids();
    if (ids.length === 0) return;
    const i = Math.max(0, ids.indexOf(this.editor.active()));
    this.activateBuffer(ids[(i + d + ids.length) % ids.length]);
  }

  private showView(): void {
    this.editorWrap.classList.toggle("active", this.activeSys === null);
    this.settingsView?.el.classList.toggle("active", this.activeSys === "settings");
    this.kbView?.el.classList.toggle("active", this.activeSys === "keybindings");
  }

  // ---- system tabs (Settings / Shortcuts) --------------------------------------

  openSys(kind: SysTab): void {
    if (kind === "settings" && !this.settingsView) this.settingsView = this.buildSettings();
    if (kind === "keybindings" && !this.kbView) this.kbView = this.buildKeybindings();
    this.activeSys = kind;
    (kind === "settings" ? this.settingsView : this.kbView)?.page.sync();
    this.showView();
    this.renderTabstrip();
  }

  closeSys(kind: SysTab): void {
    const view = kind === "settings" ? this.settingsView : this.kbView;
    view?.el.remove();
    if (kind === "settings") this.settingsView = null;
    else this.kbView = null;
    if (this.activeSys === kind) {
      this.activeSys = null;
      this.showView();
      this.editor.view.focus();
    }
    this.renderTabstrip();
  }

  private buildSettings() {
    const wrap = el("div", "tabview");
    const page = buildSettingsPage({
      get: () => state.settings,
      onTheme: (t: Theme) => {
        state.settings.theme = t;
        applyTheme(t);
        persist();
      },
      onFontFamily: (f) => {
        state.settings.fontFamily = f;
        this.applyFont();
        persist();
      },
      onFontSize: (n) => {
        state.settings.fontSize = n;
        this.setZoom(n, false);
        persist();
      },
      onWrapLines: (v) => {
        state.settings.wrapLines = v;
        this.editor.applyWrap();
        persist();
      },
      onMinimap: (v) => {
        state.settings.minimap = v;
        this.editor.applyMinimap();
        persist();
      },
      onActiveLine: (v) => {
        state.settings.activeLine = v;
        this.editor.applyActiveLine();
        persist();
      },
      onLowercaseTabs: (v) => {
        state.settings.lowercaseTabs = v;
        this.syncTitles();
        persist();
      },
      onTabsSide: (side) => {
        state.settings.tabsSide = side;
        this.applyTabsLayout();
        persist();
      },
      onDefaultLanguage: (l) => {
        state.settings.defaultLanguage = l;
        persist();
      },
      onDevTools: (v) => {
        state.settings.devTools = v;
        this.syncDevBtn();
        if (!v) void invoke("close_devtools").catch(() => {});
        persist();
      },
      onOpenKeybindings: () => this.openSys("keybindings"),
    });
    wrap.append(page.el);
    this.contentEl.append(wrap);
    return { el: wrap, page };
  }

  private buildKeybindings() {
    const wrap = el("div", "tabview");
    const page = buildKeybindingsPage({
      get: () => state.keybindings,
      add: (id, combo) => {
        const prev = this.comboMap.get(combo);
        for (const cid of Object.keys(state.keybindings) as CommandId[]) {
          state.keybindings[cid] = state.keybindings[cid].filter((c) => c !== combo);
        }
        if (!state.keybindings[id].includes(combo)) state.keybindings[id].push(combo);
        if (prev && prev !== id) {
          const label = COMMANDS.find((c) => c.id === prev)?.label ?? prev;
          toast(`Reassigned from “${label}”`);
        }
        this.afterBindingsChanged();
      },
      remove: (id, combo) => {
        state.keybindings[id] = (state.keybindings[id] ?? []).filter((c) => c !== combo);
        this.afterBindingsChanged();
      },
      owner: (combo) => this.comboMap.get(combo) ?? null,
      reset: () => {
        state.keybindings = mergeKeybindings(null);
        this.afterBindingsChanged();
      },
    });
    wrap.append(page.el);
    this.contentEl.append(wrap);
    return { el: wrap, page };
  }

  private rebuildComboMap(): void {
    const m = new Map<string, CommandId>();
    for (const cmd of COMMANDS) {
      for (const combo of state.keybindings[cmd.id] ?? []) m.set(combo, cmd.id);
    }
    this.comboMap = m;
  }

  private afterBindingsChanged(): void {
    this.rebuildComboMap();
    this.kbView?.page.sync();
    persist();
  }

  // ---- tab title fitting (borrowed from Delight) --------------------------------

  private fitTabTitles(): void {
    const bar = this.tabsEl.parentElement;
    if (!bar || this.tabsEl.children.length === 0) return;
    if (bar.clientWidth === 0) return;
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const WIDE = 13.5 * rootPx;
    const MIN = 5 * rootPx;
    const CHROME = 2.6 * rootPx;
    const barCS = getComputedStyle(bar);
    const gap = parseFloat(barCS.gap) || 0;
    const padX = parseFloat(barCS.paddingLeft) + parseFloat(barCS.paddingRight);
    let reserved = 0;
    for (const child of bar.children) {
      const c = child as HTMLElement;
      if (c === this.tabsEl || c.classList.contains("flexspace")) continue;
      reserved += c.getBoundingClientRect().width;
    }
    const gaps = gap * (bar.children.length - 1);
    const count = this.tabsEl.children.length || 1;
    const available = bar.clientWidth - padX - reserved - gaps;
    const budget = available / count - CHROME;
    const max = clamp(budget, MIN, WIDE);
    this.tabsEl.style.setProperty("--tab-title-max", `${Math.floor(max)}px`);
  }

  // ---- tab dragging (reorder buffer tabs) ---------------------------------------

  private beginTabDrag(startEvent: MouseEvent, tabEl: HTMLElement): void {
    const container = this.tabsEl;
    // Top tabs reorder along X; sidebar tab rows reorder along Y.
    const vert = state.settings.tabsSide === "left";
    const axis = vert ? "Y" : "X";
    const pointerStart = vert ? startEvent.clientY : startEvent.clientX;
    const home = vert ? tabEl.offsetTop : tabEl.offsetLeft;
    const extent = (s: HTMLElement) => (vert ? s.offsetTop : s.offsetLeft);
    const size = (s: HTMLElement) => (vert ? s.offsetHeight : s.offsetWidth);
    const edge = (r: DOMRect) => (vert ? r.top : r.left);
    let dragging = false;

    const flip = (mutate: () => void) => {
      const sibs = [...container.querySelectorAll<HTMLElement>(".tab")].filter((s) => s !== tabEl);
      const before = new Map(sibs.map((s) => [s, edge(s.getBoundingClientRect())]));
      mutate();
      for (const s of sibs) {
        const d = (before.get(s) ?? 0) - edge(s.getBoundingClientRect());
        if (!d) continue;
        s.style.transition = "none";
        s.style.transform = `translate${axis}(${d}px)`;
        requestAnimationFrame(() => {
          s.style.transition = "transform 0.15s ease";
          s.style.transform = "";
        });
      }
    };

    const onMove = (e: MouseEvent) => {
      const raw = (vert ? e.clientY : e.clientX) - pointerStart;
      if (!dragging) {
        if (Math.abs(raw) < 4) return;
        dragging = true;
        tabEl.classList.add("dragging");
        document.body.classList.add("tab-dragging");
      }
      tabEl.style.transform = `translate${axis}(${raw - (extent(tabEl) - home)}px)`;
      const visualCenter = home + raw + size(tabEl) / 2;
      const sibs = [...container.querySelectorAll<HTMLElement>(".tab")].filter((s) => s !== tabEl);
      let target = 0;
      for (const s of sibs) if (visualCenter > extent(s) + size(s) / 2) target++;
      const curIdx = [...container.querySelectorAll(".tab")].indexOf(tabEl);
      if (target !== curIdx) flip(() => container.insertBefore(tabEl, sibs[target] ?? null));
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("tab-dragging");
      if (!dragging) return;
      const ids = [...container.querySelectorAll<HTMLElement>(".tab")].map((e) =>
        Number(e.dataset.bufId)
      );
      this.editor.reorder(ids);
      this.renderTabstrip();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // ---- status bar ----------------------------------------------------------------

  syncStatus(): void {
    const s = this.editor.status();
    const parts = [`Ln ${s.line}, Col ${s.col}`, `${s.chars.toLocaleString()} chars`];
    if (s.selected > 0) parts.push(`${s.selected.toLocaleString()} selected`);
    this.statusLeft.textContent = parts.join("  ·  ");
    this.langBtn.textContent = LANGS[this.editor.language()].label;
  }

  private toggleLangPop(): void {
    if (this.langPop) {
      this.closeLangPop();
      return;
    }
    const pop = el("div", "droplist up");
    for (const id of LANG_IDS) {
      const item = el("button", "dropitem" + (this.editor.language() === id ? " on" : ""));
      item.textContent = LANGS[id].label;
      item.addEventListener("click", () => {
        this.editor.setLanguage(id);
        this.closeLangPop();
        this.syncStatus();
        this.editor.view.focus();
      });
      pop.append(item);
    }
    this.langBtn.parentElement!.append(pop);
    this.langPop = pop;
    document.addEventListener("mousedown", this.onDocDown, true);
  }

  private closeLangPop(): void {
    this.langPop?.remove();
    this.langPop = null;
    document.removeEventListener("mousedown", this.onDocDown, true);
  }

  private onDocDown = (e: MouseEvent) => {
    if (this.langPop && !this.langPop.contains(e.target as Node) && e.target !== this.langBtn) {
      this.closeLangPop();
    }
  };

  // ---- import / export -------------------------------------------------------------

  private async importFile(): Promise<void> {
    if (!isTauri) {
      toast("Import needs the native app");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: false, title: "Import into a buffer" });
    if (typeof path !== "string") return;
    await this.openPaths([path]);
  }

  /** Read each path into its own new buffer — shared by ⌘O import and file drop. */
  private async openPaths(paths: string[]): Promise<void> {
    let opened = 0;
    for (const path of paths) {
      try {
        const text = await invoke<string>("read_file", { path });
        this.editor.newBuffer(text, langForFilename(path));
        opened++;
      } catch (e) {
        toast(String(e));
      }
    }
    if (!opened) return;
    this.showBuffers();
    this.renderTabstrip();
    toast(opened === 1 ? "Imported — the buffer is now on its own" : `Imported ${opened} files`);
  }

  /** Native OS file drop onto the window → import the dropped files (Tauri only). */
  private setupFileDrop(): void {
    if (!isTauri) return;
    void import("@tauri-apps/api/webview").then((m) =>
      m.getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths.length) {
          void this.openPaths(event.payload.paths);
        }
      })
    );
  }

  private async exportFile(): Promise<void> {
    if (!isTauri) {
      toast("Export needs the native app");
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const lang = this.editor.language();
    const base =
      this.editor
        .title(this.editor.active())
        .replace(/[/\\:*?"<>|]/g, "")
        .trim()
        .slice(0, 40) || "untitled";
    const path = await save({
      title: "Export buffer",
      defaultPath: `${base}.${extForLang(lang)}`,
    });
    if (typeof path !== "string") return;
    try {
      await invoke("write_file", { path, contents: this.editor.activeText() });
      toast("Exported — the buffer stays a buffer");
    } catch (e) {
      toast(String(e));
    }
  }

  // ---- theme / zoom -------------------------------------------------------------

  private toggleTheme(): void {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    state.settings.theme = next;
    applyTheme(next);
    this.settingsView?.page.sync();
    toast(next === "dark" ? "Dark theme" : "Light theme");
    persist();
  }

  private syncThemeBtn(): void {
    const dark = effectiveTheme() === "dark";
    this.themeBtn.innerHTML = dark ? icons.sun : icons.moon;
    this.themeBtn.title = dark ? "Switch to light theme" : "Switch to dark theme";
  }

  private syncDevBtn(): void {
    this.devBtn.hidden = !state.settings.devTools;
  }

  toggleWrap(): void {
    state.settings.wrapLines = !state.settings.wrapLines;
    this.editor.applyWrap();
    this.settingsView?.page.sync();
    toast(state.settings.wrapLines ? "Wrap: on" : "Wrap: off");
    persist();
  }

  setZoom(px: number, announce: boolean): void {
    state.zoomSize = clamp(px, FONT_MIN, FONT_MAX);
    this.applyFont();
    if (announce) toast(`${state.zoomSize}px`);
    persist();
  }

  zoomStep(d: 1 | -1): void {
    this.setZoom(state.zoomSize + d, true);
  }
}

new App().init();
