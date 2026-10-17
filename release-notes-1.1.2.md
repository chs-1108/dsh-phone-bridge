## 下载

| 文件 | 装在哪 | 大小 |
| --- | --- | --- |
| [`phone-bridge-1.1.2.apk`](https://github.com/chs-1108/dsh-phone-bridge/releases/download/v1.1.2/phone-bridge-1.1.2.apk) | 手机 | 249 KB |
| [`phone-bridge-plugin-1.1.2.zip`](https://github.com/chs-1108/dsh-phone-bridge/releases/download/v1.1.2/phone-bridge-plugin-1.1.2.zip) | 电脑（DSH 插件） | 0.9 MB |

APK 是**通用包**，没有把电脑地址写死 —— 谁的手机都能连自己的电脑。

## 怎么用

1. 电脑和手机都装好 Tailscale，登录**同一个账号**
2. 电脑装插件，重启 DSH，打开「设置 → 手机同步」
3. 手机 App 点「扫描电脑上的二维码」
4. 开始用。两端不用连同一个 Wi-Fi

---

## ⚠️ 装完必看：让 DSH 能被手机访问

DSH 的 web 服务默认只监听 `127.0.0.1`，**手机连不进来**。装完插件如果手机一直「连接失败」，先检查这个。

**v1.1.2 起插件会自动检测**：设置面板顶部出现红框时，点「一键修复」就行。插件会自己找到 profile 的 `cordis.patch.yml`，改好 `host`，并在旁边留一份带时间戳的备份。

然后**完全退出 DSH 再打开**（关窗口不算）。

### 手动改（自动修复失效时）

编辑 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，加上：

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
```

### 验证

```powershell
netstat -ano | findstr LISTENING | findstr 19387
```

| 看到 | 含义 |
| --- | --- |
| `0.0.0.0:19387` 或 `[::]:19387` | ✅ 手机能连进来 |
| `127.0.0.1:19387` | ❌ 只有本机能连，手机一定失败 |

---

## 这个版本修了什么

- **监听地址检测**：`/health` 和 `/api/status` 返回 `boundHost` / `loopbackOnly`，面板用红框提示
- **一键修复**：自动改 YAML，留备份，二次点击无副作用
- **配置定位穿透 Junction**：DSH 用目录联接挂载插件，之前定位不到 profile，点了没反应 —— 已修
- **失败可读**：报错带文件路径和候选 profile 列表

## 排错

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| `Failed to connect to /x.x.x.x` | 地址填了别的设备 | 扫二维码，别手填 |
| `服务返回 502` | 服务没起来或只监听本机 | 点「一键修复」再重启 |
| 地址对但连不上 | 手机 Tailscale 隧道没建 | Tailscale 断开再连 |
| 密钥只有 44 位 | 抄错了，实际是 48 位 | 从二维码取 |
| 面板红框无按钮 | 装的是旧版 | 重装 1.1.2 |
