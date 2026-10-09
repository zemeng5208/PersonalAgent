# 自有镜像接口与执行边界

2026-10-09；MOD-29/30/31，负责人 zemeng；Profile `huawei_ict_agentarts`。这是当前提交实现的接口说明，不把完整目标方案或 WSS/Wiki 待办列为已交付能力。

## 服务端部署接口

| 接口 | 请求与控制 | 响应/状态 |
| --- | --- | --- |
| `GET /ping` | 不调用模型 | JSON：Healthy/HealthyBusy、更新时间；仅证明进程健康 |
| `POST /invocations` | `Content-Type: application/json`；仅 `query` 字段，或显式配置的单一旧 Workflow `inputs` | JSON 事件数组；不是原生 SSE 流 |
| `/ws` | 目标方案的 WSS 主通道 | 当前镜像未实现；公网 URL/Upgrade/认证/生命周期未验收 |

入站 JSON 只接受指定字段。请求体上限 1,200,000 bytes；query 总量和工具目录另有公开解析器限制。`X-PA-Deadline` 为严格 UTC 时间，取原期限与服务上限较早值；超时覆盖上传、模型和序列化。断开触发取消，非协作 Provider 也不能拖住对外响应。

可选 `Authorization: Bearer ...` 由宿主注入，服务配置额外 token 时核验；AgentArts 模式仍要求平台入站认证。`X-HW-AgentArts-Session-Id` 与 `X-Request-Id` 只用于关联，必须为受限 ASCII 标识，不赋予用户权限。缺省关联 ID 由服务生成。

HTTP 状态包括 404（未知路径）、401（入站验证失败）、429（并发已满）、400（非法输入）、504（期限）、499（取消）和 502（外部/未支持错误，详见结构化 code）。错误响应只给规范化 code，不回显凭据、Provider 响应正文或模型输入。

成功外层示例：

```json
[
  {"event":"message","data":{"text":"{\"kind\":\"text\",\"text\":\"答复内容\"}"}},
  {"event":"task_end"},
  {"event":"end"}
]
```

`task_end` 是云调用返回事件，不是本地任务完成证明。Coordination 校验内层输出后，ToolRuntime/Policy 与实际读回仍决定任务结果。

## query 与公开契约

- 普通文本：没有工具目录时仅答复；看起来像 JSON 但解析非法时拒绝，不偷偷当自然语言处理。
- 初始 JSON 字符串：`{goal, availableTools}`；目录使用 Coordination 的公开 `CoordinationAvailableTool` 解析，未知字段/版本/非法参数拒绝。
- 继续轮次：`{continuation}`，复用公开 `CoordinationContinuation`。已确认工具回执、原请求与 repairContext 依照现有契约处理，不创建私有 DTO。
- 结果：`text`、`tool_proposal` 或 `repair_candidate` 的公开子集；始终由本地严格解析并视为外部未核实输入。

来源单一：`packages/coordination` 公共 exports 和解析器、`packages/agentarts/src/input.ts`、`packages/agentarts/src/index.ts`。不要复制类型再声称第二套接口 frozen。

## 编排与模型端口

`OwnedAgentOrchestrator.invoke({query,deadline,signal,sessionId,requestId})` 统一进入 fast/world/plan/review；每角色调用 ModelGateway/ModelPort，并继承期限、取消与输出预算。普通请求走 fast；受限计划修复走 World→Plan→Review，核对影响范围、版本、依赖和最终候选。

角色回执只记录 role、requestId、promptVersion、started/completed/failed 及可选 totalTokens；不记录原提示词、私人资料、密钥。真实 Provider 使用受信启动配置，缺配置明确失败，没有 Fake 回退。旧 8 工作流/3 多 Agent 的全部内部报告语义尚未证明等价。

## 工具执行与权限

镜像消费本地公布的动态工具目录，产生工具提案；不打包 Desktop、TaskRuntime、业务凭据或本机文件执行器。MOD-06~09/16~18/20~26/33 已公布能力通过本地 ToolGateway/Connector Host 消费。未公布能力必须拒绝，不能为了“全部接口”虚构生产可用工具。

工具执行仍遵守用户授权、参数绑定、一次性消费、未知结果协调与实际读回。修复候选仍需本地版本/CAS/审批；模型和云端无权更改任务终态。

## 验证等级与后续

本 PR 包含编排、HTTP 服务、截止/取消/并发校验、allowlist 镜像上下文、Dockerfile、针对性测试与 Runtime 集成测试。完整 `npm run check` 和真实容器合成验证分别记录。镜像构建/上传只证明构建/发布；真实云模型、AgentArts deployment/API/trace、工具闭环与评估仍待验收。

目标双通道、Wiki 和常驻监管见 [完整设计](../design/resident-developer-agent-20261008/DESIGN.md)；Wiki 接入交给 [goo122](../design/resident-developer-agent-20261008/WIKI-MEMORY-HANDOFF.md)。合并遵守 [两人本机阅读门槛](../reviews/DESIGN_READING_GATE.md)，禁止强制合并。
