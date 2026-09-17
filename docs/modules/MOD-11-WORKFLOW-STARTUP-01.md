# MOD-11-WORKFLOW-STARTUP-01：Competition 文本启动组合

- Profile：`huawei_ict_agentarts`；负责人 zemeng；非作者评审 goo122；状态 review。
- 组合分支：`codex/zemeng/agentarts-text-ready`；基线为 PR #72 头 `98769b2`，并包含
  PR #51 头 `82c7c0e` 的 Workflow 回答解析和索引复位修复。

可信 Desktop 主进程可从 `PA_AGENTARTS_WORKFLOW_GOAL_INPUT` 读取 Workflow 开始节点变量名，
并把原值交给 Runtime 工厂。变量未设置时适配器发送 `{query: 目标文本}`；设置时发送
`{inputs: {[变量名]: 目标文本}}`。云端普通文字仍作为 `kind: text`、
`verification: unverified` 返回，由 TaskRuntime 决定任务终态，Desktop 只沿现有链路展示
结果摘要。本片不新增 Renderer、语音、IPC、数据库或依赖。

## 真实工具闭环边界

- `packages/coordination/src/agentarts.ts:97` 在鉴权和网络调用前拒绝任何非 `undefined` 的
  `continuation`，错误为 `INVALID_ARGUMENT: AgentArts text adapter does not support tool continuation`。
- 当前真实 `AgentArtsCloudAgentPort` 只解析普通文字结果，不会从云端响应提出工具调用，
  也没有把本地工具结果恢复到 AgentArts 的协议。
- 本地提交 `5773149` 的 `apps/runtime/src/application/coordination.ts` 仅允许
  `verification: mock` 的工具提案进入本地继续循环；非 mock 导出会明确返回
  `UNSUPPORTED_CAPABILITY`。提交 `cb49b5` 证明 Desktop 可在本地注册所选的
  `workspace.read`、`workspace.list`、`workspace.preview` provider，但两者都不构成真实
  AgentArts 工具提案或 continuation 验证。

因此剩余缺口是明确的云端工具提案、授权结果导出与恢复协议；本片不臆造该协议，也不放宽
现有 guard 或公共契约。验证只覆盖主进程语法、所需提交祖先关系与 `git diff --check`；
未读取凭据、未调用 AgentArts 云端、未重复完整适配器测试，不能据此声称真实 Workflow 或
真实工具闭环已接通。
