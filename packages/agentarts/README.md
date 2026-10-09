# 自有 AgentArts 编排包

<!-- current-design-20261009 -->
> 当前目标与协作规则（2026-10-09）：[完整设计](../../docs/design/resident-developer-agent-20261008/DESIGN.md) · [离线阅读/全部 SVG](../../docs/design/resident-developer-agent-20261008/index.html) · [两人确认与本机阅读门槛](../../docs/reviews/DESIGN_READING_GATE.md)。WSS 主通道、HTTPS 备用；Wiki 记忆由 goo122 接入。goo122 与 Potatos498 均确认后才可按授权合并，禁止强制合并/管理员绕过。设计不等于已实现；本文历史验收与作者记录保留，旧合并规则以当前门槛为准。

`OwnedAgentOrchestrator` 只负责云端语义编排，复用 ModelGateway 和现有严格
Coordination parser。普通目标走 fast，合法修复走 world → plan → review；
confirmed 普通结果只总结，不误入修复；命令检查回执可确定性总结。
所有输出仍是不可信提案。本包不拥有授权、工具执行、任务终态、数据库或 Evidence。

入口为既有 `{goal,availableTools}`、`{continuation}`、普通文字或固定主动 Goal 包装。
ModelPort 按角色注入，可替换供应商；每次调用必须提供输出 token 预算、原期限和取消信号。
模型失败不回退；角色 trace 仅记录角色/请求标识/状态/token，不记录内容或凭据。
部署入口在 `apps/agentarts-runtime`，迁移边界见 ADR-0012。

这是 code-owned MVP 路径的实现，提示词已进入版本控制；2026-10-08 已收到并清点8个工作流原始导出。
多智能体导出、旧版报告格式和未盘点的知识/MCP/插件尚不能声明等价迁移。
应用 JSON 和本地 Runtime 契约保持原有 provisional 状态。
