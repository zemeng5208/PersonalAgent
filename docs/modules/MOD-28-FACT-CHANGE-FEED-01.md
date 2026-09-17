# MOD-28-FACT-CHANGE-FEED-01：事实变化消费首片

- Profile：`huawei_ict_agentarts`；实施负责人 zemeng；非作者评审 goo122。
- 分支 `codex/zemeng/fact-change-feed`，基于 PR #62 `c670433`；状态 in_progress。
- 主任务拥有公开 feed 契约、输入验证器与本文；Sol 实施同一 FakeMemoryHost 的消费状态机。

## 解决的问题

已有 MemoryQueryPort 只支持查询，不代表事实变化已被消费。这个工作包补充有界批次、
宿主绑定、bootstrap、重读及确认语义，作为 MOD-27/28 事实投影的前置，不重做查询层。
批次只携带随机 eventId 和精确 FactRef；不公开内部 sequence、隐藏条数或正文。

读者只获得 `FactChangeFeedPort.read`。确认在可信 Fake 宿主侧进行，要求完整已交付批次、
checkpoint CAS 与精确引用匹配；同输入重试返回相同回执。Fake 确认不构成持久投影完成
证明；生产实现必须把投影、去重/影响登记与 checkpoint 放在同一可信本地事务中。

bootstrap 按固定水位选取每个事实最新头版本，再做 scope 过滤，保留可见的未来生效、
过期和 withdrawn 版本；不能用 listCurrent(at) 代替完整基线。旧图依赖不能自动重绑定。
可见性收缩使旧视图失效并要求重建，不复活旧头。查询 snapshot、feed watermark、消费
checkpoint 和 graphRevision 各有用途，不能互换或用于任意跳过未处理事件。

## 当前边界

所有新增接口为 provisional、进程内 TS；没有 wire operation、生产数据库、删除策略、
云端出机、真实私人事实或自动任务提交。无外部 exactly-once 承诺。
保留与删除、历史权限及真实事实出机政策尚需产品确认，但不阻碍合成数据契约首片。
本片不宣称整个 MOD-28 完成。

## 验证

公开批次解析验证器覆盖精确结构、上限、重复身份、输入副本隔离、getter/proxy 错误脱敏。
Node 24.15.0 下 memory 构建通过，解析器目标测试 4/4 通过；其中覆盖数组 Proxy
伪造 length 不能跳过条目验证，以及额外数组属性拒绝。使用 `--test-isolation=none`。
Fake 状态机验证由对应目标测试登记；实际结果在交付前补齐，不以方案代替执行证据。
