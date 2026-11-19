# 国外小博主寻找器 · 发布仓库

最新版本 **1.1.6**。这个仓库同时放**源码**（`src/`、`public/`、`server.js`、`electron-main.js`…，可直接阅读）和**发布产物**。

## 下载

| 用途 | 文件 | 直连 | 国内加速 |
|---|---|---|---|
| 便携版（免安装，默认直连） | `creator-finder-1.1.6-portable.zip` | [直连](https://github.com/meiyoume/creator-finder-release/releases/download/v1.1.6/creator-finder-1.1.6-portable.zip) | [gh-proxy](https://gh-proxy.com/https://github.com/meiyoume/creator-finder-release/releases/download/v1.1.6/creator-finder-1.1.6-portable.zip) |
| 标准版（覆盖已安装目录，保留默认代理） | `creator-finder-1.1.6-standard.zip` | [直连](https://github.com/meiyoume/creator-finder-release/releases/download/v1.1.6/creator-finder-1.1.6-standard.zip) | [gh-proxy](https://gh-proxy.com/https://github.com/meiyoume/creator-finder-release/releases/download/v1.1.6/creator-finder-1.1.6-standard.zip) |
| 源码包 | `creator-finder-source-1.1.6.zip` | [直连](https://github.com/meiyoume/creator-finder-release/releases/download/v1.1.6/creator-finder-source-1.1.6.zip) | [gh-proxy](https://gh-proxy.com/https://github.com/meiyoume/creator-finder-release/releases/download/v1.1.6/creator-finder-source-1.1.6.zip) |

软件内的「检查更新」会自动在直连和 3 个国内镜像之间测速，挑最快的通道下载，不需要手动选。

## 源码

- `src/net.js`：网络层（Chromium 传输 + curl 回退、同域名串行、429 退避、备用出口轮换）
- `src/bridge.js`：跨平台桥接（从 Kick/YouTube/TikTok 的公开资料里抽其它平台账号）
- `src/search-api.js`：Brave Search API 可选通道
- `src/updater.js`：应用内升级（镜像测速、sha256、覆盖安装）
- `src/platforms/`：六个平台的发现与核验
- `public/`：界面

## latest.json

给 jsDelivr 兜底用的版本清单（`api.github.com` 不可达时读取）：
`https://cdn.jsdelivr.net/gh/meiyoume/creator-finder-release@main/latest.json`
