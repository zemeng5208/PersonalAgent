# MOD-28-FACT-PROJECTION-01：事实投影纯预览

- Profile：`huawei_ict_agentarts`；负责人 zemeng；状态 `in_progress`。
- 基线：`d2aac1b`（FactChangeFeed Fake）；分支：`codex/zemeng/fact-projection`。
- 所有权：`packages/cognition`；只消费 `@personal-agent/memory` 与
  `@personal-agent/goals` 的公开 provisional 接口。

## 本片行为

`previewFactProjection` 接收现有 `GraphSnapshot`、已投递的公开
`FactChangeBatch`、宿主绑定的 `MemoryQueryPort`、显式 deadline/cancel context
和评估时间。它逐项读取精确 `FactRef`，在隔离图副本上使用已有
`appendVersion` 构造候选，再以 `analyzeImpact` 返回已有 `StoredImpact` 形状。

本片只支持图 Fact 节点 ID/revision 与 Memory `FactRef` 严格一致且连续的
子集。首次版本必须为 1；空图收到 revision 大于 1 的 bootstrap head，或已有
投影后出现 revision 缺口，均返回 `REBUILD_REQUIRED`，不猜测或补造历史。
重复的精确版本只有在 summary、sourceRef、有效期、敏感级别、状态、固定 reason
和空依赖全部一致时才是 no-op；任一共享字段漂移返回固定
`INTEGRITY_ERROR`。新 revision 的 `corrects` 必须精确指向同 ID 的前一版。

映射只复制图谱已有语义：`kind` 固定为 `fact`，`reason` 固定为
`fact projection`，dependencies 固定为空；原 `sourceRef` 原样保留。
`observedAt`、`confirmation` 和 `corrects` 继续由 Memory 权威保存，不编码进
sourceRef，也不在图谱中冒充完整事实记录；但映射前仍完整验证精确字段集合、规范
UTC 时间、枚举和 corrects 结构，拒绝缺字段、额外字段、访问器或恶意代理，且固定
错误不会回显外部正文。

所有读取复用同一 deadline 和取消信号。非法批次、范围拒绝、完整性失败、超时或
取消时不返回局部候选，调用方输入图始终不变。成功结果也只是一份候选图和影响报告；
旧精确依赖会触发最小 RECHECK，无关节点保持 KEEP，但不会自动重绑
Goal/Decision/Plan。读取端另有取消/截止竞速，即使提供者永不 settle 也能返回；
竞速结束会清理监听器和定时器，晚到结果或异常只被消费，不进入 candidate。

## 明确未交付

- 不写 CoordinationStore、SQLite、Runtime、任务状态或 Evidence。
- 不确认 feed、不推进 checkpoint，不给普通消费者确认入口。
- 不提供持久 eventId/FactRef 去重、影响队列或跨重启恢复。
- 不把图写入、影响登记和 feed 确认宣称为同一事务。
- 不支持 revision 大于 1 的完整 bootstrap 重建、物理删除、真实私人数据或
  AgentArts 修复。

因此真实持久投影与原子确认继续为 `unavailable`；Memory Fake 和本片纯预览
不能提升接口冻结状态。

## 后续架构提案（未实施）

[ADR-0009](../adr/0009-external-fact-projection-identity.md) 提议把 Memory
`FactRef` 与图 `NodeRef` 的版本空间分离，并用成对 externalRef/digest 保存映射完整性。
它仍是 proposed，涉及 Goals 公共类型、严格 parser 和持久格式，须由 `goo122` 确认
迁移与回滚后另行实施。当前 PR #73 的 ID/revision 相等、首次 revision 大于 1
`REBUILD_REQUIRED` 限制保持不变；不得从本链接推断实现或生产能力已经可用。

## 验收

目标测试使用合成事实，覆盖连续 correction 与最小 RECHECK、完整重复 no-op 和
字段冲突、首次跳号及后续缺口、withdrawn 传播、scope 拒绝整批，以及读取途中
取消整批；另覆盖永不 settle 的读取被 abort gate 释放，以及缺 metadata、非法枚举、
throwing getter 固定失败。需要构建 Memory、Goals、Cognition，并运行目标测试与一次架构门禁；
实际命令和结果在交付审查时记录。不运行全仓检查、真实服务或云端验收。
