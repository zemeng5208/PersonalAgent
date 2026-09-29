# P7 关注事项与知识增量更新：给 Gemini 的挂载说明

Profile：`huawei_ict_agentarts`。本文只说明 Desktop 消费宿主。`snapshot().mountedInMain` 恒为 `false`。导入本模块或跑测试都不等于桌面进程已经挂上。

总装写入者是 Gemini。本文不再把接线交给 Luna。宿主不修改 `apps/desktop/electron/main.js`。

拥有文件：

- `apps/desktop/electron/knowledge-watch-host.js`
- `apps/desktop/test/knowledge-watch-host.test.mjs`
- `apps/desktop/docs/knowledge-watch-integration.md`

## 公开导出

```js
import {
  createKnowledgeWatchHost,
  createUnavailableSourcePort,
  knowledgeWatchCheckpointKey,
  knowledgeWatchConversationId,
  knowledgeWatchScheduleInput,
} from './knowledge-watch-host.js';
```

`createUnavailableSourcePort` 只给显式测试装配。生产构造不要调用它，也不要把它的返回值传进 `sourcePort`。省略来源时，`refreshSource` / `refreshSubscribedFeed` 返回 `availability: "unavailable"`、`reason: "source_provider_missing"`，不写检查点，也不带 `provider: "fake"`。

宿主内部从 `@personal-agent/cognition` 使用：

- `buildInterestOptions`：只生成选项，并在模型返回后按当前墓碑和范围重验。它不是 Laya 的选择。
- `LayaInterestDecisionService`：只有传入 `layaChooser` 且没有另传 `interestDecider` 时，宿主才 `new LayaInterestDecisionService(layaChooser, now)`。
- `planKnowledgeReevaluation`：只重评仍绑定同一 `sourceId` + `sourceRevision` + `contentSha256` 的依赖。

宿主不调用 `LayaActionChoiceService` 来给兴趣选项排序，不取第一项，也不读取提供者私有字段。

## 构造参数和提供者

| 参数 | 必须 | 现有提供者 | 宿主实际调用 |
| --- | --- | --- | --- |
| `profile` | 是 | 固定 `huawei_ict_agentarts` | 其他值抛 `INVALID_ARGUMENT` |
| `namespace` | 是 | `desktopHost.userNamespace` | 写入检查点并拒绝不一致事件 |
| `checkpointTaskId` | 是 | 已存在的 Runtime 任务 `taskId` | 传给 `loadCheckpoint` / `saveCheckpoint`。宿主不创建任务 |
| `checkpoints` | 是 | `runtimeApplication.runtime` | `loadCheckpoint(taskId, key)`、`saveCheckpoint(taskId, key, value)` |
| `now` | 否 | 桌面时钟。正式模式用 `Date.now` | 兴趣服务和来源时间都用这一只钟 |
| `layaChooser` | 生产要跟踪时需要 | 现有 `localLaya`。它的 `choose(request)` 是 `LayaActionChoiceService` 的单参数形态 | 包进 `LayaInterestDecisionService`。不要把 `localLaya` 直接当作 `interestDecider` |
| `interestDecider` | 否 | 测试双份，或已经构造好的 `LayaInterestDecisionService` | `choose(input, {deadline, signal})`。有它时不再包一层 |
| `runtime` | 来源变化要提交工作时需要 | `runtimeApplication.runtime` | `submitTask`、`findTaskByIdempotencyKey`；若同时有调度方法，也用于下面三行 |
| `workPort` | 否 | 只在显式测试里代替 `runtime` | `read` / `submit`。传入后不再改编 `runtime.submitTask` |
| `scheduler` | 否 | 同上 Runtime，或单独传入同名方法 | `createSchedule`、`listSchedules`、`reconcileSchedules` |
| `feedCollect` | 要读真实订阅时需要 | `feedsHost.tools` 里 `descriptor.name === "feeds.collect"` 的 `execute` | `feedCollect({subscriptionId, cursor?}, signal)`，对应 `FeedService.collect` |
| `feedSubscriptionId` | 否 | 已配置订阅的 `id`。`feeds.subscriptions` 只返回 `id`、`title`、`sensitivity` | `refreshSubscribedFeed()` 省略参数时使用 |
| `notificationService` | 否 | `@personal-agent/notifications` 的 `NotificationService` | `ingest`、`drain`。宿主不调用 `acknowledge` |
| `notificationPort` | 否 | 显式测试双份 | `send`，可选 `read`。传入后不再改编 `notificationService` |
| `policyPort` | 范围扩大、私有或高风险时需要 | `AuthorizationPolicy` | 生产走 `authorize(request)`。测试双份可以是 `evaluate` |
| `authorizationRef`、`policyToolName`、`policyScopes` | 调用 `authorize` 时三者一起给 | 已登记的授权引用、工具名、范围。没有默认范围 | 缺任一项则 `allowed: false`，原因 `policy_request_incomplete` |
| `readTrackingGrant` | 否 | 能读当前跟踪授权的现有函数 | 副作用前重读。未注入时只重读宿主自己的墓碑和关注状态 |
| `sourcePort` | 否 | 旧的显式读取口。生产 RSS 用 `feedCollect` | `read({namespace, sourceId, signal})` |
| `subscriptions` | 否 | 只有真有 `subscribe(handler) -> unsubscribe` 时才传入 | `start` 登记一次。当前桌面没有这个推送总线 |
| `knowledgeMaxAgeMs` | 否 | 默认两小时 | 传给 `planKnowledgeReevaluation` 的 `maxAgeMs` |

检查点键是 `knowledgeWatchCheckpointKey(namespace)`，即 `knowledge-watch:v1:<namespace>`。对话 id 是 `knowledgeWatchConversationId(namespace)`，即 `knowledge-watch:<namespace>`。这个对话只放本宿主的调度，避免 `reconcileSchedules` 取消别人的提醒。

`saveCheckpoint` 会先 `getTask`。任务不存在时 Runtime 抛 `NOT_FOUND`。这不是空关注列表，宿主不会改写成首次运行。`loadCheckpoint` 没有行时返回 `undefined`，那才是空文档。加载抛错，或文档版本、命名空间、墓碑、已投递却无回执不合法，则 `health.status = "unreadable"`，`watches` 为 `null`，消费抛 `CHECKPOINT_UNREADABLE`，并且不回写。

## 尚缺、不能由本宿主补上的依赖

- `feedsHost` 不导出 `FeedService`。公开入口是工具 `feeds.collect`。`prepare()` 之后才出现在 `feedsHost.tools`。会话未 `authorize({readAndCloudConsent: true})` 时，现有包装会抛 `订阅读取许可已撤销或任务绑定已改变`。宿主把这种失败记为 `source_unavailable`，不把关注清成空列表。
- `createDesktopTodoHost` 内部的 `NotificationService` 没有公开句柄。没有可传入的实例时就省略 `notificationService`。提醒保持 `delivered: false`，原因 `notification_port_missing`。不要在总装里伪造 `{delivered: true}`。
- `localLaya.choose` 不是兴趣决策。兴趣决策必须经过 `LayaInterestDecisionService`。模型进程仍只有现有的 `localLaya.start` / `localLaya.stop`。
- 桌面没有来源推送总线。不要为了本宿主新增 `setInterval`。到点后由现有 Runtime `dispatchDueSchedules` / `recoverMissedSchedules` 产生任务，再显式调用 `refreshSubscribedFeed`。宿主自己不调用这两个分发方法。

## 初始化和生命周期

挂载位置在 `apps/desktop/electron/main.js`：`const namespace = desktopHost.userNamespace` 且 `runtimeApplication` 已赋值之后，与 `feedsHost.bindApplication(runtimeApplication)`、`feedsHost.prepare()` 同一段。退出释放放在现有 `feedsHost?.close()` 之前。下面使用的都是该文件里已经存在的对象；`watchTask` 和 `collectTool` 是这两次调用的返回值，不是预先存在的全局变量。

```js
import {createKnowledgeWatchHost, knowledgeWatchConversationId} from './knowledge-watch-host.js';

const watchTask = runtimeApplication.runtime.submitTask({
  goal: '保持关注事项检查点',
  conversationId: knowledgeWatchConversationId(namespace),
  idempotencyKey: `knowledge-watch-checkpoint:${namespace}`,
});
const collectTool = feedsHost?.tools.find(tool => tool.descriptor.name === 'feeds.collect');
const knowledgeWatch = createKnowledgeWatchHost({
  profile: 'huawei_ict_agentarts',
  namespace,
  checkpointTaskId: watchTask.taskId,
  checkpoints: runtimeApplication.runtime,
  now: () => Date.now(),
  layaChooser: localLaya,
  runtime: runtimeApplication.runtime,
  feedCollect: collectTool
    ? (query, signal) => collectTool.execute(query, {taskId: watchTask.taskId, signal})
    : null,
});
knowledgeWatch.start();
```

顺序：

1. 恢复：再次启动时用同一个 `idempotencyKey` 调用 `submitTask`。Runtime 返回已经存在的任务，不新建第二份。随后 `loadCheckpoint` 读回关注、墓碑、来源头、`feedCursor` 和未完成提醒。
2. `feedsHost.prepare()` 后才能找到 `feeds.collect`。用户是否允许本会话读取，仍走现有订阅设置里的 `authorize` / `revoke`。宿主不代用户打开许可。
3. `knowledgeWatch.start()`。重复调用直接返回快照，不会再登记一次 `subscriptions`。`start` 不创建调度，也不读网络。
4. 若要排一次检查，调用 `registerFeedCheck({checkId, runAt})`。它调用 `createSchedule`，输入来自 `knowledgeWatchScheduleInput`。同一个 `scheduleId` 配不同输入时，Runtime 抛 `REVISION_CONFLICT`，宿主返回该 `code`，不另造一条。`missedRunPolicy` 固定 `run_once`。宿主不计算下一次运行时间。
5. 进程重启后调用 `restoreFeedChecks()`，它只 `listSchedules`。到期分发仍由 Gemini 已有的 Runtime tick 调用 `dispatchDueSchedules` 或 `recoverMissedSchedules`。分发成功后，用订阅 id 调用 `refreshSubscribedFeed({subscriptionId})`。
6. 兴趣：`consumeInterestSignal(signal, {deadline, signal})`。`deadline` 和 `signal` 都要有，否则在需要模型时抛 `INVALID_ARGUMENT`。宿主把调用方信号和自己的停止信号合成一个 `AbortSignal`。
7. 撤销：`revoke(topicId, {id, revokedAt})` 同步写入墓碑。暂停和恢复是 `pause` / `resume`。唯一可以带用户重新开启的入口是 `enable(signal, enablement)`。
8. 停止：`stop()` 增加代际、中止在途信号、调用订阅的取消函数。若本实例登记过调度，再 `reconcileSchedules(conversationId, [])`，只取消本对话里仍为 `pending` 的调度。对话里若有不属于 `knowledge-watch:<namespace>:` 的调度，返回 `scheduler_conversation_not_exclusive`，不取消。
9. `dispose()` 调用 `stop` 并拒绝再次 `start`。它不调用 `localLaya.stop`，也不 `runtimeApplication.close`。退出时先 `knowledgeWatch.dispose()`，再执行现有的 `feedsHost?.close()`。

和 P5 共用模型时，进程归属仍是 `laya-local-host.js` 的 `localLaya`。本宿主只在 `choose` 期间借用它。`localLaya.snapshot().ready !== true` 时，现有 `choose` 抛 `本地 Laya 决策尚未就绪`，本次兴趣消费失败，已保存的关注不变。不要为 P7 再启动一个 Laya。

## 关注、来源和通知怎么走

一次提问保持 `suggested`（待建议），不调用模型。持续的公开低风险证据先由 `buildInterestOptions` 得到 `watch_public`，再由 `LayaInterestDecisionService.choose` 选择。只有 `outcome === "selected"`、`requiresHostRevalidation === true`，并且选中的 `track_public` 仍在当前选项里，才可能变成 `tracked`（已跟踪）。选择端口缺失时原因是 `decision_port_missing`，不是自动跟踪。

低风险公开跟踪沿用信号里的 `scope.publicLowRiskTracking`，授权投影是 `{basis: "existing_public_low_risk_scope"}`，没有默认的 `allowed: true`。`requestsScopeExpansion`、私有或高风险才调用 `AuthorizationPolicy.authorize`。成功时返回的 `scopes` 必须覆盖 `policyScopes`，原因记为 `authorized`。抛错时 `allowed: false`，原因用错误上的 `code`（例如 `UNAUTHORIZED`）。策略允许也不能越过兴趣政策把高风险来源变成跟踪。

`tracked` 会记下 `boundSource`（来源 id、版本、`contentSha256`、缓存版本、最近成功检查、有效期）、`scope`、`expiresAt`、`modelReceiptId` 和撤销所需的主题 id。

`refreshSubscribedFeed` 读 `FeedService.collect` 的公开结果：

- `collection.state === "fetched"` 且 `hasMore === false`：用公开条目的 `dedupeKey`、`occurredAt`、`contentRef`、`title`、`summary` 计算内容摘要。版本是校验器 `{etag, lastModified}` 的摘要；两个都为空时，版本只来自这份正文摘要。比较只用相等，不按字符串大小判断新旧。引用用条目自己的 `contentRef`，不复制订阅 URL。
- `unchanged`：这是条件请求的未变化结果，不是空的首次运行。没有先前正文摘要时返回 `source_body_not_read`，不编造哈希。
- `hasMore === true`：只保存 `nextCursor` 到该来源的 `feedCursor`，原因 `feed_page_incomplete`，不宣告新版本。
- `TIMEOUT`、`EXTERNAL_FAILURE`、`RATE_LIMITED`：`source_transient_failure`。不改关注，不把检查点当首次运行。
- `NOT_FOUND`：按撤回交给现有来源消费。
- 结果缺字段：`invalid_feed_result`，不写版本。

来源版本变化只重评绑定该旧版本的事项。其他来源上的关注保持原绑定。工作项的幂等键是计划返回的 `workKey`。`submitTask` 的输入固定为 `{goal: "RECHECK <workKey>", conversationId, idempotencyKey: workKey}`。提交前先 `findTaskByIdempotencyKey`。已经有任务就记下 `taskId`，不再提交。读或写结果不明时保持 `unknown`，不把重评检查点写成已提交，也不发提醒。

用户撤销若发生在读取或提交期间，提交前会再看墓碑和 `tracked` 状态。已经撤销的事项不提交。已经进入 Runtime 的幂等记录不会被删除后再提交一次。

提醒只在回执 `delivered === true` 且 `receiptId` 非空时标成已投递。`NotificationService.drain()` 给出的 `ready_for_delivery` 只记下批次 id，原因 `awaiting_acknowledgement`，`delivered` 仍为 `false`。桌面现有确认路径调用 `acknowledge(batchId)` 后，把返回的批次交给 `observeNotificationAcknowledgement`。只有 `state === "delivered"` 且 id 匹配才完成。未确认的事项留在 `listPending().notices`，不会被删掉。没有引用定位符的提醒原因是 `citation_missing`，同样留在待处理里。

来源摘要只放进带“不可信数据”字样的提醒，不改变授权、模型或工具。私人笔记和邮件不在这条 RSS 路径里，宿主不因为关注更新而发送它们。

## 状态投影

`snapshot()` 含 `namespace`、`running`、`disposed`、`health`、`wiring`、`checkpointKey`、`mountedInMain`、`watches`、`notices`、`submissions`、`sources`。损坏时后四项为 `null`。

关注状态：`suggested` 待建议、`tracked` 已跟踪、`paused` 暂停、`revoked` 撤销、`expired` 过期、`source_unavailable` 来源不可用、`authorization_required` 待授权。

`listPending()` 返回待建议、待授权、来源不可用、暂停，以及未投递提醒和 `unknown` 提交。`listWatches()` 在检查点不可读时抛错，不返回空数组。

`wiring.source` 为 `feeds`、`injected` 或 `unavailable`。`wiring.layaChooser` 表示宿主自己包了 `LayaInterestDecisionService`。`wiring.main` 恒为 `false`。

## 已验证和未验证

已在 `node --test apps/desktop/test/knowledge-watch-host.test.mjs` 验证，14 项通过。其中原有 9 项仍覆盖偶然提问、持续跟踪、撤销、重复与乱序、损坏检查点、丢失提交和停止。本轮新增：

- 真实 `LayaInterestDecisionService` 包住一个选择器双份：持续兴趣才调用模型形态的 `choose`，弃权不跟踪。没有启动 Laya 进程。
- 合成的 `FeedService.collect` 结果：只影响绑定该来源的关注；`unchanged` 不重复提交；`TIMEOUT` 不把文档当成首次运行。这不是真实网络变化。
- 版本字符串 `"2"` 可以替换更早观察到的 `"10"`，因为它们只是不同身份；更早的 `fetchedAt` 不会覆盖。
- `submitTask` 成功落账但响应丢失后，`findTaskByIdempotencyKey` 能对上，提交次数保持 1。这是内存双份，不是 Runtime 的 sqlite。
- `ingest` / `drain` 的 `ready_for_delivery` 不会标成已投递；`observeNotificationAcknowledgement` 只接受 `state === "delivered"`。
- 撤销发生在 `read` 返回之前时，`submit` 不会被调用。
- `createSchedule` 相同输入不产生第二条；`stop` 通过 `reconcileSchedules` 取消本对话的 pending 调度。
- `AuthorizationPolicy.authorize` 覆盖范围时记录 `authorized`；抛 `UNAUTHORIZED` 时 `allowed` 为 false。

另有一次公开只读：`HttpFeedProvider.fetchFeed({url: "https://hnrss.org/frontpage"})`。`verification` 为 `conditional`，`source` 为 `http-feeds`，结果 `state` 为 `fetched`，没有 ETag，有 Last-Modified，正文 16437 字节。没有先前版本，因此没有观察到变化，也没有把这次正文送进宿主。没有修改订阅、没有发消息、没有上传私人数据。

尚未验证：`main.js` 挂载、真实 Laya 进程、桌面会话授权后的 `feeds.collect`、Runtime sqlite、以及用户界面上的 `acknowledge`。这些属于 Gemini 的总装和现有进程，不在本宿主测试里启动。
