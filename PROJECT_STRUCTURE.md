# 项目结构与模块职责

目录树由 agent-dev-workflow 的 `update_project_structure.py` 维护。参数：`--depth 5 --exclude node_modules --exclude .cache --exclude release --exclude test-results --exclude __pycache__`。项目已采用 Git，工具依据工作区文件和排除项生成下方源码摘要，不纳入依赖安装目录、临时数据与构建产物。

## 依赖与入口

- `src/main.js` 装配系统捕获、可信 IPC、会话服务器、设置存储和只读路由器发现；`preload.js` 暴露固定能力；`display-media.js` 核对所选来源、主 frame、revision 与系统声音授权。
- `src/config.js` 定义默认配置、草稿保存与严格启动验证。`settings-store.js` 仅负责持久化。`router-discovery.js` 仅负责所选网卡的网络查询。
- `src/broadcast-session.js` 管理服务器所有权与未完成退出的 retired owner；`lan-server.js` 管理 HTTP / WS 和认证，`cast-server.js` 装配网页及可选 RTMP 服务；`audience.js` 为两种协议提供唯一人数边界。服务不依赖 GUI。
- `src/renderer/host.js` 是广播 GUI 装配入口；capture / microphone / audio-mixer / autosave / router / share / host-media 各模块独占其状态与资源，互不循环依赖。`audio-mixer.mjs` 为两种声音创建独立 gain 与单一发送音轨，资源归 CaptureSession。
- `src/rtmp-session.js` 拥有认证、原生子进程、临时配置、发布管道及状态轮询；`rtmp-encoder.js` 实际探测 H.264 / HEVC 的硬件与软件路径，固定编码参数并向服务交还探测进程归属。`renderer/rtmp-recorder.mjs` 仅拥有录制及有界分片队列，借用最终媒体流，不停止共享轨道。
- `src/shared/network.mjs` 是地址和候选映射纯函数；`shared/rtc.js` 是通用编码能力与统计。共享层不依赖主进程或 DOM。
- `src/viewer/viewer.js` 装配网页接收；`receiver-session.mjs` 管理连接和重试，`invitation.mjs` 解析地址导入。接收端不拥有 Node / preload 权限。
- `tests/` 包括纯函数、状态、混音与授权、真实 UDP / HTTP 协议夹具、共享容量、服务器、录制背压和持久化回归。五类桌面脚本 smoke / gui-regressions / features-smoke / system-audio-smoke / rtmp-smoke 串行运行真实程序，使用 `.cache/` 隔离设置；后两类验证实际 Windows 输出回环、混合音频与接收解码。
- `scripts/verify-bundle.js` 比对 ASAR 与源码；`portable-launch.js` 检查单文件启动；`package-release.py` 生成带文档与脱敏验证摘要的 ZIP 并核对 CRC / 哈希。
- `scripts/media-evidence.js` 核对完整原生文件清单及实际字节；`source-fingerprint.js` 定义含原生资源的生产与验证指纹；`validate.js` 绑定 Node / 语法结果；`runtime-evidence.js` 绑定实际应用版本、候选 EXE / ASAR 和原生文件。
- `vendor/media/` 为离线运行资源：bin 保存 FFmpeg、MediaMTX 及 DLL，licenses 保存原始许可与依赖来源，sources 保存固定源码及重建脚本，manifest 记录每项 SHA256。`scripts/fetch-media-dependencies.ps1` 固定取件、最小 LGPL 构建及校验；构建缓存仅在 `.cache/`。
- `docs/` 保存设计、增量计划、网络说明、实际验证和项目维护 skill；这些开发文档不需要进入应用 ASAR。

工程命令见 `package.json`，产品使用见 [README](README.md)，当前计划见 [DEVELOPMENT_PLAN](DEVELOPMENT_PLAN.md)。

<!-- BEGIN AUTO STRUCTURE -->
Index mode: git (git ls-files --cached --others --exclude-standard; deduplicated).
Depth: 5 (root is 0; deeper children are omitted).
Fixed exclusions (any path component, case-insensitive): .git, node_modules, dist, build, target, venv, .venv, __pycache__, cache, .cache, coverage, .next.
Environment exclusions: .env, .env.*; exceptions: .env.example, .env.sample.
Custom exclusions (case-sensitive glob): node_modules, .cache, release, test-results, __pycache__.
The output path is always included, even when ignored, excluded, or beyond the depth limit.

```text
./
├── assets/
│   ├── icon.ico
│   └── icon.png
├── docs/
│   ├── changes/
│   │   ├── 2026-10-12-v1.1.md
│   │   ├── 2026-10-13-v1.1.1.md
│   │   ├── 2026-10-13-v1.2.md
│   │   └── 2026-10-13-v1.3.md
│   ├── releases/
│   │   └── 1.0.md
│   ├── skills/
│   │   └── lan-cast/
│   │       └── SKILL.md
│   ├── superpowers/
│   │   ├── plans/
│   │   │   └── 2026-10-12-lan-cast.md
│   │   └── specs/
│   │       └── 2026-10-12-lan-cast-design.md
│   ├── delivery.md
│   ├── network-guide.md
│   └── verification.md
├── scripts/
│   ├── check.js
│   ├── diagnose-devices.js
│   ├── features-smoke.js
│   ├── fetch-media-dependencies.ps1
│   ├── gui-regressions.js
│   ├── make-icon.ps1
│   ├── media-evidence.js
│   ├── package-release.py
│   ├── portable-launch.js
│   ├── rtmp-smoke.js
│   ├── runtime-evidence.js
│   ├── smoke.js
│   ├── source-fingerprint.js
│   ├── system-audio-smoke.js
│   ├── validate.js
│   └── verify-bundle.js
├── src/
│   ├── renderer/
│   │   ├── audio-mixer.mjs
│   │   ├── capture-session.mjs
│   │   ├── host-media.js
│   │   ├── host.css
│   │   ├── host.js
│   │   ├── index.html
│   │   ├── microphone-controller.mjs
│   │   ├── router-address.mjs
│   │   ├── rtmp-recorder.mjs
│   │   ├── settings-autosave.mjs
│   │   └── share.js
│   ├── shared/
│   │   ├── network.mjs
│   │   └── rtc.js
│   ├── viewer/
│   │   ├── index.html
│   │   ├── invitation.mjs
│   │   ├── receiver-session.mjs
│   │   ├── viewer.css
│   │   └── viewer.js
│   ├── audience.js
│   ├── broadcast-session.js
│   ├── cast-server.js
│   ├── config.js
│   ├── display-media.js
│   ├── lan-server.js
│   ├── main.js
│   ├── preload.js
│   ├── router-discovery.js
│   ├── rtmp-encoder.js
│   ├── rtmp-session.js
│   ├── settings-store.js
│   └── trusted-page.js
├── tests/
│   ├── audience.test.js
│   ├── audio-mixer.test.js
│   ├── cast-server.test.js
│   ├── codec.test.js
│   ├── config.test.js
│   ├── display-media.test.js
│   ├── host-lifecycle.test.js
│   ├── host-media.test.js
│   ├── lifecycle.test.js
│   ├── main-router-lifecycle.test.js
│   ├── media-evidence.test.js
│   ├── microphone-controller.test.js
│   ├── network.test.js
│   ├── preferences.test.js
│   ├── router-address.test.js
│   ├── router-discovery.test.js
│   ├── rtmp-encoder.test.js
│   ├── rtmp-recorder.test.js
│   ├── rtmp-session.test.js
│   ├── server-wan-refresh.test.js
│   ├── server.test.js
│   ├── settings-autosave.test.js
│   ├── settings-store.test.js
│   ├── share.test.js
│   ├── trusted-page.test.js
│   ├── viewer-invitation.test.js
│   └── viewer-session.test.js
├── vendor/
│   └── media/
│       ├── bin/
│       │   ├── avcodec-62.dll
│       │   ├── avdevice-62.dll
│       │   ├── avfilter-11.dll
│       │   ├── avformat-62.dll
│       │   ├── avutil-60.dll
│       │   ├── ffmpeg.exe
│       │   ├── ffprobe.exe
│       │   ├── libwinpthread-1.dll
│       │   ├── mediamtx.exe
│       │   ├── swresample-6.dll
│       │   └── swscale-9.dll
│       ├── licenses/
│       │   ├── mediamtx-modules/
│       │   │   ├── aead.dev_minisign_v0.2.0/ [depth limit: children omitted]
│       │   │   ├── code.cloudfoundry.org_bytefmt_v0.92.0/ [depth limit: children omitted]
│       │   │   ├── dario.cat_mergo_v1.0.0/ [depth limit: children omitted]
│       │   │   ├── github.com_abema_go-mp4_v1.7.3/ [depth limit: children omitted]
│       │   │   ├── github.com_alecthomas_kong_v1.16.1/ [depth limit: children omitted]
│       │   │   ├── github.com_asticode_go-astikit_v0.30.0/ [depth limit: children omitted]
│       │   │   ├── github.com_asticode_go-astits_v1.16.0/ [depth limit: children omitted]
│       │   │   ├── github.com_bluenviron_gohlslib_v2_v2.4.6/ [depth limit: children omitted]
│       │   │   ├── github.com_bluenviron_gortmplib_v1.0.4/ [depth limit: children omitted]
│       │   │   ├── github.com_bluenviron_gortsplib_v5_v5.6.7/ [depth limit: children omitted]
│       │   │   ├── github.com_bluenviron_mediacommon_v2_v2.9.6/ [depth limit: children omitted]
│       │   │   ├── github.com_cloudflare_circl_v1.6.3/ [depth limit: children omitted]
│       │   │   ├── github.com_cyphar_filepath-securejoin_v0.6.1/ [depth limit: children omitted]
│       │   │   ├── github.com_datarhei_gosrt_v0.12.0/ [depth limit: children omitted]
│       │   │   ├── github.com_dunglas_httpsfv_v1.1.1/ [depth limit: children omitted]
│       │   │   ├── github.com_emirpasic_gods_v1.18.1/ [depth limit: children omitted]
│       │   │   ├── github.com_fsnotify_fsnotify_v1.10.1/ [depth limit: children omitted]
│       │   │   ├── github.com_gabriel-vasile_mimetype_v1.4.13/ [depth limit: children omitted]
│       │   │   ├── github.com_gin-contrib_pprof_v1.5.6/ [depth limit: children omitted]
│       │   │   ├── github.com_gin-contrib_sse_v1.1.1/ [depth limit: children omitted]
│       │   │   ├── github.com_gin-gonic_gin_v1.12.0/ [depth limit: children omitted]
│       │   │   ├── github.com_go-git_gcfg_v1.5.1-0.20230307220236-3a3c6141e376/ [depth limit: children omitted]
│       │   │   ├── github.com_go-git_go-billy_v5_v5.9.2/ [depth limit: children omitted]
│       │   │   ├── github.com_go-git_go-git_v5_v5.19.3/ [depth limit: children omitted]
│       │   │   ├── github.com_go-playground_locales_v0.14.1/ [depth limit: children omitted]
│       │   │   ├── github.com_go-playground_universal-translator_v0.18.1/ [depth limit: children omitted]
│       │   │   ├── github.com_go-playground_validator_v10_v10.30.3/ [depth limit: children omitted]
│       │   │   ├── github.com_goccy_go-yaml_v1.19.2/ [depth limit: children omitted]
│       │   │   ├── github.com_golang-jwt_jwt_v5_v5.3.1/ [depth limit: children omitted]
│       │   │   ├── github.com_golang_groupcache_v0.0.0-20241129210726-2c02b8208cf8/ [depth limit: children omitted]
│       │   │   ├── github.com_google_gopacket_v1.1.19/ [depth limit: children omitted]
│       │   │   ├── github.com_google_uuid_v1.6.0/ [depth limit: children omitted]
│       │   │   ├── github.com_gookit_color_v1.6.1/ [depth limit: children omitted]
│       │   │   ├── github.com_gorilla_websocket_v1.5.3/ [depth limit: children omitted]
│       │   │   ├── github.com_jbenet_go-context_v0.0.0-20150711004518-d14ea06fba99/ [depth limit: children omitted]
│       │   │   ├── github.com_kballard_go-shellquote_v0.0.0-20180428030007-95032a82bc51/ [depth limit: children omitted]
│       │   │   ├── github.com_kevinburke_ssh_config_v1.2.0/ [depth limit: children omitted]
│       │   │   ├── github.com_leodido_go-urn_v1.4.0/ [depth limit: children omitted]
│       │   │   ├── github.com_Masterminds_semver_v3_v3.5.0/ [depth limit: children omitted]
│       │   │   ├── github.com_matthewhartstonge_argon2_v1.6.3/ [depth limit: children omitted]
│       │   │   ├── github.com_mattn_go-isatty_v0.0.23/ [depth limit: children omitted]
│       │   │   ├── github.com_MicahParks_jwkset_v0.11.3/ [depth limit: children omitted]
│       │   │   ├── github.com_MicahParks_keyfunc_v3_v3.8.2/ [depth limit: children omitted]
│       │   │   ├── github.com_Microsoft_go-winio_v0.6.2/ [depth limit: children omitted]
│       │   │   ├── github.com_minio_selfupdate_v0.6.0/ [depth limit: children omitted]
│       │   │   ├── github.com_pelletier_go-toml_v2_v2.4.3/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_datachannel_v1.6.3/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_dtls_v3_v3.1.9/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_ice_v4_v4.4.5/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_interceptor_v0.1.49/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_logging_v0.2.4/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_mdns_v2_v2.2.2/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_randutil_v0.1.0/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_rtcp_v1.2.19/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_rtp_v1.10.5/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_sctp_v1.11.3/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_sdp_v3_v3.0.20/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_srtp_v3_v3.1.3/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_stun_v4_v4.0.1/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_transport_v5_v5.1.1/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_turn_v5_v5.1.2/ [depth limit: children omitted]
│       │   │   ├── github.com_pion_webrtc_v4_v4.2.22/ [depth limit: children omitted]
│       │   │   ├── github.com_pires_go-proxyproto_v0.15.0/ [depth limit: children omitted]
│       │   │   ├── github.com_pjbgf_sha1cd_v0.7.0/ [depth limit: children omitted]
│       │   │   ├── github.com_ProtonMail_go-crypto_v1.1.6/ [depth limit: children omitted]
│       │   │   ├── github.com_quic-go_qpack_v0.6.0/ [depth limit: children omitted]
│       │   │   ├── github.com_quic-go_quic-go_v0.63.0/ [depth limit: children omitted]
│       │   │   ├── github.com_quic-go_webtransport-go_v0.13.0/ [depth limit: children omitted]
│       │   │   ├── github.com_sergi_go-diff_v1.3.2-0.20230802210424-5b0b94c5c0d3/ [depth limit: children omitted]
│       │   │   ├── github.com_skeema_knownhosts_v1.3.1/ [depth limit: children omitted]
│       │   │   ├── github.com_ugorji_go_codec_v1.3.1/ [depth limit: children omitted]
│       │   │   ├── github.com_wlynxg_anet_v0.0.5/ [depth limit: children omitted]
│       │   │   ├── github.com_xanzy_ssh-agent_v0.3.3/ [depth limit: children omitted]
│       │   │   ├── github.com_xo_terminfo_v0.0.0-20220910002029-abceb7e1c41e/ [depth limit: children omitted]
│       │   │   ├── go.mongodb.org_mongo-driver_v2_v2.8.0/ [depth limit: children omitted]
│       │   │   ├── golang.org_x_crypto_v0.57.0/ [depth limit: children omitted]
│       │   │   ├── golang.org_x_net_v0.59.0/ [depth limit: children omitted]
│       │   │   ├── golang.org_x_sync_v0.23.0/ [depth limit: children omitted]
│       │   │   ├── golang.org_x_sys_v0.48.0/ [depth limit: children omitted]
│       │   │   ├── golang.org_x_term_v0.46.0/ [depth limit: children omitted]
│       │   │   ├── golang.org_x_text_v0.42.0/ [depth limit: children omitted]
│       │   │   ├── golang.org_x_time_v0.15.0/ [depth limit: children omitted]
│       │   │   ├── google.golang.org_protobuf_v1.36.11/ [depth limit: children omitted]
│       │   │   └── gopkg.in_warnings.v0_v0.1.2/ [depth limit: children omitted]
│       │   ├── toolchain/
│       │   │   ├── gcc/ [depth limit: children omitted]
│       │   │   ├── mingw-w64/ [depth limit: children omitted]
│       │   │   └── winpthreads/ [depth limit: children omitted]
│       │   ├── ffmpeg-buildconf.txt
│       │   ├── ffmpeg-LICENSE.md
│       │   ├── ffmpeg-LICENSE.txt
│       │   ├── ffmpeg-version.txt
│       │   ├── go-LICENSE.txt
│       │   ├── go-PATENTS.txt
│       │   ├── kvazaar-LICENSE.txt
│       │   ├── kvazaar-threadwrapper-LICENSE.txt
│       │   ├── mediamtx-checksums.sha256
│       │   ├── mediamtx-dependencies.json
│       │   ├── mediamtx-LICENSE.txt
│       │   ├── nv-codec-headers-LICENSE.txt
│       │   ├── README.md
│       │   └── toolchain-build-info.txt
│       ├── sources/
│       │   ├── go-header-notices/
│       │   │   └── github.com_benburkert_openpgp_v0.0.0-20160410205803-c2471f86866c.zip
│       │   ├── collect-mediamtx-licenses.py
│       │   ├── FFmpeg-46d899d7a02bc63237472cc4897258d5ddf274ac.zip
│       │   ├── kvazaar-2b06691bb5844404c0e703f12a5d7b0fee914ec7.zip
│       │   ├── mediamtx-914e39535ece709919ac325aaeed98d394ed9093.zip
│       │   ├── minimal-pkg-config.sh
│       │   ├── nv-codec-headers-ced4f8eba3ba5dd431932cba17928f0dffdaeb2b.zip
│       │   └── rebuild-ffmpeg.sh
│       └── manifest.json
├── .gitattributes
├── .gitignore
├── AGENTS.md
├── DEVELOPMENT_PLAN.md
├── LICENSE
├── package-lock.json
├── package.json
├── PROJECT_STRUCTURE.md
└── README.md
```
<!-- END AUTO STRUCTURE -->
