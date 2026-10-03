# MOD-34-CI-FIX-01：有界失败修复消费链

状态：review；目标 profile：`huawei_ict_agentarts`。负责人 zemeng；非作者集中验收由 Potatos498 执行。本增量不声明真实 GitHub、模型、Windows 或 AgentArts 验收已完成。

## 入口与依赖

`createCiFixWorkflow(CiFixOptions): CiFixWorkflowPort` 返回 `run(AgentWorkerContext)`；也可调用 `runCiFix(context, options)`。仅消费公开 `@personal-agent/agents` 的 `AgentToolPort` / `AgentWorkerContext` 与 `@personal-agent/models` 的 `ModelPort`，不导入 apps，不创建任务库、调度器、模型入口或授权服务。`ToolExecutionPort` 是既有 AgentToolPort 的本模块别名，并非新冻结契约。

宿主绑定 repository、失败 runId、sourcePaths、验证 recipe、source/base branch、Git 工具名、steps/tokens 上限和 authorizationRefFor。缺端口或注册工具返回 unsupported。issue-only 模式省略 runId，要求 expectedHeadSha 与 issue 元信息；不伪造失败 CI。

生产工具依赖：

| 能力 | 名称 / 参数 |
| --- | --- |
| Failed run | `github.actions.run.list {repo,page:1,perPage:100,status:'failure'}` |
| Failed jobs | `github.actions.job.list {repo,runId,page:1,perPage:100}` |
| Job log | `github.actions.log.read {repo,runId,jobId,offset:0,maxChars}` |
| Source | `workspace.read_text {path,maxBytes:65536}` |
| Patch | `workspace.apply_text_patch {path,expectedSha256,edits}` |
| Verify | `workspace.run_allowed_command {recipeId}` |
| Git | Host registered head / commit / push，见 Git 工具交付文档 |
| Approved PR | `github.pr.create {repo,head,base,expectedHeadSha,title,body,draft:true}` |
| Backlink | `github.pr.comment {repo,number,body}`，含原 run URL |
| Issue-only | `github.issue.get {repo,number}` 与 `github.issue.comment {repo,number,body}` |

所有上述读写均通过 Runtime ToolGateway，模型没有 GitHub provider 或 shell 访问权。GitHub run 本身没有评论 API；实际回链是 draft PR 正文及 PR comment 引用原 run URL，issue 模式另对原 issue 评论 PR URL，不自动 close 或 merge。

## 行为与可信结果

一次有界尝试：读取失败 run 与至多八个 failed-job 日志 → 确认初始完整 workspaceClean 与失败 SHA → 读取宿主批准源文件 → ModelPort 返回严格 JSON 诊断/精确文本 patch → 校验只有已读路径及 SHA → 经现有 patch 工具审批应用 → 执行宿主 allowlist verification recipe → 必须 confirmed exitCode=0 → 重新读取同 HEAD SHA → 经可信 Git 工具核实真实验证 receipt 与当前文件指纹后 commit → 独立审批 push → 审批 draft PR → 写回链。

Git receipt 必须从 Runtime 获得；commit 参数中的 verificationRunId 仅是查找键，不能当成功证据。实际 receipt 同 workspace/HEAD/文件快照绑定由 Git 工具及 composition 执行。本链不绕过验证；用户本次要求不在云执行开发验收，不影响未来产品实际验证要求。工具返回 pending / unknown 或外部 write state unknown 均不作为成功。

issue fingerprint 与 MOD-38 一致：SHA256(JSON.stringify([number,title,body,state,sortedLabels,url,updatedAt]))；修复前重新读取并校验，变化返回 stale。PR 保留 issue URL/fingerprint，不使用自动关闭关键字。

## 恢复与预算

Runtime checkpoint `ci-fix-v1` 保存参数 identity、调用计数、token 保守预留、confirmed receipts、evidence 与 in-flight 标识。工具 runId 稳定绑定 task/identity/step。每次 dispatch 前持久化；异常、取消、超时保留 in-flight，默认恢复不重试。pending 审批恢复复用相同 runId 与参数。unknown 仅当宿主 `confirmedReplayReady(runId)` 明确表示 Runtime 已完成真实读回且可消费缓存确认结果时，才允许调用既有 Runtime adapter 重放；不得用该函数授权重新执行未知写入。模型未知响应不自动重做。

`maxSteps` 含读取、模型、工具，tokens 在请求前预留整个可用上限，恢复不能重置。取消信号与 deadline 贯穿全部调用。没有 shell 字段，模型不能选择 command recipe 或 Git/PR 参数。

## 验收交接

已编写 `packages/coding-tools/test/ci-fix.test.mjs` Fake 行为场景：完整闭环、执行顺序、真实 verify失败拒绝commit、缺能力、模型shell拒绝、unknown不重发、pending恢复同runId、HEAD变化、请求identity变化、取消、预算、issue-only与指纹漂移。本作者按用户约束未执行测试、build、typecheck、npm install 或真实请求；只执行静态 diff 检查。

Potatos498 在集成依赖与 exports 后执行 workspace build/typecheck/test 及根架构检查，精确脚本以当前 package.json 为准。真实验收需获授权的 GitHub 仓库/分支/账号、已发布 MOD-33 adapter、真实 ModelPort/AgentArts、Windows 授权 patch host、受限验证 recipe，以及 Runtime verification snapshot adapter。Fake 通过不替代上述真实验收。
