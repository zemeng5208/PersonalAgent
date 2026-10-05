# DEV-WORKFLOWS-INTEGRATION-01

状态：`review`（静态交付待集中验收）。负责人：zemeng；验收：Potatos498。

## 范围和入口

用户本轮明确授权新增可选 `local` 开发工作流。该增量不替换 Competition Profile，不改现有 RuntimeApplication 或 Desktop 默认路径。

公开入口计划为 `@personal-agent/runtime/dev-workflows`，导出 `createDevWorkflowsRuntime`、`DevWorkflowsRuntimeOptions`、`DevWorkflowRequest`。公开 exports、依赖和锁文件由根集成负责人维护。模块接口仍为 provisional；未开展真实 GitHub、Git push、模型或 Windows 命令验收。

工厂装配既有 TaskRuntime、Policy、ToolGateway、ModelGateway，并消费 MOD-33 GitHub、MOD-34 CI 修复、MOD-36 PR 审查和 MOD-38 Issue 分诊的公开包入口。无第二套任务数据库或状态机。

## 受信配置

`model`、`maxSteps`、`maxTokens` 必须明确提供。ModelProvider 始终由 ModelGateway 包装；未配置不偷偷选择 Fake 或替代模型。

生产宿主提供 `github: GitHubProvider`、`workspace: {read, patch, command}`、`git: GitToolsOptions`（`readVerification` 由组合生成）以及 `ciFix` 的受信 sourcePaths、verifyRecipeId、分支与来源修订。GitHub 注册全部工具；workspace 注册 read、patch、固定 recipe command；Git 注册 head、commit、push。允许额外 `tools` 作为明确 Fake 或受信宿主扩展，重复工具名注册拒绝。

GitHub token getter和 Git `getCredentials` 由同一受信宿主安全存储适配，凭据不进请求、模型上下文或持久 checkpoint。`isUserPresent` 为实时可信会话回调，写工具需要此回调返回 true，并仍要求逐次审批；审批本身不代表当前用户在场。

Issue 修复复用 MOD-34 `createCiFixWorkflow`。宿主可提供 `failedRunForIssue(repo, number)`，或使用 `ciFix.expectedHeadSha` 绑定 issue-only 源码修订。传入最新 issue URL、number、fingerprint，由 MOD-34在PR正文关联 Issue。缺修复配置返回人工处理，不宣称已修复。

## 提交、暂停和恢复

`submit({request, conversationId, idempotencyKey, deadline})` 受理并持久化原请求，不自动开始；`start(taskId)` 执行。request 区分 `ci_fix`、`code_review`、`issue_list`、`issue_triage`。同幂等键替换请求或 deadline 被拒绝。`readResult(taskId)` 读取模块真实结果，TaskRuntime 的 snapshot 仍为最终状态事实来源。

`issue_list` 的 `input` 复用公开 `IssueListRequest`，经既有 MOD38 `listIssues` 和
`github.issue.list` 走原 Runtime 审批；成功返回该页 items/page/nextPage/hasMore/evidenceRefs。
页号、仓库、筛选条件和期限属于持久原请求，重启恢复不替换页，不调用模型或写标签。
列表不是稳定快照，列表标题/正文仍是不可信数据，不授予后续修复许可。

可信宿主显式选择返回项，再用现有 `issue_triage` 提交各自独立 task；使用稳定的发现批次与
Issue 身份作为幂等键，不因审批/进程重启重新生成键。下一页只能按读回 nextPage 显式提交。
`issue_triage` 会重新读取原 Issue、核实分类证据，并单独审批写入；宿主提供受信 repairGoal，
不得从 Issue 正文推导权限或命令。此入口不自动轮询、创建子任务或为整页重复分配模型预算。
独立 task 使 MOD34 原 `ci-fix-v1` 日志、预算、审批与 unknown 记录不被另一 Issue 覆盖。
公开请求联合新增可选分支，不改变既有 wire、工具 scope、配置格式或默认 Desktop profile。

所有 GitHub 读写和 workspace/Git 执行均经 AgentToolPort → RuntimeToolInvoker → TaskRuntime 请求路径 → ToolGateway → Policy。首次调用 `requestToolApproval` 绑定原 task、runId、工具、范围和参数 digest；pending 暂停原任务。宿主用原 `runtime.respondApproval`（含 revision）决定，然后 `resume(taskId)`。拒绝审批取消任务；未知结果不因审批被重发。

unknown 暂停为 `waiting_reconciliation`。受信宿主先用原 Runtime 核实接口保存原执行的 confirmed Evidence 和缓存，再 `resumeConfirmed(taskId, originalReceipt)`；它调用 `prepareConfirmedReplay`，拒绝缺失、参数变化、取消或仍有未知执行的任务。workflow 的 `confirmedReplayReady(runId)` 只接受该 task 的已授权 confirmed 执行和缓存；实际回放仍由 Runtime 校验工具、版本、原参数 digest 并返回缓存。既不重开已终结任务，也不新建重试任务或盲目重写外部副作用。

原绝对 deadline 在恢复时保持不变。取消和 deadline 由原 TaskRuntime 信号贯穿模型、工具和子工作流。`close()` 取消活跃任务、等待执行结束，然后注销工具与关闭数据库。

## 命令验证到 Git commit 的证据

组合包装原 `workspace.run_allowed_command`，不更改原命令工具。执行前后读取绑定分支的真实 HEAD 和受信 allowedPaths 文件 SHA256；命令 exitCode=0 且前后 HEAD/文件 fingerprint 相同，才保存 task/run 绑定的验证 receipt。

Git `readVerification` 还要求原命令 ToolExecutionRecord 已开始、Policy allow、state confirmed，持久 tool-result 的 exitCode=0 与 receipt 一致。Git commit 自行复验当前 HEAD/完整文件 hashes 与该 receipt，并拒绝其它路径或 index 变化。模型返回“测试通过”不能生成 commit 授权或验证证据。

## 验收交接

本 writer 只执行静态审阅与 `git diff --check`，按用户要求不安装、不构建、不跑测试、不访问真实服务。新增 Fake 测试覆盖未审批 GitHub read 零执行、幂等请求/期限绑定、无原 confirmed Evidence 的恢复拒绝。

Potatos498 集中整合全部模块和 exports 后执行仓库实际脚本：

```sh
npm run check
npm run test --workspace=@personal-agent/runtime
```

补充集中验收必须覆盖：审批后同 task/run 恢复；重启后原请求和缓存保留；unknown readback 后 cached replay 零重复写；未知结果无 readback 不恢复；命令前后源码变化不能产生 commit receipt；伪造模型验证不能 commit；拒绝审批、撤销授权、缺实时 presence、deadline 和取消；Issue 修复新PR正文关联原 Issue；PR head/base 变化拒绝评论。真实服务验收仅在用户明确授权的环境执行，Fake/类型检查通过不替代真实闭环。
