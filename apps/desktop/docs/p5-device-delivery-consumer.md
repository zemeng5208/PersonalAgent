# P5 设备通知：策略与 Runtime 持久回执消费

- Profile：`huawei_ict_agentarts`；工作包：P5-DEVICE-DELIVERY-CONSUMER。
- 唯一写入者：设备通知对话；原宿主/专属 case/docs，以及 P8 明确释放的 receipt store/case。
- 工作树复用 `.worktrees/p5-notification-lifecycle`，分支 `codex/zemeng/p5-device-delivery-consumer`，
  基线 `803089919171d655b7a76c2df51cd2c297bf1d6f`；#248 生命周期实现保持。
- P6 提供真实指标，P5 负责连续确认/迟滞/多 source/共享 Laya 合法候选与持久决策，
  P8 唯一装配 main/Runtime/migration。该包不改业务 notification 提供者或公共 wire。

## P8 准确挂载参数

```js
const p5DeviceReceiptStore = createP5DeviceReceiptStore({
  storage: runtimeApplication.createHostStateStore('device-notifications'),
  filePath: path.join(app.getPath('userData'), 'p5-device-receipts.json'),
  // 默认仅 node:os；只有另一个真实可信 source 交付后才由主装配显式扩大。
  allowedSources: ['node:os'],
});
const notificationPort = createP5DeviceNotificationHost({
  Notification, store: p5DeviceReceiptStore,
  isActive: () => Boolean(p5DeviceTelemetrySubscription
    && p5Cognition?.snapshot().state === 'running' && proactiveHost?.snapshot().enabled),
  readProvenance: notification => p5SystemObservationSource?.readCurrentProvenance(notification),
  readDeliveryPolicy, // 以下同步新鲜端口；不可填固定 true 或只读一次缓存。
  onUpdate: publish,
  onLateOutcome: reconcileDeviceDeliveries,
});
```

`storage` 是 P8 的原 TaskRuntime SQLite namespace closure，同步 `get/set/delete`；
调用方不能从通知输入选择 namespace。此模块不打开数据库、不新建任务、不执行迁移。
固定 KV key 为 `p5-device-receipts:v2`；数据 version=2，保留原记录字段。
缺少两种持久后端或非法端口拒绝。显式 `filePath` 仍保留历史文件模式供兼容；正式新
Competition 装配使用 SQLite port，不能把历史 file-only 模式说成同 Runtime 持久化。

首次 SQLite key 不存在时验证并导入旧 JSON；V1 旧 deliveredAt 仅证明历史卡片保存，
导入为 unknown。任何重启时 pending 也转 unknown，并先持久化再允许新通知。
SQLite key 已存在后不重读旧文件、不向旧文件写入，旧副本原样保留以便回查。
腐坏、配置缺失、读写失败均明确抛错，不清空历史或以空 Fake 继续。
同进程多个 store 句柄每次操作重读最新持久状态；主装配仍保持唯一通知发送者。

历史列表上限、unknown/pending 永不裁剪、同 ID 完整输入/来源一致性、terminal 不反转
均复用原 store 算法。卡片历史有界，较早 terminal 可退出历史列表；所有旧采样不重跑
仍依赖 P5 同 Runtime 的单调采样、source 独立 checkpoint 和已确认冷却事实，不靠 UI 卡片
承担整个决策历史。未决容量满时拒绝新投递，不删 unknown 给新弹窗腾空间。

## 新鲜 quiet/pause 端口

`readDeliveryPolicy()` 同步返回 `{allowed:true}`（可附 `reason:null`），或
`{allowed:false, reason:'quiet_hours'|'paused'|'unavailable'}`。主装配复用
`@personal-agent/notifications` 公开策略函数/可信 status 读回，不复制业务裁定或 scheduler。
授权/配置缺失、异常、异步 Promise、非法字段或不一致 allowed/reason 均按 unavailable。

缺省端口明确 unavailable；设置尚未接齐的新宿主不得静默放行。宿主在新意图保存前、
构造原生对象前及紧靠 native.show 前重读。安静/暂停抑制新的意图时返回
`{delivered:false,error:reason}`，不弹 OS、不生成每个高压样本一张新卡片；P5 不锁冷却。
若保存后策略才变动，则记明确 failed（没有调用 show），解绑等待并返回 false。
不建另一个计时器恢复队列；结束安静后由新真实采样及合法候选重新决定。

已实际调用 show 后，等待的是 OS 结果：quiettime 后续变化不能抹去已发生的回执，
同 ID 已 delivered 仍读回 true。unknown 仍拒绝、不重发、不因安静规则返回确定 false。
授权撤销/stop/dispose 的迟到隔离继续按 #248，未知副作用保留待核实。

## 可信回执读取与恢复

`notificationPort.readDeliveryOutcome(id)` 返回持久来源
`source/sourceTaskId/evidenceRefs`、`persisted`、`queued`、`deliveryState`、`delivered`、
`deliveredAt`、`userRead:'unobserved'`；没有记录返回 undefined，未知 state 拒绝。
它只用于可信宿主，不能把原始 Evidence 或 task 身份直接塞进 Renderer/云输入。
重启恢复可以读取该回执而不重放旧 sampling cache；read 返回拷贝，消费者不能改存储。

只有实际原生 show 后持久成功才是 delivered；卡片保存不是投递，系统投递不是用户已读。
P8 现有 `reconcileDeviceDeliveries()` 只核实同 source、同 pendingDeliveryId 的 terminal
delivered/failed，之后 readDeviceFeedback 读回；unknown/pending 不猜测、不清空、不重复弹。
开启订阅前核实、关闭订阅后同步 host.stop、退出 dispose 的两个生命周期点保持。

## 已运行与待验

- 新策略/只读回执 case 5/5 通过：quiet/pause/缺失/非法策略、show 前重读、
  已投递与 unknown 不被策略覆盖、queued/delivered/user-read 区分。
- 新 Node SQLite port case 5/5 通过：数据库关闭重开、delivered 去重、pending→unknown、
  旧 JSON 一次导入/旧文件不变、V1 不伪 delivered、读写/腐坏失败、多 source 来源绑定、容量保留。
- 宿主和 store 的 node --check、git diff --check 通过。#248 原 10 个 Fake case 不重复运行。
- Node SQLite seam case 使用隔离真实 SQLite 和同形 StoragePort，不等于 P8 migration10
  与正式 Runtime namespace 集成验收。未安装/启动模型、没有真实 OS 通知副作用。
- P6 默认真实 source 是 node:os；injected 只能是显式测试来源。CPU/内存没有进程/磁盘/
  温度/网络归因，不能从相关性推断变慢原因。
- 完整证据需 P8 最后短槽：实际已许可 Windows 指标/同 Runtime Evidence → P5 真实 Laya
  多候选 → 新鲜策略 → OS show/failed/unknown → SQLite 回执/重启核实/撤销隔离。
  若用公开合成持续高压样本触发一次真实 OS，必须分别标注“合成输入、真实投递”；
  该结果不能证明真实指标异常或物理用户已阅读。用户不在不做过量通知测试。
- 原 Laya 因本机资源/账号/现场受阻的项目保持未验，不能用固定 delivered:true 替代，
  不停止用户应用或改安全策略。未完成全链证据前不标记本包/首版 MVP done。
