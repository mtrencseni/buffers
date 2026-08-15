import "./styles.css";
import { invoke, isTauri, onEvent } from "./ipc";
import {
  FONT_MAX,
  FONT_MIN,
  INDENT_MAX,
  INDENT_MIN,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  hint as kbHint,
  persist,
  state,
} from "./state";
import type { LangId, Theme } from "./types";
import { Editor, type EditorCommandId } from "./editor";
import { buildFindAll } from "./findall";
import { initKeyboard } from "./keyboard";
import { COMMANDS, mergeKeybindings, type CommandId } from "./commands";
import { isMac, isTouch } from "./platform";
import { isBrowser, isWeb } from "./target";
import { requestPersistence } from "./idb";
import { applyTheme, effectiveTheme, onThemeChange } from "./theme";
import { toast } from "./toast";
import { toggleKeyboardMap } from "./keyboardmap";
import { icons } from "./icons";
import { buildSettingsPage, type SettingsPage } from "./settingsPage";
import { buildKeybindingsPage, type KeybindingsPage } from "./keybindingsPage";
import { buildRemotePage, type RemotePage } from "./remotePage";
import {
  cloudConfigured,
  cloudDelete,
  cloudPush,
  fetchRemote,
  forcePush,
  hostDelete,
  loadRemoteCache,
  HOST_RE,
  initRemote,
  noteRestoredSession,
  normalizeRemoteUrl,
  remoteConfigured,
  remoteStatus,
  saveRemoteCache,
  schedulePush,
} from "./remote";
import { extForLang, isLangId, langForFilename, LANG_IDS, LANGS } from "./langs";
import { buildLangPicker } from "./langpicker";

type SysTab = "settings" | "keybindings" | "remote";

/** Display titles for the system tabs (tab strip). */
const SYS_TITLES: Record<SysTab, string> = {
  settings: "Settings",
  keybindings: "Shortcuts",
  remote: "Remote",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Below this width the chrome re-flows for a phone: tabs scroll across the top,
    the action toolbar drops to a bottom bar within thumb reach, and the left
    sidebar isn't offered at all. Width, not touch — a narrow desktop window gets
    the same treatment, and a tablet in landscape doesn't need it. */
const NARROW_PX = 820;
const isNarrow = () => window.innerWidth < NARROW_PX;

/** " (⌘T)" / " (Ctrl+T)" — the command's current binding, parenthesized for a
 *  tooltip. Platform-correct and rebind-aware; never spell a shortcut by hand. */
function hint(id: CommandId): string {
  const h = kbHint(id);
  return h ? ` (${h})` : "";
}

class App {
  tabsEl = el("div", "tabs");
  sysTabsEl = el("div", "systabs");
  contentEl = el("div", "content");
  themeBtn = el("button", "tbtn");
  kbBtn = el("button", "tbtn");
  cloudBtn = el("button", "tbtn");
  devBtn = el("button", "tbtn");
  newBtn = el("button", "tbtn");
  gearBtn = el("button", "tbtn");
  // The action toolbar (import / export / close / find / replace) — the buttons
  // the native menu used to carry. Re-parented by applyTabsLayout: into the top
  // tab bar (top mode) or a strip above the editor (left mode).
  actionsEl = el("div", "actions");
  // Left-mode only: a strip above the editor that carries the action toolbar and
  // doubles as a window-drag region (there's no top tab bar to grab by).
  editorTopbar = el("div", "editor-topbar");
  // Top-tabs container and the left-sidebar container; only one is populated at a
  // time (see applyTabsLayout). The sidebar has a resize handle on its right edge.
  tabbar = el("div", "tabbar");
  sidebar = el("div", "sidebar");
  sidebarResize = el("div", "sidebar-resize");
  // Narrow screens only: a bottom bar carrying + and the action toolbar, within
  // thumb reach. It takes the SAME elements the top bar would (see
  // applyTabsLayout), so there is one set of buttons and one set of handlers.
  mobilebar = el("div", "mobilebar");

  editorWrap = el("div", "tabview editorview");
  editorHost = el("div", "edhost");
  statusLeft = el("span", "statusinfo");
  // Name-pin toggle + linked-file indicator/unlink, both live in the status bar.
  pinBtn = el("button", "statusbtn");
  fileEl = el("span", "filelink");
  langBtn = el("button", "langbtn");
  langPop: HTMLElement | null = null;

  editor!: Editor;
  settingsView: { el: HTMLElement; page: SettingsPage } | null = null;
  kbView: { el: HTMLElement; page: KeybindingsPage } | null = null;
  remoteView: { el: HTMLElement; page: RemotePage } | null = null;
  /** Which system tab is showing, or null when a buffer tab is active. */
  activeSys: SysTab | null = null;

  private comboMap = new Map<string, CommandId>();
  private commandHandlers: Record<CommandId, () => boolean | void> = {} as any;
  /** Toolbar action buttons by command id, for the contextual show/hide. */
  private actionBtns: Partial<Record<CommandId, HTMLButtonElement>> = {};
  /** Cloud-delete toolbar button (Remote tab, Cloud selection only). */
  private delBtn = el("button", "tbtn");
  private delArmTimer = 0;
  /** The find-in-all-buffers overlay while it's open (see findall.ts). */
  private findAllEl: HTMLElement | null = null;
  /** Last known side of the NARROW_PX breakpoint, so resize only re-lays-out
      the chrome when the window actually crosses it. */
  private wasNarrow = isNarrow();

  async init(): Promise<void> {
    // The web build is served by the very server it talks to, so ask that server
    // who we are before anything renders. An unauthenticated boot goes to the
    // login page — nothing is built yet, so nothing is lost. Being merely
    // OFFLINE must not redirect: the session is sitting in IndexedDB and the app
    // works fine without a network.
    let webUser = "";
    if (isWeb) {
      const { whoami } = await import("./web");
      const who = await whoami();
      if (who.status === "unauth") {
        location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
        return;
      }
      if (who.status === "ok") webUser = who.user;
      requestPersistence();
    }

    const [saved, session] = await Promise.all([
      invoke<any>("load_state").catch(() => null),
      invoke<any>("load_buffers").catch(() => null),
    ]);
    this.restoreSettings(saved);
    // A cold start that restored nothing must not publish an empty session over
    // this client's good server-side state (see noteRestoredSession).
    noteRestoredSession(!!session?.buffers?.length);
    if (isWeb) {
      // Pinned, not settable: the server is whoever served this page. A stale
      // saved URL — or a settings blob carried over from a desktop — must never
      // point this tab somewhere else.
      state.settings.remoteUrl = location.origin;
      if (webUser) state.settings.remoteUser = webUser;
    }
    state.keybindings = mergeKeybindings(saved?.keybindings);

    // First run (or a cleared setting): name this machine after its hostname,
    // pre-sanitized by the backend to the server's host charset. In the browser
    // there is no hostname to take, so web.ts mints a stable per-browser name.
    if (!state.settings.remoteHost) {
      try {
        const h = await invoke<string>("machine_hostname");
        if (h) {
          state.settings.remoteHost = h;
          persist();
        }
      } catch {}
    }

    // Mirror "Developer mode" into the backend: the Windows context-menu
    // filter keeps its Inspect item only while this is on (ctxmenu.rs).
    void invoke("set_devmode", { enabled: state.settings.devTools }).catch(() => {});

    applyTheme(state.settings.theme);
    this.buildShell();
    this.applyFont();

    this.editor = new Editor(this.editorHost, {
      titlesChanged: () => this.syncTitles(),
      statusChanged: () => this.syncStatus(),
      // Every real session write also queues a (longer-debounced) remote push.
      sessionFlushed: (s) => schedulePush(s),
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
        // In the Remote tab, find searches the (read-only) preview.
        if (this.activeSys === "remote") {
          this.remoteView?.page.openFind();
          return;
        }
        this.showBuffers();
        this.editor.openFind();
      },
      replace: () => {
        // Same panel: under readOnly CM hides its replace row anyway.
        if (this.activeSys === "remote") {
          this.remoteView?.page.openFind();
          return;
        }
        this.showBuffers();
        this.editor.openFind();
      },
      findInBuffers: () => this.openFindAll(),
      // The editing commands CodeMirror used to own outright. Each returns CM's
      // own verdict, so a key that doesn't apply (outdent at column 0) falls
      // through instead of being swallowed.
      gotoLine: () => this.runEditor("gotoLine"),
      toggleComment: () => this.runEditor("toggleComment"),
      deleteLine: () => this.runEditor("deleteLine"),
      moveLineUp: () => this.runEditor("moveLineUp"),
      moveLineDown: () => this.runEditor("moveLineDown"),
      duplicateLineUp: () => this.runEditor("duplicateLineUp"),
      duplicateLineDown: () => this.runEditor("duplicateLineDown"),
      indentMore: () => this.runEditor("indentMore"),
      indentLess: () => this.runEditor("indentLess"),
      toggleWrap: () => this.toggleWrap(),
      keyboardMap: () => {
        if (isTouch) return; // nothing to map
        toggleKeyboardMap();
      },
      zoomIn: () => this.zoomStep(1),
      zoomOut: () => this.zoomStep(-1),
      zoomReset: () => this.setZoom(state.settings.fontSize, true),
      devtools: () => {
        if (state.settings.devTools) void invoke("toggle_devtools").catch(() => {});
      },
      openRemote: () => this.openSys("remote"),
      pushCloud: () => void this.pushToCloud(),
      pushNow: () => {
        // A deliberate action deserves feedback either way (unlike the silent
        // automatic pushes) — forcePush resolves to "" on success.
        this.editor.flush();
        void forcePush(this.editor.session()).then((err) =>
          toast(err ? `Push failed: ${err}` : "Pushed")
        );
      },
    };
    this.rebuildComboMap();
    initKeyboard({
      lookup: () => this.comboMap,
      run: (id) => this.commandHandlers[id]?.(),
    });

    // Native menu items route through the same handlers as the shortcuts.
    onEvent<string>("menu", (id) => this.commandHandlers[id as CommandId]?.());

    // A file path handed to us at launch (Delight's F4 → "edit in Buffers"), or by
    // a second launch while already running (single-instance → "open-file" event).
    onEvent<string>("open-file", (path) => void this.openFile(path));
    if (isTauri) {
      void invoke<string | null>("take_open_file")
        .then((p) => {
          if (typeof p === "string" && p) void this.openFile(p);
        })
        .catch(() => {});
    }

    // Drop files onto the window → import each into a new buffer (like ⌘O).
    this.setupFileDrop();

    // Last-resort flush when the window goes away.
    window.addEventListener("pagehide", () => this.editor.flush());
    // Remote's immediate-push triggers (blur/hidden/pagehide) — registered
    // AFTER the editor's flush listeners so each flush queues the fresh
    // payload before the push fires (same-event listeners run in order).
    initRemote();
    requestAnimationFrame(() => this.fitTabTitles());

    // The window starts hidden (visible: false) so the webview's white default
    // background never shows. Everything is built and restored by now; wait two
    // rAFs — the first schedules alongside the pending layout, the second fires
    // after that frame has actually been composited — then reveal.
    if (isTauri) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => void invoke("show_main_window").catch(() => {}))
      );
    }

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
      // activeLine was missing from this allowlist, which is exactly the failure
      // the gotcha below describes: the toggle worked, and forgot itself on quit.
      if (typeof s.activeLine === "boolean") state.settings.activeLine = s.activeLine;
      if (typeof s.indentSize === "number")
        state.settings.indentSize = clamp(Math.round(s.indentSize), INDENT_MIN, INDENT_MAX);
      if (typeof s.indentTabs === "boolean") state.settings.indentTabs = s.indentTabs;
      if (typeof s.searchAllBuffers === "boolean")
        state.settings.searchAllBuffers = s.searchAllBuffers;
      if (typeof s.lowercaseTabs === "boolean") state.settings.lowercaseTabs = s.lowercaseTabs;
      if (s.tabsSide === "left" || s.tabsSide === "top") state.settings.tabsSide = s.tabsSide;
      if (typeof s.sidebarWidth === "number")
        state.settings.sidebarWidth = clamp(s.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX);
      if (isLangId(s.defaultLanguage)) state.settings.defaultLanguage = s.defaultLanguage;
      if (typeof s.devTools === "boolean") state.settings.devTools = s.devTools;
      // Remote (GOTCHA: this allowlist is why new settings must be added here —
      // anything missing silently fails to persist across restarts).
      if (typeof s.remoteUrl === "string") state.settings.remoteUrl = normalizeRemoteUrl(s.remoteUrl);
      if (typeof s.remoteUser === "string" && s.remoteUser.trim())
        state.settings.remoteUser = s.remoteUser.trim();
      if (typeof s.remoteHost === "string" && HOST_RE.test(s.remoteHost))
        state.settings.remoteHost = s.remoteHost;
      if (typeof s.remoteToken === "string") state.settings.remoteToken = s.remoteToken;
      if (typeof s.remotePush === "boolean") state.settings.remotePush = s.remotePush;
    }
    state.zoomSize =
      typeof saved?.zoomSize === "number"
        ? clamp(saved.zoomSize, FONT_MIN, FONT_MAX)
        : state.settings.fontSize;
  }

  // ---- shell -----------------------------------------------------------------

  private buildShell(): void {
    const root = document.getElementById("app")!;
    // .native = running in Tauri (not the browser mock); .mac gates the macOS-only
    // integrated-titlebar insets (traffic lights). Windows/Linux keep normal chrome.
    if (isTauri) document.documentElement.classList.add("native");
    // .web = served by the Buffers server; .touch = no mouse, no keyboard.
    if (isWeb) document.documentElement.classList.add("web");
    if (isTouch) document.documentElement.classList.add("touch");
    if (isMac) document.documentElement.classList.add("mac");

    this.newBtn.innerHTML = icons.plus;
    this.newBtn.title = "New buffer" + hint("newTab");
    this.newBtn.addEventListener("click", () => this.commandHandlers.newTab());

    // Every action here is also a shortcut and lives in the same command registry —
    // the toolbar just makes the important ones visible (there's no native menu).
    // Refs are kept so syncActions() can hide the buffer-only ones while the
    // Remote tab is showing (only Find applies to a read-only remote buffer).
    const action = (id: CommandId, icon: string, label: string) => {
      const b = el("button", "tbtn");
      b.innerHTML = icon;
      b.title = label + hint(id);
      b.addEventListener("click", () => this.commandHandlers[id]());
      this.actionBtns[id] = b;
      return b;
    };
    // Cloud delete for the Remote tab's selected buffer. Not a command — it's
    // contextual (visible only for a Cloud selection), and destructive, so it
    // uses the same two-click arm/confirm idiom as the row ×.
    this.delBtn.innerHTML = icons.trash;
    this.delBtn.title = "Delete this buffer from Cloud";
    this.delBtn.hidden = true;
    this.delBtn.addEventListener("click", () => {
      if (!this.delBtn.classList.contains("armed")) {
        this.delBtn.classList.add("armed");
        this.delBtn.title = "Click again to permanently delete from Cloud";
        clearTimeout(this.delArmTimer);
        this.delArmTimer = window.setTimeout(() => this.disarmDelete(), 4000);
        return;
      }
      this.disarmDelete();
      void this.remoteView?.page.deleteSelected();
    });
    this.actionsEl.append(
      action("importFile", icons.importFile, "Import file"),
      action("exportFile", icons.exportFile, "Save buffer to a file"),
      action("pushCloud", icons.cloudUp, "Push buffer to Cloud"),
      action("closeTab", icons.closeBuffer, "Close buffer"),
      action("find", icons.search, "Find"),
      action("replace", icons.replace, "Find & replace"),
      this.delBtn
    );

    this.themeBtn.addEventListener("click", () => this.toggleTheme());

    this.kbBtn.innerHTML = icons.keyboard;
    this.kbBtn.title = "Keyboard map" + hint("keyboardMap");
    // No keyboard, no keyboard map. (The key handler stays installed, so a
    // paired hardware keyboard still works — there is just no UI promising
    // keys the device doesn't have.)
    this.kbBtn.hidden = isTouch;
    this.kbBtn.addEventListener("click", () => toggleKeyboardMap());
    onThemeChange(() => this.syncThemeBtn());

    this.cloudBtn.innerHTML = icons.cloud;
    this.cloudBtn.title = "Remote buffers" + hint("openRemote");
    this.cloudBtn.addEventListener("click", () => this.openSys("remote"));

    this.devBtn.innerHTML = icons.code;
    this.devBtn.title = "Developer tools" + hint("devtools");
    this.devBtn.addEventListener("click", () => void invoke("toggle_devtools").catch(() => {}));

    this.gearBtn.innerHTML = icons.gear;
    this.gearBtn.title = "Settings" + hint("openSettings");
    this.gearBtn.addEventListener("click", () => this.openSys("settings"));

    this.sidebarResize.addEventListener("mousedown", (e) => this.beginSidebarResize(e));

    // Editor view: the CodeMirror host + a status bar underneath.
    const statusBar = el("div", "statusbar");
    this.langBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleLangPop();
    });
    // Name pin toggle: freeze the name (or let it follow the first line again).
    this.pinBtn.innerHTML = icons.pin;
    this.pinBtn.addEventListener("click", () => {
      if (this.editor.meta().pinned) this.editor.unpinName();
      else this.editor.pinName();
      this.syncStatus();
      this.renderTabstrip();
    });
    // Linked-file indicator: <link icon><file name><unlink ✕>. Hidden when unlinked.
    const linkIcon = el("span", "filelink-icon");
    linkIcon.innerHTML = icons.link;
    const unlinkBtn = el("button", "filelink-unlink");
    unlinkBtn.innerHTML = icons.close;
    unlinkBtn.title = "Unlink file — the next save will ask where";
    unlinkBtn.addEventListener("click", () => {
      this.editor.unlink();
      this.syncStatus();
    });
    this.fileEl.append(linkIcon, el("span", "filelink-path"), unlinkBtn);
    statusBar.append(this.statusLeft, this.fileEl, this.pinBtn, this.langBtn);
    this.editorWrap.append(this.editorHost, statusBar);
    this.editorWrap.classList.add("active");
    this.contentEl.append(this.editorWrap);

    root.append(this.tabbar, this.sidebar, this.contentEl, this.mobilebar);
    this.applyTabsLayout();
    this.syncThemeBtn();
    this.syncDevBtn();
    this.trackViewport();
    new ResizeObserver(() => this.fitTabTitles()).observe(this.tabbar);
    window.addEventListener("resize", () => {
      // Crossing the narrow breakpoint re-parents the chrome (JS, not CSS: the
      // pieces move between containers), so only re-lay-out when it actually
      // changes — a rotation or an on-screen keyboard fires resize constantly.
      const narrow = isNarrow();
      if (narrow !== this.wasNarrow) {
        this.wasNarrow = narrow;
        this.applyTabsLayout();
      }
      this.fitTabTitles();
    });
  }

  /** Height of what the user can actually see. On a phone `100vh` includes the
      area behind the on-screen keyboard and the browser's collapsing toolbars,
      so the cursor ends up under the keyboard; visualViewport is the only thing
      that knows better. Falls back to 100dvh in CSS when unsupported. */
  private trackViewport(): void {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () =>
      document.documentElement.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    apply();
  }

  /** Place the shared tab pieces into the top bar, the left sidebar, or (narrow
      screens) a top strip plus a bottom bar. Called at startup, when the
      tabsSide setting changes, and when the window crosses NARROW_PX.

      Every layout re-parents the SAME elements, so there is exactly one + button
      and one action toolbar in the app, with one set of handlers. */
  applyTabsLayout(): void {
    const narrow = isNarrow();
    // A left sidebar would eat half a phone screen. Narrow forces top tabs
    // without touching the setting, so widening the window restores it.
    const left = state.settings.tabsSide === "left" && !narrow;
    const app = document.getElementById("app")!;
    app.classList.toggle("tabs-left", left);
    app.classList.toggle("narrow", narrow);
    this.mobilebar.hidden = !narrow;
    if (narrow) {
      // Top: the tabs alone, scrolling sideways. Bottom: everything you tap.
      this.tabbar.removeAttribute("data-tauri-drag-region");
      this.tabbar.replaceChildren(this.tabsEl, this.sysTabsEl);
      this.editorTopbar.remove();
      this.sidebar.replaceChildren();
      this.sidebar.style.width = "";
      const spacer = el("div", "flexspace");
      this.mobilebar.replaceChildren(
        this.newBtn,
        this.actionsEl,
        spacer,
        this.cloudBtn,
        this.themeBtn,
        this.gearBtn
      );
    } else if (left) {
      this.mobilebar.replaceChildren();
      // Sidebar head: empty on purpose — it's the window-drag strip, and on macOS
      // the inset that keeps the traffic lights clear of the buffer list. The
      // action toolbar lives above the editor (below); + sits under the list.
      const head = el("div", "sidebar-head");
      head.setAttribute("data-tauri-drag-region", "");
      // + directly under the last buffer, centered across the sidebar.
      const newRow = el("div", "sidebar-new");
      newRow.append(this.newBtn);
      // The list sizes to its content here, so the spacer (not the list) takes up
      // the slack and keeps the system tabs and controls pinned to the bottom.
      const spacer = el("div", "sidebar-space");
      spacer.setAttribute("data-tauri-drag-region", "");
      const controls = el("div", "sidebar-controls");
      controls.append(this.themeBtn, this.kbBtn, this.cloudBtn, this.devBtn, this.gearBtn);
      this.sidebar.replaceChildren(
        head,
        this.tabsEl,
        newRow,
        spacer,
        this.sysTabsEl,
        controls,
        this.sidebarResize
      );
      this.sidebar.style.width = `${state.settings.sidebarWidth}px`;
      this.tabbar.replaceChildren();
      // Strip above the editor: actions on the left, the rest is empty drag space
      // to move the window (this layout has no top tab bar to grab).
      this.editorTopbar.setAttribute("data-tauri-drag-region", "");
      this.editorTopbar.replaceChildren(this.actionsEl);
      if (this.editorTopbar.parentElement !== this.contentEl)
        this.contentEl.prepend(this.editorTopbar);
    } else {
      // Top bar: tabs, +, then the actions — set off from + by a wider gap so they
      // read as a toolbar rather than more tab chrome. The spacer keeps them left.
      this.mobilebar.replaceChildren();
      const spacer = el("div", "flexspace");
      spacer.setAttribute("data-tauri-drag-region", "");
      this.tabbar.setAttribute("data-tauri-drag-region", "");
      // replaceChildren, not append: the narrow layout leaves its own children
      // here, and coming back from it must not stack a second set.
      this.tabbar.replaceChildren(
        this.tabsEl,
        this.newBtn,
        this.actionsEl,
        spacer,
        this.sysTabsEl,
        this.themeBtn,
        this.kbBtn,
        this.cloudBtn,
        this.devBtn,
        this.gearBtn
      );
      this.editorTopbar.remove();
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
      close.title = "Close buffer" + hint("closeTab");
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
    for (const kind of ["settings", "keybindings", "remote"] as SysTab[]) {
      const view = this.sysView(kind);
      if (!view) continue;
      const t = el("div", "tab" + (this.activeSys === kind ? " active" : ""));
      const title = el("span", "tabtitle");
      title.textContent = SYS_TITLES[kind];
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
    if (this.remoteView) kinds.push("remote");
    sysEls.forEach((e, i) => e.classList.toggle("active", this.activeSys === kinds[i]));
  }

  activateBuffer(id: number): void {
    this.activeSys = null;
    this.editor.activate(id);
    this.showView();
    this.syncActiveTabClass();
    this.syncStatus(); // reflect this buffer's name-pin + linked file
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
    this.remoteView?.el.classList.toggle("active", this.activeSys === "remote");
    this.syncActions();
  }

  /** Fit the action toolbar to what's showing. In the Remote tab the buffer
      actions (import/export/push/close/replace) make no sense on a read-only
      remote buffer and hide; Find stays (it searches the preview), and a Cloud
      Delete appears only while the selection is a Cloud buffer. */
  private syncActions(): void {
    const remote = this.activeSys === "remote";
    for (const [id, b] of Object.entries(this.actionBtns)) {
      if (b) b.hidden = remote && id !== "find";
    }
    const sel = remote ? this.remoteView?.page.selection() ?? null : null;
    this.delBtn.hidden = !sel?.cloud;
    if (this.delBtn.hidden) this.disarmDelete();
  }

  private disarmDelete(): void {
    clearTimeout(this.delArmTimer);
    this.delBtn.classList.remove("armed");
    this.delBtn.title = "Delete this buffer from Cloud";
  }

  // ---- system tabs (Settings / Shortcuts / Remote) ------------------------------

  private sysView(kind: SysTab) {
    if (kind === "settings") return this.settingsView;
    if (kind === "keybindings") return this.kbView;
    return this.remoteView;
  }

  openSys(kind: SysTab): void {
    // Rebinding keys on a device with no keys is not a tab worth having; the
    // Settings row that opens it is hidden there too.
    if (kind === "keybindings" && isTouch) return;
    if (kind === "settings" && !this.settingsView) this.settingsView = this.buildSettings();
    if (kind === "keybindings" && !this.kbView) this.kbView = this.buildKeybindings();
    if (kind === "remote" && !this.remoteView) this.remoteView = this.buildRemote();
    this.activeSys = kind;
    this.sysView(kind)?.page.sync();
    this.showView();
    this.renderTabstrip();
  }

  closeSys(kind: SysTab): void {
    this.sysView(kind)?.el.remove();
    if (kind === "settings") this.settingsView = null;
    else if (kind === "keybindings") this.kbView = null;
    else this.remoteView = null;
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
      onIndentSize: (n) => {
        state.settings.indentSize = n;
        this.editor.applyIndent();
        persist();
      },
      onIndentTabs: (v) => {
        state.settings.indentTabs = v;
        this.editor.applyIndent();
        persist();
      },
      onSearchAllBuffers: (v) => {
        state.settings.searchAllBuffers = v;
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
        void invoke("set_devmode", { enabled: v }).catch(() => {});
        if (!v) void invoke("close_devtools").catch(() => {});
        persist();
      },
      onOpenKeybindings: () => this.openSys("keybindings"),
      onRemoteUrl: (v) => {
        state.settings.remoteUrl = normalizeRemoteUrl(v);
        persist();
      },
      onRemoteUser: (v) => {
        const t = v.trim();
        if (t) state.settings.remoteUser = t;
        persist();
      },
      onRemoteHost: (v) => {
        const t = v.trim();
        // Empty is allowed (disables pushing); anything else must fit the
        // server's charset — it becomes a path component there.
        if (t && !HOST_RE.test(t)) {
          toast("Host may only use letters, digits, . _ -");
          return;
        }
        state.settings.remoteHost = t;
        persist();
      },
      onRemoteToken: (v) => {
        state.settings.remoteToken = v.trim();
        persist();
      },
      onRemotePush: (v) => {
        state.settings.remotePush = v;
        persist();
      },
      remoteTest: async () => {
        if (!state.settings.remoteUrl) return "Set a server URL first";
        try {
          const d = await fetchRemote();
          const n = d.hosts?.length ?? 0;
          return `OK — ${n} host${n === 1 ? "" : "s"}`;
        } catch (e) {
          return String(e);
        }
      },
      remoteStatus: () => remoteStatus,
      caps: {
        fixedRemote: isWeb,
        keyboard: !isTouch,
        devTools: isTauri,
        signOut: isWeb
          ? () => {
              // Flush first: the redirect tears the page down, and the session
              // write is asynchronous.
              this.editor.flush();
              void fetch("/logout", { method: "POST" }).finally(() =>
                location.replace("/login")
              );
            }
          : undefined,
      },
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

  private buildRemote() {
    const wrap = el("div", "tabview");
    const page = buildRemotePage({
      configured: () => remoteConfigured(),
      fetch: () => fetchRemote(),
      loadCache: () => loadRemoteCache(),
      saveCache: (d) => void saveRemoteCache(d),
      openLocal: (buf, host) => {
        // A normal, editable, UNLINKED buffer — it will push under THIS
        // machine's hostname like any other. The remote one is untouched.
        this.editor.newBuffer(buf.text, isLangId(buf.language) ? buf.language : "plain", {
          bufferName: `${buf.name} (${host})`,
          namePinned: true,
        });
        this.showBuffers();
        this.renderTabstrip();
        this.syncStatus();
      },
      openSettings: () => this.openSys("settings"),
      deleteCloud: (name) => cloudDelete(name),
      deleteHost: (host) => hostDelete(host),
      status: () => remoteStatus,
      selectionChanged: () => this.syncActions(),
    });
    wrap.append(page.el);
    this.contentEl.append(wrap);
    return { el: wrap, page };
  }

  /** ⌘⇧C / toolbar: put the ACTIVE buffer in the Cloud store under its current
      display name. Same name overwrites; nothing else on the server is touched.
      User-initiated, so both outcomes are toasted (the background machine push
      stays silent by contrast). */
  private async pushToCloud(): Promise<void> {
    if (!cloudConfigured()) {
      toast("No server configured — see Settings");
      return;
    }
    const id = this.editor.active();
    // The resolved title, NOT this.title(): lowercaseTabs is a display
    // preference and must not rename what lands on the server.
    const name = this.editor.title(id);
    try {
      const replaced = await cloudPush({
        name,
        language: this.editor.language(id),
        text: this.editor.activeText(),
      });
      toast(replaced ? `Replaced on Cloud: ${name}` : `Pushed to Cloud: ${name}`);
    } catch (e) {
      toast(`Cloud push failed: ${e}`);
    }
  }

  /** Run one of the CodeMirror editing commands the registry owns. Returning
      false on a system tab leaves the key to the browser — these all act on
      buffer text, and Settings has none. */
  private runEditor(id: EditorCommandId): boolean {
    if (this.activeSys !== null) return false;
    return this.editor.run(id);
  }

  // ---- find in all buffers (⌘⇧F) ---------------------------------------------

  private openFindAll(): void {
    if (!state.settings.searchAllBuffers) {
      toast("Searching all buffers is off — turn it on in Settings");
      return;
    }
    if (this.findAllEl) return;
    const picker = buildFindAll({
      buffers: this.editor.all(),
      initial: this.editor.selectedText(),
      onPick: (id, from, to) => {
        this.closeFindAll();
        this.showBuffers();
        this.editor.reveal(id, from, to);
        this.syncActiveTabClass();
        this.syncStatus();
      },
      onClose: () => {
        this.closeFindAll();
        this.editor.view.focus();
      },
    });
    document.body.append(picker.el);
    this.findAllEl = picker.el;
    picker.focus();
  }

  private closeFindAll(): void {
    this.findAllEl?.remove();
    this.findAllEl = null;
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
    const parts = [
      `Ln ${s.line}, Col ${s.col}`,
      `${s.words.toLocaleString()} word${s.words === 1 ? "" : "s"}`,
      `${s.chars.toLocaleString()} chars`,
    ];
    if (s.selected > 0) parts.push(`${s.selected.toLocaleString()} selected`);
    this.statusLeft.textContent = parts.join("  ·  ");
    this.langBtn.textContent = LANGS[this.editor.language()].label;

    // Name pin + linked file.
    const m = this.editor.meta();
    this.pinBtn.classList.toggle("on", m.pinned);
    this.pinBtn.title = (m.pinned ? "Name pinned — click to follow the first line" : "Pin the name") ;
    if (m.filePath) {
      const name = m.filePath.split(/[\\/]/).filter(Boolean).pop() || m.filePath;
      const label = this.fileEl.querySelector<HTMLElement>(".filelink-path");
      if (label) label.textContent = name;
      this.fileEl.title = m.filePath;
      this.fileEl.classList.remove("hidden");
    } else {
      this.fileEl.classList.add("hidden");
    }
  }

  private toggleLangPop(): void {
    if (this.langPop) {
      this.closeLangPop();
      return;
    }
    const picker = buildLangPicker({
      current: this.editor.language(),
      cls: "up", // the status bar sits at the bottom, so it opens upward
      onPick: (id) => {
        this.editor.setLanguage(id);
        this.closeLangPop();
        this.syncStatus();
        this.editor.view.focus();
      },
      onClose: () => {
        this.closeLangPop();
        this.editor.view.focus();
      },
    });
    this.langBtn.parentElement!.append(picker.el);
    this.langPop = picker.el;
    document.addEventListener("mousedown", this.onDocDown, true);
    picker.focus();
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
    // In a browser there is no path to hand the backend — the file arrives as
    // content, so it lands in an UNLINKED buffer. Saving it later downloads a
    // copy rather than writing back; browsers don't grant a page a path.
    if (isBrowser) {
      const input = el("input");
      input.type = "file";
      input.multiple = true;
      input.addEventListener("change", () => void this.openFiles([...(input.files ?? [])]));
      input.click();
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: false, title: "Import into a buffer" });
    if (typeof path !== "string") return;
    await this.openPaths([path]);
  }

  /** Read each path into its own new buffer — shared by ⌘O import and file drop. */
  /** Open one file (Delight's F4): switch to it if it's already open here,
      otherwise import it as a linked buffer. */
  private async openFile(path: string): Promise<void> {
    const existing = this.editor.idForPath(path);
    if (existing != null) {
      this.showBuffers();
      this.activateBuffer(existing);
      this.renderTabstrip();
      return;
    }
    await this.openPaths([path]);
  }

  private async openPaths(paths: string[]): Promise<void> {
    let opened = 0;
    for (const path of paths) {
      try {
        const text = await invoke<string>("read_file", { path });
        const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
        // Imported buffers are linked to their file, name pinned to the file name.
        this.editor.newBuffer(text, langForFilename(path), {
          bufferName: name,
          namePinned: true,
          filePath: path,
        });
        opened++;
      } catch (e) {
        toast(String(e));
      }
    }
    if (!opened) return;
    this.showBuffers();
    this.renderTabstrip();
    this.syncStatus();
    toast(opened === 1 ? "Imported" : `Imported ${opened} files`);
  }

  /** Import files dropped or picked in a browser: same result as ⌘O, but read
      through the File API, so the buffers are unlinked (there is no path). */
  private async openFiles(files: File[]): Promise<void> {
    let opened = 0;
    for (const file of files) {
      try {
        const text = await file.text();
        this.editor.newBuffer(text, langForFilename(file.name), {
          bufferName: file.name,
          namePinned: true,
        });
        opened++;
      } catch (e) {
        toast(String(e));
      }
    }
    if (!opened) return;
    this.showBuffers();
    this.renderTabstrip();
    this.syncStatus();
    toast(opened === 1 ? "Imported" : `Imported ${opened} files`);
  }

  /** File drop onto the window → import each file. Tauri hands us real paths
      (so those buffers stay linked); a browser hands us content. */
  private setupFileDrop(): void {
    if (isBrowser) {
      // Both handlers are required: without preventDefault on dragover the drop
      // never fires, and the browser navigates away to display the file instead.
      document.addEventListener("dragover", (e) => e.preventDefault());
      document.addEventListener("drop", (e) => {
        e.preventDefault();
        const files = [...(e.dataTransfer?.files ?? [])];
        if (files.length) void this.openFiles(files);
      });
      return;
    }
    void import("@tauri-apps/api/webview").then((m) =>
      m.getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths.length) {
          void this.openPaths(event.payload.paths);
        }
      })
    );
  }

  /** Save the active buffer in a browser: a download, every time. A page can't
      write back to the file it was given, so there is no linked-file path here
      and nothing to pin — the buffer stays exactly as it was. */
  private downloadActive(): void {
    const id = this.editor.active();
    const base =
      this.editor
        .title(id)
        .replace(/[/\\:*?"<>|]/g, "")
        .replace(/…$/, "")
        .trim()
        .slice(0, 40) || "untitled";
    const blob = new Blob([this.editor.activeText()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = `${base}.${extForLang(this.editor.language())}`;
    a.click();
    // Revoking immediately can beat the download on some browsers; a tick is
    // enough and the blob is small.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast("Downloaded");
  }

  private async exportFile(): Promise<void> {
    if (isBrowser) {
      this.downloadActive();
      return;
    }
    const id = this.editor.active();
    const linked = this.editor.meta(id).filePath;
    let path = linked;
    // No linked file yet → ask where to save.
    if (!path) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const lang = this.editor.language();
      const base =
        this.editor
          .title(id)
          .replace(/[/\\:*?"<>|]/g, "")
          .replace(/…$/, "")
          .trim()
          .slice(0, 40) || "untitled";
      const chosen = await save({ title: "Save buffer", defaultPath: `${base}.${extForLang(lang)}` });
      if (typeof chosen !== "string") return;
      path = chosen;
    }
    try {
      await invoke("write_file", { path, contents: this.editor.activeText() });
      // First save of an unlinked buffer: link it + pin the name to the file name.
      if (!linked) {
        const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
        this.editor.setFileInfo(id, name, path);
        this.renderTabstrip();
      }
      this.syncStatus();
      toast("Saved");
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
