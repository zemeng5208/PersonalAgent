# 授权策略（MOD-05）

`@personal-agent/policy` 提供任务级授权策略。授权绑定 `authorizationRef`、任务、工具、scope、到期时间和可选使用次数、参数摘要；支持立即撤销。工具调用方不能把自报 scope 当作授权。

本包是当前 [Huawei ICT AgentArts Competition Profile](../../docs/competition/HUAWEI_ICT_AGENTARTS_PROFILE.md) 的共享本地信任边界：AgentArts 只能提出动作，不能生成或消费本地授权。正式比赛链路必须经过本策略并保留决策证据；可选 Local Profile 不建立另一套授权体系。

当前策略实现及端口为 `provisional`：任务级持久授权和一次性事务消费已有离线证据，但跨任务持续授权、撤销管理面和真实模型/工具宿主消费尚未完成。冻结状态见[当前接口目录](../../docs/interfaces/CURRENT_INTERFACE_CATALOG.md)。

`AuthorizationPolicy` 消费 `AuthorizationStore` 事务端口；Runtime 注入 SQLite 存储，一次性授权的检查和消费在同一事务内完成，重启不会重置次数。`InMemoryAuthorizationPolicy` 保留为隔离测试实现。授权当前仍绑定单个任务和工具，跨任务持续授权管理不是已完成能力。

验证：

```sh
npm run build --workspace=@personal-agent/policy
npm run test --workspace=@personal-agent/policy
```
