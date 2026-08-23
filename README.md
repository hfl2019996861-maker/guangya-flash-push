<div align="center">

# ⚡ 光鸭闪推

**嗅探网页中的磁力 / ed2k / 迅雷链接，一键推送到光鸭云盘离线下载**

[![Version](https://img.shields.io/badge/version-2.1.1-orange)](https://github.com/hfl2019996861-maker/guangya-flash-push/releases)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-110%2B-4285F4)](https://developer.chrome.com/docs/extensions/develop/migration)
[![Manifest](https://img.shields.io/badge/Manifest-V3-34A853)](./manifest.json)
[![Privacy](https://img.shields.io/badge/%E9%9A%90%E7%A7%81-%E4%B8%8D%E4%B8%8A%E4%BC%A0-success)](#%EF%B8%8F-隐私声明)

网页版「云添加」的快捷入口 —— 看到磁力，点一下，云盘见。

</div>

---

## ✨ 功能特性

- **智能嗅探** — 自动识别页面中的下载链接，链接旁直接出现「⚡推送」按钮
  - 磁力链接（`xt` 参数顺序任意，v1/v2 哈希）
  - ed2k 链接 · 迅雷链接（自动解码还原）
  - 超链接 / 正文纯文本 / 输入框 / `data-*` 属性，支持 Shadow DOM 与 iframe
- **一键推送** — 推送前解析并展示资源名称、大小、文件数，确认后提交
- **批量推送** — 右下角面板显示「发现 N 个链接」，支持整页推送
- **右键直达** — 任意链接或选中文本上右键 →「推送到光鸭云盘」
- **目录选择** — 弹窗内逐级浏览云盘目录，指定保存位置
- **登录同步** — 网页版登录一次即可，token 到期前自动续期，无需反复登录
- **任务面板** — 弹窗内查看最近云下载任务与实时状态

## 📦 安装

**方式一：下载 Release（推荐）**

1. 打开 [Releases](https://github.com/hfl2019996861-maker/guangya-flash-push/releases)，下载最新 `release.zip` 并解压
2. Chrome / Edge 打开 `chrome://extensions/`
3. 开启右上角「开发者模式」→「加载已解密的扩展程序」→ 选择解压出的文件夹

**方式二：克隆源码**

```bash
git clone https://github.com/hfl2019996861-maker/guangya-flash-push.git
```

然后同样在 `chrome://extensions/` 开发者模式下加载该文件夹。

## 🚀 三步上手

1. **登录** — 打开 [光鸭云盘网页版](https://www.guangyapan.com/) 并登录，插件自动同步（弹出「登录成功」通知即完成）
2. **嗅探** — 打开任意资源页（已打开的页面按 `F5` 刷新一次），链接旁出现「⚡推送」按钮
3. **推送** — 点击按钮确认，任务即刻进入云下载

## ⚙️ 设置项

| 设置 | 说明 | 默认 |
| :--- | :--- | :---: |
| 推送前确认 | 展示资源名称/大小/文件数，确认后提交 | 开 |
| 推送成功通知 | 系统通知提醒 | 开 |
| 自动续期登录 | token 到期前自动续期并回写网页版 | 开 |
| 启用链接嗅探 | 总开关 | 开 |
| 嗅探类型 | 磁力 / ed2k / 迅雷 / HTTP 直链 | 前三项开 |
| 纯文本嗅探 | 识别未做成超链接的正文磁力 | 开 |
| 右下角面板 | 「发现 N 个链接」悬浮面板 | 开 |
| 站点黑名单 | 每行一个 host，支持 `*` 通配 | 空 |

## ❓ 常见问题

<details>
<summary><b>为什么提示「请先登录」？</b></summary>

打开一次[光鸭云盘网页版](https://www.guangyapan.com/)并确保处于登录状态即可，插件会自动同步凭证。token 平时自动续期，只有极长时间（超过 refresh_token 有效期）完全不用浏览器后才需要重新登录。

</details>

<details>
<summary><b>为什么页面上没有推送按钮？</b></summary>

依次检查：① 该页面是否在插件安装/更新**之后**加载（`F5` 刷新）；② 页面是否命中黑名单；③ 浏览器内部页面（`chrome://` 等）不支持嗅探；④ Chrome 启动时若弹出「停用开发者模式扩展程序」气泡，请选择**保留**。

</details>

<details>
<summary><b>支持迅雷链接吗？</b></summary>

支持。插件会先把 `thunder://` 链接本地解码还原成其中的磁力/HTTP 地址再推送，不依赖服务端支持。

</details>

<details>
<summary><b>我的账号安全吗？</b></summary>

凭证只保存在你浏览器本地的 `chrome.storage.local`；网络请求只发往光鸭云盘官方域名（`*.guangyapan.com`）；开源代码可自行审计，无任何统计与上报。

</details>

## 🛡️ 隐私声明

- 凭证与设置仅保存在浏览器本地，**不上传任何服务器**
- 链接嗅探完全在浏览器内完成
- 网络请求只发往 `*.guangyapan.com`

## 🔍 工作原理

```
网页登录 ──► auth-bridge 读取凭证 ──► 自动同步 / 自动续期
                                          │
资源页面 ──► sniffer 嗅探链接 ──► 推送按钮 │
                                          ▼
                              resolve_res 解析 → create_task 建任务
```

- 云下载调用光鸭云盘官方接口：`resolve_res`（解析）→ `create_task`（建任务）→ `list_task`（任务列表）
- 登录凭证来自网页版 localStorage（`@xbase/sdk` 存储），续期走 `account.guangyapan.com` 并双向同步
- 页面 UI 全部使用 Shadow DOM 隔离，不污染网页样式

## 🛠️ 开发指南

```bash
git clone https://github.com/hfl2019996861-maker/guangya-flash-push.git
```

- 目录结构：`src/background`（Service Worker）/ `src/content`（嗅探 + 凭证桥）/ `src/popup` / `src/options` / `tools`（图标与安装脚本）
- **修改代码后必须到 `chrome://extensions` 点击本扩展卡片上的「重新加载」**——Chrome 会缓存开发模式扩展的 Service Worker，重启浏览器不会加载新代码
- 设置页底部「开发者诊断」可查看嗅探与凭证同步的内部状态（不含 token 内容）

## 📄 许可与声明

[MIT License](./LICENSE) · 仅供个人学习研究使用，请遵守当地法律法规，勿用于传播侵权内容。本项目与光鸭云盘官方无关。

---

<div align="center">

**如果这个插件帮到了你，欢迎点一个 ⭐ Star 让更多人看到**

</div>
