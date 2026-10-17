# phone-bridge 一键部署

手机 ⇄ 电脑 DSH 直连。**不同 WiFi 也能用**，靠 Tailscale 组虚拟内网。

---

## 使用者要做什么

1. 一根 **USB 数据线**
2. 一个 **Tailscale 账号**（免费，[注册地址](https://login.tailscale.com/start)）

就这些。剩下的脚本全包。

---

## 三步搞定

### 第 1 步：手机开启 USB 调试

设置 → 关于手机 → **连点「版本号」7 次** → 返回 → 系统 → 开发者选项 → 打开 **USB 调试**

> 小米/红米：设置 → 我的设备 → 全部参数 → 连点 MIUI 版本 7 次

### 第 2 步：USB 连电脑，跑脚本

**右键 PowerShell → 以管理员身份运行**，然后：

```powershell
cd <解压目录>
Set-ExecutionPolicy -Scope Process Bypass -Force
.\setup-phone-bridge.ps1
```

### 第 3 步：按提示操作

脚本会做这些事，中间只需要你配合三下：

| 脚本在做什么 | 你要做什么 |
| --- | --- |
| 装 Tailscale（PC） | 等 |
| 打开浏览器让你登录 | **用你的账号登录** |
| 改 DSH 配置、装插件 | 等 |
| 重启 DSH | 按回车确认（**先存好工作**） |
| 构建 APK | 等约 10 秒 |
| 装 App 到手机 | 等 |
| 打开手机上的 Tailscale | **登录同一个账号，点 Connect** |

完成后手机上会有一个 **「DSH 手机同步」** App，**已经配对好了，直接就能聊**。

---

## 手机上还要做的一步

打开 **Tailscale** App → 用**和电脑同一个账号**登录 → 点 **Connect**（允许 VPN 请求）。

之后：

- ✅ **Tailscale 可以一直挂着**，它是常驻服务，不用每次手动开
- ✅ **换 WiFi、切 4G 都不影响**，因为走的是虚拟内网
- ✅ 电脑关机重启后 Tailscale 自动连回来（已设为开机自启）

---

## 脚本参数

```powershell
# 完整部署（默认）
.\setup-phone-bridge.ps1

# 只弄电脑端，不碰手机
.\setup-phone-bridge.ps1 -SkipPhone

# 手机已经装好了，只重新部署电脑端
.\setup-phone-bridge.ps1 -SkipPhone -SkipTailscale

# 跳过 APK 构建（用上次的包）
.\setup-phone-bridge.ps1 -SkipApk

# 不重启 DSH（稍后自己重启）
.\setup-phone-bridge.ps1 -SkipRestart

# 指定端口
.\setup-phone-bridge.ps1 -Port 19387
```

---

## 它会改哪些东西

脚本对系统的改动**全部可回滚**，每步都留了 `.bak-<时间戳>` 备份。

| 位置 | 改什么 |
| --- | --- |
| `C:\Program Files\Tailscale\` | 安装 Tailscale |
| `~\.dsh\profiles\desktop\cordis.patch.yml` | 加插件行 + 监听改 `0.0.0.0` |
| `~\.dsh\phone-bridge\` | 安装插件本体 |
| `~\.dsh\profiles\desktop\node_modules\dsh-phone-bridge` | 软链（junction） |
| 手机 | 装 Tailscale + DSH App |

---

## 前置条件

| 需要 | 说明 |
| --- | --- |
| **Windows 10/11** | Tailscale 与 DSH 都是 Windows 版 |
| **DSH 桌面端** | 至少启动过一次（脚本要读 profile） |
| **管理员权限** | 装软件、改服务 |
| **winget** | Win10 1809+ 自带；没有就手动装 Tailscale |
| **Android SDK + JDK 17** | 只在构建 APK 时需要；没有就用手浏览器访问 |
| **adb** | 装手机 App 要用；没有就手动装 |

### 关于 Android 工具链

脚本会自动找这些位置：

```
JDK 17:  %PHONE_BRIDGE_JAVA_HOME%
         D:\bian_cheng_ruan_jian\jabba\jdk\zulu@17.0.9
         C:\Program Files\Zulu\zulu-17
         C:\Program Files\Eclipse Adoptium\jdk-17

SDK:     %PHONE_BRIDGE_SDK%
         D:\bian_cheng_ruan_jian\AndroidSdk\sdk
         %LOCALAPPDATA%\Android\Sdk

adb:     %PHONE_BRIDGE_ADB%
         D:\bian_cheng_ruan_jian\platform-tools\adb.exe
         %LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe
         PATH 里的 adb
```

找不到就跳过 APK，**不影响 PC 端部署**，手机改用浏览器访问。

---

## 部署完你会看到

```
  Phone URL:
  http://100.x.x.x:19387/phone-bridge/?token=<48位token>
```

这个地址**直接用手机浏览器打开也能用**，App 是可选的加分项。

---

## 出问题怎么查

### 手机连不上

```powershell
# 1. 电脑 Tailscale 通不通
tailscale status

# 2. 本机 IP
tailscale ip -4

# 3. 服务是否监听 0.0.0.0
Get-NetTCPConnection -LocalPort 19387

# 4. 插件活没活
curl http://127.0.0.1:19387/phone-bridge/health
```

正常应该返回：

```json
{"ok":true,"name":"phone-bridge","version":1}
```

### 手机浏览器显示 `{"ok":false,"error":"unauthorized"}`

**Token 传错方式了。** 必须用 `?token=` 查询参数：

```
✅ http://100.x.x.x:19387/phone-bridge/?token=xxx
❌ http://100.x.x.x:19387/phone-bridge/#t=xxx     （# 后面的内容不发给服务器）
```

### adb 找不到手机

```powershell
adb devices
```

- 显示 `unauthorized` → 手机上点「允许 USB 调试」
- 列表为空 → 换数据线（有些线只供电不传数据）/ 换 USB 口

### App 装不上，报签名冲突

```powershell
adb uninstall com.dsh.phonebridge
```

然后重跑脚本。

### 拍照不行

脚本已经用 `pm grant` 预授了相机和相册权限。如果还是不行：

```powershell
adb shell dumpsys package com.dsh.phonebridge | findstr CAMERA
```

应该看到 `granted=true`。

---

## 技术原理

详见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)，14 章完整说明架构、路由、鉴权、拍照链路的 9 个坑。

### 一句话版

```
手机 App (WebView)
   ↓ HTTP over Tailscale（点对点加密隧道）
电脑 DSH webServer 的 /phone-bridge 前缀路由
   ↓ 插件代理
DSH sessionController → LLM
```

### 为什么用 Tailscale

试过 cloudflared（429 限流）、花生壳免费版（边缘拦截）都不行。Tailscale 是 **WireGuard 点对点加密**，两台设备各拿一个固定 `100.x.x.x` IP，**跟物理网络完全解耦**——换 WiFi、切 4G、跨运营商都不用改任何配置。

免费版支持 100 台设备，够用。

---

## 文件清单

```
phone-bridge/
├── setup-phone-bridge.ps1     ← 一键部署脚本
├── build-apk.ps1               APK 构建（免 Gradle）
├── index.js                    插件 Host 半
├── client.js                   插件 Client 半
├── web/app.html                手机端单页
├── apk/                        Android 原生壳源码
├── bin/
│   ├── tailscale-android.apk   手机端 Tailscale（会自动装）
│   ├── zxing-core-3.5.3.jar    扫码库
│   └── phone-bridge-debug.keystore
├── IMPLEMENTATION.md           实现原理详述
└── SETUP.md                    ← 本文
```
