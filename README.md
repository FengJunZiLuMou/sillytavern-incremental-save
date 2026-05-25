# SillyTavern Incremental Save for ST 1.18

这是基于 `ransxd/sillytavern-incremental-save` 的 SillyTavern 1.18 适配版。

当前 fork 的目标是：尽量不再直接修改 SillyTavern 核心文件，而是用“前端第三方扩展 + 服务端插件”的方式提供增量保存和外链图片代理缓存。

## 当前结构

```text
manifest.json              # SillyTavern 前端第三方扩展入口
index.js                   # 运行时拦截保存请求和外链图片
server-plugin/index.js     # SillyTavern server plugin，提供文件追加和图片代理
patches/                   # upstream 原补丁，保留作参考和兼容安装
new-files/                 # upstream 原新增文件，保留作参考
docs/ST-1.18-ADAPTATION.md # 适配说明
```

## 安装方式

### 1. 安装前端扩展

在 SillyTavern 的扩展管理里安装：

```text
https://github.com/FengJunZiLuMou/sillytavern-incremental-save
```

### 2. 安装服务端插件

把本仓库放到 SillyTavern 的 `plugins` 目录，并确保 `server-plugin` 里的入口文件能被 ST 加载。

推荐部署形态：

```text
plugins/sillytavern-incremental-save/
  package.json
  index.js
```

其中 `package.json` 和 `index.js` 来自本仓库的 `server-plugin/` 目录。

也可以在服务器上执行：

```bash
./install-server-plugin.sh /opt/sillytavern
```

然后在 `config/config.yaml` 启用：

```yaml
enableServerPlugins: true
```

重启 SillyTavern。

## 功能

- 个人聊天增量保存：只追加新消息，失败自动回退全量保存。
- 群聊增量保存：只追加新消息，失败自动回退全量保存。
- 外链图片代理缓存：外部图片改写到 `/api/plugins/incremental-save/image-proxy?url=...`，服务端磁盘缓存 7 天。
- 不再需要直接修改 `public/script.js`、`public/scripts/chats.js`、`src/endpoints/chats.js`。

## 注意

SillyTavern 的普通“安装扩展”只会安装前端扩展，不会自动启用 server plugin。首次部署服务端插件仍需要服务器权限。

更多适配细节见 [docs/ST-1.18-ADAPTATION.md](docs/ST-1.18-ADAPTATION.md)。

---

以下是 upstream 原说明，保留作参考。

# SillyTavern Performance Patches

## 优化效果

以 110MB / 964 条消息的实际聊天记录测试：

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 保存消息 | 全量上传 110MB，耗时数秒 | 增量追加，**~5ms** |
| 外部图片加载 | 每次从源站下载，单张 5-29s | 首次代理缓存，之后 **~8ms** |
| 发消息到 AI 响应的等待 | 50+ 次串行 token 计数，**~20s 空等** | 字符估算，**<1s** |

## 功能详解

### 1. 增量保存（Incremental Save）

**问题**：SillyTavern 每次发消息后将完整聊天记录全量上传覆写文件。110MB 的聊天每发一条消息都要传 110MB。

**方案**：检测到仅新增消息时，只上传新增部分并追加到文件末尾。

```
发一条消息 → 检测变更类型
  ├─ 仅新增消息     → save-append：只上传新消息（毫秒级）
  ├─ 仅元数据变更   → save-append：空消息 + 更新头部（毫秒级）
  └─ 编辑/删除/swipe → 回退全量保存（保证数据一致性）
```

**实现细节**：

- 前端通过消息数量 + 内容 hash 判断是否可增量保存
- 新增 `/api/chats/save-append` 和 `/api/chats/group/save-append` 端点
- `expectedLines` 校验确保客户端与服务端文件行数一致，不匹配则拒绝增量并回退全量
- 支持 header-only 更新（`saveMetadataDebounced` 等触发的仅元数据变更）

### 2. 外部图片代理缓存（Image Proxy Cache）

针对「命定之诗」等大量使用外部图床的角色卡做的特别优化。

**问题**：聊天中嵌入的外部图片（如 `files.catbox.moe`）没有 `Cache-Control` 头，每次加载/切换聊天都重新从源站下载。20 张图 = 32MB 重复流量。

**方案**：服务端代理 + 磁盘缓存 + 浏览器长缓存三级缓存。

```
浏览器渲染消息 → 外部图片 URL 自动改写为 /api/image-proxy?url=...
  ↓
第 1 次请求：服务端下载 → 磁盘缓存 → 返回（Cache-Control: 7天）
第 2 次请求：服务端读磁盘 → 返回（~8ms）
第 3+ 次：浏览器本地缓存直接返回（不发请求）
```

**实现细节**：

- 通过 `HTMLImageElement.prototype.src` setter 拦截 + DOMPurify 钩子双重覆盖，确保所有外部图片（包括扩展通过 `new Image()` 加载的）都走代理
- SHA256(URL) 作为缓存文件名，存储在 `data/<user>/cache/images/`
- 并发去重：同一 URL 的多个请求只发起一次远程下载
- 安全限制：仅代理 HTTP/HTTPS，单文件最大 10MB

### 3. Token 快速估算（Token Fast Estimate）

**问题**：SillyTavern 在发送 generate 请求前，需要逐条消息计算 token 数来决定上下文窗口塞多少消息。当 token 缓存为空时（首次加载、切换聊天、`squashSystemMessages` 合并消息），会串行发起 50+ 个 HTTP 请求，每个 200-500ms，累计阻塞 **15-20 秒**。

**方案**：缓存未命中时立即返回字符估算值，后台异步获取真实值并回填缓存。

```
缓存未命中 → 立刻返回 Math.ceil(text.length / 3.35)（0ms）
           → 后台异步请求真实 token 数 → 写入 IndexedDB 缓存
下次同消息 → 缓存命中 → 直接返回真实值（0ms）
```

**实现细节**：

- 估算比率 `3.35 字符/token` 与 SillyTavern 服务端 fallback 一致
- `squashSystemMessages()` 每次合并消息内容不同导致 hash 不同，永远命中不了缓存——改为估算后从 ~17s 阻塞降为 0
- 估算偏差（偏高估）可能导致首次少包含 1-2 条旧消息，第二次发消息即恢复精确值

## 适用版本

- SillyTavern **1.16.0**（`ghcr.io/sillytavern/sillytavern:latest`）

## 安装

### Docker

```bash
git clone https://github.com/ransxd/sillytavern-incremental-save.git
cd sillytavern-incremental-save
./install.sh --docker sillytavern
```

容器名默认 `sillytavern`，不同则替换最后的参数。脚本会自动备份原始文件到 `backups/` 目录、应用补丁、重启容器。

### 本地安装

```bash
git clone https://github.com/ransxd/sillytavern-incremental-save.git
cd sillytavern-incremental-save
./install.sh --local /path/to/SillyTavern
```

应用后需手动重启 SillyTavern。

## 卸载

```bash
# Docker
./uninstall.sh --docker sillytavern

# 本地
./uninstall.sh --local /path/to/SillyTavern
```

所有补丁通过 `patch -R` 反向还原，不会残留修改。

## 验证方法

安装后打开浏览器 DevTools → Network 面板：

**增量保存**：
1. 发送第一条消息 → 看到 `/api/chats/save`（全量，初始化跟踪状态）
2. 再发一条 → 看到 `/api/chats/save-append`（增量）
3. 编辑旧消息 → 回退到 `/api/chats/save`（全量）
4. Console 中会打印 `Incremental save: appending N new message(s)` 或 `header-only update`

**图片缓存**：
1. 打开包含外部图片的聊天
2. 图片请求 URL 变为 `/api/image-proxy?url=...`
3. 响应头 `X-Image-Cache: HIT`（命中）或 `MISS`（首次）
4. 刷新页面 → 图片瞬间加载

**Token 快速估算**：
1. 发送消息后，`save-append` 和 `generate` 之间间隔应 <2s（之前 ~20s）
2. `tokenizers/openai/count` 请求出现在 `generate` 请求之后（异步后台执行）
3. 第二次发消息 → `tokenizers/openai/count` 请求大幅减少（缓存命中）

## 修改的文件

```
patches/
  chats.server.patch      → src/endpoints/chats.js         增量保存服务端端点
  script.patch             → public/script.js               增量保存前端逻辑 + Image.src 拦截器
  group-chats.patch        → public/scripts/group-chats.js  群组聊天增量保存
  server-startup.patch     → src/server-startup.js          注册图片代理路由
  chats.patch              → public/scripts/chats.js        DOMPurify 图片 URL 改写
  tokenizers.patch         → public/scripts/tokenizers.js   Token 快速估算

new-files/
  image-proxy.js           → src/endpoints/image-proxy.js   图片代理缓存端点（新文件）
```

## 安全性

- 增量保存失败时**自动回退**全量保存，不会丢数据
- `expectedLines` 校验确保客户端与服务端数据一致，不匹配拒绝增量
- 原有的 integrity check、backup 机制完全保留
- 编辑/删除/swipe 等操作不受影响，自动触发全量保存
- 图片代理仅允许 HTTP/HTTPS 协议，单文件限制 10MB
- 图片缓存跟随用户数据目录，Docker volume 持久化

## License

MIT
