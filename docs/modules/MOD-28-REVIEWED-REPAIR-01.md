# MOD-28：Goal review 来源的受控计划修复

> 维护入口（2026-10-07）：项目主要负责人为 zemeng；当前分工以 [模块分工](../../docs/MODULE_ASSIGNMENTS.md) 为准，最新状态见 [ROADMAP](../../docs/ROADMAP.md)。历史日期、作者和验收结论按原记录保留。

目标 profile 为 `huawei_ict_agentarts`。本包补齐 P5 的已选结构化候选 → AgentArts 候选 → 现有 Runtime/Policy 工具 → 图版本/Evidence 读回。根已授权 P5 唯一修改 `local-repair.ts` 及专属测试；P8 仍唯一修改 Runtime Application 构造与 main。复用 `cognition.commit_repair`，不增加 repair registry、wire operation、任务库或执行循环。

## 接口与装配（provisional）

`prepareReviewedRepair(snapshot, at, review, candidate?)` 由 cognition 公开导出。它只为精确 offered、eligible selected REVISE、带结构化 repair 的受影响节点生成 binding/request/preview；RECHECK、uncertain、缺 repair 或 restricted scope 返回 unavailable。图版本、目标版本、依赖身份与版本、原有合法范围均严格校验，复用既有 repair preflight。策略 description 不成为节点 summary。

`goal-cognition-host` 与 `proactive-host` 的可信 getter：

- `readRepairBinding(sourceTaskId)`：当前许可、generation、review、graph 仍有效时返回 `{reviewTaskId, graphNamespace, bindingVersion, graphRevision, selectionDigest, candidateDigest, targets, dependencies}`，否则 undefined。refs 是本地真实 `{id, revision}`，不直接出云。
- `readPreparedRepair(sourceTaskId)`：读取现有 `competition-repair-candidate` 1.0 checkpoint；仅允许 source task succeeded，以本地原 scope 反解 opaque refs，并重新执行预览。返回 `{kind:'prepared', binding, request, preview}` 或 unavailable。非法替换明确拒绝。

P8 在既有 Competition Runtime 构造传入 `repairCandidateVersion:'1.0'` 与：

```js
localRepair: {
  graphNamespace: namespace,
  bindingVersion: 'desktop-reviewed-execution-v1',
  withSourceLock: work => existingSourceLock(work),
  reviewedSource: {
    resolve({sourceTaskId, reviewTaskId}) {
      const value = proactiveHost?.readPreparedRepair(sourceTaskId);
      return value?.kind === 'prepared' && value.binding.reviewTaskId === reviewTaskId
        ? value : undefined;
    },
  },
}
```

纯 Goal 模式不伪造 memory、Fact、sourceTool 或 Evidence。原 Fact 配置的 sourceTool/memory/resolveBinding/matchesSource 原样保留，也可与 reviewedSource 同时存在。构造检查接受完整 Fact 来源或 trusted reviewedSource；固定 namespace、bindingVersion、source lock 始终必需。

既有 `submitLocalRepair` 进程内请求兼容原 `{sourceTaskId,evidenceId,idempotencyKey,deadline}` 与新 `{sourceTaskId,reviewTaskId,idempotencyKey,deadline}`。公共 wire 不变。Goal 来源需真实 succeeded Runtime review/checkpoint、精确 conversation/namespace、完整 review digest、immutable cloud candidate digest、合法 selected option 与 binding、当前目标及依赖版本。Runtime 独立反解 cloud refs，不能信任 resolver 自报授权。执行仍通过既有 ToolGateway、`cognition:repair` Policy/审批和当前 source lock，最终 guard 到 CAS/持久读回之间无异步等待。

## 云端数据与真实兼容限制

初始 goal 字符串的 JSON 数据包含 action、strategy、受限 nodes、`repairContext:{expectedGraphRevision,targets,allowedDependencies}`。targets 含 opaque NodeRef、原节点 summary 与 requestedDependencies；不含 sourceRef、private Fact 正文、凭据或路径映射。AgentArts 提案仍是已有 repair_candidate 1.0；不伪造 confirmed continuation，也不将候选说成执行。

当前云 router 原先只从真实 confirmed continuation.result 读取 repairContext，且要求 requestedSummary。本包新初始 goal 使用 summary 基线以允许语义修订。唯一云作者已收到最小结构样例并负责兼容；在实际云返回读回前，本路径的云兼容仍未验收。缺结构化候选或装配时保持 unavailable，不静默 Local 回退。

## 反馈与恢复

source 任务仅受理/返回候选时不会显示 applied。已有 tick/applyDecision 在当前许可内提交独立受控修复任务，保存既有 Runtime checkpoint 的 repair task ID；未知受理先按固定幂等键读回，不另起写入。审批与真实终态保持。

只有 `cognition.commit_repair` 的真实 confirmed、policy allow、executionStarted Evidence，精确 intentDigest/input 绑定，提交历史 snapshot 完整持久读回，以及涉及节点的当前 revision 都一致时，Desktop 才设置 executionVerified/graphUpdateVerified=true；修复任务 succeeded 后才显示 applied。updatedNodes 明确列出本次实际变化的 Goal/Decision/Plan，不把 Plan 更新说成全部 Goal 修改。后续节点版本变化保留执行已发生，当前核实降为 false。

重建恢复原 review/source/repair task IDs 和已核实回执，不恢复云许可或后台推理。started 取消或写中结果未知保留 waiting_reconciliation，不重放。代码回滚不能撤销已提交图历史。

## 已运行的必要验证

- cognition 与 Runtime 定向 TypeScript 编译通过。最初 Runtime 类型失败源于 agents/dist 旧版本；只重编当前 agents 产物后通过，未改其源码。
- 3 个 reviewed-repair 域检查通过；只读预览与范围/替换/uncertain/restricted/版本拒绝。
- 13 个既有 Fact local-repair 检查通过，保留来源 Evidence、审批、冲突、锁、未知写入与恢复行为。
- 3 个新增 reviewed-local-repair 检查通过，包含纯 Goal 来源实际 SQLite/Policy/CAS/Evidence 和持久重建、4 个来源/候选/图/许可变化零追加场景，以及取消 started 后未知状态不重放。
- Desktop 专属检查 13 项通过，包括 Fake Laya/AgentArts 候选经真实 Runtime 审批、SQLite 图 5→7、Decision/Plan revision 1→2、Evidence 和目标读回后才 applied；重建保持 task ID/verification 且不恢复许可，后续 Plan revision 3 降核实。
- 没有启动/训练真实模型、联网邮箱/日历、全仓 check 或重复全包测试。真实云 router、P8 main 生产装配、实际用户目标/会议仍待集成验收；MOD/MVP 未 done。
