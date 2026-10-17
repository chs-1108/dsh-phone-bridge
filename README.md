<p align="center">
  <img src="docs/banner.svg" alt="phone-bridge" width="640">
</p>

<h1 align="center">📱 phone-bridge</h1>

<p align="center"><strong>v1.1.0</strong></p>

<p align="center">
  <em>用手机跟电脑上的 DSH 对话：发文字、拍照、传图，回复实时回显。不同 Wi-Fi 也能用。</em>
</p>

<p align="center">
  <a href="https://github.com/chs-1108/dsh-phone-bridge/stargazers"><img src="https://img.shields.io/github/stars/chs-1108/dsh-phone-bridge?logo=github&label=Stars" alt="GitHub stars"></a>
  <a href="https://github.com/chs-1108/dsh-phone-bridge/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-65a30d?style=flat" alt="MIT license"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin"></a>
  <a href="https://www.deepseek.com/harness/"><img src="https://img.shields.io/badge/dsh-0.2.0--rc.2-blue" alt="DSH"></a>
  <br>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=fff" alt="Node.js">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=000" alt="JavaScript">
  <img src="https://img.shields.io/badge/Android-24%2B-3DDC84?logo=android&logoColor=fff" alt="Android">
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">中文</a>
</p>

> **Official Web and the official desktop app are both supported.** Official `dsh web` uses profile `web`. The official desktop EXE (DeepSeek Harness **0.2.0-rc.2**) uses profile `desktop`. Install and Apply them separately.
>
> **No public server, no third-party relay.** The phone and the PC meet on a private WireGuard network that you create with your own Tailscale account. Nothing is exposed to the public internet.
>
> Node.js **≥18**. Android **7.0 (API 24)** or newer for the native app; any modern browser also works.

## Contents

- [What this is](#what-this-is)
- [Highlights](#highlights)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Manual install](#manual-install)
- [The phone side](#the-phone-side)
- [How it works](#how-it-works)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## What this is

**phone-bridge** is a plugin for the official [DeepSeek Harness](https://www.deepseek.com/harness/) that puts your DSH session in your pocket. The phone opens a small web app (or a native Android shell), sends text and photos into a real DSH session, and reads the Agent's reply as it streams back.

```
Phone (WebView / browser)
   │  HTTP over Tailscale — encrypted WireGuard, peer to peer
   ▼
DSH webServer  ──▶  /phone-bridge prefix route  ──▶  sessionController  ──▶  model
```

It consumes only DSH's public `webServer` and `sessionController` services. No core patches, no forked host.

## Highlights

- **Works across networks** — the phone does not need to share a Wi-Fi with the PC. Both sides join a Tailscale tailnet, each gets a stable `100.x.y.z` address, and the URL never changes when you switch between Wi-Fi and cellular.
- **Real session, not a side channel** — messages land in a normal DSH session. Pin the bridge to any session with `/api/prefs`, or let it create one lazily and reuse it.
- **Streaming replies** — the plugin subscribes to `sessionController.follow({assistantStream: true})` and the phone polls incremental results, so long answers appear while they are being written.
- **Photos and camera** — the native Android shell wires `onShowFileChooser` into a system chooser with a camera entry, writes the capture through `MediaStore`, and hands the WebView a readable URI. Text and up to 8 images per message.
- **Camera-free fallback** — no APK needed. A plain browser works: open the URL, send text, attach images.
- **One-click deployment** — `setup-phone-bridge.ps1` installs Tailscale, patches the listen address, registers the plugin, builds the APK, and pushes both apps to a USB-attached phone. It needs your Tailscale account and nothing else.
- **No Gradle** — the APK builds straight from `aapt2` + `d8` + `zipalign` + `apksigner` in about ten seconds.

## Requirements

| | |
| --- | --- |
| **DSH** | 0.2.0 or newer, desktop EXE or `dsh web` |
| **Node.js** | ≥ 18 |
| **Host OS** | Windows 10/11 (the deploy script is PowerShell) |
| **Phone** | Android 7.0+ for the APK, or any modern browser |
| **Account** | Your own free [Tailscale](https://login.tailscale.com/start) account |

Optional, only for building the APK: JDK 17 and Android SDK build-tools 34.0.0. Optional, only for pushing to a phone over USB: `adb`.

## Quick start

On the PC, in an **elevated** PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\setup-phone-bridge.ps1
```

The script walks nine steps and stops to ask you only twice:

1. Sign in to your Tailscale account (a browser opens).
2. Confirm restarting DSH so the plugin loads.

Connect the phone by USB with **USB debugging** enabled beforehand if you want the script to install the Tailscale and phone-bridge APKs for you. It also pre-grants the camera permissions.

When it finishes you get a URL like:

```
http://100.x.y.z:19387/phone-bridge/?token=<48 hex chars>
```

Open it on the phone, or launch the installed **DSH 手机同步** app — it is already paired.

> `?token=` is a query parameter on purpose. A `#fragment` never reaches the server, so `#t=...` would fail authorization.

### Script options

```powershell
.\setup-phone-bridge.ps1 -SkipPhone       # PC side only
.\setup-phone-bridge.ps1 -SkipApk         # reuse the last APK build
.\setup-phone-bridge.ps1 -SkipTailscale   # already installed and signed in
.\setup-phone-bridge.ps1 -SkipRestart     # restart DSH yourself later
.\setup-phone-bridge.ps1 -Port 19387      # pin the port
```

## Manual install

If you would rather wire it up by hand:

**1. Put the plugin where DSH can find it**

```bash
git clone https://github.com/chs-1108/dsh-phone-bridge.git
mkdir -p ~/.dsh/phone-bridge
cp -r phone-bridge/{index.js,client.js,package.json,cordis.patch.yml,web,vendor} ~/.dsh/phone-bridge/
```

**2. Register it in the profile**

Link the package into the profile's `node_modules` and add a row to `cordis.patch.yml`:

```yaml
- id: phone-bridge
  name: dsh-phone-bridge
```

**3. Make the webServer reachable**

The server listens on `127.0.0.1` by default, so the phone cannot reach it. Override the host in the same `cordis.patch.yml` (profile patch is the highest-precedence layer):

```yaml
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

**4. Restart DSH, then read the token**

```bash
cat ~/.dsh/phone-bridge/state.json
```

## The phone side

Three options, cheapest first.

**Browser only** — install Tailscale on the phone, sign in with the same account, enable the VPN, open the URL. Photos work through the standard file picker.

**Native APK** — build it with your own address baked in:

```powershell
.\build-apk.ps1 -BaseUrl "http://100.x.y.z:19387/phone-bridge" -Token "<your token>"
adb install -r apk-out/phone-bridge.apk
```

The app then skips the QR screen entirely. Build without `-BaseUrl` to get a generic APK that pairs by scanning the QR code shown in DSH settings.

**QR pairing** — `build-apk.ps1` with no arguments, install, and scan the code from DSH → Settings → 手机同步.

Tailscale runs as a background service on both sides, so closing the window does not drop the tunnel, and it reconnects automatically after a reboot.

## How it works

| Piece | Role |
| --- | --- |
| `index.js` | Host half. Registers a `prefix` route on `webServer`, drives `sessionController.prompt()` and `.follow()`, mints the token. |
| `client.js` | Client half. Injects the settings panel into the DSH web UI. |
| `web/app.html` | The single-page app the phone loads. No framework, ~16 KB. |
| `apk/` | Native Android shell: `SetupActivity`, `MainActivity` (WebView + file chooser + camera), `ScanActivity` (zxing), `CaptureProvider`. |
| `setup-phone-bridge.ps1` | Nine-step deployment for both ends. |
| `build-apk.ps1` | Gradle-free APK build. |

Authorization is either loopback (the PC talking to itself) or a 48-hex-character token compared in constant time. Sessions are resolved lazily: if the stored `sessionId` still exists it is reused, otherwise a new one is created and persisted.

The capture path deliberately writes into the shared `MediaStore` rather than a private `ContentProvider`. Every camera app can already write there, which removes the cross-process URI grant that silently fails on several OEM ROMs.

Full detail, including the nine capture bugs and why each fix was needed, is in [IMPLEMENTATION.md](IMPLEMENTATION.md). Deployment walkthrough and troubleshooting: [SETUP.md](SETUP.md).

## Privacy

This plugin ships **no** server address, token, or account. Values are injected at build time by `build-apk.ps1` from `-BaseUrl` / `-Token`, and the committed `BuildDefaults.java` and `network_security_config.xml` stay blank apart from loopback.

Traffic stays inside your own tailnet. Nothing is proxied through a third-party service, and the plugin makes no outbound connections except the optional `cloudflared` tunnel if you explicitly start one.

Treat the token like a password: anyone holding it can talk to your DSH. Rotate it by deleting `token` from `~/.dsh/phone-bridge/state.json` and restarting.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `{"ok":false,"error":"unauthorized"}` | Token not transmitted | Use `?token=`, never `#t=` |
| Phone cannot connect | Server bound to loopback | Set `host: '0.0.0.0'` in `cordis.patch.yml`, restart |
| `web boot: 1 entry did not activate` | Client registration id ≠ package name | Must be `dsh-phone-bridge` |
| Capture saves but the photo never appears | Provider unreachable by the camera app | Use the `MediaStore` path in `MainActivity` |
| `adb devices` shows `unauthorized` | Debugging prompt not accepted | Unlock the phone, tap **Allow** |
| APK install fails on signature | Different signing key | `adb uninstall com.dsh.phonebridge` first |

Check the plugin is alive:

```bash
curl http://127.0.0.1:19387/phone-bridge/health
# {"ok":true,"name":"phone-bridge","version":1}
```

## Development

```bash
node test/loader-import.mjs   # client half registers under the package name
node test/composition.mjs     # host half composes
node test/host.smoke.mjs      # route and auth smoke tests
```

Rebuild the distributable:

```powershell
.\build-zip.ps1
```

## License

MIT — see [LICENSE](LICENSE).
