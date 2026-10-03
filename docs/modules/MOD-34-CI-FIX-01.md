# MOD-34-CI-FIX-01：有界失败修复消费链

状态：review；目标 profile：`local`（本轮明确授权的开发工作流增量）。负责人 zemeng；非作者集中验收由 Potatos498 执行。本增量不声明真实 GitHub、模型、Windows 或 AgentArts 验收已完成，也不替代 Competition Golden Path。

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

有界修复循环：读取失败 run 与至多八个 failed-job 日志 → 确认初始完整 workspaceClean 与失败 SHA → 每轮读取宿主批准源文件的当前内容 → ModelPort 返回严格 JSON 诊断/精确文本 patch → 校验只有已读路径及 SHA → 经现有 patch 工具审批应用 → 执行宿主 allowlist verification recipe。`maxAttempts` 默认 2、合法范围 1～4；验证失败时将上一轮诊断与有界验证输出作为不可信数据交给下一轮，补丁在已有改动上叠加。达到上限或预算不足时不提交。

只有 confirmed exitCode=0 后才重新读取同 HEAD SHA，并经可信 Git 工具核实实际验证 receipt 与当前文件指纹后 commit → 独立审批 push → 审批 draft PR → 写回链。commit 路径从所有轮次的 confirmed patch receipts 去重汇总；审批恢复与重启不能丢失前轮已应用文件，也不重新执行已确认补丁。暂停结果中的 verificationRunId 指向最近实际确认的验证步骤，不指向尚未执行的新轮次。

Git receipt 必须从 Runtime 获得；commit 参数中的 verificationRunId 仅是查找键，不能当成功证据。实际 receipt 同 workspace/HEAD/文件快照绑定由 Git 工具及 composition 执行。本链不绕过验证；用户本次要求不在云执行开发验收，不影响未来产品实际验证要求。工具返回 pending / unknown 或外部 write state unknown 均不作为成功。

issue fingerprint 与 MOD-38 一致：SHA256(JSON.stringify([number,title,body,state,sortedLabels,url,updatedAt]))；修复前重新读取并校验，变化返回 stale。PR 保留 issue URL/fingerprint，不使用自动关闭关键字。

## 恢复与预算

Runtime checkpoint `ci-fix-v1` 保存参数 identity、调用计数、token 保守预留、confirmed receipts、evidence 与 in-flight 标识。工具 runId 稳定绑定 task/identity/step。每次 dispatch 前持久化；异常、取消、超时保留 in-flight，默认恢复不重试。pending 审批恢复复用相同 runId 与参数。unknown 仅当宿主 `confirmedReplayReady(runId)` 明确表示 Runtime 已完成真实读回且可消费缓存确认结果时，才允许调用既有 Runtime adapter 重放；不得用该函数授权重新执行未知写入。模型未知响应不自动重做。

`maxSteps` 含读取、模型、工具；tokens 在请求前保守预留全部剩余预算，确认响应后按合法 `usage.totalTokens` 结算，多轮共享预算。usage 缺失或非法时保留耗尽状态，恢复不能重置预算。每轮 source/model/patch/verify 标识绑定轮次，防止误用上一轮结果。取消信号与 deadline 贯穿全部调用。没有 shell 字段，模型不能选择 command recipe 或 Git/PR 参数。

## 验收交接

### 全仓工作区与 patch helper 组合

Potatos498 在 PR #277 评论 `5968380670` 报告真实失败 run `37116843775` 的 MOD-34
验收受阻：仓库根同时包含默认包内 `locked-apply.ps1`，原保护正确拒绝从可写工作区执行
helper，但源码部署没有外部 helper 配置入口。本轮保留 root/helper/recovery 隔离，增加
`WorkspacePatchApplyHostOptions.helperScriptPath?`，经公开 apply factory 及 Runtime 的
`workspace.patch.helperScriptPath` 转交。不删除 in-root 保护、不缩小全仓验证 root、不自动部署。

受信宿主须先把本版本已审查 helper 的字节一致副本安装到工作区及 recovery 之外的独立限权
目录，再显式注入绝对路径；factory 校验常规文件/单硬链接/位置/摘要，执行前复核。
缺外部安装时仍明确拒绝，不能把 workspace 内的脚本豁免为受信程序。该选项是进程内可选
配置，不改变 wire/tool schema 或授权范围；宿主 ACL 和非作者兼容评审仍待 goo122 核实。
已补仓库根注册、外部 helper 实际应用、相对/越界/未知脚本/硬链接拒绝、注册后突变拒绝的
Windows 测试源码；本轮只做语法/whitespace 静态检查，未运行或启动 PowerShell，待 Potatos498
对最新准确 head 集中复验真实 MOD-34 链。

已编写 `packages/coding-tools/test/ci-fix.test.mjs` Fake 行为场景：完整闭环、执行顺序、真实 verify失败拒绝commit、缺能力、模型shell拒绝、unknown不重发、pending恢复同runId、HEAD变化、请求identity变化、取消、预算、issue-only与指纹漂移。本作者按用户约束未执行测试、build、typecheck、npm install 或真实请求；只执行静态 diff 检查。

Potatos498 在 `656bd874a7d3bf159c773260b13ea82a5c533a17` 报告全仓 build、开发工作流 59/59 与架构检查通过。本次后续静态修复补充两文件分轮修改、第二轮审批恢复、跨轮路径完整提交及最近确认验证回执的回归场景；该新增场景尚未执行，需对后续精确 head 集中验证，不能沿用 59/59 作为修复后证据。

Potatos498 在集成依赖与 exports 后执行 workspace build/typecheck/test 及根架构检查，精确脚本以当前 package.json 为准。真实验收需获授权的 GitHub 仓库/分支/账号、已发布 MOD-33 adapter、真实 ModelPort/AgentArts、Windows 授权 patch host、受限验证 recipe，以及 Runtime verification snapshot adapter。Fake 通过不替代上述真实验收。
