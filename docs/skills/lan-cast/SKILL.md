---
name: lan-cast-maintenance
description: 在本项目修改路由器地址发现、WAN 分享及 ICE 映射、媒体取消或重连、声音混合、设置保存、编码协商或 RTMP 及原生依赖时，先读取本规则并执行对应回归，区分能力声明与真实媒体验证。
---

# LAN Screen Cast 跨模块维护规则

适用版本：1.0.0 正式版；权威事实为 `src/`、对应 `tests/` 与 `scripts/`。升级 Electron / Chromium、变更 IPC、配置字段、协议发现或协商状态时重新验证相关规则。项目环境的 `.agents/` 为只读，本规则存放 `docs/skills/`，入口登记在根计划与结构文件。

## 不可破坏的合同

1. 100 Mbps、默认 6 Mbps × 5；视频上限 `bitrateMbps × maxViewers <= 70`。RTT 与 jitter 不能命名为端到端延迟。
2. 二级路由器网关是 LAN 地址；观看者用该路由器 WAN 口在一级网络的 IPv4，可以是私网地址。不能把默认网关当作 WAN 地址。每次重新查询，协议不支持时明确失败并保留旧手动值。
3. SSDP 发现响应源和 NAT-PMP 查询目标限于所选网卡对应网关；只调用 UPnP GetExternalIPAddress / NAT-PMP opcode 0，不调用映射创建 / 删除。网关声明的 UPnP HTTP 服务可以位于该 NIC 同子网的其他数值 IPv4；限定这些本地目标、响应长度、超时与取消，拒绝 DTD / 实体、重定向和子网外主机。
   SSDP 字段名遵循 HTTP token 语法，含点号的 BOOTID.UPNP.ORG 等标准字段可解析；字段值允许空 EXT，但关键 ST / LOCATION 仍须有效。夹具应包含标准空 EXT，覆盖重复字段的大小写变体及非法字段名拒绝，避免只有非标准简化响应能通过。
4. TCP 网页端口可以映射成不同端口；UDP 范围必须相同端口转发。候选保留原地址，只对所选 NIC / UDP 范围生成 WAN 副本。动态 WAN 更新只影响同一服务实例，保留 token / PIN；旧 WAN 的 Host / Origin 删除，新邀请需重新分享。
5. 主进程拥有服务器和电源句柄，渲染器拥有捕获 / 探测轨道与 PeerConnection。每个异步结果核对当前 revision / generation。先释放已有媒体，迟到轨道立即 stop；保存失败不阻挡停止。
6. 被动麦克风枚举不隐式申请权限；用户启用 / 刷新后探测期间保持轨道，枚举完成后全部停止。排除默认 / communications 重复项，保存真实设备偏好，短暂隐藏或拔插不能改写偏好。
7. 250 ms 自动保存最新完整白名单配置；主进程顺序原子写入。正常关闭先停止，再刷新渲染器快照及写队列。草稿可未填写 WAN 或包含旧网卡地址，启动必须验证真实接口及完整配置。不得保存随机 token 或临时窗口 ID。
8. HEVC 优先保留 H.264 / VP8 与 RTX / RED / FEC；不能伪造硬件支持。`getCapabilities`、偏好、SDP 协商、实际编码四层证据分开；只有统计 codec H.265 且 framesEncoded > 0 才报告实际 HEVC。接收端需要 framesDecoded > 0。旧 peer 统计不能覆盖新连接。
9. 可信 IPC 必须为主窗口、主 frame、精确解码本地广播页；接收端没有 preload / Node。保留 sandbox 与 contextIsolation。源码路径 / ASAR 路径 / Windows 短路径都要覆盖，不采用关闭 sandbox 修复环境限制。
10. 系统声音默认关闭，只有所选来源明确启用且请求来自本地主 frame 才授予 Windows `audio: 'loopback'`；查找来源后再次核对 revision 和开关，不使用 `loopbackWithMute`。采集整台电脑输出，不宣称仅抓取所选进程声音。
11. 系统声音与麦克风独立 GainNode，最多一条输出音轨；麦克风静音不关掉系统声音。两路广播音量严格为 0–100 整数，广播时可实时调整并保存；不改变 Windows 扬声器音量。原始、混合轨道和 AudioContext 在第一次 await 前归当前 CaptureSession；取消不能等 resume，dispose 幂等。准备期间来源或声音断开需取消并提示；运行中声音断开明确提示画面仍继续。

## 实施与验证

网页视频采用 `maintain-resolution`，受限时优先保留分辨率并允许降帧；`maxBitrate` / `maxFramerate` 仍为配置上限。画质回归应核对真实采集、编码及接收尺寸和实际帧率，不能用静态低流量或参数桩代替清晰度证据。具体用户说明见 [README 的带宽设置](../../../README.md#100-mbps-带宽设置)。

RTMP 增量合同：

- RTMP 与网页复用同一最终 MediaStream，合计人数受 AudienceRegistry 限制；随机 RTMP 路径不保存。控制 API / HTTP 认证仅在 loopback，发布凭据不进入 UI / 日志 / 摘要。RTMP error / stopped 立即 dispose recorder，不能停止网页或共享轨道。保持复制链接、二维码与地址导入，取消 URL 文件导出。
- H.264 / HEVC 与加速模式严格白名单。实际短帧编码后报告编码器可用，实际接收解码后算传输验证；auto 保持同 codec 软件回退，hardware 无设备明确失败。探测和发布进程归同次 RtmpSession；未证实退出不能遗失归属、释放占位或绕开上限重启。retired owner 保留到重试成功，关闭失败允许再次关窗。
- 新配置和缺少对应字段的设置默认网页 HEVC、RTMP HEVC + auto；显式保存偏好保留。RTMP 首先实际探测 NVIDIA NVENC，再尝试其他硬件和同 codec 软件。网页 GPU 由 Chromium / 驱动决定。便携验收须使用干净配置验证默认值、实际发布编码器与加速状态及 Enhanced RTMP 解码；不能只改控件或文档。
- HEVC 使用 Enhanced RTMP，接收端必须支持；FFmpeg 接收需在 -i 前声明 -rtmp_enhanced_codecs hvc1。编码器名或子进程启动不能作为硬件或可播放证据。
- 原生依赖固定来源、版本、SHA256、许可与对应源码，离线自足。source / validation / runtime evidence 包含原生文件和 manifest 哈希；源与打包目录各自实际解码 H.264 硬件 / 软件、HEVC 硬件 / 软件四组视频及 AAC / 混合 PCM。修改验证脚本后重收匹配指纹的全部报告。新增串行桌面命令 node scripts/rtmp-smoke.js。

先读根计划、结构及改动领域源码，检查调用者和配置兼容。按文件所有权开发，主 agent 串行执行所有桌面脚本，使用隔离 userData。必要命令：`npm.cmd test`、`npm.cmd run check`、`node scripts/features-smoke.js`、`node scripts/smoke.js`、`node scripts/gui-regressions.js`、`node scripts/system-audio-smoke.js`；构建后设置 `LAN_CAST_EXECUTABLE` 指向打包目录 EXE 再运行桌面检查，最后核对 bundle、单文件启动与 ZIP。

例如 WAN 从 10.20.30.40 变为 10.20.30.41：新链接地址变化，令牌不变，旧 Host 拒绝；这不证明一级网络用户已穿过 NAT。接收端不接受 H.265：仍收到 H.264 / VP8 解码帧，GUI 显示回落。只有 H.265 capability：仍不能报告实际编码成功。

失败时保留同次日志、状态及最小复现。实际媒体检查从 Node 等待已完成的异步 getStats 结果；不要将 Playwright waitForFunction 中未结算的 Promise 当作通过。真实校园网、物理多机、100 Mbps 限速、游戏采集、端到端延迟均需独立现场证据，缺少时明确未测。

系统声音检查必须经过真实 Windows 播放设备、原生 getDisplayMedia 回环和接收解码；不能用合成 display 音轨替换回环后报告通过。麦克风输入可在传输测试中替换，但明确边界；接收端在本机输出静音以防循环反馈。频率、RMS 与音量 / 静音前后变化用于证明可听信号；只有 RTP 字节或 live 音轨不能证明系统声音可用。测试失败清理只关闭自己的 fixture，并保持有界；创建测试 BrowserWindow 后先 loadURL，再等 Playwright window 事件。

用户反馈测试音过大后，真实输出夹具默认静音，仅在采样窗口开启幅度 0.0003 的信号，每段最多 20 秒并自动归零；异常与非采样阶段及时静音。基础媒体测试的观看窗口也须通过 webContents.setAudioMuted(true) 禁止本机播放，保留真实解码检查。不得调整用户 Windows 系统音量或真实设置来通过验收。进程清理与残留判断须核对 PID、创建时间及程序路径，不能把复用 PID 的无关进程误当成测试所有。
