# LAN Screen Cast 软件设计

## 1. 产品目标与网络条件

Windows 10/11 x64 桌面软件，选择网卡、网页端口、媒体端口、屏幕或窗口，以 WebRTC 向浏览器发送画面和可选麦克风。接收方不安装客户端。参考 Deskreen 的 Electron / WebRTC 机制，独立实现并采用 MIT 许可。

用户条件：广播方上下行带宽均按 **100 Mbps** 计算，主要为 **1–5 台**同时观看。校园网下有一台可管理的二级 NAT 路由器；一级网络的其他用户需要通过二级路由器的端口转发观看。支持复制邀请、二维码和双击打开的 Windows 观看快捷方式。

默认 1080p / 30 fps，每台视频上限 6 Mbps、音频上限 96 Kbps，最多 5 台。默认视频预算为 30 Mbps；所有配置的 `码率 × 人数` 不得超过 70 Mbps，为音频、协议开销和其他网络使用保留空间。码率是发送器上限而非恒定带宽，100 Mbps 是规划条件，不代表软件能够保证校园网的可用吞吐。60 fps 或高动态游戏可使用 720p，实际编码能力由电脑决定。

当前是逐观看者的点对点传输，不是 IP 广播或组播，也不支持 RTSP / PotPlayer。没有云端、外部 STUN / TURN 或在线字体资源。无线拥塞、校园网隔离、窗口最小化、独占全屏或受保护内容可能限制实际效果。先交付可独立运行的软件；真实跨设备延迟和校园网端口映射必须记录为现场验证项。

## 2. 架构与模块边界

```mermaid
flowchart LR
  GUI[可信本地广播 GUI] -->|受限 IPC| Main[Electron 主进程]
  Main --> Capture[屏幕 / 窗口授权]
  Capture --> Media[HostMedia 采集与 WebRTC]
  Main --> Session[BroadcastSession 生命周期]
  Session --> Server[HTTP 页面 + WebSocket 信令]
  Media <-->|IPC / 逐设备信令| Server
  Server <-->|TCP 8765| Router[可选二级路由器转发]
  Media <-->|UDP 50000–50100| Router
  Router <-->|网页 / 信令 / 加密媒体| Viewer[一级网络或同网浏览器]
```

| 模块 | 职责 | 禁止承担的职责 |
| --- | --- | --- |
| `config.js` | 网卡、已知设置字段、端口和带宽预算校验 | 保存邀请秘密、修改系统网络 |
| `broadcast-session.js` | 启动、取消、停止、服务实例唯一所有权 | 操作 DOM、采集媒体 |
| `lan-server.js` | 指定 IPv4 绑定、静态资源、认证、容量、信令隔离、连接回收 | 采集、外部远程控制 |
| `shared/network.mjs` | 转发地址、邀请地址、ICE 映射的纯函数 | 执行路由器配置、访问网络 |
| `main.js` / `preload.js` | 捕获授权、可信 IPC、设置、唤醒、快捷方式保存 | 将 Node 能力暴露给接收页 |
| `trusted-page.js` | 解码本地文件 URL 并精确匹配广播页路径 | 放宽窗口 / frame 身份、允许远程页面控制 |
| `renderer/host.js` | 广播状态、设备选择、媒体和服务的组合 | 验证外部观看者 |
| `renderer/host-media.js` | 每观看者 PeerConnection、码率、协商、候选队列、统计 | 控制网页服务器 |
| `renderer/share.js` | 内网 / 一级网络分享、二维码、快捷方式、映射清单 | 采集或接收远程指令 |
| `viewer/` | 加入、播放、导入地址、诊断、重连、静音、全屏 | 请求摄像头 / 麦克风、控制广播端 |
| `shared/rtc.js` | 编码偏好、低延迟提示、统计计算 | 将 RTT 当作端到端延迟 |

主进程拥有服务器和电源唤醒句柄；广播渲染器拥有采集轨道和发送连接；每个接收页面拥有自己的信令连接和解码连接。停止必须沿所有权链释放，不依赖垃圾回收。

## 3. 配置和接口合同

配置：`host`, `port`, `udpMin`, `udpMax`, `resolution`, `fps`, `bitrateMbps`, `maxViewers`, `codec`, `microphone`, `micDeviceId`, `roomName`，另有 `forwardingEnabled`, `advertisedHost`, `advertisedPort`。保存时只保留已知且通过校验的字段。转发关闭时空 WAN 地址合法；转发开启时需要有效的普通单播 IPv4 和 TCP 端口，不接受 URL、控制字符、组播、全零或广播地址。仅本机测试地址不允许启用转发。

`LanServer.start()` 返回 `{ roomId, url, inviteUrl, localUrl, localInviteUrl, forwardedUrl, forwardedInviteUrl, pin, token }`。`url` 与 `inviteUrl` 是当前建议的分享地址；转发关闭时为内网地址。主进程补充二维码。令牌与观看码只存内存，每次启动重新生成。`stop()` 可重复调用并等待所有属于本实例的连接关闭。

`BroadcastSession.start(config, decorate)` 只有在监听和异步装饰均成功且未被取消后发布 `current`。停止递增版本号；等待中的启动最终完成时必须自行关闭实例，不能恢复旧会话。重复启动、停止期间启动均拒绝。

可信 preload 只暴露固定方法：网卡 / 采集源读取，选择源，启动 / 停止，发送单设备信令，移除设备，复制，保存观看快捷方式，读取 / 保存设置和订阅事件。所有 IPC 验证发送方是主窗口的可信本地文件及主 frame。

`share.js` 导出 `createShareController({ notify })`，返回 `getConfig()`, `loadSettings(settings)`, `show(info, config)`, `clear()`。广播 UI 将 `getConfig()` 的字段合并进设置；开始后调用 `show()`，任意停止 / 失败调用 `clear()`。快捷方式保存通过 `lan.saveInvite('local'|'forwarded')`，主进程从当前会话生成地址，不接受任意外部 URL。

`shared/network.mjs` 约定 `advertiseCandidate(candidateInit, config) -> RTCIceCandidateInit[]` 和 `advertiseDescription(descriptionInit, config) -> descriptionInit`。输入和原始候选不修改；关闭转发时保持原值。候选映射同时用于 SDP 和 trickle ICE，保持本地候选以兼容二级网络内观看。

## 4. 二级路由器和一级网络观看

填写的是**二级路由器 WAN 口在一级网络中的 IPv4**，可以是校园网分配的私网地址；不是电脑的二级 LAN 地址，也不要求公网 IP。

路由器配置两组转发：

1. WAN TCP 网页端口（可自定义）→ 广播电脑 LAN IPv4 / 本地 TCP 网页端口。默认 `8765 → 8765`。
2. WAN UDP `udpMin–udpMax` → 同一电脑的**相同** UDP 端口范围。默认 `50000–50100 → 50000–50100`，必须一一对应，不能只转发网页端口。

电脑应固定 DHCP 租约，Windows 防火墙允许该应用的网页与媒体连接；软件给出精确清单，不自动修改路由器或防火墙。一级网络通过 WAN 地址进入，二级网络通过本地地址进入；路由器是否支持 NAT 回环不影响本地分享入口。

HTTP Host / WebSocket Origin 允许本地地址和用户配置的转发地址，严格拒绝其他来源。广播端给浏览器补充基于 WAN 地址和相同 UDP 端口的映射 ICE 候选。只映射采集机器所选网卡的 UDP host 候选；不改写 DTLS 密钥、凭据或其他媒体字段。需要可用的数字 IPv4 候选，无法得到时明确诊断，不用错误候选假装转发成功。

端口映射是静态候选的前提，不是万能穿透。校园网用户隔离、上级 ACL、WAN 入站拦截或 UDP 禁用仍可阻断连接。接收页面依次显示：网页已打开 → 观看认证 → 媒体协商 → 收到视频；页面可打开但媒体失败时提示检查 UDP 转发和隔离规则。软件不能把发送端自身打开 WAN 地址当作一级用户可达的证明。需要 TURN 的网络不在当前无服务器方案中自动处理。

## 5. 观看便利性

分享选择“本路由器内”或“一级网络”，即时显示相应邀请链接与二维码，提供复制完整邀请、复制地址加观看码、保存 `.url` 观看快捷方式。接收方双击快捷方式由 Windows 默认浏览器打开，不需要安装软件；手机扫码。快捷方式仅对本次广播有效。接收页可粘贴完整邀请后导入，验证 HTTP(S) 地址和邀请格式，跳转后仍需要点击开始观看以满足浏览器音频播放策略。

普通地址手动加入时输入 6 位观看码。邀请令牌放 URL fragment，不进入普通 HTTP 请求。停止、移除或认证失败时清空视频和音频；移除设备不自动重新加入。

## 6. 生命周期和异常处理

广播状态：`idle → preparing → live → stopping → idle`。准备包含选择授权、屏幕轨道、尺寸限制、可选麦克风、服务器启动；任意阶段源结束、停止、渲染器重载 / 崩溃或退出都取消当前版本。异步步骤返回后核对版本和轨道状态；已经结束的轨道不能发布为 live。麦克风请求尚未完成时先释放已有屏幕轨道，随后收到的麦克风轨道立即停止。设置保存失败不撤销成功的广播，也不能延迟停止。麦克风被拔掉时保留视频并提示，用户静音只改音频轨道的 enabled。

接收状态：`idle → connecting → admitted → negotiating → watching`，网络异常进入 `retrying`，用户离开 / 结束 / 移除进入 terminal。采用有限间隔的指数退避；旧连接的回调不可修改新版本。重新加入遇到旧连接尚占容量时继续重试，首次加入人数已满则明确提示。页面换邀请 fragment 必须清理旧认证和媒体，不能沿用旧令牌。

每次协商有随机 `generation`。offer / answer / candidate 携带该值，过期值丢弃。远端描述设置前 ICE 候选有界排队；串行处理避免并发 SDP 状态冲突。未完成协商的观看者有超时并释放人数；网络失败的连接不永久占位。自动媒体超时 / 失败通过可信 `lan.retry(peerId, reason)` 发送 `error {code: 'RETRY', message}`，接收端保留观看意愿并退避；人工移除使用 kicked 并停止重试。这两种控制消息均立即处理，不排在尚未完成的 SDP 后。

服务器停止发送 ended，关闭 WebSocket，并强制回收所属 HTTP keep-alive / 预连接 TCP socket，避免浏览器预连接导致停止卡住。开始监听失败和 QR 生成失败回收半成品实例。

## 7. 信令与权限

观看者发送 `join {token|pin, name}`，成功收到 `joined {peerId, roomId}`。广播端发送 `offer {generation, sdp}` 和 `candidate {generation, candidate}`；观看者回复 answer / candidate，也可请求 restart。服务端将收到的 peerId 替换为当前 socket 的已认证 ID，绝不允许向其他观看者发送信令。

随机邀请令牌、观看码按恒定时间比较。限制未认证等待、消息长度、SDP 长度、候选长度、单连接消息频率、错误观看码和连接总数。静态资源采用白名单、CSP、禁止 frame、无远程脚本，不暴露文件系统或运行日志。

GUI 的 BrowserWindow 使用 sandbox、contextIsolation，关闭 Node integration，拒绝远程导航和新窗口。接收页面无 preload，浏览器无需麦克风 / 摄像头权限。WebRTC 媒体使用其 DTLS-SRTP 加密；HTTP / WS 信令当前适用于受信任网络，校园网其他节点可见明文信令，因此不得描述为具备 HTTPS 的完整安全方案。

## 8. GUI 与诊断

左侧网卡、网页端口、采集缩略图、画质、麦克风、UDP 范围与一级网络设置；右侧真实预览、分享入口、在线设备；底部常驻开始 / 停止。浅蓝灰背景、白色面板、深蓝文字与单一蓝色主操作。设置面板独立滚动，最小窗口仍可看到停止按钮。所有广播参数在准备或广播期间禁改，静音和移除设备可即时操作。

统计显示视频码率、fps、RTT 和接收缓冲；分别标注含义，不将任何一个指标标成端到端延迟。网络检测只报告实际完成的环节和具体错误，不声称能够检测未执行的上级网络访问。

## 9. 验收与交付

| 类别 | 自动验收 | 现场验收 / 边界 |
| --- | --- | --- |
| 设置 | IPv4、端口、未知字段、预算、转发配置 | 实际网卡变化 |
| HTTP / WS | 本地 / 映射 Host 和 Origin、认证、容量、隔离、畸形消息、端口占用 | 一级网络网页可达 |
| 生命周期 | 取消监听 / QR、预连接释放、源结束时正在申请麦克风、重载可重开 | 系统睡眠 / 热拔插 |
| 媒体 | 实际窗口 / 屏幕帧、5 个独立浏览器会话、音频测试信号传输与解码、静音 | 5 台外部设备、真实麦克风收听、具体游戏 |
| 转发 | 候选映射纯函数与端口边界、转发 Host 集成、配置与快捷方式 | 校园路由器 NAT / UDP / 用户隔离 |
| 恢复 | 旧邀请失效、新 fragment、断线与容量恢复、结束 / 移除停止重试 | 不同手机浏览器 |
| 打包 | Windows x64 包启动、资源、ZIP 内容、SHA256 | 其他 Windows 电脑 |

交付源码、完整设计与模块计划、中文使用说明、网络映射清单、Windows 便携包和具备实际通过 / 未测状态的验证记录。相同电脑的独立浏览器会话只能证明本机链路，不能替代物理多机、100 Mbps 实网和端到端延迟测量。

参考：[Deskreen](https://github.com/pavlobu/deskreen)、[Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[Electron WebRTC UDP 范围](https://www.electronjs.org/docs/latest/api/web-contents/)、[ICE / NAT RFC 8445](https://www.rfc-editor.org/rfc/rfc8445)、[RTCRtpReceiver](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver)。
