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
import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { highlight } from "./editor-core";
import { isLangId, LANGS } from "./langs";
import { state } from "./state";
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
  /** Push health, shown in the toolbar (the only place besides Settings). */
  status(): { lastPushAt: number; lastError: string };
}

export interface RemotePage {
  el: HTMLElement;
  /** Re-fetch and re-render (called every time the tab is opened). */
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

/** A read-only editor state that renders exactly like the real editor: same
    highlight style, same language syntax, wrap following the user's setting. */
function previewState(buf: RemoteBuffer): EditorState {
  const lang = isLangId(buf.language) ? buf.language : "plain";
  const syntax = LANGS[lang].syntax();
  return EditorState.create({
    doc: buf.text,
    extensions: [
      lineNumbers(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      state.settings.wrapLines ? EditorView.lineWrapping : [],
      syntaxHighlighting(highlight),
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

  // One persistent read-only view; selecting a buffer swaps its state in.
  const view = new EditorView({ parent: edHost });

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
      row.addEventListener("click", () => {
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

  /** The × on a Cloud row. Deleting is destructive and can't be undone from the
      app, so the first click only arms it: the × becomes a "Delete?" the user
      must hit again. Anything else — a second thought, 4 s, another row — puts
      it back. (The app has no modal system; this stays in the row.) */
  const deleteControl = (name: string): HTMLElement => {
    const wrap = el("span", "remote-del");
    const x = el("span", "tabclose");
    x.innerHTML = icons.close;
    x.title = "Delete from Cloud";
    // A span, not a button: the row itself is a <button> and nesting one inside
    // another is invalid HTML. Same reason .tabclose is a span in main.ts.
    const confirm = el("span", "remote-delconfirm", "Delete?");
    confirm.title = "Permanently remove this buffer from the Cloud store";
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
        try {
          await hooks.deleteCloud(name);
          toast(`Deleted from Cloud: ${name}`);
        } catch (err) {
          toast(`Cloud delete failed: ${err}`);
        }
        // Refresh either way: on success to drop the row, on failure because the
        // server is the truth — a 404 (already gone) resolves as success above.
        await refresh();
      })();
    });
    return wrap;
  };

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
      if (isCloud) row.append(deleteControl(b.name));
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
  };
}
