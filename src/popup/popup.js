// 光鸭闪推 - popup 逻辑（发布版）

const SVG_FOLDER =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const SVG_CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const STATUS_TEXT = { 0: "等待中", 1: "下载中", 2: "已完成", 3: "已完成", 4: "失败" };

const MAGNET_URI_RE = /magnet:\?[^\s"'<>]+/i;
const MAGNET_HASH_RE = /xt=urn:btih:[a-z0-9]+/i;
const ED2K_RE = /ed2k:\/\/\|file\|[^|]+\|\d+\|[a-f0-9]{32}\|[^"\s<>]*/i;
const THUNDER_RE = /thunder:\/\/[A-Za-z0-9+/=]{10,}/i;

function extractLink(text) {
  const s = (text || "").trim();
  const m = s.match(MAGNET_URI_RE);
  if (m && MAGNET_HASH_RE.test(m[0])) return m[0];
  const e = s.match(ED2K_RE) || s.match(THUNDER_RE);
  if (e) return e[0];
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  return null;
}

function thunderInner(url) {
  try {
    let d = atob(url.slice("thunder://".length));
    if (d.startsWith("AA") && d.endsWith("ZZ")) d = d.slice(2, -2);
    return d;
  } catch (e) {
    return url;
  }
}

function showMsg(text, cls) {
  const el = $("pushMsg");
  el.textContent = text || "";
  el.className = "msg show " + (cls || "");
  if (!text) el.classList.remove("show");
}

function hideConfirm() {
  $("confirmBox").classList.add("hidden");
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

// ---------- 登录状态 ----------

async function loadState() {
  let state;
  try {
    state = await send({ type: "GY_GET_STATE" });
  } catch (e) {
    state = null;
  }
  const el = $("userStatus");
  if (state?.loggedIn) {
    const name = state.userInfo?.nickname || `账号 ${(state.creds?.sub || "").slice(0, 8)}`.trim();
    el.textContent = name || "已登录";
    el.title = name || "已登录";
    el.className = "status ok";
    const av = $("userAvatar");
    const avatarUrl = state.userInfo?.avatar;
    if (avatarUrl) {
      av.src = avatarUrl;
      av.classList.remove("hidden");
      av.onerror = () => av.classList.add("hidden");
    } else {
      av.classList.add("hidden");
    }
  } else {
    el.innerHTML = '未登录 · <a href="#" id="loginLink">去网页版登录</a>';
    el.className = "status err";
    $("loginLink").addEventListener("click", (e) => {
      e.preventDefault();
      send({ type: "GY_OPEN_LOGIN" });
    });
  }
  return state;
}

// ---------- 手动推送（内联确认） ----------

let pendingPushUrl = null;

async function pushUrl(url) {
  const raw = extractLink(url);
  if (!raw) {
    showMsg("未识别到有效的磁力/ed2k/迅雷/HTTP 链接", "err");
    return;
  }
  const link = /^thunder:/i.test(raw) ? thunderInner(raw) : raw;
  hideConfirm();
  showMsg("推送中…");

  const btn = $("btnPush");
  btn.disabled = true;
  try {
    const resp = await send({ type: "GY_PUSH", url: link });
    if (resp?.needLogin) {
      showMsg("请先登录光鸭云盘网页版（点上方“去登录”）", "err");
    } else if (resp?.needConfirm) {
      const info = resp.info || {};
      const size = fmtSize(info.size);
      const parts = [];
      if (info.name) parts.push(`名称：${info.name}`);
      if (size) parts.push(`大小：${size}`);
      if (info.fileCount) parts.push(`文件数：${info.fileCount}`);
      parts.push(link);
      $("confirmInfo").textContent = parts.join("\n");
      $("confirmBox").classList.remove("hidden");
      pendingPushUrl = link;
      showMsg("");
    } else if (resp?.ok) {
      showMsg(`✓ 已添加到云下载${resp.name ? `：${resp.name}` : ""}`, "ok");
      loadTasks();
    } else {
      showMsg(`推送失败：${resp?.error || "未知错误"}`, "err");
    }
  } catch (e) {
    showMsg(`推送失败：${e?.message || e}`, "err");
  } finally {
    btn.disabled = false;
  }
}

$("btnDoConfirm").addEventListener("click", async () => {
  if (!pendingPushUrl) return;
  const url = pendingPushUrl;
  pendingPushUrl = null;
  hideConfirm();
  showMsg("推送中…");
  $("btnPush").disabled = true;
  try {
    const r = await send({ type: "GY_PUSH", url, skipConfirm: true });
    if (r?.ok) {
      showMsg(`✓ 已添加到云下载${r.name ? `：${r.name}` : ""}`, "ok");
      loadTasks();
    } else {
      showMsg(`推送失败：${r?.error || "未知错误"}`, "err");
    }
  } catch (e) {
    showMsg(`推送失败：${e?.message || e}`, "err");
  } finally {
    $("btnPush").disabled = false;
  }
});

$("btnCancelConfirm").addEventListener("click", () => {
  pendingPushUrl = null;
  hideConfirm();
  showMsg("已取消");
});

// ---------- 目录选择器 ----------

const fp = { stack: [{ id: "", name: "全部文件" }], settings: null };

function folderLabelOf(settings) {
  const id = settings?.defaultParentId ?? "";
  const name = settings?.defaultParentName || "";
  return id ? name || `目录 ${id.slice(0, 8)}…` : "默认（云下载）";
}

async function initFolderBtn() {
  const state = await send({ type: "GY_GET_STATE" }).catch(() => null);
  fp.settings = state?.settings || {};
  $("folderLabel").textContent = folderLabelOf(fp.settings);
}

async function openPicker() {
  $("folderPicker").classList.remove("hidden");
  fp.stack = [{ id: "", name: "全部文件" }];
  await loadFpList();
}

async function loadFpList() {
  const cur = fp.stack[fp.stack.length - 1];
  $("fpPath").textContent = fp.stack.map((s) => s.name).join(" / ");
  $("fpUp").style.visibility = fp.stack.length > 1 ? "visible" : "hidden";
  const ul = $("fpList");
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const resp = await send({ type: "GY_LIST_FOLDERS", parentId: cur.id }).catch(() => null);
  if (!resp?.ok) {
    ul.innerHTML = `<li class="empty">${resp?.needLogin ? "请先登录" : resp?.error || "加载失败"}</li>`;
    return;
  }
  const folders = resp.folders || [];
  ul.innerHTML = "";
  if (!folders.length) {
    ul.innerHTML = '<li class="empty">此目录下没有子文件夹</li>';
    return;
  }
  for (const f of folders) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="fp-ic">${SVG_FOLDER}</span><span class="fp-name"></span><span class="fp-arrow">${SVG_CHEVRON}</span>`;
    li.querySelector(".fp-name").textContent = f.name;
    li.title = f.name;
    li.addEventListener("click", async () => {
      fp.stack.push({ id: f.id, name: f.name });
      await loadFpList();
    });
    ul.appendChild(li);
  }
}

$("folderBtn").addEventListener("click", () => {
  const picker = $("folderPicker");
  if (picker.classList.contains("hidden")) openPicker();
  else picker.classList.add("hidden");
});
$("fpClose").addEventListener("click", () => $("folderPicker").classList.add("hidden"));
$("fpUp").addEventListener("click", async () => {
  if (fp.stack.length > 1) {
    fp.stack.pop();
    await loadFpList();
  }
});
$("fpChoose").addEventListener("click", async () => {
  const cur = fp.stack[fp.stack.length - 1];
  const resp = await send({
    type: "GY_UPDATE_SETTINGS",
    patch: { defaultParentId: cur.id, defaultParentName: cur.id ? cur.name : "" },
  }).catch(() => null);
  if (resp?.ok) {
    fp.settings = resp.settings;
    $("folderLabel").textContent = folderLabelOf(resp.settings);
    $("folderPicker").classList.add("hidden");
    showMsg(cur.id ? `已设置保存目录：${cur.name}` : "已恢复默认目录", "ok");
  }
});
$("fpReset").addEventListener("click", async () => {
  const resp = await send({
    type: "GY_UPDATE_SETTINGS",
    patch: { defaultParentId: "", defaultParentName: "" },
  }).catch(() => null);
  if (resp?.ok) {
    fp.settings = resp.settings;
    $("folderLabel").textContent = "默认（云下载）";
    $("folderPicker").classList.add("hidden");
    showMsg("已恢复默认目录", "ok");
  }
});

// ---------- 本页链接 ----------

async function loadPageLinks() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error();
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GY_SNIFF_COLLECT" });
    setPageCount(resp?.links?.length || 0);
  } catch (e) {
    $("pageCard").style.display = "none";
  }
}

function setPageCount(n) {
  $("pageCount").textContent = String(n);
  $("btnPushAll").disabled = n === 0;
}

$("btnRescan").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GY_SNIFF_RESCAN" });
    setPageCount(resp?.count || 0);
    showMsg(`重新扫描完成：发现 ${resp?.count || 0} 个链接`, resp?.count ? "ok" : "");
  } catch (e) {
    showMsg("当前页面无法扫描（浏览器内部页面，或插件更新后未刷新）", "err");
  }
});

$("btnPushAll").addEventListener("click", async () => {
  const btn = $("btnPushAll");
  btn.disabled = true;
  btn.textContent = "推送中…";
  hideConfirm();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "GY_SNIFF_COLLECT" });
    const links = resp?.links || [];
    let ok = 0;
    let fail = 0;
    for (const l of links) {
      const r = await send({ type: "GY_PUSH", url: l.url, skipConfirm: true }).catch(() => null);
      r?.ok ? ok++ : fail++;
      await new Promise((r2) => setTimeout(r2, 350));
    }
    showMsg(`批量推送完成：成功 ${ok}${fail ? `，失败 ${fail}` : ""}`, fail ? "err" : "ok");
    loadTasks();
  } catch (e) {
    showMsg(`批量推送失败：${e?.message || e}`, "err");
  } finally {
    btn.textContent = "全部推送";
    btn.disabled = false;
  }
});

// ---------- 任务列表 ----------

async function loadTasks() {
  const ul = $("taskList");
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const resp = await send({ type: "GY_LIST_TASKS" }).catch(() => null);
  if (!resp?.ok) {
    ul.innerHTML = `<li class="empty">${resp?.needLogin ? "登录后查看任务" : resp?.error || "加载失败"}</li>`;
    return;
  }
  const tasks = resp.tasks || [];
  if (!tasks.length) {
    ul.innerHTML = '<li class="empty">暂无任务，去推送一个资源试试 🦆</li>';
    return;
  }
  ul.innerHTML = "";
  for (const t of tasks.slice(0, 8)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "task-name";
    name.textContent = t.name || t.id || "未命名任务";
    name.title = name.textContent;
    const st = t.status;
    const status = document.createElement("span");
    status.className =
      "task-status " + (st === 2 || st === 3 ? "s-done" : st === 4 ? "s-error" : "s-running");
    const dot = document.createElement("i");
    dot.className = "dot";
    const label = document.createElement("span");
    label.textContent =
      st >= 0 && st <= 1
        ? `${STATUS_TEXT[st]}${t.progress ? " " + Math.round(t.progress) + "%" : ""}`
        : STATUS_TEXT[st] || `状态 ${st}`;
    status.append(dot, label);
    li.append(name, status);
    ul.appendChild(li);
  }
}

// ---------- 事件绑定与启动 ----------

$("btnPush").addEventListener("click", () => pushUrl($("pushInput").value));
$("pushInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") pushUrl($("pushInput").value);
});
$("btnOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("btnRefreshTasks").addEventListener("click", loadTasks);

try {
  chrome.action.setBadgeText({ text: "" });
} catch (e) {}

$("verInfo").textContent = `v${chrome.runtime.getManifest().version}`;

loadState();
initFolderBtn();
loadPageLinks();
loadTasks();
