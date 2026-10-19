# 交付配置

2026-10-19 新确认的在用程序及本次窄范围热修复目标见下方[网页清晰度热修复](#网页清晰度热修复2026-10-19)；原 Release 1.0 的发布回执保持历史含义。

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

## Release 1.0 发布回执

2026-10-15 07:47:46 UTC 已发布 [Release 1.0](https://github.com/Panda-Panta/LAN-Screen-Cast/releases/tag/v1.0)，非草稿、非预发布且为 Latest。v1.0 对应源码候选 f666e804bdf6e13642a3ecdfa71475f979cf7be2；EXE 的初始构建提交为 e36ed52a2d6df600eaa6456a9d063c9a5f12c580，随后只更新测试夹具和文档，生产输入指纹及 ASAR 逐项一致。当前音频复验仍按上面的明确延期范围记录。

四个发布附件的 GitHub 服务端 SHA256 与本地一致。下载程序为 1.0.0：

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| LAN-Screen-Cast-1.0.0-win-x64.exe | 149803292 | f33532714d5188b7e0ca599ab2dbe9831a1f12a77a4854f6e9140af5f087ea6a |
| LAN-Screen-Cast-1.0.0-win-x64.zip | 215198981 | 53a740aa06346ca96977403b335ea1f7db26a9a4f34074fac4b8dbbb19808c34 |

本节为发布后的文档回执，未重新改写已发布的 ZIP 或 v1.0 标签。原始交付与远程校验记录在本地 .cache/github-release-1.0/，不上传私有测试日志、会话或配置。

## 网页清晰度热修复（2026-10-19）

用户确认正在使用的程序为 `D:\Tools\LAN Screen Cast\LAN Screen Cast.exe`，包内为 1.2.0。当前任务只修复网页发送在受限时主动降低分辨率的问题。基于原 ASAR 制作候选，只替换已确认与修复前源码一致的 `src/renderer/host-media.js`，其余 278 个 ASAR 文件及属性不变，保留原 EXE、运行库和用户配置，不用最新整包引入其他功能变化。

候选已通过 60 / 30 fps 上限下的真实静音采集和解码尺寸检查。源修复候选 `1c3e8206d2ecd1479f680de989800d571939fb7f` 已从 `test` 验证后快进晋升 `main` 并普通推送；后续仅补交付回执。复核原哈希与占用后，已原子替换安装目录的 `resources/app.asar`，原文件备份哈希匹配。安装后 91 个文件中其余 90 个与真实配置均保持原哈希，并已从该安装路径用隔离配置完成 1904×994 动态画面编码 / 解码检查，实际约 31.3 fps、2.83 Mbps，测试程序已退出。

原 ASAR 备份及差异清单在 `.cache/quality-diagnosis-20261019/candidate.json` 指向的位置，修复 ASAR 保留于 `artifacts/quality-fix-app.asar`，清理重复候选 runtime 和五个测试配置。此项是现有 1.2.0 的本机单模块热修复，元数据版本保留；不创建或覆盖 Release 资产。原观众网络与主观清晰度尚待复播确认。

## 动态码率启动预算热修复（2026-10-19）

延续同一在用 1.2.0，仅更新 `src/renderer/host-media.js` 与 `src/shared/rtc.js`：配置的网页每台码率同时提供给本地发送端的起始带宽和 transport 探测上限，保留 sender 上限及原更低协商上限。基线为上一轮已安装的 ASAR `2115b6e4f9e299928d4a3b5e42c54d42fcd2dd26edbd78f04f056e7faf56973c`；279 文件内容和条目属性逐项比对，其余 277 文件、包版本、EXE / DLL 均不变。候选 SHA256 为 `c57d2010e3934d4fe2cea2aabde4fd9a0752429a3adde6e1a007945944c5ce2a`，两个模块与已验收源码字节一致。

候选在独立 runtime 实际采集和解码 1904×994，动态约 13.16 Mbps、59.97 fps，前 5 秒采样窗约 12.62 Mbps，默认 startup 回归通过，真实配置哈希保持。源码和候选的证据及帧率边界见 [验证记录首节](verification.md#动态码率启动预算修复2026-10-19)。候选与原 ASAR 备份、全安装目录清单在 `.cache/bitrate-diagnosis-20261019/candidate.json`；正式安装需在晋升后再次核对进程、原文件和配置哈希，仅原子替换 ASAR，再从真实安装路径复测。当前安装回执待补，不创建或修改 GitHub Release 附件。
