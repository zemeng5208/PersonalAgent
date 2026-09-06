# Models

MOD-04 的模型端口和模型网关。`ModelGateway` 只接受显式配置的 Provider，并在请求前校验文本、工具调用和结构化输出能力；Provider 返回的 deployment、verification 和 usage 会随结果保留。

当前验证等级：

- `FakeModelProvider`：`mock`，仅用于无网络测试。
- `UnavailableModelProvider`：明确返回不可用。
- `PanguModelProvider`：`conditional` 占位适配器，未猜测 endpoint、SDK 或部署名，真实接入需要单独授权和官方文档验证。

模型不能提供 `scopeRef`、凭据或执行函数。工具提案必须由 Agent 根据 Runtime 提供的工具描述重新校验。
