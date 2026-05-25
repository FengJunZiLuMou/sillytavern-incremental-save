# SillyTavern 1.18 适配说明

这个 fork 不再直接修改 SillyTavern 核心文件，而是拆成两部分：

- 前端第三方扩展：`manifest.json` + `index.js`
- 服务端插件：`server-plugin/index.js`

## 为什么需要服务端插件

增量保存必须写入服务器上的 JSONL 聊天文件，外链图片代理缓存也必须把图片落盘到用户数据目录。普通 SillyTavern 前端扩展不能直接访问服务器文件系统，所以需要启用 SillyTavern 1.18 的 server plugin。

服务端插件注册在：

```text
/api/plugins/incremental-save
```

提供接口：

```text
GET  /api/plugins/incremental-save/status
POST /api/plugins/incremental-save/chats/save-append
POST /api/plugins/incremental-save/chats/group/save-append
GET  /api/plugins/incremental-save/image-proxy?url=...
```

## 前端工作方式

前端扩展不修改 `public/script.js`。它在运行时拦截：

- `fetch('/api/chats/save')`
- `fetch('/api/chats/group/save')`
- `HTMLImageElement.prototype.src`
- DOM 中新增或变化的 `<img src>`

当检测到只是追加新消息或仅 header 更新时，改为调用服务端插件的 `save-append`。如果条件不满足、插件不可用、行数不一致或请求失败，就自动放行原始全量保存。

## 云端部署要点

第一次部署需要在服务器上同时完成：

1. 通过 SillyTavern 安装第三方扩展：

```text
https://github.com/FengJunZiLuMou/sillytavern-incremental-save
```

2. 将 `server-plugin` 安装到 SillyTavern 的 `plugins` 目录。
3. 在 `config/config.yaml` 启用：

```yaml
enableServerPlugins: true
```

4. 重启 SillyTavern。

之后前端扩展可通过 ST 的扩展更新机制更新；服务端插件如使用 git clone 放在 `plugins` 目录，也会跟随 ST 的 server plugin auto-update 机制更新。

## 缓存位置

外链图片磁盘缓存位于当前用户数据目录：

```text
data/<user>/cache/images/
```

缓存文件名使用 `SHA256(URL)`，旁边保存 `.meta.json` 元数据。

## 回滚

禁用或删除前端扩展后，前端不再拦截保存和图片。

删除 `plugins/sillytavern-incremental-save` 或关闭 `enableServerPlugins` 后，服务端插件不再加载。

如果云端还残留旧版核心补丁，应从 Docker Compose 的 `patches/...` 挂载中移除，并恢复原始 `public/script.js`、`public/scripts/*.js`、`src/endpoints/chats.js`。
