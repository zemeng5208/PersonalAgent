# ADR-0008：事实变化消费与投影确认边界

- 状态：proposed，待非作者评审；MOD-09B/09C 已提供进程内契约、Fake 与独立 SQLite Memory 适配器，本修订定义后续生产消费边界。
- Profile：huawei_ict_agentarts；关联 PA-024/025、PR #57/#62。

## 选择

Memory 保存来源明确的事实版本，Goal 图只保存精确 Ref 对应的依赖投影。事实版本、
feed 内部提交序号和 graphRevision 分离，不自动将旧决策重绑定到新事实。
同一个 FactRef 对应不同内容是完整性错误，不通过覆盖或摘要比较消解。

feed 由可信宿主绑定 namespace、consumer 和显式 scope。对外只返回随机句柄，
不编码/暴露原始 sequence 或隐藏事件数量。每消费者最多一个未确认批次，重读固定批次。
初次 bootstrap 固定水位并选各事实最新头，再过滤权限；未来生效、过期和撤回头也保留。
完成所有基线批次后才转为该水位之后的增量，不能用当前有效事实查询代替基线。

scope 变化或先前可见事实变为不可见，旧绑定失效并要求重建；不能过滤新头后复活旧值。
只读消费端无 ack 方法。确认必须由可信宿主核实批次完整性、绑定、checkpoint CAS 与
精确 Ref。确认幂等回执先于旧 checkpoint 冲突处理，但不能绕过当前权限失效。

## 生产事务要求与 MOD-09D 增量实现

1. 事实版本和变化事件在 Memory 自己的本地事务中追加；Memory 的 delivery journal 只证明
   provider 侧持久投递，不证明 Goal 投影完成。
2. Goal/Coordination 数据库使用持久事务 Inbox。在同一个宿主事务中提交事实投影、精确
   FactRef → NodeRef 映射、事件/批次去重、待重检记录、本地 consumer checkpoint 和回执。
3. 该事务提交后，可信宿主才调用 Memory 的 `confirmFeedBatch()`。如果在本地提交后、
   provider 确认前崩溃，Memory 可以重放原批次；宿主必须依据已提交 Inbox 回执跳过重复
   图写入并重试确认。
4. provider checkpoint 与本地 Goal 数据库不宣称跨库原子。可恢复性来自“先提交本地
   业务效果，再幂等确认 provider”，而不是 SQLite 跨文件事务或分布式事务。
5. PR #57 的 `appendBatch` 仅覆盖图事务；先调用它再单独 ack、但不持久化 Inbox、精确
   映射和待重检记录，不能称为原子消费。
6. 相同 FactRef、event、batch 或 expected checkpoint 若绑定不同内容，必须作为完整性
   冲突拒绝，不能沿用旧回执。
7. 同步数据库调用不承诺即时抢占取消；提交前检查，提交后以持久回执为准，不将已提交
   操作伪装为无副作用取消。消费者不获得 SQL、数据库连接或通用事务回调。

事实节点 ID 对同一 memory namespace/fact ID 保持稳定，但 Goal node revision 独立增长。
每个精确 FactRef 必须持久映射到精确 NodeRef，不能假设两侧 revision 数值相同。

## 限制与代价

单批次协议牺牲并发吞吐，换取首片可核验的确认边界。Fake 的内存确认不能证明崩溃恢复，
也不能替代真实图投影、SQLite 事务测试或云端闭环。这里不承诺外部副作用 exactly-once。
事务 Inbox 只保证本地投影与待重检登记的幂等效果；provider 确认是提交后的可重试步骤。
本地读取许可不等于出机许可。真实数据的保留、删除/派生内容/备份策略以及历史权限
仍需产品决定；不擅自设置固定保留时长或默认永久保存。
