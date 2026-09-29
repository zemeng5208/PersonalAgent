# P7 关注事项与知识增量更新：消费宿主挂载说明

Profile：`huawei_ict_agentarts`。本文件只说明 Desktop 消费宿主，不表示产品已经接通。

拥有文件：

- `apps/desktop/electron/knowledge-watch-host.js`
- `apps/desktop/test/knowledge-watch-host.test.mjs`
- `apps/desktop/docs/knowledge-watch-integration.md`

基线为挂载说明写作时的 `origin/main`。宿主复用 `@personal-agent/cognition` 已导出的 `buildInterestOptions`、`LayaInterestDecisionService.choose` 形态，以及 `planKnowledgeReevaluation`。它不实现第二套兴趣分类、调度器、爬虫或任务库，也不修改 `packages/cognition`、`packages/goals`、`packages/knowledge`、`packages/memory`、`main.js`、公共 Schema 或根配置。

## 当前状态

| 层面 | 状态 |
| --- | --- |
| 宿主实现 | 已提供 `createKnowledgeWatchHost`。可 `start` / `stop` / `dispose`，可消费兴趣与来源事件，可投影快照、待处理项和撤销。 |
| Fake 验证 | `apps/desktop/test/knowledge-watch-host.test.mjs` 用注入端口覆盖撤销、版本变化、重复与乱序、损坏检查点、丢失回执后的核实，以及停止后不再消费。 |
| 真实来源 | 未接通。没有生产连接器时，省略 `sourcePort` 会使用 `createUnavailableSourcePort()`，只返回 `availability: "unavailable"` 和 `provider: "fake"`。 |
| 生产接线 | 未做。`snapshot().mountedInMain` 恒为 `false`。导出本模块或在测试里调用，都不等于桌面进程已经挂上。 |

## 给 P8 的构造参数

```js
import {createKnowledgeWatchHost, createUnavailableSourcePort} from './knowledge-watch-host.js';

const host = createKnowledgeWatchHost({
  profile: 'huawei_ict_agentarts',
  namespace,                 // 已登录账号的命名空间。事件里的 namespace 不一致会被拒绝。
  checkpointTaskId,          // 已经存在的 Runtime 任务。宿主不创建任务，也不另开任务库。
  checkpoints: {
    loadCheckpoint(taskId, key) { return runtime.loadCheckpoint(taskId, key); },
    saveCheckpoint(taskId, key, value) { runtime.saveCheckpoint(taskId, key, value); },
  },
  now: () => Date.now(),
  sourcePort,                // 可选。没有生产端口时不要注入“假装成功”的对象。
  subscriptions,             // 可选。既有订阅设施：subscribe(handler) 必须返回 unsubscribe。
  interestDecider,           // 可选。只接受 { choose(input, {deadline, signal}) }。
  workPort,                  // 来源变化需要重评时必须提供，并且按 workKey 幂等。
  notificationPort,          // 可选。缺省不会把提醒标成已投递。
  policyPort,                // 范围扩大、私有或高风险时必须提供。缺省不是 allowed。
});
```

检查点键是 `knowledge-watch:v1:<namespace>`，由 `knowledgeWatchCheckpointKey(namespace)` 生成。文档内部再次绑定 `namespace`。键能读出但结构、撤销墓碑或回执不合法时，宿主进入 `health.status = "unreadable"`，`watches` 为 `null`。这不是空列表，后续消费会抛 `CHECKPOINT_UNREADABLE`，不会把损坏数据当成“还没有关注”重新执行。

`checkpointTaskId` 必须事先存在。Runtime 的 `saveCheckpoint` 会检查任务；本宿主不负责创建它。

## 事件来源

宿主没有 `setInterval` 或 `setTimeout`，也不会自己抓取页面。

- 显式调用 `consumeInterestSignal(signal, {deadline, signal})`。
- 显式调用 `consumeSourceUpdate(event)` 或 `refreshSource(sourceId)`。
- `subscriptions.subscribe(handler)` 推送 `{type: "interest", ...}` 或 `{type: "source", ...}`。`start` 只登记一次；再次 `start` 不会重复登记。`stop` 和 `dispose` 都会调用返回的取消函数，并中止在途的 `AbortSignal`。

兴趣信号只读取 `topicId`、`at`、证据、`scope`、可选的公开 `source`、`sourceContent`、`classification` 和 `requestsScopeExpansion`。载荷里的 `explicitEnable`、`allowed`、`execute` 会被丢弃。来源事件只读取版本、内容摘要、获取时间、引用定位符和核验回执；摘要只放进带“不可信数据”字样的提醒，不会变成授权或工具参数。

`sourceContent` 必须带可信读回的 `contentSha256`、`cacheVersion`、`lastSuccessfulCheck` 和 `validUntil`。没有这组身份时，即使决策端口选了 `track_public`，状态也保持 `suggested`（待建议）。

## 公开方法

| 方法 | 行为 |
| --- | --- |
| `start()` | 开始接收。重复调用不会叠加监听。 |
| `stop()` | 停止消费，取消订阅，中止在途操作。之后的 `consume*` 抛 `STOPPED`。 |
| `dispose()` | 调用 `stop` 并拒绝再次 `start`。重复调用只返回快照。 |
| `snapshot()` | 命名空间、健康、接线投影、关注、提醒、提交和来源头。 |
| `listPending()` | 待建议、待授权、来源不可用、暂停，以及未投递提醒和未知提交。 |
| `listWatches()` | 关注列表。损坏检查点时抛错，不返回空数组。 |
| `consumeInterestSignal` | 调用 `buildInterestOptions`。只有策略已是 `watch_public` 且注入了决策端口时，才调用 `choose`。 |
| `consumeSourceUpdate` | 只对仍处于 `tracked` 且绑定了该来源版本的事项调用 `planKnowledgeReevaluation`。 |
| `refreshSource` | 读一次注入端口或不可用 Fake。不是轮询。 |
| `revoke(topicId, {id, revokedAt})` | 写入用户墓碑。迟到选择、旧来源事件、重启和载荷里的 `explicitEnable` 都不能恢复跟踪。 |
| `pause` / `resume` | 暂停不接收新提醒。恢复只回到原来已经选定的跟踪，不会重新询问模型。 |
| `enable(signal, enablement)` | 唯一能带上用户显式重新开启的入口，仍交给既有 `decideInterest` 判断。 |

关注状态使用：`suggested` 待建议、`tracked` 已跟踪、`paused` 暂停、`revoked` 撤销、`expired` 过期、`source_unavailable` 来源不可用、`authorization_required` 待授权。

低风险公开跟踪沿用已经授予的 `scope.publicLowRiskTracking`，不写默认的 `allowed: true`。`requestsScopeExpansion`、私有或高风险来源会调用 `policyPort.evaluate`。端口缺失、抛错或没有返回 `allowed === true` 时保持待授权。策略端口即使允许，也不能越过 `decideInterest` 把高风险来源变成跟踪。

## 存储、重评和通知

来源变化先按既有纯函数筛选依赖。未变化不生成工作项，也不再发提醒。重复事件和更早的 `fetchedAt` 不覆盖较新的来源头。同一绑定缓存上的后续核验，不会把已经观察到的另一版本头退回去。

工作项使用计划返回的 `workKey` 作为幂等键：

```js
workPort.submit({namespace, idempotencyKey, work}) // {accepted: true, taskId}
workPort.read({namespace, idempotencyKey})         // state: accepted | absent | unknown
```

提交结果丢失时，宿主把该键记为 `unknown`，不把重评检查点写成已提交，也不发提醒。下一次只先 `read`。`unknown` 不再次提交；`accepted` 才补写检查点。`read` 缺失时不能把重评当成完成。

提醒只有在 `notificationPort.send` 返回 `delivered === true` 且带非空 `receiptId` 时才标成已投递。缺端口是 `notification_port_missing`，坏回执是 `invalid_receipt`。宿主不发邮件，不删除文件，也不改外部订阅。

## 缺配置时

| 缺失 | 行为 |
| --- | --- |
| `sourcePort` | `refreshSource` 报告 Fake 不可用，不编造摘要、引用或成功抓取。 |
| `subscriptions` | 只接受显式消费，不自建轮询。 |
| `interestDecider` | 可以留下待建议，不会自动进入已跟踪，也不会启动 Laya。 |
| `workPort` | 可用的来源变化返回 `work_port_missing`，不假装重评已提交。来源不可用仍可标记状态。 |
| `notificationPort` | 提醒保留，`delivered` 保持 `false`。 |
| `policyPort` | 范围扩大或高风险得到 `allowed: false`，原因 `policy_port_missing`。 |
| 损坏检查点 | `watches: null`，拒绝消费，不回写成空文档。 |

## 需要协作者提供的接口

- P8：在唯一的 `main.js` / Runtime 装配槽构造本宿主。请传入已存在的 `checkpointTaskId`、上面的 `checkpoints`，以及真正的订阅、通知和工作端口。不要把本文件复制进装配层再改一份。
- P5：决策端口沿用 `LayaInterestDecisionService`。本宿主不创建 `LocalLayaHttpTransport`，也不启动第二个本地 Laya 进程。
- P1：生产 `sourcePort.read({namespace, sourceId, signal})` 需要返回 `availability`、`revision`、`contentSha256`、`fetchedAt`、`citation.locator` 和可选 `summary`。在该端口存在之前，宿主保持不可用 Fake。
- 记忆 / 检查点在途改动：如果 `loadCheckpoint(taskId, key)` 的损坏语义不再是“抛错或返回无法通过结构校验的值”，需要在接手前说明。本宿主现在把这两种情况都当成不可读，而不是空数据。
