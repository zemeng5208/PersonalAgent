# P5 目标决策反馈修复（Competition Profile）

本工作包独立于 #231 的日历/会议恢复包，仅拥有 `electron/goal-cognition-host.js`、专属测试及本文。
共享 main.js / Renderer / Admin 由 P8 唯一写入，Luna 仅处理 CSS，不新增 Local Profile。

## 问题与行为变化

旧 `applyDecision` 把 Laya 的策略 `selectedOption.description` 当作 Goal.summary，目标不明确时取最后一个 Goal；uncertain 的机器复核也可能进入该写入。它还向真实 GoalHostCore 的严格输入添加由宿主负责注入的 sourceRef，并把 task 受理直接标成 applied。旧测试的 Fake revise 直接 append，掩盖了这些生产缺陷。

现在应用入口只读取已有 Runtime review，验证 namespace/binding、候选对象及版本、当前图谱版本和现有云端许可，复用 `cognition.handoffReview` 把合法策略交给 AgentArts 编排。uncertain 只能交接原有 RECHECK 复核选项，不能按已选动作改 Goal。移除 description 改写和 lastGoal fallback，不调用 GoalHost.revise、不制造 NodeInput/Plan 或签发授权；原有合法 Goal CRUD 的严格校验保持。

已有交接任务只读回当前状态，不重新提交或恢复旧许可。新提交沿既有最小投影/出口策略和 beforeCompetitionSend 验证，不新增账号读取、范围、权限确认或重试循环。

## P8 返回与展示契约

`applyCognitionDecision(reviewTaskId)` / `proactive.cognition.apply` 返回：

```js
{
  status: 'submitted', // 或 pending/unavailable/expired、实际失败/取消/审批/核实/成功态
  reviewTaskId,
  taskId, // 已确认受理时存在
  state: 'created', // 有任务时为当前 Runtime TaskState，如 planning/running/waiting_approval 等
  executionStatus: '编排任务已受理，尚未执行完成',
  executionVerified: false,
  graphUpdateVerified: false,
}
```

`snapshot().reviews[]` 使用同样的 state/taskId/executionStatus/verification 字段。未交接时 state 可以为本地选择或 unavailable/pending/expired 状态。任务 succeeded 仅显示“AgentArts 编排任务已完成；目标更新尚未核实”，不输出 applied。真正的目标更新完成需要后续合法执行 Evidence 与目标 revision 读回；本工作包没有这份执行证据。

P8 必须消除 Renderer 中“非 applied 也显示执行完成”及按钮固定“已在本地执行”的默认分支。缺许可或非法/过时候选显示明确失败/复核原因；复用已存在设置授权，不新增逐次低风险审批。

## 持久恢复

构造时及既有 tick 中复用 Goal source task 的 `desktop-goal-cognition-review` marker 与公开 readReview 重建显示记录，不依赖模型启动。交接确认后仅在现有 TaskRuntime checkpoint 写入 `desktop-goal-cognition-handoff-task-v1`（namespace、bindingVersion、reviewTaskId、selectionDigest、taskId）。无新任务库/调度器，无原始目标文本/云 payload/凭据/许可。重建以 digest/宿主绑定和实际 Runtime task 确认交接任务，实时展示状态；出云许可与 outgoing 会话不恢复。

## 验证与限制

专属检查 11 项通过：现有出口撤销/新版本防发送、合法候选/机器复核、缺许可拒绝、受理与真实终态分离、同交接幂等、失败读回、稳定 marker/交接 ID 重建、不恢复许可、不新增推理，以及候选替换/宿主绑定错配拒绝。测试使用真实 Runtime/SQLite/Client 与严格 GoalHostCore；Laya 推理和 AgentArts fetch 为明确测试替身，未调用真实模型/云端/账号，不证明实际 Plan 执行或图谱更新。

依赖产物只在包 src/package.json/tsconfig 指纹一致时复用 P8 已有 dist；不匹配的 coordination/cognition/Runtime 单独编译。未全仓构建、未全套 smoke、未启动模型。最初缺 Client/dist 导致测试启动失败，补齐上述匹配产物后重新通过。P8 Renderer 消费与正式窗口验收待完成，P5/MVP 未 done。
