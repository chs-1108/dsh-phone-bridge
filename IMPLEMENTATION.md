# phone-bridge 实现原理

用手机浏览器或原生 App 跟电脑上的 DSH 对话：发文字、拍照、传图，回复实时流式回显。

本文说明**它到底怎么实现的、用了什么技术、每一层为什么这么选**。

---

## 1. 整体架构

```
┌─────────────────────────────┐
│  手机（Android）             │
│  ┌───────────────────────┐  │
│  │ 原生壳 MainActivity    │  │   Java + WebView
│  │  ┌─────────────────┐  │  │
│  │  │ WebView         │  │  │   ← 加载 http://PC:19387/phone-bridge/
│  │  │  app.html       │  │  │
│  │  │  + client 逻辑   │  │  │
│  │  └─────────────────┘  │  │
│  │  拍照 / 相册 → URI     │  │
│  └───────────────────────┘  │
└──────────────┬──────────────┘
               │ HTTP（Tailscale 内网 VPN）
               │ 明文 http，局域网/虚拟内网
┌──────────────┴──────────────┐
│  电脑（DSH 桌面端）           │
│  ┌───────────────────────┐  │
│  │ webServer（Cordis 服务）│  │
│  │  ↓ 前缀路由 /phone-bridge│ │
│  │ phone-bridge 插件      │  │
│  │  index.js（Host 半）   │  │
│  └──────────┬────────────┘  │
│             │ ctx.sessionController
│  ┌──────────┴────────────┐  │
│  │ DSH 会话引擎            │  │  prompt() / follow()
│  │ Claude / DeepSeek …    │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

**一句话**：插件在 DSH 的 webServer 上挂了一个 `/phone-bridge` 前缀路由，手机访问这个路由拿到网页 + JSON API，插件再代理到 DSH 内部的 `sessionController` 服务。

---

## 2. 插件是「双半」结构

DSH 插件由两半组成，缺一不可：

| 半 | 文件 | 运行环境 | 职责 |
| --- | --- | --- | --- |
| **Host 半** | `index.js` | Node.js（Electron 主进程） | 挂路由、连 DSH 会话、起隧道 |
| **Client 半** | `client.js` | 浏览器渲染进程 | 在 DSH 设置页注入「手机同步」UI 面板 |

`package.json` 里用 `dsh.client` 字段声明 client 入口：

```json
{
  "name": "dsh-phone-bridge",
  "dsh": {
    "client": "./client.js"
  }
}
```

### 关键约束：注册 id 必须等于包名

`client.js` 开头：

```js
window.__ModuleLoader__.load({
  id: 'dsh-phone-bridge',        // ← 必须 === package.json 的 name
  factory: (require) => { ... }
})
```

**踩过的坑**：早先写成 `id: 'phone-bridge'`，跟包名 `dsh-phone-bridge` 不一致，DSH 报：

```
duplicate factory registration for "phone-bridge"
web boot: 1 entry did not activate
```

整个插件静默失效。**这条规则是硬性的**：加载器按 id 去匹配 `package.json.name`，对不上就注册失败。

### Host 半声明依赖

```js
export const name = 'phone-bridge'
export const inject = ['webServer', 'sessionController']
export function apply(ctx, config) { ... }
export default { name, inject, apply }
```

`inject` 让 Cordis 在 `apply()` 被调用**之前**把这两个服务注入好。

---

## 3. 路由：怎么把 HTTP 请求接进 DSH

```js
const ROUTE_PREFIX = '/phone-bridge'

export function apply(ctx, config) {
  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,       // 所有 /phone-bridge/* 都进 handle()
    handler: handle,
  })
}
```

`kind: 'prefix'` 是**前缀匹配**，不是精确匹配——所以 `/phone-bridge/api/send`、`/phone-bridge/health` 全落到同一个 `handle(req, res)`，内部用 `URL` 解析后再分发。

### 路由清单

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/phone-bridge/` | 返回 `web/app.html` 单页 |
| `GET` | `/phone-bridge/health` | 探活，**唯一免鉴权**的接口 |
| `GET` | `/phone-bridge/api/sessions` | 列出可选的 DSH 会话 |
| `POST` | `/phone-bridge/api/send` | 发消息（文字 + 图片） |
| `GET` | `/phone-bridge/api/poll` | 拉取进度 / 回复 |
| `POST` | `/phone-bridge/api/prefs` | 切换会话、清空会话、偏好设置 |
| `POST` | `/phone-bridge/api/tunnel` | `action: start\|stop` 控制 cloudflared |
| `GET` | `/phone-bridge/api/status` | 管理端状态（仅本机回环） |

---

## 4. 鉴权模型

核心函数：

```js
function isLocalAdmin(req) {
  return isLoopbackAddress(remoteAddress(req)) && !isTunneled(req)
}

function isLocalAdmin(req) { ... }
const authorized = admin || (token !== '' && timingSafeEqual(token, state.token))
```

两条通路：

| 通路 | 条件 | 用途 |
| --- | --- | --- |
| **本机管理员** | 来源 IP 是回环 **且** 不是隧道转发 | 电脑上直接开管理接口，不用输 token |
| **Token** | `timingSafeEqual(token, state.token)` | 手机等外部设备 |

### Token 从哪读

```js
function tokenFrom(req, url) {
  // 1. Authorization: Bearer <token>
  // 2. ?token=<token>
  // 3. ?k=<token>
}
```

**踩过的坑**：一开始用 URL fragment 传 token：

```
#t=04f5bca5...
```

页面显示 `{"ok":false,"error":"unauthorized"}`。原因很基础但很致命——**`#` 后面的内容永远不会发给服务器**，浏览器只在本地保存。必须用 query 参数：

```
http://100.x.y.z:19387/phone-bridge/?token=04f5bca5...
```

### 恒时比较

```js
function timingSafeEqual(a, b) {
  // 定长比较，避免计时侧信道
}
```

Token 是 48 位十六进制（24 字节随机），存在 `~/.dsh/phone-bridge/state.json`。

---

## 5. 会话绑定：消息怎么进到「那个」窗口

### 状态文件

`~/.dsh/phone-bridge/state.json`：

```json
{
  "token": "<YOUR_TOKEN>",
  "sessionId": "session-66014b02-4bfd-44cb-a577-6bfe6bda2be3",
  "cwd": null,
  "defaultShowThinking": false
}
```

### 惰性创建

```js
async ensureSession() {
  if (this.state.sessionId) {
    const known = await this.ctx.sessionController
      .inspect(this.state.sessionId, new AbortController().signal)
      .then(() => true)
      .catch(() => false)
    if (known) return this.state.sessionId      // 复用
    this.state.sessionId = null                  // 失效了就重建
  }
  const cwd = this.state.cwd || process.cwd()
  const created = await this.ctx.sessionController.create({ cwd })
  this.state.sessionId = created.sessionId
  saveState(this.state)
  return this.state.sessionId
}
```

**踩过的坑**：`state.json` 里放了占位符 `session-aaa`，`inspect()` 失败 → 自动建了个新会话，**你的消息跑到了别的窗口**。修复方式是用 `/api/prefs` 把 sessionId 钉到目标会话。

`/api/prefs` 的两个用法：

```json
{"sessionId": "session-66014b02-..."}   // 钉到指定会话
{"newSession": true}                     // 清空，下次自动新建
```

---

## 6. 发送：文字 + 图片怎么变成 DSH 消息

```js
async send(input) {
  const content = []
  if (trimmed) content.push({ type: 'text', text: trimmed })
  for (const image of images.slice(0, 8)) {
    const mediaType = String(image.mediaType || 'image/jpeg')
    const data = image.data.replace(/^data:[^;]+;base64,/, '')   // 剥掉 data URL 头
    if (!/^image\/(png|jpeg|webp|gif)$/.test(mediaType)) continue
    content.push({ type: 'image', mediaType, data })
  }
  ...
}
```

产出的是**多模态 content 数组**，跟 DSH 内部消息格式一致。

限制：最多 8 张图，MIME 白名单四种。

然后交给会话引擎：

```js
await this.ctx.sessionController.prompt(
  {
    requestId: job.requestId,
    sessionId,
    mode: 'queue',              // 排队，不打断正在跑的回合
    content,
  },
  new AbortController().signal,  // 实现内部会 signal.throwIfAborted()
)
```

**踩过的坑**：`prompt()` 第二参数**必须是真 AbortSignal**，传 `undefined` 会在内部 `throwIfAborted()` 崩掉。

---

## 7. 流式回显：怎么把回复推回手机

DSH 的 `follow()` 返回**异步迭代器**，插件在后台持续消费：

```js
ensureFollower(sessionId) {
  const controller = new AbortController()
  ;(async () => {
    const stream = this.ctx.sessionController.follow(
      { address: { kind: 'session', sessionId }, assistantStream: true },
      controller.signal,
    )
    for await (const frame of stream) {
      this.onFrame(frame)      // 逐帧处理
    }
  })()
}
```

`assistantStream: true` 意味着**助手输出边生成边推送**，不是等全部完成。

### Job 状态机

每次 `send` 建一个 job：

```
queued → running → done
                 ↘ error
```

`onFrame()` 按帧类型更新 job：

- 文本增量 → 追加到 `job.text`
- 思考块 → 追加到 `job.reasoning`（受 `showThinking` 控制）
- 结束帧 → `job.status = 'done'`

job 有 45 分钟 TTL，`prune()` 定期清理。

### 手机端取结果

```
GET /phone-bridge/api/poll?job=<id>
```

返回当前进度和已累积的文本。手机端轮询这个接口拿增量。

---

## 8. 原生 Android 壳：为什么需要它

纯网页在手机上能用，但**拍照体验很差**——HTML 的 `<input type="file">` 在 Android 上的行为各家不一致，尤其国产 ROM。所以配了一个原生壳。

### 技术选型：不用 Gradle

| 工具 | 作用 |
| --- | --- |
| `javac`（JDK 17） | 编译 Java |
| `aapt2` | 编译资源 + 链接 manifest |
| `d8` | `.class` → `classes.dex` |
| `zipalign` | 4 字节对齐 |
| `apksigner` | v1/v2/v3 签名 |

7 步流水线，`build-apk.ps1` 一把梭。**不依赖 Gradle / AGP**，整套工具链只有几百 MB，构建 10 秒完成。

### 四个组件

| 类 | 职责 |
| --- | --- |
| `SetupActivity` | LAUNCHER 入口，扫码配对 / 手填地址 |
| `MainActivity` | WebView 容器 + 文件选择 + 相机 |
| `ScanActivity` | zxing 扫码（配对二维码） |
| `CaptureProvider` | 给相机提供写入 URI（降级方案） |

### WebView 关键配置

```java
settings.setJavaScriptEnabled(true);
settings.setDomStorageEnabled(true);
settings.setAllowContentAccess(true);     // 允许 content:// URI
settings.setAllowFileAccess(false);       // 禁 file:// 更安全
settings.setMixedContentMode(MIXED_CONTENT_NEVER_ALLOW);
```

### 预置配对信息

`BuildDefaults.java`（由 `build-apk.ps1` 生成）：

```java
static final String BASE_URL = "http://100.x.y.z:19387/phone-bridge";
static final String TOKEN = "04f5bca5...";
```

`BridgeConfig.baseUrl()` 在预置值非空时直接返回它，所以**首次启动就跳过扫码页**，直接进主界面。

构建时传入：

```powershell
./build-apk.ps1 -BaseUrl "http://100.x.y.z:19387/phone-bridge" -Token "04f5..."
```

---

## 9. 拍照链路（最难的一块，9 个 bug）

完整路径：

```
用户点「拍照」
  → WebView 触发 onShowFileChooser
  → MainActivity 构造 ACTION_IMAGE_CAPTURE Intent
  → 系统选择器 / 相机 App
  → 相机写入 URI（MediaStore 或自有 Provider）
  → onActivityResult 拿回 URI
  → WebView 的 <input type=file> 收到 File
  → JS FileReader 读成 base64 data URL
  → POST /api/send
  → DSH 收到图片
```

### 踩过的 9 个坑

| # | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | `client.js` 插件不激活 | 注册 id ≠ 包名 | 改成 `dsh-phone-bridge` |
| 2 | zip 里没有 `cloudflared.exe` | `package.json.files` 漏 `bin` | 补上 |
| 3 | 相机报写入失败 | `openFile()` 硬编码 `MODE_READ_ONLY` | 按 `mode` 参数映射读写标志 |
| 4 | 拍照后静默无反应 | `query()` 返回 `null`，WebView 问文件名/大小拿不到 | 用 `MatrixCursor` 返回 `DISPLAY_NAME` + `SIZE` |
| 5 | base64 为空 | `fileInput.value=''` 在 `FileReader` 之前执行，`File` 对象失效 | 所有文件读完后才清空 |
| 6 | 绕过选择器直接进相机 | `capture="environment"` 属性 | 移除，改用 `multiple` |
| 7 | **相机完全写不进去** | provider `android:exported="false"`，相机是别的 App | 改 `exported="true"` |
| 8 | 写授权被丢弃 | Android 11+ `EXTRA_OUTPUT` 写授权必须走 `ClipData` | `intent.setClipData(...)` |
| 9 | 读不回图片 | Android 13+ 需要 `READ_MEDIA_IMAGES` | 启动时请求 |

### 最终方案：写 MediaStore，不写私有 Provider

**关键转折**：私有 `ContentProvider` 的授权传递在国产 ROM（尤其 MIUI）上极不可靠。改成写系统 `MediaStore`：

```java
private Uri createImageOutputUri() {
    ContentValues values = new ContentValues();
    values.put(MediaStore.Images.Media.DISPLAY_NAME, "dsh-bridge-" + System.currentTimeMillis() + ".jpg");
    values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
    values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES);
    return getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
}
```

**为什么这个能成**：所有相机 App 都已经有写 `MediaStore` 的权限，**不需要任何跨进程 URI 授权**。绕开了授权传递的全部坑。

写完后校验：

```java
private boolean mediaStoreEntryHasBytes(Uri uri) {
    // query OpenableColumns.SIZE，> 0 才算成功
}
private void discardMediaStoreEntry(Uri uri) {
    // 空记录删掉，不留垃圾
}
```

私有 Provider 保留为降级路径（设备无外部存储卷时）。

### 权限请求时机

```java
// 启动后 600ms 预请求（不抢 WebView 初始化的焦点）
if (!missingPermissions().isEmpty()) {
    web.postDelayed(() -> requestPermissions(missing.toArray(new String[0]), REQ_CAMERA_PERMISSION), 600);
}
```

```java
// 点拍照时兜底（用户可能拒绝了启动时的请求）
if (!missingPermissions().isEmpty() && cameraIntent != null) {
    pendingChooser = chooser;
    requestPermissions(...);
    return;   // 授权回调里再 launchChooser
}
```

### 线程问题

```java
public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
    pendingFileCallback = callback;
    runOnUiThread(() -> openChooser(params));   // ← 必须
    return true;
}
```

`requestPermissions()` 和 `startActivityForResult()` **都必须在主线程**。WebView 回调不保证在主线程，不加 `runOnUiThread` 会静默失败（权限对话框根本不弹）。

---

## 10. 网络方案：为什么用 Tailscale

目标：**不同 WiFi 下手机能直接访问电脑**。

### 试过的方案

| 方案 | 结果 |
| --- | --- |
| **cloudflared 快速隧道** | 返回 429（限流），放弃 |
| **贝锐花生壳免费版** | 边缘拦截，外部 `:50577` 返回花生壳自己的首页，不是我们的服务 |
| **`--host 0.0.0.0` + 端口转发** | CLI 参数被 `startup.js:40` 拦下 |
| **Tailscale** | ✅ 成了 |

### Tailscale 为什么最优

- **点对点加密内网**（WireGuard），不经过任何中转服务器
- **两台设备各拿一个固定 IP**：`100.x.y.z`，跟物理网络无关
- **换 WiFi / 用 4G 都不用改配置**
- 免费版够用（100 台设备）

当前环境：

```
电脑  your-pc     100.x.y.z
手机  your-phone     100.a.b.c
账户  you@example
```

手机始终访问 `http://100.x.y.z:19387/phone-bridge/?token=...`。

### 仍然需要 `host: 0.0.0.0`

服务默认只监听 `127.0.0.1`。改成 `0.0.0.0` 才能接受来自 Tailscale 接口的连接：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: webserver
  name: '@deepseek-ai/dsh-web-server'
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
  inject: [webStartup]
```

**注意**：`desktop` profile 由桌面端独占管理，但**手写的 patch 行会被保留**（手写的 bundle 列表条目会被清掉）。profile patch 是**最高优先级层**，能覆盖代码里的默认值。

验证：

```
Get-NetTCPConnection -LocalPort 19387
→ 0.0.0.0:19387  Listen
```

### 明文 HTTP 与 Android 9+

```xml
<!-- AndroidManifest.xml -->
<application android:usesCleartextTraffic="true"
             android:networkSecurityConfig="@xml/network_security_config">
```

```xml
<!-- res/xml/network_security_config.xml -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">100.x.y.z</domain>
        <domain>127.0.0.1</domain>
        <domain>localhost</domain>
    </domain-config>
</network-security-config>
```

**白名单式**：全局禁明文，只对指定地址开口子。

---

## 11. 二维码配对

```js
function qrSvg(text, cellSize = 6, margin = 4) { ... }
```

自实现 QR 编码，输出 SVG。配对 URL 形如：

```
https://<tunnel-url>/phone-bridge/#t=<token>
```

`GET /phone-bridge/api/pair` 返回 SVG，DSH 设置页用 `<img>` 显示，手机用 `ScanActivity`（zxing）扫。

> **注意**：这个 URL 里用了 `#t=`，是因为二维码显示在**电脑屏幕上**、由**原生扫码器**读取后手动拼接。手机浏览器直接访问时必须用 `?token=`。

---

## 12. 文件清单

```
phone-bridge/
├── index.js              Host 半：路由、会话桥接、隧道（30 KB）
├── client.js             Client 半：设置页 UI 注入（17 KB）
├── package.json          元数据 + dsh.client + files 白名单
├── cordis.patch.yml      profile 注册行
├── web/
│   └── app.html          手机上跑的单页应用（16 KB，无框架）
├── apk/
│   ├── AndroidManifest.xml
│   ├── res/xml/network_security_config.xml
│   └── src/com/dsh/phonebridge/
│       ├── BuildDefaults.java      （构建时生成）
│       ├── BridgeConfig.java
│       ├── SetupActivity.java
│       ├── MainActivity.java
│       ├── ScanActivity.java
│       └── CaptureProvider.java
├── build-apk.ps1         无 Gradle 的 APK 构建脚本
├── build-zip.ps1         插件打包
├── bin/
│   ├── cloudflared.exe
│   ├── zxing-core-3.5.3.jar
│   └── phone-bridge-debug.keystore
└── dist/
    └── phone-bridge-plugin-<version>.zip
```

---

## 13. 技术栈总结

| 层 | 技术 | 为什么 |
| --- | --- | --- |
| 插件框架 | DSH + Cordis | 原生支持双半结构和服务注入 |
| 服务端 | Node.js ESM | 跟 DSH 同进程，零 IPC 开销 |
| 路由 | 原生 `http` handler | 不引 Express，减少依赖 |
| 前端 | 单页 HTML + 原生 JS | 无框架、无构建、16 KB |
| 原生壳 | Java + WebView | 相机/相册是 Web 的短板 |
| APK 构建 | aapt2 + d8 + apksigner | 免 Gradle，10 秒出包 |
| 扫码 | zxing-core | 纯 Java，无 Google Play 依赖 |
| 内网穿透 | Tailscale | 点对点加密，换网络不用改配置 |
| 安全 | 48 位 hex token + 恒时比较 | 简单够用，不引入账号体系 |

---

## 14. 已知限制

- **无离线能力**：断网/断 Tailscale 就用不了
- **图片上限 8 张**，MIME 只支持 png/jpeg/webp/gif
- **job 45 分钟 TTL**：超时后 `/api/poll` 查不到
- **单会话绑定**：一次只能钉一个会话（`/api/prefs` 可切换）
- **测试照片会留在 `Pictures/`**：`dsh-bridge-*.jpg` 需要手动清理
