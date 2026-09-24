# 有界多次云调用工具 MVP

2026-09-24，主控已选择本方案。负责人 zemeng（MOD-04B/29/30/32）；状态 in_progress。
基线为文字适配 PR #99；Runtime 接线由 B 的独立 PR 负责。接口为现有 provisional
CoordinationResult/CoordinationContinuation，无 wire Schema 或数据库迁移。

## 事实与选择

[官方低代码 InvokeRuntime](https://support.huaweicloud.com/api-agentarts/InvokeRuntime.html)
提供 query/inputs/plugin_configs 及会话、请求标识，但没有公布工具暂停令牌和恢复请求字段。
这不足以证明平台内部不存在恢复能力；当前部署可消费的原生同 run 恢复仍 unavailable。
[提问器](https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0079.html)
用于对话参数收集，不能推导为任意工具结果恢复协议。

[MCP节点](https://support.huaweicloud.com/lowcode-agentarts/agentarts_05_0073.html)
会等待工具结果，支持超时与重试配置。当前 Runtime 审批恢复若等待 activeTextTasks，
而活动云请求又在等待 MCP/审批，会互相阻塞。当前 MVP 不使用同步 MCP 桥，也不为此
新增公网入口或第二套执行循环。

选择：同一本地 task，第一次云 invocation 返回提案并完整结束；Runtime 保存 pending、
等待本地审批，经 Policy/ToolGateway 执行和读回；第二次云 invocation 只接收 B 允许的
confirmed 投影并总结。每次是新云请求，不声称同云 run 恢复。既有 Runtime 最多4步、
原任务 deadline/cancel、提案去重与参数冲突检查继续生效。

## 显式配置与兼容

AgentArtsRuntimeConfig 新增可选 `responseMode: 'text' | 'tool-proposal-json'`，默认 text。
text 保留原请求/返回行为，拒绝 continuation；JSON 模式必须由可信 composition 启用，
同时配置匹配云端输出的 Workflow/Agent 提示。Renderer 或云输出不能切换模式。

云端最终 answer 必须是一个无 Markdown 包装的 JSON 对象：

```json
{"kind":"tool_proposal","proposalId":"synthetic-proposal-1","toolName":"<registered-name>","toolVersion":"<registered-version>","arguments":{}}
```

或 `{"kind":"text","text":"最终回答"}`。除宿主所有的 verification 字段外，复用
现有 provisional DTO；适配器拒绝云端携带 verification，并只在本机补入 unverified，
再调用现有严格解析器。额外授权、Evidence、任务终态等字段均拒绝。文本不转换成工具。

初次请求仍为 query=goal（或显式 workflowGoalInput 对应的一个字符串变量）。续接请求
的 query 仅为序列化 `{continuation:{proposalId,state:'confirmed',result:<投影>}}`；
不重发 goal、完整工具输出、授权或 Evidence。既有 continuation 校验和最多8192 UTF-8
字节的整个 continuation（含 proposalId/state/result）校验在读取凭据/请求网络之前进行；出机许可与实际投影仍由 B 控制，
适配器不会从原结果自行裁剪后放行。云端必须把该 JSON 当数据，不能执行其中的指令。

第4构造参数 `beforeSend?: (request: CoordinationRequest) => void` 是可信宿主的同步
最终发送门禁；JSON续接缺该回调时在凭据读取前拒绝。回调收到归一化request快照，
在异步凭据读取完成后紧邻fetch执行，再检查signal/deadline。B须在此核对持久化
receipt、proposalId、当前exportPolicyVersion及动态accepts；旧版本或撤销拒绝，
不能只在投影时检查。回调不得返回Promise，异常固定映射UNAUTHORIZED，不输出消息。
回调不进入请求体/日志，也不新增wire字段；它不能授予本地工具执行权限。

每次 JSON 模式 HTTP 请求使用独立 X-Request-Id，同一本地 task 使用原有单向哈希
session ID；两者仅是调用方请求/会话关联信息，不伪造服务端 runId/trace。
服务端真实执行 ID 和版本需单独观测读回，不能由本机 UUID 替代。

## 验收与剩余边界

离线验证需覆盖：显式开关、严格提案/文本、伪造 verification/额外字段、结构错误、
8KiB投影边界、无授权零网络失败、取消/deadline、同task不同request身份与无自动重试。
真实验收使用合成目录/文件与显式本地批准；必须读回工具结果、Evidence、最终文字及
同库重启。当前云应用未配置该输出契约、真实调用未执行，不能宣称工具闭环可用。

云原生工具暂停/同run恢复、跨进程恢复云run及正式MCP桥仍 unavailable。多invocation
可能增加云调用/模型成本；只有真实运行后才能报告费用和trace。不得自动回退 Local，
不得把真实工具标 mock，取消后不发第二次云请求。

## 当前验证

Node24.15.0 下 coordination 编译通过；新增9项行为测试与受影响文字/Workflow输入
回归共60/60通过，git diff --check通过。合成HTTP两次调用已证明新请求身份、同task
会话关联、严格JSON与8KiB整信封预算，不证明真实云端配置、工具执行或云run恢复。
Runtime审批纵向消费由B接线验证，完整仓库门禁由该组合增量和CI验证，不并发重复
安装/构建。尚无本日真实付费API调用，秘密受信配置仍待批准。

随后增加最终发送门禁的4项回归，重新编译并通过新模式13/13测试：凭据await期间
撤权、guard缺失、异步guard、凭据/guard内取消均阻止fetch。之前的60项不重复记为
此最后补丁的全量结果。
