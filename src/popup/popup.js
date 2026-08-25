// 光鸭闪推 - popup 逻辑（发布版）

const SVG_FOLDER =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const SVG_CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const STATUS_TEXT = { 0: "等待中", 1: "下载中", 2: "已完成", 3: "已完成", 4: "失败" };

import { normalizeLink } from "../shared/link-parser.js";

function showMsg(text, cls) {
  const el = $("pushMsg");
  el.textContent = text || "";
  el.className = "msg show " + (cls || "");
  if (!text) el.classList.remove("show");
}

function isTrustedAvatarUrl(url) {
  try {
    const parsed = new URL(url, location.origin);
    return (
      (parsed.protocol === "https:" && parsed.hostname === "guangyapan.com") ||
      parsed.hostname.endsWith(".guangyapan.com")
    );
  } catch {
    return false;
  }
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

function setListMessage(list, message) {
  list.replaceChildren();
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = message;
  list.appendChild(li);
}

function formatRemainingDuration(expiresAt) {
  const milliseconds = expiresAt - Date.now();
  if (milliseconds <= 0) return "已过期";

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const days = Math.floor(milliseconds / day);
  if (days >= 365) {
    const years = Math.floor(days / 365);
    const remainDays = days % 365;
    return remainDays ? `${years} 年 ${remainDays} 天` : `${years} 年`;
  }
  if (days >= 1) return `${days} 天 ${Math.floor((milliseconds % day) / hour)} 小时`;
  if (milliseconds >= hour) return `${Math.floor(milliseconds / hour)} 小时`;
  return Math.max(1, Math.floor(milliseconds / minute)) + " 分钟";
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
    el.replaceChildren(name || "已登录");
    el.title = name || "已登录";
    el.className = "status ok";
    const vipExpiresAt = state.userInfo?.vipExpiresAt;
    let membershipText = "";
    if (state.userInfo?.vip && vipExpiresAt) {
      membershipText = `会员时长 剩余 ${formatRemainingDuration(vipExpiresAt)}`;
    } else if (state.userInfo?.vip) {
      membershipText = "会员生效中";
    }
    if (membershipText) {
      const membership = document.createElement("span");
      membership.className = "membership";
      membership.textContent = membershipText;
      el.append(membership);
      el.title = `${el.title} · ${membershipText}`;
    }
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
    el.replaceChildren("未登录 · ");
    const loginLink = document.createElement("a");
    loginLink.href = "#";
    loginLink.id = "loginLink";
    loginLink.textContent = "去网页版登录";
    el.appendChild(loginLink);
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
  const linkInfo = normalizeLink(url);
  if (!linkInfo) {
    showMsg("未识别到有效的磁力/ed2k/迅雷/HTTP 链接", "err");
    return;
  }
  const link = linkInfo.inner || linkInfo.url;
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
  const resp = await send({ type: "GY_LIST_FOLDERS", parentId: cur.id }).catch(() => null);
  if (!resp?.ok) {
    setListMessage(ul, resp?.needLogin ? "请先登录" : resp?.error || "加载失败");
    return;
  }
  const folders = resp.folders || [];
  if (!folders.length) {
    setListMessage(ul, "此目录下没有子文件夹");
    return;
  }
  for (const f of folders) {
    const li = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = "fp-ic";
    icon.innerHTML = SVG_FOLDER;
    const name = document.createElement("span");
    name.className = "fp-name";
    const arrow = document.createElement("span");
    arrow.className = "fp-arrow";
    arrow.innerHTML = SVG_CHEVRON;
    li.append(icon, name, arrow);
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
  const resp = await send({ type: "GY_LIST_TASKS" }).catch(() => null);
  if (!resp?.ok) {
    setListMessage(ul, resp?.needLogin ? "登录后查看任务" : resp?.error || "加载失败");
    return;
  }
  const tasks = resp.tasks || [];
  if (!tasks.length) {
    setListMessage(ul, "暂无任务，去推送一个资源试试 🦆");
    return;
  }
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
