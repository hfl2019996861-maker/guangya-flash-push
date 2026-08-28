// 光鸭闪推 - auth-bridge
// 运行于 www.guangyapan.com，从网页版 localStorage 读取登录凭证同步给插件，
// 并在插件续期后把新 token 回写回 localStorage，保持两边登录态一致。

(() => {
  if (!chrome?.runtime?.id) return; // 扩展已重载，本脚本已失效
  const CLIENT_ID = "aMe-8VSlkrbQXpUR";
  const CRED_PREFIX = `credentials_${CLIENT_ID}`;

  let lastSnapshot = "";
  let lastCaptureSent = null;
  let debugMode = false;
  try {
    chrome.storage.local.get("settings").then((s) => {
      debugMode = !!(s && s.settings && s.settings.debugMode);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) {
        debugMode = !!(changes.settings.newValue && changes.settings.newValue.debugMode);
      }
    });
  } catch (e) {}

  // 递归抽取凭证字段，兼容 SDK 存储结构变化
  function extractTokens(obj, found = {}) {
    if (!obj || typeof obj !== "object") return found;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        if (/^access_?token$/i.test(k) && v.length > 20) found.access_token = v;
        else if (/^refresh_?token$/i.test(k) && v.length > 20) found.refresh_token = v;
      } else if (typeof v === "number") {
        if (/^expires_?in$/i.test(k)) found.expires_in = v;
        else if (/^expire[s_]?(at|time|d)?$/i.test(k)) found.expire_time = v;
      } else if (typeof v === "string" && /^expires_?at$/i.test(k) && v.length >= 20) {
        const ts = Date.parse(v);
        if (Number.isFinite(ts)) found.expires_at = ts;
      } else if (v && typeof v === "object") {
        extractTokens(v, found);
      }
    }
    return found;
  }

  function readCreds() {
    let sub = "";
    try {
      sub = localStorage.getItem("current_sub") || "";
    } catch (e) {}

    let rawKey = sub ? `${CRED_PREFIX}@${sub}` : CRED_PREFIX;
    let raw = null;
    try {
      raw = localStorage.getItem(rawKey);
    } catch (e) {}
    if (!raw) {
      rawKey = CRED_PREFIX;
      try {
        raw = localStorage.getItem(rawKey);
      } catch (e) {}
    }
    if (!raw) return null;

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    const tokens = extractTokens(parsed);
    if (!tokens.access_token) return null;

    let expiresAt = null;
    if (tokens.expires_at) {
      expiresAt = tokens.expires_at;
    } else if (tokens.expires_in && Number.isFinite(tokens.expires_in)) {
      // 可能是相对秒数，也可能是绝对时间戳（秒或毫秒）
      const v = tokens.expires_in;
      if (v > 1e12) expiresAt = v;
      else if (v > 1e9) expiresAt = v * 1000;
      else expiresAt = Date.now() + v * 1000;
    } else if (tokens.expire_time) {
      const v = tokens.expire_time;
      expiresAt = v > 1e12 ? v : v * 1000;
    }

    let did = "";
    try {
      did = localStorage.getItem("swangpan_web_device_id") || "";
    } catch (e) {}

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || "",
      sub: String(sub || parsed?.sub || parsed?.user?.sub || ""),
      expiresAt,
      rawKey,
      did,
    };
  }

  // 凭证结构上报（只含字段名/类型/长度，不含值本身）
  function shapeOf(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 3) return typeof obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object") out[k] = shapeOf(v, depth + 1);
      else out[k] = `${typeof v}${typeof v === "string" ? `(${v.length})` : ""}`;
    }
    return out;
  }

  function reportShape() {
    try {
      let sub = "";
      try {
        sub = localStorage.getItem("current_sub") || "";
      } catch (e) {}
      for (const key of [`credentials_aMe-8VSlkrbQXpUR@${sub}`, "credentials_aMe-8VSlkrbQXpUR"]) {
        let raw = null;
        try {
          raw = localStorage.getItem(key);
        } catch (e) {}
        if (!raw) continue;
        try {
          const creds = readCreds();
          chrome.storage.local.set({
            gyCredShape: {
              key,
              shape: shapeOf(JSON.parse(raw), 0),
              capture: {
                hasAccess: !!creds?.accessToken,
                accessLen: creds?.accessToken?.length || 0,
                hasRefresh: !!creds?.refreshToken,
                refreshLen: creds?.refreshToken?.length || 0,
                expiresAt: creds?.expiresAt || null,
              },
              at: Date.now(),
            },
          });
          return;
        } catch (e) {}
      }
    } catch (e) {}
  }

  function capture() {
    const creds = readCreds();
    const snapshot = creds
      ? `${creds.rawKey}|${creds.accessToken}|${creds.refreshToken}`
      : "";
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    lastCaptureSent = creds;
    chrome.runtime.sendMessage({ type: "GY_CAPTURE_CREDS", creds }).catch(() => {});
    if (debugMode) reportShape();
  }

  // 续期回写：递归替换存储结构中的 token 字段
  function writeBack(patch) {
    const creds = readCreds();
    const keys = [creds?.rawKey, CRED_PREFIX].filter(Boolean);
    for (const key of new Set(keys)) {
      let raw = null;
      try {
        raw = localStorage.getItem(key);
      } catch (e) {}
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        const replaced = replaceDeep(obj, patch);
        localStorage.setItem(key, JSON.stringify(replaced));
        return true;
      } catch (e) {}
    }
    return false;
  }

  function replaceDeep(obj, patch) {
    if (!obj || typeof obj !== "object") return obj;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object") {
        replaceDeep(v, patch);
      } else if (typeof v === "string") {
        if (/^access_?token$/i.test(k) && patch.access_token) obj[k] = patch.access_token;
        else if (/^refresh_?token$/i.test(k) && patch.refresh_token) obj[k] = patch.refresh_token;
      } else if (typeof v === "number") {
        if (/^expires_?in$/i.test(k) && patch.expires_in) obj[k] = patch.expires_in;
      }
    }
    return obj;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "GY_WRITE_CREDS") {
      sendResponse({ ok: writeBack(msg.patch || {}) });
      return;
    }
    if (msg?.type === "GY_BRIDGE_PING") {
      sendResponse({ ok: true, hasCreds: !!readCreds() });
      return;
    }
  });

  capture();

  // 凭证同步主要靠 storage / focus 事件，轮询只是兜底。
  // 后台标签页不轮询；长期没有变化就把间隔从 2s 逐步放宽到 30s。
  const POLL_MIN = 2000;
  const POLL_MAX = 30000;
  let pollInterval = POLL_MIN;
  let pollTimer = 0;

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (document.hidden) return;
    pollTimer = setTimeout(() => {
      const before = lastSnapshot;
      capture();
      // 有变化立刻回到高频，没变化就越来越懒
      pollInterval = lastSnapshot === before ? Math.min(pollInterval * 2, POLL_MAX) : POLL_MIN;
      schedulePoll();
    }, pollInterval);
  }

  window.addEventListener("storage", capture);
  window.addEventListener("focus", capture);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) schedulePoll();
  });
  schedulePoll();
})();
