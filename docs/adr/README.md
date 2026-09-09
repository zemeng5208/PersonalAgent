# 架构决策记录

ADR 记录已经采纳且会长期影响多个模块的决定。编号递增，合并后不重写历史；后续决策使用新的 ADR 标记替代关系。

当前只实施 Huawei ICT AgentArts Competition Profile，Local Profile 仅可选留存现有代码且当前不新增。ADR-0001～0006 的通用边界继续适用，ADR-0007 规定比赛主路径和当前范围。

每份 ADR 包含：状态、背景、决定、理由、影响、替代方案和复审条件。

- [ADR-0001：采用模块化单体](0001-modular-monolith.md)
- [ADR-0002：依赖方向与应用装配](0002-dependency-direction.md)
- [ADR-0003：Runtime 控制任务与工具执行](0003-runtime-authority.md)
- [ADR-0004：持久授权、工具证据与审批恢复](0004-persistent-tool-approval.md)
- [ADR-0005：采用分层接口冻结与显式不可用状态](0005-layered-interface-freeze.md)
- [ADR-0006：核心认知依赖倒置与 AgentArts 本地信任边界](0006-coordination-and-agentarts-boundary.md)
- [ADR-0007：华为 ICT AgentArts Competition Profile 优先](0007-huawei-ict-agentarts-competition-profile.md)
