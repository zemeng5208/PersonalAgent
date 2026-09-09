# 连接器宿主（MOD-05）

`@personal-agent/connector-host` 提供连接器注册、能力发现、健康状态和连接生命周期。连接器工厂只能读取注册时声明的凭据引用；列表和健康结果不返回凭据。具体凭据由注入的 `SecretStorePort` 提供，Windows Credential Manager / DPAPI 实现仍归 MOD-16。

ConnectorPort、ConnectorHost 和 `SecretStorePort.read` 当前为 `provisional`。生产 Runtime 尚未公布 `connector.connect` / `connector.disconnect`，账号会话也未持久化；未公布 operation 必须按 `unavailable` 处理。见[当前接口目录](../../docs/interfaces/CURRENT_INTERFACE_CATALOG.md)。

业务查询和写动作不从宿主直接暴露，必须注册为工具并经过 `@personal-agent/tool-gateway`，避免绕过授权策略。当前切片尚未持久化账号会话，也未接真实连接器。

验证：

```sh
npm run build --workspace=@personal-agent/connector-host
npm run test --workspace=@personal-agent/connector-host
```
