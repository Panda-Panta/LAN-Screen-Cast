# 交付配置

- 源码根：本项目目录；本次建立 Git main 并上传已确认的用户自有公开仓库，实际提交以本地 HEAD / 远端核验为准。
- 已授权产物目标：项目内 `release/` 及 GitHub Release 1.0（v1.0），正式程序版本和 EXE / ZIP 文件名统一 1.0.0；原生 RTMP 运行库、对应源码与许可随包提供。旧同名开发包在 .cache/github-release-1.0/previous-1.0-artifacts/ 备份并核对哈希，本地 release/ 下的 1.3.1 EXE / ZIP 已核对已知哈希并移除，不上传旧版本附件。
- 用户安装目录：未提供；本次不执行额外安装或替换。
- 远程仓库 / 正式在线发布：用户明确授权公开仓库 https://github.com/Panda-Panta/LAN-Screen-Cast，main；发布标题 Release 1.0，标签 v1.0。发布步骤由主 agent 串行执行，核对远端提交和附件 SHA256 后登记结果。
- 用户数据：真实应用 userData 中的 settings.json 保留；全部测试使用 `LAN_CAST_DATA_DIR` 隔离目录，不读写用户 APPDATA 配置。
- 本地构建：`npm.cmd run build -- --config.electronDist=node_modules/electron/dist`；builder cache 放 `.cache/`。应用保留 sandbox / contextIsolation，关闭 Node integration；测试 runtime 需要普通 Windows 会话运行。
- 便携版解压目录：沿用 electron-builder 为本构建生成的目录名，不跨构建共用固定 `LAN-Screen-Cast-runtime`；不会因此迁移原 userData。
- 产物证据：真实打包目录媒体 / GUI / RTMP 硬件编码验证、单文件启动、生产源码与 ASAR 逐项比对、原生 manifest 和逐文件哈希比对、ZIP CRC 与内含 EXE / ASAR / 原生资源哈希比对。最终值见 `release/release-verification.json` 与 `SHA256SUMS.txt`。
- 本次验证范围例外：用户明确停止声音测试，当前四份系统回环 / RTMP 混音复验未完成。源码与打包各 22 项静音 GUI、Node / 语法、bundle 和关闭音频的单文件 HEVC / NVIDIA 视频实际解码通过；临时打包适配器保留这些检查及全部 ZIP / 原生哈希核验，在 ZIP 内外标记完整 runtimeValidationPassed=false、audioValidationDeferred=true。常规发布工具的严格门禁不改，历史源码音频仅单列，不冒充当前打包版音频已验证。
- 回退与配置：保留必要内部构建备份，区分旧开发用同名 1.0.0 与本次正式发行，以标签 v1.0 和发布附件 SHA256 为准。软件兼容已有设置并补默认字段，不执行破坏性迁移；广播会话和观看邀请不跨重启保存。

未配置额外用户安装目录；本次交付范围为本地制品、源码 GitHub 仓库及正式 Release，逐项核验后报告状态。
