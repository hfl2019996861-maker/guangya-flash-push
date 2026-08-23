// 光鸭闪推 - 设置页逻辑（发布版，改动自动保存）

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let settings = null;
let blacklistTimer = 0;

const FIELD_MAP = {
  optConfirm: "confirmBeforePush",
  optNotify: "notifyOnSuccess",
  optAutoRefresh: "autoRefresh",
  optSniffEnabled: "sniffEnabled",
  optSniffMagnet: "sniffMagnet",
  optSniffEd2k: "sniffEd2k",
  optSniffThunder: "sniffThunder",
  optSniffHttp: "sniffHttp",
  optPlainText: "sniffPlainText",
  optPanel: "showPagePanel",
  optDebug: "debugMode",
};

function showToast(text, isErr) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = "toast"), 1800);
}

// ---------- 账号 ----------

async function load() {
  const state = await send({ type: "GY_GET_STATE" }).catch(() => null);
  settings = state?.settings || {};

  const el = $("accountStatus");
  if (state?.loggedIn) {
    const name = state.userInfo?.nickname || `账号 ${(state.creds?.sub || "").slice(0, 8)}`.trim();
    const exp = state.creds?.expiresAt
      ? `，token 有效期至 ${new Date(state.creds.expiresAt).toLocaleString()}`
      : "";
    const rt = `，refresh_token：${state.creds?.hasRefreshToken ? "正常" : "缺失"}`;
    el.className = "account-status ok";
    el.textContent = "";
    const avatar = state.userInfo?.avatar;
    if (avatar) {
      const img = document.createElement("img");
      img.src = avatar;
      img.alt = "";
      img.className = "acc-avatar";
      img.referrerpolicy = "no-referrer";
      img.onerror = () => img.remove();
      el.appendChild(img);
    }
    el.appendChild(
      document.createTextNode(`✓ 已登录：${name || "光鸭云盘账号"}${rt}${exp}`)
    );
    $("btnLogout").style.display = "";
  } else {
    el.textContent = "未登录 —— 请打开光鸭云盘网页版登录，插件会自动同步";
    el.className = "account-status err";
    $("btnLogout").style.display = "none";
  }

  for (const [id, key] of Object.entries(FIELD_MAP)) {
    $(id).checked = !!settings[key];
  }
  $("optBlacklist").value = settings.blacklist || "";

  // 调试面板：入口常显（折叠态），日志区按开关
  $("debugPanels").style.display = settings.debugMode ? "" : "none";
}

// ---------- 自动保存 ----------

async function savePatch(patch) {
  const resp = await send({ type: "GY_UPDATE_SETTINGS", patch }).catch(() => null);
  if (resp?.ok) {
    settings = resp.settings;
    showToast("✓ 已保存");
  } else {
    showToast("保存失败，请重试", true);
  }
}

for (const [id, key] of Object.entries(FIELD_MAP)) {
  $(id).addEventListener("change", () => {
    savePatch({ [key]: $(id).checked });
    // 调试开关切换时刷新面板可见性
    if (id === "optDebug") {
      $("debugPanels").style.display = $(id).checked ? "" : "none";
    }
  });
}

$("optBlacklist").addEventListener("input", () => {
  clearTimeout(blacklistTimer);
  blacklistTimer = setTimeout(() => savePatch({ blacklist: $("optBlacklist").value.trim() }), 800);
});

// ---------- 账号操作 ----------

$("btnOpenLogin").addEventListener("click", () => send({ type: "GY_OPEN_LOGIN" }));

$("btnRefresh").addEventListener("click", async () => {
  const btn = $("btnRefresh");
  btn.disabled = true;
  btn.textContent = "续期中…";
  try {
    const resp = await send({ type: "GY_FORCE_REFRESH" }).catch(() => null);
    if (resp?.ok) {
      showToast(`✓ 续期成功，新有效期至 ${resp.expiresAt ? new Date(resp.expiresAt).toLocaleString() : "未知"}`);
    } else {
      showToast(resp?.error || "续期失败，请重新打开网页版登录", true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "立即续期 Token";
    load();
  }
});

$("btnLogout").addEventListener("click", async () => {
  if (!confirm("确定清除插件中保存的登录态？（不影响网页版登录）")) return;
  await send({ type: "GY_LOGOUT" }).catch(() => {});
  load();
});

$("btnImport").addEventListener("click", async () => {
  const raw = $("importToken").value.trim();
  if (!raw) {
    showToast("请粘贴 access_token", true);
    return;
  }
  const [accessToken, refreshToken] = raw.split(/\s+/);
  const resp = await send({ type: "GY_IMPORT_CREDS", accessToken, refreshToken }).catch(() => null);
  if (resp?.ok) {
    showToast("✓ 导入成功");
    $("importToken").value = "";
    load();
  } else {
    showToast(resp?.error || "导入失败", true);
  }
});

// ---------- 调试面板 ----------

async function loadDebugPanels() {
  if (!(await send({ type: "GY_GET_STATE" }).catch(() => null))?.settings?.debugMode) return;
  const store = await chrome.storage.local.get(["gyCaptureLog", "gyDiag", "gyCredShape", "gySwStart"]);

  const cap = store.gyCaptureLog;
  $("captureLogPre").textContent = cap
    ? `${new Date(cap.at).toLocaleTimeString()} access:${cap.accessLen}字符 refresh:${cap.hasRefresh ? cap.refreshLen + "字符" : "无"}`
    : "（尚未收到网页版凭证消息）";

  const diag = store.gyDiag;
  $("diagPre").textContent = diag
    ? `页面: ${diag.url}\n识别: ${diag.found} 个\n链接: ${(diag.labels || []).join(" | ") || "无"}\n错误: ${diag.lastError || "无"}`
    : "（打开任意网页后显示最近一次嗅探信息）";

  const userRaw = store.gyUserRaw;
  $("userRawPre").textContent = userRaw
    ? `${new Date(userRaw.at).toLocaleTimeString()} ${JSON.stringify(userRaw.fields)}`
    : "（触发一次状态刷新后显示）";

  const shape = store.gyCredShape;
  $("shapePre").textContent = shape
    ? `存储键: ${shape.key}\n结构: ${JSON.stringify(shape.shape)}\n提取: ${JSON.stringify(shape.capture || "-")}`
    : "（打开一次光鸭云盘网页版后显示）";
}

// ---------- 启动 ----------

load();
loadDebugPanels();
setInterval(() => {
  if (document.visibilityState === "visible") {
    load();
    loadDebugPanels();
  }
}, 5000);
