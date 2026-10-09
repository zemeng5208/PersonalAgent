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

这是 code-owned 路径的受限实现，提示词进入版本控制。2026-10-09 已核对已授权的8个 Workflow、
3个顶层 Controller 导出，按原有内部职责补充完整 World/Plan 报告；逐项迁移与缺口见
[迁移矩阵](../../docs/modules/AGENTARTS-OWNED-IMAGE-PARITY.md)。清点不等于全量等价或真实云验收。

`owned-1.1` 提示词输出 `reportVersion: "1.1"` 的完整内部报告，校验 graph revision、
宿主提供的事实/Goal前后版本及原文、最新目标与允许依赖引用。World保留显式/推断观察、
变化与 direct/transitive 影响标签；推断、缺项和缺少前后版本不能生成修复。
direct/transitive 是待本地图谱预览的模型分析，当前投影没有完整旧依赖边，不能据此证明因果。
Plan保留保留/复核/修订/移除、依赖更新、证据需求与本地后续建议这些独立职责。
步骤分类互斥，影响目标不可遗漏；未列出的无关目标默认不改。

确定的 `revised_steps` 映射既有 `repair_candidate`，依赖逐字采用宿主
`requestedDependencies`，Review不得替换或遗漏方案。`preserved_steps` 不产生写入，
未满足的 `rechecked_steps` 返回RECHECK。现有候选不能表达删除、新步骤或工具动作，
含确定移除/后续动作的报告返回 `UNSUPPORTED_CAPABILITY`，不假装已经迁移这些行为。
`evidence_required` 仅是尚需可信本地核实的要求，保留给Review，不生成或满足真实Evidence。

兼容 `owned-1.0` 的紧凑World/Plan报告供原有消费夹具使用；完整报告必须声明版本，
不能混用完整World和紧凑Plan，也不直接执行无版本的旧导出DSL或报告。
继续轮次只含 `repairContext` 时没有可引用事实原文与前后版本，完整World必须RECHECK；
后续需宿主公布来源投影契约，不能由模型补造。缺来源不静默切换旧提示词或供应商。
应用 JSON 和本地 Runtime 契约保持原有 provisional 状态。
