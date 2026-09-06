# 工具网关（MOD-05）

`@personal-agent/tool-gateway` 实现生产侧 `ToolHost` 注册和受控调用：

- 输入/输出按工具 JSON Schema 校验；
- scope 只从 `PolicyPort` 根据受信 `authorizationRef` 解析；
- 校验任务、工具版本、deadline、用户在场要求；
- 取消信号传给工具；
- 外部写入在执行开始后被取消或超时时返回 `RESULT_UNKNOWN`，不自动重试。

Runtime 只允许为 `running` 的持久任务调用工具，并为 confirmed/unknown 结果记录 `tool.completed` 事件。当前切片不负责生成审批 UI、持久化授权或保存独立 Evidence 实体；这些由后续存储装配和 MOD-13 消费端完成。工具仍需自行实现可核实的恢复接口，网关只阻止盲目重试。

验证：

```sh
npm run build --workspace=@personal-agent/tool-gateway
npm run test --workspace=@personal-agent/tool-gateway
```
