# 开发入口

软件开发、更新、修复、重构及工程配置变更，先读取用户默认 `C:/Users/Panda-Panta/.agents/skills/agent-dev-workflow/SKILL.md`，然后读取 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) 和 [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)。当前用户具体要求优先。纯问答和只读审查不执行安装或同步。

修改路由器地址发现、WAN / ICE 映射、采集取消或重连、麦克风探测、设置保存、编码协商时，读取 [项目维护规则](docs/skills/lan-cast/SKILL.md)。按根计划核对当前增量验收。

已委派子 agent 按文件归属执行，不递归派工；主 agent 统一集成和交付。桌面测试由主 agent 串行运行，使用隔离 userData；保持用户真实配置。远程与安装目标以 [交付配置](docs/delivery.md) 的已确认内容为准。
