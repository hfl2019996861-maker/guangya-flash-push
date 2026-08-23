// 光鸭闪推 - 页面磁力链接嗅探
// 识别页面中的磁力/ed2k/迅雷链接（a 标签与纯文本），在链接旁追加推送按钮，
// 并提供右下角“全部推送”面板。UI 全部使用 Shadow DOM 隔离，避免污染页面样式。

(() => {
  if (window.__gyFlashPushLoaded) return;
  if (!chrome?.runtime?.id) return; // 扩展上下文已失效（重载后未刷新的页面）
  window.__gyFlashPushLoaded = true;

  // xt 参数可能不在磁力链接首位（如 magnet:?dn=xx&xt=urn:btih:...），两步提取
  const MAGNET_URI_RE = /magnet:\?[^\s"'<>]+/i;
  const MAGNET_HASH_RE = /xt=urn:btih:([a-z0-9]+)/i;
  const ED2K_RE = /ed2k:\/\/\|file\|([^|]+)\|(\d+)\|([a-f0-9]{32})\|[^"\s<>]*/i;

  const state = {
    settings: null,
    found: new Map(), // key -> { url, label, type }
    scanTimer: 0,
    shadowScanAt: 0,
    observer: null,
    shadowRoots: new Set(),
  };

  // ---------- 设置 ----------

  const DEFAULTS = {
    sniffEnabled: true,
    sniffMagnet: true,
    sniffEd2k: true,
    sniffThunder: true,
    sniffHttp: false,
    sniffPlainText: true,
    showPagePanel: true,
    blacklist: "",
  };

  async function loadSettings() {
    const { settings } = await chrome.storage.local.get("settings");
    state.settings = { ...DEFAULTS, ...(settings || {}) };
    applyEnabledState();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      loadSettings();
    }
  });

  function blacklisted() {
    const list = (state.settings?.blacklist || "")
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const host = location.hostname;
    return list.some((pat) => {
      const re = new RegExp(
        "^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*").replace(/\\\./g, "\\.") + "$",
        "i"
      );
      return re.test(host);
    });
  }

  // ---------- 链接识别 ----------

  function thunderInner(url) {
    try {
      let d = atob(url.slice("thunder://".length));
      if (d.startsWith("AA") && d.endsWith("ZZ")) d = d.slice(2, -2);
      return d;
    } catch (e) {
      return url;
    }
  }

  function parseLink(text) {
    const s = state.settings;
    if (!s) return null;
    if (s.sniffMagnet) {
      const m = text.match(MAGNET_URI_RE);
      if (m) {
        const h = m[0].match(MAGNET_HASH_RE);
        if (h) {
          return { type: "magnet", url: m[0], key: "btih:" + h[1].toUpperCase(), label: m[0] };
        }
      }
    }
    if (s.sniffEd2k) {
      const m = text.match(ED2K_RE);
      if (m) return { type: "ed2k", url: m[0], key: "ed2k:" + m[3], label: decodeURIComponent(m[1]) };
    }
    if (s.sniffThunder) {
      const m = text.match(/thunder:\/\/[A-Za-z0-9+/=]{10,}/i);
      if (m) {
        const inner = thunderInner(m[0]);
        return { type: "thunder", url: inner, key: "th:" + inner, label: inner };
      }
    }
    return null;
  }

  // ---------- 扫描 ----------

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT"]);

  function isOwnEl(el) {
    // 不能用 el.host 判断 shadow 宿主：<a> 元素自带 host 属性（URL host），
    // thunder://、http:// 链接的 host 非空，会被误判为插件自身元素而跳过
    return !el || !!el.closest?.("[data-gy-el],[data-gy-skip]");
  }

  function registerLink(link) {
    if (state.found.has(link.key)) return;
    state.found.set(link.key, link);
    updatePanel();
  }

  function scanAnchor(root) {
    const anchors = (root || document).querySelectorAll("a[href]");
    state.anchorDebug = state.anchorDebug || [];
    for (const a of anchors) {
      const href0 = (a.getAttribute("href") || "").slice(0, 45);
      if (state.anchorDebug.length < 14) {
        let skip = "";
        if (isOwnEl(a)) skip = "SKIP_OWN";
        state.anchorDebug.push(`${href0} => ${skip || (parseLink(href0) ? "ok" : "?")}`);
      }
      if (isOwnEl(a)) continue;
      const href = a.getAttribute("href") || "";
      const link = parseLink(href);
      if (!link) continue;
      registerLink(link);
      if (!isGyEl(a.nextElementSibling)) {
        const btn = makePushButton();
        a.insertAdjacentElement("afterend", btn);
        bindButton(btn, link);
      }
    }
    // 部分站点把磁力放在 data 属性上（复制按钮等）
    for (const el of (root || document).querySelectorAll(
      "[data-magnet],[data-clipboard-text],[data-clipboard]"
    )) {
      if (isOwnEl(el)) continue;
      for (const attr of ["data-magnet", "data-clipboard-text", "data-clipboard"]) {
        const link = parseLink(el.getAttribute(attr) || "");
        if (link) {
          registerLink(link);
          if (!isGyEl(el.nextElementSibling)) {
            const btn = makePushButton();
            el.insertAdjacentElement("afterend", btn);
            bindButton(btn, link);
          }
          break;
        }
      }
    }
  }

  // 输入框/文本域中的链接（很多站点把磁力放在复制框里）
  function scanFields(root) {
    if (!state.settings?.sniffPlainText) return;
    for (const f of (root || document).querySelectorAll(
      'textarea, input[type="text"], input[type="search"], input:not([type])'
    )) {
      if (isOwnEl(f)) continue;
      const link = parseLink(f.value || "");
      if (!link) continue;
      registerLink(link);
      if (!isGyEl(f.nextElementSibling)) {
        const btn = makePushButton();
        try {
          f.insertAdjacentElement("afterend", btn);
          bindButton(btn, link);
        } catch (e) {}
      }
    }
  }

  function scanText(root) {
    if (!state.settings?.sniffPlainText) return;
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName) || isOwnEl(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        const t = node.nodeValue;
        if (!t || t.length < 10 || !/(magnet:|ed2k:\/\/|thunder:\/\/)/i.test(t)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    let count = 0;
    while ((node = walker.nextNode()) && count < 300) {
      count++;
      const text = node.nodeValue;
      const link = parseLink(text);
      if (!link) continue;
      if (state.found.has(link.key)) continue; // 已处理过（含上轮包裹出的文本）
      registerLink(link);
      wrapTextNode(node, link, text.indexOf(link.url));
    }
  }

  function wrapTextNode(node, link, index) {
    if (index < 0) return;
    const parent = node.parentElement;
    if (!parent) return;
    try {
      const after = node.splitText(index);
      after.splitText(link.url.length);
      const span = document.createElement("span");
      span.className = "gy-sniffed";
      span.style.cssText = "position:relative;display:inline;";
      parent.insertBefore(span, after);
      span.appendChild(document.createTextNode(link.url));
      const btn = makePushButton();
      span.appendChild(btn);
      bindButton(btn, link);
      after.remove();
    } catch (e) {}
  }

  // shadow DOM 穿透：发现 shadow root 后扫描其中的链接并挂监听
  function discoverShadow(root, depth) {
    if (depth > 4 || !root || !root.querySelectorAll) return;
    let els;
    try {
      els = root.querySelectorAll("*");
    } catch (e) {
      return;
    }
    for (const el of els) {
      const sr = el.shadowRoot;
      if (sr) {
        if (!state.shadowRoots.has(sr)) {
          state.shadowRoots.add(sr);
          scanAnchor(sr);
          scanText(sr);
          scanFields(sr);
          state.observer?.observe(sr, { childList: true, subtree: true });
        }
        discoverShadow(sr, depth + 1);
      }
    }
  }

  function reportDiag(extra) {
    if (!state.settings?.debugMode) return;
    try {
      chrome.storage.local.set({
        gyDiag: {
          url: location.href.slice(0, 200),
          frame: window.top === window ? "top" : "iframe",
          found: state.found.size,
          keys: [...state.found.keys()].slice(0, 10),
          labels: [...state.found.values()].map((l) => (l.label || "").slice(0, 40)).slice(0, 10),
          anchorDebug: (state.anchorDebug || []).slice(0, 12),
          selfTest: (() => {
            const t = parseLink("thunder://QUFodHRwOi8vZXhhbXBsZS5jb20vZmlsZS56aXAaWlo=");
            return t ? t.type : "null";
          })(),
          effSettings: state.settings
            ? `magnet:${!!state.settings.sniffMagnet} ed2k:${!!state.settings.sniffEd2k} thunder:${!!state.settings.sniffThunder} text:${!!state.settings.sniffPlainText} on:${!!state.settings.sniffEnabled}`
            : "none",
          lastError: state.lastError || "",
          at: Date.now(),
          ...(extra || {}),
        },
      });
    } catch (e) {}
  }

  function scan() {
    if (!document.body || !state.settings) return;
    if (!state.settings.sniffEnabled || blacklisted()) {
      reportDiag({ skipped: true });
      return;
    }
    try {
      scanAnchor(document.body);
      scanText(document.body);
      scanFields(document.body);
    } catch (e) {
      state.lastError = String(e && e.stack || e).slice(0, 500);
    }
    // shadow DOM 全量遍历较重，节流到 2 秒一次
    const now = Date.now();
    if (now - state.shadowScanAt > 2000) {
      state.shadowScanAt = now;
      try {
        discoverShadow(document.body, 0);
      } catch (e) {
        state.lastError = String(e && e.stack || e).slice(0, 500);
      }
    }
    reportDiag();
  }

  function scheduleScan() {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(scan, 500);
  }

  // ---------- 推送 ----------

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (/context invalidated|Receiving end/i.test(String(e))) {
        toast("插件已更新，请刷新本页后使用", true);
      }
      throw e;
    }
  }

  async function pushOne(link, { skipConfirm = false } = {}) {
    const resp = await send({ type: "GY_PUSH", url: link.url, skipConfirm });
    return resp;
  }

  function fmtSize(n) {
    if (!n || n <= 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  async function startPush(link, btn) {
    btn?.setState("loading");
    let resp;
    try {
      resp = await pushOne(link);
    } catch (e) {
      btn?.setState("error");
      toast(`推送失败：${e?.message || e}`, true);
      return;
    }
    if (resp?.needLogin) {
      btn?.setState("idle");
      confirmCard({
        title: "请先登录光鸭云盘",
        body: "点击下方按钮打开光鸭云盘网页版登录，插件会自动同步登录状态。",
        confirmText: "去登录",
        onConfirm: () => send({ type: "GY_OPEN_LOGIN" }),
      });
      return;
    }
    if (resp?.needConfirm) {
      btn?.setState("idle");
      const info = resp.info || {};
      const size = fmtSize(info.size);
      confirmCard({
        title: "推送到光鸭云盘",
        body:
          (info.name ? `名称：${info.name}\n` : "") +
          (size ? `大小：${size}\n` : "") +
          (info.fileCount ? `文件数：${info.fileCount}\n` : "") +
          `\n${link.url}`,
        confirmText: "立即推送",
        onConfirm: async () => {
          btn?.setState("loading");
          try {
            const r = await pushOne(link, { skipConfirm: true });
            if (r?.ok) {
              btn?.setState("done");
            } else {
              btn?.setState("error");
              toast(`推送失败：${r?.error || "未知错误"}`, true);
            }
          } catch (e) {
            btn?.setState("error");
            toast(`推送失败：${e?.message || e}`, true);
          }
        },
      });
      return;
    }
    if (resp?.ok) {
      btn?.setState("done");
    } else {
      btn?.setState("error");
      toast(`推送失败：${resp?.error || "未知错误"}`, true);
    }
  }

  function bindButton(btn, link) {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.disabled) return;
      startPush(link, btn);
    });
    btn.setTitle(link.label);
  }

  // ---------- 批量推送 ----------

  async function pushAll() {
    const links = [...state.found.values()];
    if (!links.length) return;
    panelBusy(`推送中 0/${links.length}...`);
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < links.length; i++) {
      panelBusy(`推送中 ${i + 1}/${links.length}...`);
      try {
        const r = await pushOne(links[i], { skipConfirm: true });
        if (r?.needLogin) {
          toast("请先登录光鸭云盘网页版", true);
          panelReset();
          send({ type: "GY_OPEN_LOGIN" });
          return;
        }
        r?.ok ? ok++ : fail++;
      } catch (e) {
        fail++;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    panelReset();
    toast(`批量推送完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ""}`, fail > 0);
  }

  // ---------- UI 组件 ----------

  // ---------- UI 工具 ----------
  // 不使用 customElements（部分环境为 null，会导致整个脚本崩溃），
  // 直接用普通 span + attachShadow 构建隔离 UI。
  function shadowEl(hostStyle, builder) {
    const host = document.createElement("span");
    host.setAttribute("data-gy-el", "1");
    if (hostStyle) host.style.cssText = hostStyle;
    const shadow = host.attachShadow({ mode: "open" });
    builder(shadow, host);
    return host;
  }

  function isGyEl(el) {
    return !!(el && el.getAttribute && el.getAttribute("data-gy-el") === "1");
  }

  // 行内推送按钮
  function makePushButton() {
    return shadowEl(
      "display:inline-block;vertical-align:middle;margin:0 4px;line-height:1;",
      (shadow, host) => {
        shadow.innerHTML = `
      <style>
        button {
          all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 3px;
          font: 500 11px/1 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
          letter-spacing: .02em;
          color: #fff; background: #1c1b19;
          border-radius: 5px; padding: 3.5px 7px;
          transition: background .14s, transform .1s, opacity .2s; user-select: none;
        }
        button:hover { background: #33312d; }
        button:active { transform: scale(.94); }
        button:focus-visible { outline: 2px solid #1c1b19; outline-offset: 1px; }
        button.loading { opacity: .6; pointer-events: none; }
        button.done { background: #15803d; }
        button.error { background: #b91c1c; }
      </style>
      <button part="btn"><svg width="10" height="10" viewBox="0 0 24 24" fill="#F5A623"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg><span class="tx">推送</span></button>`;
        const btn = shadow.querySelector("button");
        const setBtn = (inner) => (btn.innerHTML = inner);
        host.setState = (s) => {
          btn.classList.remove("loading", "done", "error");
          if (s === "loading") {
            btn.classList.add("loading");
            setBtn('<span class="tx">推送中…</span>');
          } else if (s === "done") {
            btn.classList.add("done");
            setBtn('<span class="tx">✓ 已推送</span>');
            setTimeout(() => host.setState("idle"), 4000);
          } else if (s === "error") {
            btn.classList.add("error");
            setBtn('<span class="tx">✗ 失败</span>');
            setTimeout(() => host.setState("idle"), 3000);
          } else {
            setBtn('<svg width="10" height="10" viewBox="0 0 24 24" fill="#F5A623"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg><span class="tx">推送</span>');
          }
        };
        host.setTitle = (t) => {
          btn.title = `推送到光鸭云盘：${(t || "").slice(0, 120)}`;
        };
        Object.defineProperty(host, "disabled", {
          get: () => btn.classList.contains("loading"),
        });
      }
    );
  }

  // 右下角面板
  let panelEl = null;
  function buildPanel() {
    return shadowEl("", (shadow, host) => {
      shadow.innerHTML = `
        <style>
          .panel {
            position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
            display: flex; align-items: center; gap: 9px;
            background: #fff; border: 1px solid #e9e6e0; border-radius: 10px; padding: 6px 6px 6px 10px;
            box-shadow: 0 6px 24px -8px rgba(28,27,25,.25);
            font: 12px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
            color: #57544e;
            animation: gy-slide-in .25s cubic-bezier(.2,.8,.3,1);
          }
          @keyframes gy-slide-in {
            from { transform: translateY(12px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
          .mark { width: 20px; height: 20px; border-radius: 5px; background: #1c1b19;
                  display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
          .count { letter-spacing: .01em; }
          .count b { color: #b45309; font-weight: 650; font-variant-numeric: tabular-nums; }
          button {
            all: unset; cursor: pointer; border-radius: 6px; font-size: 11.5px; font-weight: 550;
            letter-spacing: .02em; transition: background .14s, color .14s;
          }
          .push { background: #1c1b19; color: #fff; padding: 5px 11px; }
          .push:hover { background: #33312d; }
          .close { color: #9b978e; font-size: 12px; padding: 3px 7px; }
          .close:hover { color: #1c1b19; background: #f2f0eb; }
        </style>
        <div class="panel" part="panel">
          <span class="mark"><svg width="11" height="11" viewBox="0 0 24 24" fill="#F5A623"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/></svg></span>
          <span class="count">发现 <b part="n">0</b> 个链接</span>
          <button class="push" part="all">全部推送</button>
          <button class="close" title="在本页隐藏">✕</button>
        </div>`;
      shadow.querySelector(".close").addEventListener("click", () => host.remove());
      host._count = shadow.querySelector("b");
      host._all = shadow.querySelector(".push");
      host._text = shadow.querySelector(".count");
      host._all.addEventListener("click", () => {
        host.dispatchEvent(new CustomEvent("gy-push-all"));
      });
    });
  }

  function ensurePanel() {
    // 面板只在主框架显示，避免 iframe 页面弹出多个面板
    if (window.top !== window) return;
    if (panelEl || !state.settings?.showPagePanel) return;
    panelEl = buildPanel();
    panelEl.addEventListener("gy-push-all", pushAll);
    (document.documentElement || document.body).appendChild(panelEl);
  }

  function updatePanel() {
    ensurePanel();
    if (!panelEl) return;
    const n = state.found.size;
    if (!n) {
      if (panelEl.isConnected) panelEl.remove();
      panelEl = null;
      return;
    }
    panelEl._count.textContent = String(n);
  }

  function panelBusy(text) {
    if (!panelEl) return;
    panelEl._text.textContent = text;
    panelEl._all.style.pointerEvents = "none";
    panelEl._all.style.opacity = ".5";
  }

  function panelReset() {
    if (!panelEl) return;
    panelEl._all.style.pointerEvents = "";
    panelEl._all.style.opacity = "";
    updatePanel();
  }

  // 确认卡片 / 登录提示
  function buildConfirm() {
    return shadowEl("", (shadow, host) => {
      shadow.innerHTML = `
        <style>
          .mask {
            position: fixed; inset: 0; z-index: 2147483647;
            background: rgba(28,27,25,.4); display: flex; align-items: center; justify-content: center;
            font: 14px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
            animation: gy-fade .15s ease-out;
          }
          @keyframes gy-fade { from { opacity: 0; } to { opacity: 1; } }
          @keyframes gy-pop {
            from { transform: scale(.96); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
          }
          .card {
            width: min(400px, calc(100vw - 48px)); background: #fff; border-radius: 12px;
            border: 1px solid #e9e6e0;
            padding: 18px 20px; box-shadow: 0 20px 60px -12px rgba(28,27,25,.4);
            animation: gy-pop .18s ease-out;
          }
          .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
          .mark { width: 22px; height: 22px; border-radius: 6px; background: #1c1b19;
                  display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
          h3 { margin: 0; font-size: 14.5px; font-weight: 650; color: #1c1b19; letter-spacing: .01em; }
          pre {
            margin: 0 0 14px; white-space: pre-wrap; word-break: break-all;
            font: 11.5px/1.75 ui-monospace, Menlo, Consolas, monospace;
            color: #57544e; max-height: 170px; overflow: auto;
            background: #faf9f7; border: 1px solid #f2f0eb; border-radius: 8px; padding: 10px;
          }
          .row { display: flex; gap: 8px; justify-content: flex-end; }
          button {
            all: unset; cursor: pointer; border-radius: 7px; padding: 7.5px 15px;
            font-size: 12.5px; font-weight: 600; letter-spacing: .02em;
            transition: background .14s, color .14s;
          }
          .cancel { color: #9b978e; }
          .cancel:hover { color: #1c1b19; }
          .ok { background: #1c1b19; color: #fff; }
          .ok:hover { background: #33312d; }
        </style>
        <div class="mask">
          <div class="card">
            <div class="head"><span class="mark">' + BOLT + '</span><h3 part="title"></h3></div>
            <pre part="body"></pre>
            <div class="row">
              <button class="cancel">取消</button>
              <button class="ok" part="ok"></button>
            </div>
          </div>
        </div>`;
      host._title = shadow.querySelector("h3");
      host._body = shadow.querySelector("pre");
      host._ok = shadow.querySelector(".ok");
      host._cancel = shadow.querySelector(".cancel");
      const close = () => host.remove();
      host._cancel.addEventListener("click", close);
      shadow.querySelector(".mask").addEventListener("click", (e) => {
        if (e.target.classList.contains("mask")) close();
      });
      host._ok.addEventListener("click", () => {
        const fn = host._onConfirm;
        close();
        fn && fn();
      });
    });
  }

  let confirmEl = null;
  function confirmCard({ title, body, confirmText, onConfirm }) {
    confirmEl?.remove();
    confirmEl = buildConfirm();
    (document.documentElement || document.body).appendChild(confirmEl);
    const apply = () => {
      if (!confirmEl.shadowRoot) return requestAnimationFrame(apply);
      confirmEl._title.textContent = title;
      confirmEl._body.textContent = body;
      confirmEl._ok.textContent = confirmText;
      confirmEl._onConfirm = onConfirm;
    };
    apply();
  }

  // 轻提示
  function buildToast() {
    return shadowEl("", (shadow, host) => {
      shadow.innerHTML = `
        <style>
          .toast {
            position: fixed; left: 50%; top: 24px; transform: translate(-50%, 0);
            z-index: 2147483647; max-width: calc(100vw - 48px);
            background: #1c1b19; color: #fff; border-radius: 9px;
            padding: 9px 16px; font: 12.5px/1.6 -apple-system, "PingFang SC", sans-serif;
            letter-spacing: .01em;
            box-shadow: 0 10px 32px -6px rgba(28,27,25,.45);
            animation: gy-slide-down .2s ease-out;
          }
          @keyframes gy-slide-down {
            from { transform: translate(-50%, -10px); opacity: 0; }
            to { transform: translate(-50%, 0); opacity: 1; }
          }
          .toast.err { background: #b91c1c; }
        </style>
        <div class="toast" part="t"></div>`;
      host._t = shadow.querySelector(".toast");
    });
  }

  function toast(text, isErr = false) {
    const el = buildToast();
    (document.documentElement || document.body).appendChild(el);
    const apply = () => {
      if (!el.shadowRoot) return requestAnimationFrame(apply);
      el._t.textContent = text;
      el._t.classList.toggle("err", !!isErr);
    };
    apply();
    setTimeout(() => el.remove(), isErr ? 4200 : 2600);
  }

  // ---------- 消息 ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "GY_SNIFF_COLLECT") {
      sendResponse({
        ok: true,
        links: [...state.found.values()].map((l) => ({ url: l.url, type: l.type, label: l.label })),
      });
      return;
    }
    if (msg?.type === "GY_SNIFF_RESCAN") {
      state.found.clear();
      document.querySelectorAll("[data-gy-el]").forEach((b) => b.remove());
      scan();
      updatePanel();
      sendResponse({ ok: true, count: state.found.size });
      return;
    }
  });

  function applyEnabledState() {
    const s = state.settings;
    if (!s) return;
    if (!s.sniffEnabled || blacklisted()) {
      state.observer?.disconnect();
      panelEl?.remove();
      panelEl = null;
      return;
    }
    scan();
    if (!state.observer) {
      state.observer = new MutationObserver((muts) => {
        if (muts.some((m) => m.addedNodes.length)) scheduleScan();
      });
      state.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  // ---------- 启动 ----------

  loadSettings().then(() => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", scheduleScan);
    } else {
      scheduleScan();
    }
  });
})();
