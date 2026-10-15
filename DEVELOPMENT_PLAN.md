# LAN Screen Cast 开发计划入口

产品面向 Windows 10/11 x64、100 Mbps 上下行和 1–5 台观看设备；Electron 捕获屏幕或窗口，混合可选系统声音和麦克风，通过 WebRTC 网页或 RTMP 播放器观看。源码事实以 `src/` 为准。

- [产品架构与基础合同](docs/superpowers/specs/2026-10-12-lan-cast-design.md)
- [1.0 基础实施及验收](docs/superpowers/plans/2026-10-12-lan-cast.md)
- [1.1 功能增量计划](docs/changes/2026-10-12-v1.1.md)
- [1.1.1 UPnP 兼容性修复](docs/changes/2026-10-13-v1.1.1.md)
- [1.2 系统声音](docs/changes/2026-10-13-v1.2.md)
- [1.3 网页与 RTMP 分享、H.264 / HEVC 及硬件加速](docs/changes/2026-10-13-v1.3.md)
- [实际结构、职责与入口](PROJECT_STRUCTURE.md)
- [运行与网络说明](README.md)、[验证记录](docs/verification.md)、[交付配置](docs/delivery.md)
- [跨模块维护规则](docs/skills/lan-cast/SKILL.md)：修改路由器发现、持久化、采集生命周期或编码协商时读取。

本目录已建立 Git main，确认的远端为 https://github.com/Panda-Panta/LAN-Screen-Cast；交付目标为项目内 `release/` 和 GitHub Release 1.0，未配置额外安装目录。共享目录按文件所有权开发，由主 agent 统一集成、桌面运行检查和发布。

最近全项目结构审查：2026-10-13，1.3 里程碑；显示授权、音频混合、共享观看容量、原生 RTMP 服务、编码探测及录制分片各有独立模块，装配只在 main / host，未引入循环依赖。检查模块入口、取消与资源所有权、打包白名单、原生依赖清单和文档引用，验证与结论在增量计划登记。

## 已完成内部增量：默认 HEVC 与 NVIDIA 优先（2026-10-15）

状态：内部实现及软件验收已通过，随后并入正式 1.0.0；该阶段沿用个人模式、仅本地交付，当时未设置 Git 远端或外部安装目录。正式首发状态以下一节和 release/release-verification.json 为准。

- 目标：新配置与缺少对应字段的旧配置默认网页 HEVC 优先、RTMP HEVC + auto。RTMP auto 保持实际 NVENC 优先，失败依次尝试其他硬件与同 HEVC 软件；不增加枚举或改动原生依赖。网页 GPU 由 Chromium / 驱动决定，不承诺可指定 NVIDIA。
- 兼容：已保存的 codec、rtmpCodec、rtmpAcceleration 原样保留，不改写真实 userData；H.264、软件及仅硬件选项继续可用。界面说明 NVIDIA 优先和 HEVC 播放要求。
- 并行批次：default_config 独占 src/config.js、src/rtmp-encoder.js 及对应两份测试，统一默认和缺省兼容；default_acceptance 独占 scripts/portable-launch.js、scripts/package-release.py，对齐全新便携 HEVC 默认及 Enhanced RTMP 实际解码门禁。主 agent 独占 GUI / 分享测试、版本锁文件、文档、集成及桌面运行；各 agent 不启动 GUI，不递归派工。
- 验收：默认与已保存偏好检查、NVENC 实际优先及失败回退；完整 Node / 语法，源码及打包五类桌面回归，实际单文件默认 HEVC 编码器 / 硬件状态与视频解码、bundle 和 ZIP 哈希核对。保留 1.3.0 及更旧 EXE / ZIP。
- 文档与结构：更新本段、README、网络 / 验证 / 交付记录；检查现有模块索引，结构不变不另造模块。现场校园网、物理多机及端到端延迟边界继续保留。
- 完成记录：default_config 与 default_acceptance 同批并行完成并冻结，主 agent 集成 GUI / 版本；default_review 独立复核配置、GUI 与两个发布脚本，无需修复问题。完整 Node 282/282、67 个 JS / MJS 语法检查、源码及实际打包目录各五类 39 项桌面检查、真实便携默认 HEVC / hevc_nvenc 解码通过。一次源码运行因用户手动关窗中断，原代码重跑通过；未作无依据修复。根结构索引及维护 skill 校验通过；交付工具要求全部当前指纹证据通过并执行 ZIP CRC / 哈希核验，详细证据与现场边界见 [验证记录](docs/verification.md)。

## 当前交付：GitHub Release 1.0（2026-10-15）

状态：准备正式 1.0.0 构建及发布。用户已确认公开仓库 Panda-Panta/LAN-Screen-Cast，并要求不保留 1.3.1；程序元数据与附件统一 1.0.0，首次 GitHub 发布标题 Release 1.0、标签 v1.0。默认 HEVC + NVIDIA 优先保持不变。旧同名 1.0.0 开发包已在 .cache/github-release-1.0/previous-1.0-artifacts/ 备份并核对哈希；正式包通过后不保留 release/ 下的 1.3.1 EXE / ZIP。

- 范围：初始化本地 Git、提交源码与必要原生资源到确认的自有仓库 main；重新构建并完整验证 1.0.0 Windows x64 EXE / ZIP，再发布下载文件 SHA256 及验证摘要。保留真实配置和必要旧构建回退，不上传 node_modules、.cache、test-results、release 中间目录或旧版本附件。
- 并行批次：publish_audit 只读核对候选文件、许可、敏感内容和当前制品 / 指纹，输出到 .cache/github-release-1.0/；release_notes 独占 docs/releases/1.0.md，编写版本映射、功能、使用、验证和现场边界。主 agent 独占 Git / 远端 / 发布、根计划、结构和交付文档；子 agent 不运行 Git 写入、上传、GUI 或递归派工。
- 依赖：先确定仓库目标和可用认证，再核对公开清单 / 最大文件大小、实际二进制与既有证据；源码和产物都准备好后提交、普通推送，再创建 Release 并上传资产。若远程已有内容先检查，不覆盖或强推。
- 验收：1.0.0 的 Node / 语法、源码和打包各五类媒体 / GUI、单文件及 ZIP 均收集当前版本 / 指纹证据；远端 main 与本地候选 SHA 一致，v1.0 指向已验收源码，Release 非草稿且标题正确，附件清单 / 大小 / SHA256 与本地文件一致。此前内部版本证据仅作基线，不替代本次重测。远程与本地交付状态分别记录。
