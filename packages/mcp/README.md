# MCP — Competition read-only slice

目标 `huawei_ict_agentarts` / PA-005 / MOD-06，`provisional`。复用官方 TypeScript SDK `1.31.0` 和官方 filesystem reference server `2026.8.31`，只支持可信固定 stdio 服务。未实现任意 server、远程 MCP、动态 shell 或写工具。

## 公开入口

```ts
import {createReadonlyMcpHost} from '@personal-agent/mcp';
const mcp = createReadonlyMcpHost({nodeExecutable, rootPath, enabled: true});
// register(host) 或 RuntimeApplicationOptions.tools: [...mcp.tools]
await mcp.start({signal, deadline});
const ready = mcp.health().connected;
// 退出/停用前 await；dispose 同时释放 register(host) 的注册。
await mcp.setEnabled(false);
await mcp.dispose();
```

`nodeExecutable` 和已批准 `rootPath` 只能来自受信宿主。服务入口由已锁定 npm 包解析，argv 固定为入口和一个 root，`shell:false`；清空 SDK 默认继承的用户环境变量，保留 Windows `SYSTEMROOT`。未给 options 为 `unavailable`，配置默认停用，不回退 Fake。启动必须完成 SDK `initialize`/版本协商、身份与 capability 校验、真实 `tools/list` 后才显示 connected。`health()` 仅返回脱敏状态/错误码/协商版本/工具名，不返回 PID、路径或 stderr。

发现目录中的 annotations/描述/写工具不授权。唯一注册 `mcp.workspace.read_text@1.0.0`：`{path: string}` 为 root 内 `.md/.txt` 的相对路径，禁止额外字段、绝对路径、反斜杠、逃逸、符号链接、敏感名称，限 256 KiB。返回 `{path,text,contentDigest,source:'mcp',serverVersion:'2026.8.31'}`；源变化、私钥/非文本及服务错误拒绝。只读 scope `mcp:workspace:read` 来自现有 Policy；RegisteredTool 只允许 ToolGateway 调用，服务连接本身不签发授权。SDK 请求 ID 匹配、AbortSignal 和 deadline 贯穿调用；同 task/run 不允许替换参数，无确认结果不重发。Runtime 是跨重启幂等、审批和 Evidence 的事实来源；模块内缓存只补会话内绑定，`recoverySupport:false`。

stop/dispose 先撤销在途、移除连接，在 Windows 用已持有的参考服务 PID 回收其进程树后关闭 SDK；非 Windows 复用 SDK 的 EOF/TERM/KILL。固定官方服务不创建子 worker；不承诺任意第三方服务的 OS 沙箱。重新启用只改变 configured/disabled 状态，须再次显式 await start。

## 验证与来源

构建现有 contracts/policy/tool-gateway 依赖产物后 `npm run build --workspace=@personal-agent/mcp`；`npm run test:real --workspace=@personal-agent/mcp` 启动实际官方服务，只读取仓库忽略目录的公开合成资料并关闭子进程。真实握手/读取、内存 Policy、Runtime/SQLite/AgentArts/UI 的验收层级分别记录，见 [交接](../../docs/modules/MOD-06-07-MVP.md)。本模块不读取凭据/私有目录、不调用模型。

- [官方 MCP 生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)：初始化、版本协商、截止时间和 shutdown。
- [官方 filesystem 服务](https://github.com/modelcontextprotocol/servers/tree/a40bc270fb5ece62673f8a1196f57116d885c5eb/src/filesystem)：固定 npm 版本的 `gitHead`，依赖 SDK `^1.30.0`，当前选择 `1.31.0`。SDK engines `>=18`；项目目标仍 Node `24.15.x`。
- SDK tarball 自带 MIT LICENSE；filesystem tarball 的 `SEE LICENSE IN LICENSE` 指向 [该提交 LICENSE](https://github.com/modelcontextprotocol/servers/blob/a40bc270fb5ece62673f8a1196f57116d885c5eb/LICENSE)，包含 Apache-2.0/MIT 贡献迁移与文档 CC-BY-4.0。不复制服务源码，不将全部组件统称 MIT；发布归档需保留上游适用声明。

新增依赖只用于标准协议和固定服务，根唯一 lock/build 装配由 P8 串行消费。
