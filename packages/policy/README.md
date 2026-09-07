# 授权策略（MOD-05）

`@personal-agent/policy` 提供任务级授权策略。授权绑定 `authorizationRef`、任务、工具、scope、到期时间和可选使用次数、参数摘要；支持立即撤销。工具调用方不能把自报 scope 当作授权。

`AuthorizationPolicy` 消费 `AuthorizationStore` 事务端口；Runtime 注入 SQLite 存储，一次性授权的检查和消费在同一事务内完成，重启不会重置次数。`InMemoryAuthorizationPolicy` 保留为隔离测试实现。授权当前仍绑定单个任务和工具，跨任务持续授权管理不是已完成能力。

验证：

```sh
npm run build --workspace=@personal-agent/policy
npm run test --workspace=@personal-agent/policy
```
