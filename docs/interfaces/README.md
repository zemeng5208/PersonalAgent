# 接口文档

本目录是跨模块接口状态、兼容范围和可用性判定的唯一登记入口。接口在源码中出现、能够编译或存在 Fake，均不自动等于已冻结或生产可用。

当前只实施[华为 ICT AgentArts Competition Profile](../competition/HUAWEI_ICT_AGENTARTS_PROFILE.md)，Local Profile 仅可选留存现有代码且当前不新增。部署 profile 的优先级不提升接口状态；AgentArts 在真实部署、API、trace 和本地可信工具闭环完成前仍为 `unavailable`。

- [当前接口目录与冻结登记](CURRENT_INTERFACE_CATALOG.md)：当前公开操作、TypeScript 端口、冻结证据、运行时可用性及未提供接口。
- [公共开发协议](../DEVELOPMENT_PROTOCOL.md)：请求、状态、授权、副作用与兼容性语义。
- [Runtime 查询接口](../modules/RUNTIME_QUERY_API.md)：PR #34 交付的任务、会话和审批恢复查询。
- [独立开发接口请求](../modules/zemeng-interface-freeze-request.md)：F01～F10 的历史请求、已交付项和剩余工作。

任何接口状态变化必须同时更新本目录、对应实现 README、[ROADMAP](../ROADMAP.md) 和实际验证证据。
