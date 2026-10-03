# MOD-36 Code Review 预审

- 负责人：zemeng；非作者验收：Potatos498；状态：review（尚未运行验证或真实服务验收）。
- Profile：Huawei ICT AgentArts；实现为公开 ModelPort / Runtime-backed AgentToolPort 的消费流程，不新增模型、GitHub授权或工具注册体系。
- 工厂：`createCodeReviewWorkflow({model,tools,maxDiffChars?,maxPages?,maxFindings?,maxTokens?})`；公开类型位于 `packages/cognition/src/dev-workflows/code-review-types.ts`，根组合负责公共导出、依赖与 Runtime 装配。

`prepare({repo,number,rules}, AgentWorkerContext, {runId,authorizationRef})` 经 `github.pr.get` 读取精确 base/head，经带 expectedHeadSha / expectedBaseSha 的 `github.pr.diff` 完整分页，再读 PR 确认未漂移。可信规则必须由宿主提供；PR 标题、正文和 diff 仅置于模型 user 数据消息，不成为规则或权限。模型只能返回严格 JSON findings；每条包含 blocking/suggestion/question、已声明 ruleId、path、line、side、body。未知字段（包括 confidence）、未改变行、未声明规则、重复条目均拒绝。删改路径按 unified diff 左右侧定位；带引号转义的特殊路径暂不支持，明确拒绝。

报告绑定 repo/number/headSha/baseSha 和规则，保存于本任务 Runtime checkpoint 后方可消费。`publish(report,findingIndex,context,access)` 检查报告原始摘要、taskId、参数与工具公布，再读当前 head/base；只调用 `github.pr.review.comment` 发布 inline COMMENT。Provider 在外部写入前再次核对 commitId，关闭预检到写入的 head 漂移窗口；不自动 approve、request changes 或修改分支。用户授权由 ToolGateway 校验；流程不签发授权。

写入前持久保存 unknown，并绑定 runId/authorizationRef。已确认结果重放，pending 允许原 runId 审批恢复；unknown 不自动重试。仅 Runtime 确认原执行、校验原参数且安装 confirmed 缓存回放后，可信组合可以通过 `access.confirmedReplayReady(runId)` 对精确评论执行返回 true，调用相同 runId 消费缓存结果。该函数不得接受 PR/模型/Renderer 自报值。发布 suffix 为 `publish-head-${findingIndex}` / `comment-${findingIndex}`；prepare suffix 为 `head-before` / `diff-${page}` / `head-after`。读取或模型步骤失败不能留下可发表报告。

默认预算：200,000 diff 字符、32页、30条意见、8,000输出 tokens；超过 diff 限额返回 unsupported，不审查截断内容。所有异步调用传递 signal/deadline，循环及模型前后检查截止时间；无实际服务和模型时不会静默回退 Fake。

## 集中验收

按用户要求，本工作树不执行测试、build、npm安装或真实账号操作。Potatos498 在根依赖与公共 exports 集成后执行 cognition 工作区 typecheck/test 和根 `npm run check`。准备的 `packages/cognition/test/code-review.test.mjs` 覆盖可信规则隔离、head/base绑定、完整分页、严格 JSON、变更行校验、报告篡改、过时 head、仅 COMMENT、缺工具/缺授权、unknown 不重复写与 diff 不完整拒绝。Fake 通过不代表 GitHub、模型或 AgentArts 真实链路已验证；当前接口保持 provisional。
