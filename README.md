# LAN Screen Cast · 局域网投屏

[下载 Release 1.0](https://github.com/Panda-Panta/LAN-Screen-Cast/releases/tag/v1.0) · [源码仓库](https://github.com/Panda-Panta/LAN-Screen-Cast)

Windows 桌面广播端，可分享整个屏幕或一个软件/游戏窗口，并可附带系统声音、麦克风或两者混合。同时提供浏览器观看链接和 RTMP 播放地址；二级路由器下可配置端口转发，供一级网络用户观看。

按 **100 Mbps 上下行、1–5 台同时观看** 设计。采用与 [Deskreen](https://github.com/pavlobu/deskreen) 相似的 Electron + WebRTC 机制，代码独立实现。所有页面资源随软件提供，使用时无公网服务器、STUN/TURN 或 CDN 依赖。

## 直接使用

1. 将 Windows x64 压缩包完整解压到固定目录，双击 `LAN Screen Cast.exe`。也可使用单文件便携 EXE，启动时会先解压运行库。
2. 选择 **局域网网卡**，通常是以太网或 Wi-Fi。不要为其他设备观看选择“仅本机测试”或 VPN 虚拟网卡。
3. 设置网页端口（默认 `8765`），选择“整个屏幕”或“软件 / 游戏窗口”，点击对应缩略图。
4. 默认 `1080p / 30 fps / 每台 6 Mbps / 最多 5 台`。游戏、音乐等声音打开 **广播系统声音**；需要讲话时另开 **同时广播麦克风** 并选择设备，两项可独立选择。
5. RTMP 默认启用，TCP 端口为 `1935`，默认 **HEVC + NVIDIA 硬件优先**。首先实际探测 NVIDIA NVENC，不可用时尝试其他硬件及同 HEVC 软件编码；也可手动选 H.264、仅硬件或软件编码。
6. 点击 **开始广播**，复制网页邀请或扫码，也可以复制 **RTMP** 地址到 PotPlayer / VLC 的“打开链接 / 网络流”功能。无需导出文件；网页也可手动输入地址和 6 位观看码。
7. 网页接收方在 Chrome / Edge 打开链接，点击 **开始观看**。可静音、全屏、断开。手机浏览器也可尝试观看，具体兼容性需要实机验证。
8. 广播中可用两路音量滑块实时调节声音；**麦克风静音**保留系统声音。也可断开某个观看设备；点击 **停止广播** 或关闭软件会结束所有连接。

每次开始广播都生成新的邀请链接和观看码。旧码不会自动加入下一次广播。配置会保存在 `%APPDATA%\LAN Screen Cast\settings.json`；邀请令牌和观看码不会写入设置文件。

正式版默认网页 HEVC 优先、RTMP HEVC + NVIDIA 硬件优先；已经保存的编码 / 加速选择继续保留。网页的 GPU 选择由 Chromium 和驱动决定，RTMP 的 NVIDIA 优先不改变网页 GPU。HEVC 播放器需支持 Enhanced RTMP；兼容性优先时可手动改为 H.264。

## 校园网与二级路由器

你能管理二级路由器时，可以通过端口转发让一级网络用户连接。软件的 **一级网络用户观看** 开关只生成地址和媒体候选，实际端口转发需要在路由器里设置。

1. 在路由器“上网状态”中找到 **WAN 口 IPv4**。这是二级路由器在一级网络中的地址，可以是 `10.x.x.x` 等私网地址；不是广播电脑的 `192.168.x.x` LAN 地址，也不需要公网 IP。
2. 在路由器 DHCP 中为广播电脑固定地址，软件仍选择该电脑的实际 LAN 网卡。
3. 打开软件的 **一级网络用户观看**。默认自动读取二级路由器的 WAN IPv4；若路由器支持 UPnP IGD 或 NAT-PMP 地址查询，会每 30 秒检查变化。可点 **立即读取地址**。不支持时关闭自动模式，按路由器“上网状态”手动填写 WAN IPv4；填写对外网页 TCP 端口并展开 **查看端口转发清单**。
4. 按清单为所用观看方式添加转发：

| 路由器 WAN 端 | 目标电脑 LAN 端 | 用途 |
| --- | --- | --- |
| TCP `8765`（可改） | 所选电脑 IPv4 / TCP `8765`（按软件设置） | 网页和观看信令 |
| UDP `50000–50100` | 同一电脑 / UDP `50000–50100` | WebRTC 画面和声音 |
| TCP `1935`（可改） | 同一电脑 / TCP `1935`（按软件设置） | RTMP 画面和声音 |

UDP 的外部与内部端口必须一一相同。修改软件 UDP 范围后，同步修改路由器和防火墙。**只转发网页 TCP 端口不能保证媒体可连接。** 软件保留本地候选，并补充所配置 WAN 地址的映射候选，不依赖公网 STUN 服务。

5. 开始广播后，选择分享框中的 **一级网络的用户**，复制对应的网页或 RTMP 地址。自己路由器下的设备选 **本路由器内的设备**，以免依赖路由器的 NAT 回环功能。只用 RTMP 时不需要 WebRTC UDP 转发；网页观看需要网页 TCP 和 UDP 两组转发。

校园网如果启用用户隔离、禁止路由器 WAN 入站或封锁 UDP，端口转发也可能无法建立链路；需要上级网络允许用户间通信。当前软件不内置 TURN 中继。请用一级网络的另一台设备实际打开邀请：发送端自己打开 WAN 地址不能证明其他用户可达。详见 [校园网设置说明](docs/network-guide.md)。

自动读取使用电脑默认网关找到二级路由器，再查询其 WAN 口，不能把默认网关地址直接用作一级网络观看地址。软件只查询地址，不自动修改端口映射。DHCP 变化后当前广播的链接、二维码及后续连接候选会刷新，**原来分享出去的链接不会自动改地址，需要重新分享**；自动查询也不会阻止地址变动。要保持固定观看入口，应在一级 DHCP 侧为二级路由器 WAN 设置固定租约（需要一级网络管理员支持）。

## 一键打开与地址导入

- **播放器**：复制 RTMP 地址，在 PotPlayer 按 `Ctrl+U` 打开链接，或在 VLC 打开网络串流。H.264 为兼容选项；默认 HEVC 使用 Enhanced RTMP，需要接收程序支持该协议扩展。
- **手机**：扫描二维码打开网页。
- **复制邀请**：浏览器地址栏直接粘贴完整邀请；接收页也提供观看地址导入入口。
- 打开后点击 **开始观看**，浏览器才能按其播放策略启用声音；需要时点击开启声音按钮。

## 100 Mbps 带宽设置

每个接收方接收独立的一路数据；网页与 RTMP 观看者合计占用同一个人数上限。RTMP 使用一次编码向多个播放器分发，网页通过点对点 WebRTC 发送；总发送流量约为各接收方流量之和。

| 同时观看 | 每台视频上限 | 合计视频上限 |
| --- | --- | --- |
| 1 台 | 6 Mbps | 6 Mbps |
| 3 台 | 6 Mbps | 18 Mbps |
| 5 台 | 6 Mbps | 30 Mbps |

网页音频编码上限为每路 96 kbps，RTMP 的 AAC 为每路 128 kbps，另有协议开销与重传。软件限制“每台视频上限 × 观看人数上限”不超过 **70 Mbps**，给 100 Mbps 链路留出余量。这是配置预算；实时视频发送量会随画面、网络和编码器调整。

- 演示文稿、办公软件：1080p、30 fps、4–6 Mbps。
- 动态游戏：先尝试 720p、60 fps、6 Mbps；有余量时可改为 1080p、60 fps、8–10 Mbps，5 台合计上限 40–50 Mbps。
- Wi-Fi 的标称速度并不等于实际可用带宽。优先让广播端接网线，接收端保持信号稳定。
- 两个声音开关都关闭时不采集音频。系统声音和麦克风混合为同一条 Opus 音轨，保持每路 96 kbps 音频上限。

实际帧率和延迟受 CPU/GPU、编码驱动、网络抖动和接收设备影响。WebRTC 采用即时媒体传输和尽量低的接收缓冲，不提供固定毫秒数保证。接收页显示的“网络往返”与“接收缓冲”分别是 RTT 与解码前的缓冲统计，不能当成完整的端到端画面延迟。

## 连接与防火墙

网页与信令使用所选网卡上的 TCP 端口；媒体使用发送端的 UDP 范围，默认 `50000–50100`。网页端口不是唯一使用的端口。接收端浏览器也需能接收 WebRTC 的 UDP 流量。

Windows 防火墙需允许应用在实际使用的网络类型上访问；校园网络可能被识别为 **公用网络**，只勾选专用网络未必有效。软件不会自动修改系统防火墙、路由器或网卡设置。需要手动配置时可允许该程序，或允许网页 TCP 端口和 UDP 范围；改变端口后相应更新规则。

若看不到页面：检查广播已启动、网卡/IP 与分享入口选择正确、TCP 转发、防火墙和上级可达性。若页面能打开但画面连接失败：检查相同端口的 UDP 转发、防火墙、VPN 以及校园网用户隔离。当前版本支持上述静态端口映射，仍需要网络允许设备间通信，无法绕过隔离规则。

链接携带随机邀请令牌，手动地址需要观看码。观看码有尝试频率限制，接收端之间的信令互相隔离。视频和音频由 WebRTC 加密传输；网页与局域网信令使用 HTTP/WS，应在可信网络中使用。

## 捕获与兼容性

- 面向 Windows 10/11 x64。接收端优先使用新版 Chrome / Edge。
- 支持屏幕和窗口选择；窗口关闭或系统结束采集时，广播停止。
- 对游戏建议使用无边框窗口。某些独占全屏、受保护内容、反作弊或权限不同的窗口可能无法正常捕获；可尝试整个屏幕。不能保证每款游戏都能捕获。
- 窗口最小化可能暂停其图像更新。广播软件本身最小化时保持媒体处理与系统唤醒；电脑锁屏或显示设备变化仍可能影响采集。
- 麦克风可使用系统默认或指定设备。**刷新麦克风**会请求访问并重新读取，探测完成即释放临时轨道；开启广播后才持续采集。开麦失败时按界面提示检查 Windows 的麦克风权限、桌面应用访问及设备状态。重启恢复设备偏好；设备暂时不可用时提示并使用默认项。
- **广播系统声音**使用 Windows 输出回环，采集整台电脑播放的声音；选择一个窗口时也会包含其他应用的声音。声音经过当前 Windows 默认输出设备，需保证该设备正常播放。系统声音默认关闭，旧配置会补齐两个 100% 音量；音量滑块只调节发送到观看者的音量。广播预览保持静音。改变声音开关需停止后重开；音量可在广播中调整。
- 在广播电脑上自测观看时，请静音接收页，避免接收声音再次进入系统回环。
- 网页默认优先 HEVC / H.265；展开 **高级设置与连接帮助**可选 H.264、自动或 VP8。本机发送能力和接收端解码能力都需支持 HEVC，否则回落到可协商格式。观看设备列表显示每台的**实际编码**和回落情况；仅显示本机能力不能证明已实际使用 HEVC。硬件编码取决于 GPU、驱动和 Chromium。
- 网页链接和 RTMP 地址分别复制，播放器使用 `rtmp://` 地址。RTMP 与网页复用同一最终混合音画；RTMP 服务失败时网页仍可继续。RTMP 固定使用 AAC 音频，可独立选择 H.264 / HEVC。
- RTMP 的 **NVIDIA 硬件优先**首先实际探测 NVENC，再尝试其他硬件和同种编码的软件路径；**仅硬件**在无可用硬件时明确提示。可用时界面显示实际编码器及硬件 / 软件状态。随包 FFmpeg 提供 NVIDIA NVENC、Windows Media Foundation 和 Kvazaar HEVC 软件编码；设备或驱动不支持时，界面会说明失败或实际回退。软件不会安装或更改显卡驱动。
- RTMP 延迟也受播放器网络缓存影响，可在播放器里降低缓存；优先接近实时观看时仍可使用网页。软件没有把链路 RTT 显示成端到端延迟。
- 观看者过多会增加编码负载和发送带宽；当前实现为多路点对点连接，适合少量设备。

## 设置保存

设置更改约 250 ms 后自动保存，尚未开始广播也会保存；底部显示保存状态。正常退出会刷新最后一次更改，重启恢复网卡、端口、画质、编码、两路声音开关及音量、麦克风偏好和一级网络配置。电脑 LAN 地址改变时优先按保存的网卡名称重新选择。保存屏幕 / 窗口类别，具体画面仍需重新选择；临时窗口 ID 和观看令牌不会保存。输入无效或写入失败时保留上一份有效配置并提示。

## 从源码启动与打包

开发环境：Node.js 22.12+（当前验证使用 Node.js 24）、npm、Windows x64。已打包的软件无需安装 Node.js。

```powershell
npm.cmd install
npm.cmd start
npm.cmd test
npm.cmd run check
npm.cmd run test:smoke
npm.cmd run test:gui
npm.cmd run test:features
npm.cmd run test:system-audio
npm.cmd run test:rtmp
npm.cmd run build:dir
npm.cmd run build
```

Electron 44 在第一次运行时下载运行库。如果 GitHub 下载受限，可以按 [Electron 安装文档](https://www.electronjs.org/docs/latest/tutorial/installation) 使用镜像并保留官方校验：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
node node_modules\electron\install.js
```

`LAN_CAST_DATA_DIR` 可指定配置与 Chromium 会话目录，方便在测试中隔离数据。`scripts/smoke.js` 启动生产桌面端及独立浏览器会话，测试真实画面采集与 WebRTC 解码；音频传输使用测试信号，另外探测实际麦克风。`scripts/gui-regressions.js` 验证原生窗口关闭、取消准备、重载、恢复、移除和导入。`scripts/features-smoke.js` 验证 1.1 的保存 / 重启、麦克风刷新、真实 HEVC 编解码和协商回落；WAN 响应采用测试夹具，不代表校园网穿透。HEVC 检查要求测试机提供相应编码和解码能力。测试文件和截图在 `test-results/`。测试需要普通交互式 Windows 会话，开发沙箱中的 AppContainer 权限可能阻止 Electron 的子进程运行。

`scripts/system-audio-smoke.js` 在普通 Windows 会话中短暂播放低音量 440 Hz 测试音，通过原生输出回环和 WebRTC 接收频谱验证声音；混合测试只将麦克风输入替换为另一频率。接收测试窗口的本机输出静音，避免反馈；还验证独立音量、麦克风静音、停止释放及关闭后恢复。

测试输出信号幅度已降低 100 倍，仅采样时播放，每段最多 15–20 秒自动静音；基础测试接收窗口也禁止本机播放。Release 1.0 本轮音频复验已停止，发布摘要明确记录未完成范围，当前验收与历史证据分开列在 [验证记录](docs/verification.md)。

RTMP 使用随包 FFmpeg 与 MediaMTX，无需用户安装命令行工具。原生二进制、对应源码和许可证在 `vendor/media/`，通过 `scripts/fetch-media-dependencies.ps1` 准备，准确版本与校验值以 `manifest.json` 为准。

发布验证先运行 `node scripts/validate.js`，生成与当前源码 / 测试指纹绑定的完整 Node 和语法日志。桌面脚本记录实际应用版本；打包目录记录 EXE / ASAR / 原生依赖哈希，单文件检查读取实际解出的资源。`scripts/package-release.py` 要求五类桌面检查在源码和打包目录分别通过，拒绝旧版本或其他候选的记录，再生成 ZIP 并校验 CRC / 哈希。RTMP 脚本实际经过原生窗口、Windows 声音回环、混合音轨、FFmpeg 编码、MediaMTX 分发与接收解码，并检查两协议共享人数及失败隔离。

## 代码结构

- `src/main.js` / `preload.js`：桌面生命周期、受限 IPC、采集授权、配置保存；`display-media.js`：限定选中来源和声音开关的显示捕获授权。
- `src/trusted-page.js`：可信本地文件识别，兼容 Windows 便携目录的 URL 编码。
- `src/config.js`：网卡枚举与 100 Mbps 预算校验。
- `src/settings-store.js`：按序原子保存；`renderer/settings-autosave.mjs`：修改自动保存与关闭刷新。
- `src/router-discovery.js`：所选网卡的默认网关与只读 WAN 查询；`renderer/router-address.mjs`：轮询与取消。
- `src/lan-server.js`：绑定地址、接收页面、观看认证、信令与连接回收。
- `src/broadcast-session.js`：服务启动取消与唯一实例所有权。
- `src/renderer/`：广播 GUI、采集、逐接收端 WebRTC 编码传输。
- `src/renderer/audio-mixer.mjs`：会话拥有的系统声音 / 麦克风混合、独立音量与麦克风静音。
- `src/viewer/`：网页加入、解码播放、重连、音量与统计。
- `src/shared/rtc.js`：编解码偏好、低延迟提示和媒体统计。
- `src/shared/network.mjs`：本地 / WAN 地址与同端口 ICE 映射。
- `src/cast-server.js`：装配网页和可选 RTMP 服务；`audience.js`：跨协议共享人数限制。
- `src/rtmp-session.js`：原生服务、认证、受限分片、监测与退出；`rtmp-encoder.js`：真实硬件 / 软件编码探测；`renderer/rtmp-recorder.mjs`：有界顺序录制队列。
- `tests/`：配置和真实 HTTP/WebSocket 集成测试。

参考：[Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents/)、[WebRTC RTCRtpReceiver](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver)。

实际验证范围与打包校验见 `docs/verification.md`。代码采用 MIT 许可；Electron 等随包运行库保留自身许可证。

开发与增量计划入口见 [DEVELOPMENT_PLAN](DEVELOPMENT_PLAN.md)，实际源码职责见 [PROJECT_STRUCTURE](PROJECT_STRUCTURE.md)。
