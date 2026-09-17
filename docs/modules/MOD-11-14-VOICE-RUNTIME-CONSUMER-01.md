# MOD-11-14-VOICE-RUNTIME-CONSUMER-01：显式转写消费接入 Runtime Client

- Profile：`huawei_ict_agentarts`；模块负责人/实现身份：`zemeng` / `zemeng5208`。
- 用户是产品负责人和最终范围、授权来源；来源主任务统一指挥；`goo122` 负责非作者评审与共享根协调。
- 工作树：`.worktrees/zemeng-voice-runtime-consumer`；分支：`codex/zemeng/voice-runtime-consumer`。
- 基线：PR #70 head `f9e9bf7`；状态：`review` / provisional，待非作者评审与合并。

## 公共接口依据

本工作包只消费 `@personal-agent/client` 的公开 `Client.call()`：

- `task.submit` 已冻结且生产可用；输入是 `goal`、`conversationId` 和请求级
  `idempotencyKey`，结果的 taskId/state/revision 只表示受理，不表示任务完成。
- `task.get` 已冻结且生产可用，返回 Runtime 持久 `TaskSnapshot`；只有
  `state === "succeeded"` 且存在非空 `resultSummary` 时才产生语音回复。
- `event.subscribe` 的完整交付、unsubscribe 与跨进程生命周期仍为 provisional；Client
  没有可由本适配器正确消费的事件交付回调，因此本工作包使用冻结的 `task.get` 有界轮询，
  不进入 Runtime 私有 `readEvents` 或执行循环。

`packages/contracts`、Runtime 和 Client 均不修改；voice 只新增对现有 Client workspace
的公开依赖。根 build 机械调整为先构建 contracts、Client 与 voice-wake，再构建 voice。

## 行为与信任边界

`RuntimeClientTranscriptConsumer` 实现现有 `TranscriptConsumerPort`。创建适配器不连接
Client、不读取凭据、不提交任务；只有 `VoiceSessionManager.consumeTranscript()` 的明确
调用才会：

1. 以 transcript text 作为 `task.submit.goal`，携带宿主配置的 `conversationId`；不携带
   音频、token、凭据、附件或内部 Runtime 对象。
2. 由 sessionId + transcriptId 的摘要生成固定长度幂等键。实例内记录 text 摘要；同一
   identity 改用不同 text 会在提交前固定拒绝，显式重复同输入沿用同一个 key。
3. 不重试 `task.submit`。迟到的 submit 成功不能恢复已结束的本地等待，也不会触发
   `task.cancel`；外部任务的核实或取消属于宿主后续明确动作。
4. 使用 `task.get` 等待 Runtime 事实来源的终态。created/planning/running、
   waiting_approval、waiting_external、waiting_reconciliation、verifying 和 cancelling
   都不产生回复；failed/cancelled 使用固定本地失败。
5. succeeded 只读取最多 `MAX_SPEECH_CHARACTERS` 的 `resultSummary`。不解析模型元数据、
   evidence 或错误正文形成第二套协议。

请求 deadline、父 `AbortSignal` 和 `VoiceOperation.stop()` 覆盖提交前、提交等待、轮询及
查询间隔。非合作 Client Promise 也会在本地 deadline/abort 后返回。stop 仅释放本地等待，
绝不调用 `task.cancel`，也不能据此宣称远端任务已取消。

## 本轮验证与未验证项

目标测试共 6 组：

1. 明确 consume 前零 Client 调用，提交字段只含公开 goal/conversationId。
2. 受理与 waiting_approval 不输出，直到 succeeded 快照。
3. 成功只返回有界 resultSummary。
4. Runtime/Client 失败使用固定错误且不泄外部正文。
5. stop 与 deadline 有界结束非合作 Promise，`task.cancel` 调用数始终为零，迟到 submit
   不恢复轮询。
6. 重复同 identity 使用稳定 key，同 identity 异 text 提交前拒绝；同步 abort 零底层调用，
   且入口后同一 tick 修改原 request 不会改变已捕获的提交文本。

包内 6 组定向测试通过。另以 public Client、真实 Runtime Application、隔离 SQLite 和合成
HTTP 执行了一次本地组合验收：任务产生 `task.completed`，consumer 只在 Runtime 终态后
返回带 `verification=unverified` 的有界摘要，1/1 通过。该验收不联网、不使用真实模型、
设备或音频，也不证明 Desktop、Renderer、真实 AgentArts 或云服务可用。本包不创建第二套
任务库、状态机或执行循环。
