# MVP-TWIN-B-INTEREST-01：持续兴趣的合法选项

> 维护入口（2026-10-07）：项目主要负责人为 zemeng；当前分工以 [模块分工](../../docs/MODULE_ASSIGNMENTS.md) 为准，最新状态见 [ROADMAP](../../docs/ROADMAP.md)。历史日期、作者和验收结论按原记录保留。

- Profile：`huawei_ict_agentarts`；MOD-28；负责人 zemeng。
- 状态：`review`；依赖 #187 的 InterestPolicy 与 #190 的主动选择/AgentArts 交接方向。
- 所有权：`packages/cognition/**` 和本文件；根接线及连接器注册由主任务负责。

复用 `decideInterest` 判断哪些方案具备依据，再由 Laya 从多个合法方案中选择，
将选择和来源/版本依据交给 AgentArts 编排。该组件不创建订阅、任务库、计时器或爬虫，
不把模型选项或分数当作执行授权。

- 单次偶然问题只允许保留临时兴趣线索或暂缓，不产生长期跟踪选项。
- 只有充分上下文证据、已核验公开低风险来源和有效跟踪 scope 同时存在，才提供
  `track_public`，并绑定来源版本、scope 版本、精确证据和到期时间。
- 已撤销兴趣只提供停止或保持撤销；模型不能覆盖用户撤销，也不能生成重新开启事件。
- 来源不可用、证据衰减或 scope 不允许时，不把跟踪藏在其他选项的描述或参数中。
- 推理返回后复查当前时间与原始绑定；执行阶段仍须由可信宿主检查最新的撤销与来源状态。
  纯快照无法证明推理期间外部权限未变化。

输出保留 `calibrated: false` 及 `requiresHostRevalidation: true`。
本地证据内容不因此取得出云许可；AgentArts 只接收主宿主批准的最小投影。
低风险事项按已有授权自动推进，重大权限才通知用户，不要求每个兴趣判决人工点选。

公开入口为 `buildInterestOptions(input)` 与
`new LayaInterestDecisionService(chooser, now).choose(input, {deadline, signal})`。
调用方只在 `outcome === 'selected'` 且存在 `selected` 时交接所选方案；
`policy` 与 `options` 保留原判决记录，不能单独当作推理完成后的有效执行决定。
`receipt` 绑定来源、证据、scope、选项与有效期；宿主在派发时复核最新状态。

验证：cognition 构建与类型检查通过；定向测试 6/6 通过，覆盖单次问题、
持续兴趣、撤销、过期、非法枚举、伪造选项、异步输入变化与回执绑定。
模型推理使用显式 Fake，未运行真实 Laya 或真实 AgentArts。
本机 Node 26.3.0 / npm 11.16.0 与仓库期望的 24.15.x / 11.12.x 不同；未更改工具链。

没有 contracts、数据库迁移、新依赖或业务连接器变更。
主任务仍需接入兴趣证据来源、最新 scope 状态及 AgentArts 的最小出云交接。
真实订阅来源、次日知识更新和生产持久撤销链尚未验收；本包不改变接口冻结状态。
