// 光鸭闪推 - background service worker
// 负责光鸭云盘 API 调用、登录凭证管理、推送任务、右键菜单与通知。

import { normalizeLink } from "../shared/link-parser.js";
import {
  APP_VERSION,
  LATEST_RELEASE_API,
  RELEASES_URL,
  compareVersions,
} from "../shared/app-meta.js";

const SW_BUILD = "2.2.2";
const CLIENT_ID = "aMe-8VSlkrbQXpUR";

async function debugEnabled() {
  const { settings } = await chrome.storage.local.get("settings");
  return !!(settings && settings.debugMode);
}
const API_BASE = "https://api.guangyapan.com";
const ACCOUNT_BASE = "https://account.guangyapan.com";

const DEFAULT_SETTINGS = {
  confirmBeforePush: true, // 推送前解析并显示名称/大小，需二次确认
  notifyOnSuccess: true,
  sniffEnabled: true,
  sniffMagnet: true,
  sniffEd2k: true,
  sniffThunder: true,
  sniffHttp: false, // http 直链页面太多，默认不嗅探
  sniffPlainText: true, // 嗅探正文纯文本中的磁力链接
  showPagePanel: true, // 页面右下角“发现 N 个链接”面板
  defaultParentId: "", // '' = 云下载默认目录
  autoRefresh: true, // 401 时用 refresh_token 自动续期并回写网页版
  blacklist: "", // 每行一个 host 通配，如 *.example.com
  debugMode: false, // 调试诊断面板与日志
};

async function checkForUpdate({ force = false } = {}) {
  const cached = await getStore("updateStatus", null);
  const cacheTtl = 30 * 60 * 1000;
  if (
    !force &&
    cached?.checkedAt &&
    Date.now() - cached.checkedAt < cacheTtl &&
    cached.latestVersion
  ) {
    return {
      ...cached,
      currentVersion: APP_VERSION,
      updateAvailable: compareVersions(cached.latestVersion, APP_VERSION) > 0,
    };
  }

  const response = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
  const release = await response.json().catch(() => null);
  const latestVersion = String(release?.tag_name || "").replace(/^v/i, "");
  if (!latestVersion) throw new Error("未获取到最新版本号");

  const status = {
    checkedAt: Date.now(),
    latestVersion,
    releaseUrl: release.html_url || RELEASES_URL,
  };
  await setStore("updateStatus", status);
  return {
    ...status,
    currentVersion: APP_VERSION,
    updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
  };
}

// ---------- 工具 ----------

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function traceparent() {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function generateDid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${randomHex(4)}${randomHex(2)}-${randomHex(2)}-${randomHex(2)}-${randomHex(2)}-${randomHex(6)}`;
}

async function getStore(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  return obj[key] ?? fallback;
}

async function setStore(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function getSettings() {
  const saved = await getStore("settings", {});
  return { ...DEFAULT_SETTINGS, ...saved };
}

async function updateSettings(patch) {
  const merged = { ...(await getSettings()), ...patch };
  await setStore("settings", merged);
  // 嗅探脚本通过 chrome.storage.onChanged 自行感知变化
  return merged;
}

// ---------- 凭证 ----------

async function getCreds() {
  return getStore("creds", null);
}

async function saveCreds(creds) {
  await setStore("creds", creds);
}

async function ensureDid() {
  let did = await getStore("did", null);
  if (!did) {
    did = generateDid();
    await setStore("did", did);
  }
  return did;
}

// 从网页版 localStorage 捕获到的凭证（由 auth-bridge 发来）
async function handleCapture(payload) {
  if (await debugEnabled()) {
    try {
      chrome.storage.local.set({
        gyCaptureLog: {
          at: Date.now(),
          hasPayload: !!payload,
          accessLen: payload?.accessToken?.length || 0,
          hasRefresh: !!payload?.refreshToken,
          refreshLen: payload?.refreshToken?.length || 0,
        },
      });
    } catch (e) {}
  }
  if (!payload || !payload.accessToken) {
    // 网页版已登出
    const old = await getCreds();
    if (old) {
      await saveCreds(null);
      await setStore("userInfo", null);
      notify("已退出登录", "检测到网页版已登出，插件登录态已清除。");
    }
    return { ok: true };
  }
  const prev = await getCreds();
  if (
    prev &&
    prev.accessToken === payload.accessToken &&
    // 此前存的数据缺 refresh_token 而新捕获有时，仍需走完整保存修复
    (prev.refreshToken || !payload.refreshToken)
  ) {
    return { ok: true }; // 无变化
  }
  await saveCreds({
    accessToken: payload.accessToken,
    // SDK 续期写入的瞬间可能读到不完整凭证：空值不覆盖已有 refresh_token
    refreshToken: payload.refreshToken || prev?.refreshToken || "",
    sub: payload.sub || "",
    expiresAt: payload.expiresAt || prev?.expiresAt || null, // 毫秒时间戳，可能为 null
    capturedAt: Date.now(),
    lastRefreshAt: prev?.lastRefreshAt || null,
    rawKey: payload.rawKey || "",
    did: payload.did || "",
  });
  if (!prev) {
    notify("登录成功", "已同步光鸭云盘网页版登录态，可以开始推送啦 🦆");
  }
  fetchUserInfo().catch(() => {});
  return { ok: true };
}

function accountHeaders(did, bearer) {
  return {
    accept: "*/*",
    "content-type": "application/json",
    "x-client-id": CLIENT_ID,
    "x-client-version": "0.0.1",
    "x-device-id": did,
    "x-device-model": encodeURIComponent("chrome/147.0.0.0"),
    "x-device-name": "PC-Chrome",
    "x-device-sign": `wdi10.${did}${randomHex(16)}`,
    "x-net-work-type": "NONE",
    "x-os-version": "MacIntel",
    "x-platform-version": "1",
    "x-protocol-version": "301",
    "x-provider-name": "NONE",
    "x-sdk-version": "9.0.2",
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
  };
}

// 用 refresh_token 换新 access_token，并尽量回写网页版 localStorage
let lastRefreshAttempt = 0; // 限流：两次续期尝试至少间隔 60 秒

async function refreshAccessToken() {
  const creds = await getCreds();
  if (!creds || !creds.refreshToken) return false;
  if (Date.now() - lastRefreshAttempt < 60_000) return false;
  lastRefreshAttempt = Date.now();
  const did = creds.did || (await ensureDid());
  let resp;
  try {
    resp = await fetch(`${ACCOUNT_BASE}/v1/auth/token`, {
      method: "POST",
      headers: accountHeaders(did),
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
      }),
    });
  } catch (e) {
    return false;
  }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      await saveCreds(null);
      await setStore("userInfo", null);
      notify("登录已过期", "自动续期失败，请重新打开光鸭云盘网页版登录。");
    }
    return false;
  }
  const data = await resp.json().catch(() => null);
  const accessToken = data?.access_token;
  if (!accessToken) return false;
  const expiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : null;

  // 回写网页版（保持网页与插件 token 一致，避免 refresh_token 轮换互相踢）
  let writeBackOk = false;
  try {
    const tabs = [
      ...(await chrome.tabs.query({ url: "https://www.guangyapan.com/*" })),
      ...(await chrome.tabs.query({ url: "https://guangyapan.com/*" })),
    ];
    for (const tab of tabs) {
      const res = await chrome.tabs
        .sendMessage(tab.id, {
          type: "GY_WRITE_CREDS",
          patch: {
            access_token: accessToken,
            refresh_token: data.refresh_token || creds.refreshToken,
            expires_in: data.expires_in ?? undefined,
          },
        })
        .catch(() => null);
      if (res?.ok) writeBackOk = true;
    }
  } catch (e) {}

  await saveCreds({
    ...creds,
    accessToken,
    refreshToken: data.refresh_token || creds.refreshToken,
    expiresAt,
    lastRefreshAt: Date.now(),
    writeBackOk,
  });
  return true;
}

// 判断凭证是否快过期（10 分钟内到期；expiresAt 未知时按抓取时间超过 90 分钟算）
async function tokenNeedsRefresh(creds) {
  if (!creds) return false;
  if (creds.expiresAt) return Date.now() > creds.expiresAt - 10 * 60 * 1000;
  return Date.now() - (creds.capturedAt || 0) > 90 * 60 * 1000;
}

// 主动续期：token 快过期时提前刷新，避免推送时才 401
async function keepAlive() {
  const creds = await getCreds();
  if (!creds || !creds.refreshToken) return false;
  const settings = await getSettings();
  if (!settings.autoRefresh) return false;
  if (!(await tokenNeedsRefresh(creds))) return false;
  return refreshAccessToken();
}

// ---------- API 客户端 ----------

async function apiCall(path, body, { retry = true } = {}) {
  const creds = await getCreds();
  if (!creds) {
    const err = new Error("未登录");
    err.needLogin = true;
    throw err;
  }
  {
    const settings = await getSettings();
    if (settings.autoRefresh && creds.refreshToken && (await tokenNeedsRefresh(creds))) {
      await refreshAccessToken();
    }
  }
  const did = creds.did || (await ensureDid());
  let resp;
  try {
    resp = await fetch(`${API_BASE}/${path}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        authorization: `Bearer ${creds.accessToken}`,
        did,
        dt: "4",
        traceparent: traceparent(),
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    const err = new Error("网络请求失败，请检查网络");
    err.network = true;
    throw err;
  }
  if (resp.status === 401 && retry) {
    const settings = await getSettings();
    if (settings.autoRefresh && (await refreshAccessToken())) {
      return apiCall(path, body, { retry: false });
    }
    await saveCreds(null);
    const err = new Error("登录已过期，请重新登录光鸭云盘网页版");
    err.needLogin = true;
    throw err;
  }
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(data?.msg || `请求失败 (HTTP ${resp.status})`);
  }
  if (data && typeof data.code === "number" && data.code !== 0) {
    const err = new Error(data.msg || `错误码 ${data.code}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

// ---------- 用户信息 ----------

async function fetchUserInfo() {
  const creds = await getCreds();
  if (!creds) return null;
  const did = creds.did || (await ensureDid());
  let data = null;
  try {
    const resp = await fetch(`${ACCOUNT_BASE}/v1/user/me`, {
      method: "GET",
      headers: accountHeaders(did, creds.accessToken),
    });
    if (resp.ok) data = await resp.json().catch(() => null);
  } catch (e) {
    data = null;
  }
  if (!data) return null;

  // 调试：记录字段名与短值（不含长 token）
  if (await debugEnabled()) {
    const shallow = {};
    for (const [k, v] of Object.entries(data)) {
      shallow[k] =
        typeof v === "string"
          ? v.length > 60
            ? `string(${v.length})`
            : v
          : Array.isArray(v)
          ? `array(${v.length})`
          : typeof v === "object" && v !== null
          ? "object"
          : v;
    }
    try {
      chrome.storage.local.set({ gyUserRaw: { fields: shallow, at: Date.now() } });
    } catch (e) {}
  }

  // 昵称/头像可能在顶层，也可能在 providers[0] 里
  const p0 = Array.isArray(data.providers) && data.providers[0] ? data.providers[0] : {};
  const pick = (...vals) => {
    for (const v of vals) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const pickNumber = (...vals) => {
    for (const value of vals) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const vipExpiresAt = (() => {
    const values = [
      data.vip_expire_time,
      data.vip_expires_at,
      data.vip_expired_at,
      data.vip_expiration,
      data.vip_end_time,
      data.vipEndTime,
      data.vipExpireTime,
      data.vipExpiresAt,
      data.membership_expire_time,
      data.membership_expires_at,
      data.member_expire_time,
      data.member_expires_at,
      p0.vip_expire_time,
      p0.vip_expires_at,
      p0.vipExpiredAt,
    ];
    const raw = pickNumber(...values);
    if (!raw || raw <= 0) return null;
    return raw > 1e12 ? raw : raw * 1000;
  })();
  const phone = pick(data.phone_number, data.phone, p0.phone_number);
  const info = {
    nickname: pick(
      data.name,
      data.nickname,
      data.nick_name,
      data.username,
      data.display_name,
      p0.name,
      p0.nickname,
      p0.provider_user_name
    ),
    avatar: pick(data.avatar, data.avatar_url, data.head_img_url, p0.avatar, p0.avatar_url),
    phone,
    sub: pick(data.sub),
    vip: !!(vipExpiresAt || data.vip || data.is_vip || data.isVip),
    vipExpiresAt,
    fetchedAt: Date.now(),
  };
  if (!info.nickname && info.phone) {
    info.nickname = info.phone.replace(/^(\+?\d{3})\d+(\d{4})$/, "$1****$2");
  }
  if (!info.nickname) info.nickname = "";
  await setStore("userInfo", info);
  return info;
}

// ---------- 业务：解析 / 推送 / 目录 / 任务 ----------

function pickList(data) {
  const d = data?.data ?? data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.list)) return d.list;
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d?.records)) return d.records;
  return [];
}

async function resolveUrl(url) {
  const data = await apiCall("nd.bizcloudcollection.s/v1/resolve_res", { url });
  const info = data?.data ?? {};
  return {
    name: info.name || info.fileName || info.title || "",
    size: Number(info.size ?? info.fileSize ?? 0),
    fileCount: Number(info.fileCount ?? info.fileNum ?? 0),
    raw: info,
  };
}

async function createTask(url) {
  const settings = await getSettings();
  const data = await apiCall("nd.bizcloudcollection.s/v1/create_task", {
    url,
    parentId: settings.defaultParentId ?? "",
  });
  const d = data?.data ?? {};
  return { taskId: d.taskId ?? d.id ?? "", name: d.name ?? d.taskName ?? "" };
}

function detectIsDir(it) {
  // 兼容多种可能的目录标记字段
  if (it.dir !== undefined) return !!it.dir;
  if (it.isDir !== undefined) return !!it.isDir;
  if (it.isDirectory !== undefined) return !!it.isDirectory;
  if (it.resType !== undefined) return it.resType === 2;
  if (it.res_type !== undefined) return it.res_type === 2;
  if (it.dirType !== undefined) return it.dirType === 2;
  if (it.type !== undefined) return it.type === 2 || it.type === "dir";
  return null; // 未知
}

async function listFolders(parentId = "") {
  const call = (extra) =>
    apiCall("userres/v1/file/get_file_list", {
      parentId,
      page: 0,
      pageSize: 200,
      orderBy: 0,
      sortType: 0,
      ...extra,
    });
  // 优先让服务端只返回目录（resType=2），失败或为空则拉全量后本地过滤
  let items = [];
  let dirOnly = false;
  let data = await call({ resType: 2 }).catch(() => null);
  if (data && pickList(data).length) {
    items = pickList(data);
    dirOnly = true;
  } else {
    data = await call({}).catch(() => null);
    if (!data) return [];
    items = pickList(data);
  }
  return items
    .map((it) => ({
      id: String(it.fileId ?? it.id ?? it.dirId ?? ""),
      name: it.fileName ?? it.name ?? it.dirName ?? "",
      isDir: dirOnly ? true : detectIsDir(it),
    }))
    .filter((f) => f.id && f.name && f.isDir !== false && f.isDir !== null)
    .map((f) => ({ id: f.id, name: f.name }));
}

async function listTasks() {
  const data = await apiCall("nd.bizcloudcollection.s/v1/list_task", {
    page: 0,
    pageSize: 20,
    status: [0, 1, 2, 3, 4],
  });
  return pickList(data).map((t) => ({
    id: String(t.taskId ?? t.id ?? ""),
    name: t.name ?? t.taskName ?? t.fileName ?? "",
    status: t.status ?? -1,
    size: Number(t.size ?? t.fileSize ?? 0),
    progress: Number(t.progress ?? t.percent ?? 0),
    speed: t.speed ?? "",
  }));
}

// 推送入口：confirmBeforePush 开启时先解析返回 needConfirm
async function pushFlow(url, { skipConfirm = false } = {}) {
  const settings = await getSettings();
  if (!skipConfirm && settings.confirmBeforePush) {
    let info = null;
    try {
      info = await resolveUrl(url);
    } catch (e) {
      if (e.needLogin) throw e;
      // 解析失败不阻塞，继续直接推送（服务端创建时还会再解析）
    }
    return { needConfirm: true, info };
  }
  const task = await createTask(url);
  if (settings.notifyOnSuccess) {
    notify(
      "推送成功 🦆",
      task.name ? `「${task.name}」已添加到云下载` : "任务已添加到云下载"
    );
  }
  flashBadge("✓", "#22c55e");
  return { ok: true, name: task.name };
}

// ---------- 链接识别（供右键菜单/弹窗复用） ----------

// ---------- 通知 / 徽标 ----------

let notifySeq = 0;

function notify(title, message) {
  chrome.notifications.create(`gy-${Date.now()}-${notifySeq++}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
  });
}

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: "https://www.guangyapan.com/" });
});

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
}

function badgeError() {
  flashBadge("!", "#ef4444");
}

// ---------- Token 保活 ----------
// SW 每次唤醒都检查一次；闹钟作为兜底（SW 长期不活动时定时唤醒）
chrome.alarms.get("gy-keepalive", (alarm) => {
  if (!alarm) chrome.alarms.create("gy-keepalive", { periodInMinutes: 15 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gy-keepalive") keepAlive().catch(() => {});
});
keepAlive().catch(() => {});

// ---------- 右键菜单 ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "gy-push-link",
      title: "推送到光鸭云盘 ⚡",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: "gy-push-selection",
      title: "推送选中的链接到光鸭云盘 ⚡",
      contexts: ["selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const source = info.menuItemId === "gy-push-link" ? info.linkUrl : info.selectionText;
  if (!source) return;
  const link = normalizeLink(source);
  if (!link) {
    notify("无法推送", "未识别到磁力/ed2k/迅雷/HTTP 链接。");
    return;
  }
  const finalUrl = link.type === "thunder" && link.inner ? link.inner : link.url;
  try {
    await pushFlow(finalUrl, { skipConfirm: true });
  } catch (e) {
    badgeError();
    if (e.needLogin) {
      notify("请先登录", "请打开光鸭云盘网页版登录后重试。");
    } else {
      notify("推送失败", e.message || String(e));
    }
  }
});

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "GY_CAPTURE_CREDS":
        return handleCapture(msg.creds);

      case "GY_GET_STATE": {
        const creds = await getCreds();
        const settings = await getSettings();
        const userInfo = await getStore("userInfo", null);
        if (creds && (!userInfo || Date.now() - (userInfo.fetchedAt || 0) > 3600_000)) {
          fetchUserInfo().catch(() => {});
        }
        return {
          swBuild: SW_BUILD,
          loggedIn: !!creds,
          creds: creds && {
            sub: creds.sub,
            expiresAt: creds.expiresAt,
            capturedAt: creds.capturedAt,
            lastRefreshAt: creds.lastRefreshAt || null,
            hasRefreshToken: !!creds.refreshToken,
            rawKey: creds.rawKey || "",
          },
          userInfo,
          settings,
        };
      }

      case "GY_RESOLVE":
        try {
          return { ok: true, info: await resolveUrl(msg.url) };
        } catch (e) {
          return { ok: false, error: e.message, needLogin: !!e.needLogin };
        }

      case "GY_PUSH": {
        try {
          const link = normalizeLink(msg.url);
          const finalUrl = link
            ? link.type === "thunder" && link.inner
              ? link.inner
              : link.url
            : (msg.url || "").trim();
          return await pushFlow(finalUrl, { skipConfirm: !!msg.skipConfirm });
        } catch (e) {
          return { ok: false, error: e.message, needLogin: !!e.needLogin };
        }
      }

      case "GY_LIST_FOLDERS":
        try {
          return { ok: true, folders: await listFolders(msg.parentId || "") };
        } catch (e) {
          return { ok: false, error: e.message, needLogin: !!e.needLogin };
        }

      case "GY_LIST_TASKS":
        try {
          return { ok: true, tasks: await listTasks() };
        } catch (e) {
          return { ok: false, error: e.message, needLogin: !!e.needLogin };
        }

      case "GY_CHECK_UPDATE":
        try {
          return { ok: true, update: await checkForUpdate({ force: !!msg.force }) };
        } catch (e) {
          return { ok: false, error: e.message };
        }

      case "GY_UPDATE_SETTINGS":
        return { ok: true, settings: await updateSettings(msg.patch || {}) };

      case "GY_FORCE_REFRESH": {
        const ok = await refreshAccessToken();
        if (!ok) return { ok: false, error: "续期失败（无可用的 refresh_token 或刚刚尝试过）" };
        const creds = await getCreds();
        return { ok: true, expiresAt: creds?.expiresAt || null };
      }

      case "GY_LOGOUT":
        await saveCreds(null);
        await setStore("userInfo", null);
        return { ok: true };

      case "GY_IMPORT_CREDS": {
        if (!msg.accessToken) return { ok: false, error: "access_token 不能为空" };
        await saveCreds({
          accessToken: msg.accessToken.trim(),
          refreshToken: (msg.refreshToken || "").trim(),
          sub: "",
          expiresAt: null,
          capturedAt: Date.now(),
          rawKey: "",
          did: await ensureDid(),
        });
        fetchUserInfo().catch(() => {});
        return { ok: true };
      }

      case "GY_OPEN_LOGIN":
        chrome.tabs.create({ url: "https://www.guangyapan.com/" });
        return { ok: true };

      case "GY_PING":
        return { ok: true };

      default:
        return undefined;
    }
  })().then(
    (result) => sendResponse(result),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) })
  );
  return true;
});
