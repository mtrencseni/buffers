// The Remote tab: a read-only window onto the other machines' buffers, fetched
// on demand from the Buffers server. Layout: host list → that host's buffer
// list → a read-only CodeMirror preview that looks identical to the editor.
//
// Exactly two actions on a remote buffer, per the philosophy: copy its text,
// or open it as a NEW local buffer. Nothing here ever writes back.
//
// The one exception is the Cloud host (kind === "cloud"): it's a curated store
// rather than a machine mirror, so its entries only ever leave when deleted by
// hand — hence the per-row ×, behind an inline confirm. Machine mirrors have no
// delete: they self-correct on the owning machine's next push.

import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search } from "@codemirror/search";
import {
  highlight,
  minimapExtension,
  overlayScrollbar,
  selectionWhitespace,
  sublimeSelection,
} from "./editor-core";
import { isLangId, LANGS } from "./langs";
import { isTouch } from "./platform";
import { minimapOn, state } from "./state";
import { icons } from "./icons";
import { toast } from "./toast";
import type { RemoteBuffer, RemoteData, RemoteHost } from "./remote";

export interface RemoteHooks {
  /** Whether a server URL is configured at all. */
  configured(): boolean;
  fetch(): Promise<RemoteData>;
  /** Last successful fetch from disk, shown until (or instead of) a live one. */
  loadCache(): Promise<{ fetchedAt: number; data: RemoteData } | null>;
  saveCache(data: RemoteData): void;
  /** Open a remote buffer as a new LOCAL buffer (name pinned to "name (host)"). */
  openLocal(buf: RemoteBuffer, host: string): void;
  openSettings(): void;
  /** Remove one Cloud buffer by name (Cloud hosts only). Resolves when gone. */
  deleteCloud(name: string): Promise<void>;
  /** Forget a whole machine host (never the Cloud). Resolves when gone. */
  deleteHost(host: string): Promise<void>;
  /** Push health, shown in the toolbar (the only place besides Settings). */
  status(): { lastPushAt: number; lastError: string };
  /** The selected host/buffer changed — the app syncs its toolbar (the Cloud
      Delete button only applies to a Cloud selection). */
  selectionChanged?(): void;
}

export interface RemotePage {
  el: HTMLElement;
  /** Re-fetch and re-render (called every time the tab is opened). */
  sync(): void;
  /** Open the find panel in the preview (the toolbar's Find routes here). */
  openFind(): void;
  /** The selected buffer, and whether it's a Cloud one (deletable from the
      toolbar). Null when nothing is selected. */
  selection(): { name: string; cloud: boolean } | null;
  /** Delete the selected Cloud buffer. The caller owns the confirm step. */
  deleteSelected(): Promise<void>;
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

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago" from unix seconds. */
function ago(unixSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API denied (some webviews outside a user gesture) — fall back.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("Copied");
}

/** A read-only editor state that renders — and handles — exactly like the real
    editor: same highlight style, syntax, selection layer, minimap and find. The
    readOnly facet blocks every edit, but the view stays interactive: a live
    cursor, keyboard/mouse selection, and native ⌘C copy. (No editable(false)
    with a mouse: that would kill the cursor. And the custom selection pieces are
    mandatory, not cosmetic — editor-core.css hides the NATIVE selection inside
    .edhost, so without drawSelection + sublimeSelection a selection would be
    invisible.)

    ON TOUCH that trade inverts. `editable` is what makes the content
    contentEditable, and tapping contentEditable is what raises the on-screen
    keyboard — half the screen, to type into text that cannot be typed into. So
    a touch device gets `editable(false)`, loses the CM cursor it had no use for,
    and selects with the platform's own long-press handles instead. The custom
    layers come off with it (they would paint a stale CM selection under the real
    one) and styles.css restores the native selection colour for this pane. */
function previewState(buf: RemoteBuffer): EditorState {
  const lang = isLangId(buf.language) ? buf.language : "plain";
  const syntax = LANGS[lang].syntax();
  return EditorState.create({
    doc: buf.text,
    extensions: [
      EditorState.readOnly.of(true),
      lineNumbers(),
      highlightSpecialChars(),
      isTouch
        ? [
            EditorView.editable.of(false),
            // The facet already resolves `contenteditable` to "false"; setting
            // it here as well is deliberate belt-and-braces, because a single
            // stray provider of the `editable` facet (it combines by taking the
            // FIRST value) would silently hand the keyboard back. A provider
            // overrides CM's computed attribute, so this is the last word.
            //
            // inputmode="none" is the part that mobile browsers read directly:
            // "focus this, but do not raise a keyboard for it". role/aria drop
            // the textbox semantics that go with it — this is text to read.
            EditorView.contentAttributes.of({
              contenteditable: "false",
              inputmode: "none",
              role: "document",
              "aria-multiline": "false",
            }),
          ]
        : [drawSelection(), sublimeSelection, selectionWhitespace],
      highlightSelectionMatches(),
      minimapOn() ? minimapExtension() : [],
      overlayScrollbar,
      state.settings.wrapLines ? EditorView.lineWrapping : [],
      syntaxHighlighting(highlight),
      // Find works here (the toolbar's Find routes in); readOnly makes CM's
      // panel hide its replace row, so there's nothing to hide ourselves.
      search({ top: true }),
      keymap.of([
        { key: "Escape", run: closeSearchPanel, scope: "editor search-panel" },
        ...defaultKeymap, // cursor movement; edits are no-ops under readOnly
      ]),
      syntax ?? [],
    ],
  });
}

export function buildRemotePage(hooks: RemoteHooks): RemotePage {
  const root = el("div", "remote");

  // Toolbar: refresh + fetch/push status.
  const bar = el("div", "remote-bar");
  const refreshBtn = el("button", "tbtn");
  refreshBtn.innerHTML = icons.cloud;
  refreshBtn.title = "Refresh";
  const barText = el("span", "remote-bartext");
  bar.append(refreshBtn, barText);

  const body = el("div", "remote-body");
  const hostsEl = el("div", "remote-hosts");
  const bufsEl = el("div", "remote-buffers");
  const previewWrap = el("div", "remote-preview");
  const previewHead = el("div", "remote-previewhead");
  const previewTitle = el("span", "remote-previewtitle");
  const copyBtn = el("button", "remote-act");
  copyBtn.innerHTML = `${icons.copy}<span>Copy</span>`;
  copyBtn.title = "Copy the buffer's text";
  const openBtn = el("button", "remote-act");
  openBtn.innerHTML = `${icons.importFile}<span>Open as buffer</span>`;
  openBtn.title = "Copy into a new local buffer (the remote one is untouched)";
  previewHead.append(previewTitle, copyBtn, openBtn);
  const edHost = el("div", "edhost remote-edhost");
  previewWrap.append(previewHead, edHost);
  body.append(hostsEl, bufsEl, previewWrap);
  root.append(bar, body);

  // One persistent read-only view; selecting a buffer swaps its state in. It is
  // seeded with an empty previewState rather than constructed bare: a bare
  // EditorView has no extensions, so it comes up EDITABLE (the facet's default)
  // and stays that way until the first setState — a live contentEditable in the
  // DOM, on a touch device, before anything has been selected.
  const view = new EditorView({
    parent: edHost,
    state: previewState({ name: "", language: "plain", text: "" }),
  });

  // Right-click: the NATIVE context menu on a contenteditable offers Cut /
  // Paste / spellcheck — edit commands that can't apply to a read-only buffer
  // and would just no-op confusingly. The webview can't drop items from its
  // native menu, but it honors preventDefault — so replace it with a small
  // menu of exactly what works here: Copy (of the selection) and Select all.
  //
  // None of that reasoning holds on touch. A long press there is the OS's own
  // select-and-copy gesture, and it fires `contextmenu` on the way — so this
  // menu appeared *alongside* the platform's selection bar, two menus for one
  // press, ours pointing at a CM selection the finger never made. The platform's
  // is the better menu here anyway (it grew the handles), so leave it alone.
  let ctxMenu: HTMLElement | null = null;
  const closeCtxMenu = () => {
    ctxMenu?.remove();
    ctxMenu = null;
    document.removeEventListener("mousedown", onCtxAway, true);
    window.removeEventListener("keydown", onCtxKey, true);
    window.removeEventListener("blur", closeCtxMenu);
  };
  const onCtxAway = (e: MouseEvent) => {
    if (ctxMenu && !ctxMenu.contains(e.target as Node)) closeCtxMenu();
  };
  const onCtxKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeCtxMenu();
    }
  };
  if (!isTouch) edHost.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    closeCtxMenu();
    const menu = el("div", "droplist ctxmenu");
    const item = (label: string, run: () => void, enabled = true) => {
      const b = el("button", "dropitem" + (enabled ? "" : " disabled"));
      b.textContent = label;
      if (enabled)
        b.addEventListener("click", () => {
          closeCtxMenu();
          run();
        });
      menu.append(b);
    };
    const sel = view.state.selection.main;
    item("Copy", () => void copyText(view.state.sliceDoc(sel.from, sel.to)), sel.from !== sel.to);
    item("Select all", () => {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.focus();
    });
    document.body.append(menu);
    // At the pointer, nudged back inside the viewport if it would overflow.
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - r.height - 8)}px`;
    ctxMenu = menu;
    document.addEventListener("mousedown", onCtxAway, true);
    window.addEventListener("keydown", onCtxKey, true);
    window.addEventListener("blur", closeCtxMenu);
  });

  let data: RemoteData | null = null;
  /** Date.now() when `data` came off the server (0 = never). */
  let fetchedAt = 0;
  /** True when what's on screen predates this refresh — from the disk cache, or
      a live fetch that has since failed. Drives the "cached, N ago" marker. */
  let stale = false;
  let selHost = ""; // selected host's name (survives refreshes)
  let selBuf = 0;
  let loading = false;

  const currentHost = (): RemoteHost | null =>
    data?.hosts.find((h) => h.host === selHost) ?? null;
  const currentBuf = (): RemoteBuffer | null => currentHost()?.buffers[selBuf] ?? null;

  const syncBar = (msg?: string) => {
    const st = hooks.status();
    const parts: string[] = [];
    if (msg) parts.push(msg);
    if (stale && fetchedAt) parts.push(`cached, ${ago(fetchedAt / 1000)}`);
    if (st.lastPushAt) parts.push(`pushed ${ago(st.lastPushAt / 1000)}`);
    if (st.lastError) parts.push(`⚠ ${st.lastError}`);
    barText.textContent = parts.join("  ·  ");
    barText.classList.toggle("err", !!st.lastError);
  };

  const renderHosts = () => {
    const frag = document.createDocumentFragment();
    for (const h of data?.hosts ?? []) {
      const row = el("button", "remote-row" + (h.host === selHost ? " on" : ""));
      const name = el("div", "remote-rowname", h.host);
      const sub = el(
        "div",
        "remote-rowsub",
        `${h.buffers.length} buffer${h.buffers.length === 1 ? "" : "s"} · ${ago(h.received_at)}`
      );
      row.append(name, sub);
      // Machine mirrors can be forgotten wholesale; the Cloud row never can
      // (gate on kind, never the name — same rule as the per-buffer delete).
      if (h.kind !== "cloud") row.append(hostDeleteControl(h));
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".remote-del")) return; // the × owns its clicks
        selHost = h.host;
        selBuf = 0;
        renderHosts();
        renderBuffers();
      });
      frag.append(row);
    }
    if (!frag.childNodes.length) frag.append(el("div", "remote-empty", "No hosts yet"));
    hostsEl.replaceChildren(frag);
  };

  /** A × delete control (Cloud buffers, machine hosts). Deleting is destructive
      and can't be undone from the app, so the first click only arms it: the ×
      becomes a confirm label the user must hit again. Anything else — a second
      thought, 4 s, another row — puts it back. (The app has no modal system;
      this stays in the row.) `run` owns its own success/failure toasts; the
      control refreshes afterwards either way, because the server is the truth. */
  const deleteControl = (opts: {
    /** Tooltip on the ×. */
    title: string;
    /** The armed label ("Delete?" / "Delete all N from host?"). */
    confirmLabel: string;
    /** Tooltip on the armed label — state exactly what will happen. */
    confirmTitle: string;
    run: () => Promise<void>;
  }): HTMLElement => {
    const wrap = el("span", "remote-del");
    const x = el("span", "tabclose");
    x.innerHTML = icons.close;
    x.title = opts.title;
    // A span, not a button: the row itself is a <button> and nesting one inside
    // another is invalid HTML. Same reason .tabclose is a span in main.ts.
    const confirm = el("span", "remote-delconfirm", opts.confirmLabel);
    confirm.title = opts.confirmTitle;
    wrap.append(x, confirm);
    let armTimer = 0;
    const disarm = () => {
      window.clearTimeout(armTimer);
      wrap.classList.remove("armed");
    };
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      wrap.classList.add("armed");
      window.clearTimeout(armTimer);
      armTimer = window.setTimeout(disarm, 4000);
    });
    confirm.addEventListener("click", (e) => {
      e.stopPropagation();
      disarm();
      void (async () => {
        await opts.run();
        await refresh();
      })();
    });
    return wrap;
  };

  /** The Cloud row's per-buffer ×. */
  const cloudDeleteControl = (name: string): HTMLElement =>
    deleteControl({
      title: "Delete from Cloud",
      confirmLabel: "Delete?",
      confirmTitle: "Permanently remove this buffer from the Cloud store",
      run: async () => {
        try {
          await hooks.deleteCloud(name);
          toast(`Deleted from Cloud: ${name}`);
        } catch (err) {
          toast(`Cloud delete failed: ${err}`);
        }
      },
    });

  /** The × on a machine-host row: forget the whole machine. Heavier than the
      per-buffer delete — the label names the host and counts what goes. Only
      for machine mirrors (kind !== "cloud"); the Cloud row never gets one. */
  const hostDeleteControl = (h: RemoteHost): HTMLElement =>
    deleteControl({
      title: `Forget ${h.host} (all its buffers and history)`,
      confirmLabel: `Delete all ${h.buffers.length} from ${h.host}?`,
      confirmTitle:
        `Remove ${h.host} from the server: all ${h.buffers.length} buffer${
          h.buffers.length === 1 ? "" : "s"
        } and its history. ` +
        "Meant for retired machines — one that is still running re-appears on its next push.",
      run: async () => {
        try {
          await hooks.deleteHost(h.host);
          // The truth about live machines, at the moment it matters.
          toast(`Forgot ${h.host} — a live machine returns on its next push`);
        } catch (err) {
          toast(`Couldn't delete ${h.host}: ${err}`);
        }
      },
    });

  const renderBuffers = () => {
    const host = currentHost();
    const isCloud = host?.kind === "cloud"; // never match on the host's name
    const frag = document.createDocumentFragment();
    (host?.buffers ?? []).forEach((b, i) => {
      const row = el("button", "remote-row" + (i === selBuf ? " on" : ""));
      const name = el("div", "remote-rowname", b.name);
      const lang = isLangId(b.language) ? LANGS[b.language].label : b.language;
      const sub = el("div", "remote-rowsub", `${lang} · ${b.text.length.toLocaleString()} chars`);
      row.append(name, sub);
      if (isCloud) row.append(cloudDeleteControl(b.name));
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".remote-del")) return; // the × owns its clicks
        selBuf = i;
        renderBuffers();
      });
      frag.append(row);
    });
    if (!frag.childNodes.length)
      frag.append(el("div", "remote-empty", host ? "No buffers" : "Select a host"));
    bufsEl.replaceChildren(frag);
    renderPreview();
    // Every selection path funnels through here (host click, buffer click,
    // refresh) — one place to tell the app to re-sync its toolbar.
    hooks.selectionChanged?.();
  };

  const renderPreview = () => {
    const buf = currentBuf();
    previewWrap.classList.toggle("blank", !buf);
    previewTitle.textContent = buf ? buf.name : "";
    view.setState(previewState(buf ?? { name: "", language: "plain", text: "" }));
  };

  copyBtn.addEventListener("click", () => {
    const buf = currentBuf();
    if (buf) void copyText(buf.text);
  });
  openBtn.addEventListener("click", () => {
    const buf = currentBuf();
    const host = currentHost();
    if (buf && host) hooks.openLocal(buf, host.host);
  });

  const refresh = async () => {
    if (loading) return;
    if (!hooks.configured()) {
      const hint = el("div", "remote-empty remote-config");
      hint.append(el("div", "", "No server configured."));
      const link = el("button", "linkbtn", "Open Settings");
      link.addEventListener("click", () => hooks.openSettings());
      hint.append(link);
      hostsEl.replaceChildren(hint);
      bufsEl.replaceChildren();
      renderPreview();
      syncBar();
      return;
    }
    loading = true;
    // Put the cached snapshot up BEFORE the network call: offline, the fetch
    // below just fails and this is the only thing the user gets to see.
    if (!data) {
      const c = await hooks.loadCache();
      if (c) {
        data = c.data;
        fetchedAt = c.fetchedAt;
        stale = true;
        if (!currentHost()) {
          selHost = data.hosts[0]?.host ?? "";
          selBuf = 0;
        }
        renderHosts();
        renderBuffers();
      }
    }
    syncBar("loading…");
    try {
      data = await hooks.fetch();
      fetchedAt = Date.now();
      stale = false;
      hooks.saveCache(data);
      // Keep the selection if its host is still there; else take the newest.
      if (!currentHost()) {
        selHost = data.hosts[0]?.host ?? "";
        selBuf = 0;
      }
      selBuf = Math.min(selBuf, Math.max(0, (currentHost()?.buffers.length ?? 1) - 1));
      syncBar(`fetched just now · ${data.hosts.length} host${data.hosts.length === 1 ? "" : "s"}`);
    } catch (e) {
      // Whatever is on screen stays there; the failure lives in the toolbar.
      // Anything still showing is now demonstrably old, so mark it as cached —
      // a fetched-at age beats a host row's "5 min ago", which is the server's
      // last-received time and can look fresher than the data really is.
      if (data) stale = true;
      syncBar(String(e));
    }
    loading = false;
    renderHosts();
    renderBuffers();
  };

  refreshBtn.addEventListener("click", () => void refresh());

  return {
    el: root,
    sync: () => void refresh(),
    openFind: () => openSearchPanel(view),
    selection: () => {
      const host = currentHost();
      const buf = currentBuf();
      return host && buf ? { name: buf.name, cloud: host.kind === "cloud" } : null;
    },
    deleteSelected: async () => {
      const host = currentHost();
      const buf = currentBuf();
      if (!host || !buf || host.kind !== "cloud") return; // Cloud only, by kind
      try {
        await hooks.deleteCloud(buf.name);
        toast(`Deleted from Cloud: ${buf.name}`);
      } catch (err) {
        toast(`Cloud delete failed: ${err}`);
      }
      await refresh();
    },
  };
}
