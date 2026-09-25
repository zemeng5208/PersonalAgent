# MOD-28-PROJECTED-REPAIR-01：已确认事实投影的局部修复预览

- Profile：`huawei_ict_agentarts`；MOD-28 / PA-025；负责人 zemeng。
- 文件锁：`packages/cognition/**` 与本文；基于 MOD-28-GOAL-REVISION-01 的只读快照预览入口。
- 输入：可信宿主绑定的 MOD-27 图谱快照、现有 Runtime `FactProjectionReceipt` 的结构及显式时间。

`selectProjectedRepairScope` 复用 `analyzeImpact`，要求投影的 graph revision 与可信图谱相同，校验关联节点确实是已记录的 Fact，然后仅选择这批投影导致 RECHECK 的当前 Goal/Decision/Plan。无关节点仍保留在完整影响报告中，不进入本次候选范围。

`previewProjectedRepair` 从绑定存储读取一次快照，复用现有显式修复预检，只允许修改这个受影响子集。候选正文及依赖由调用方提供，部分修复后的 RECHECK 会继续保留。该入口不订阅或确认事实变化流，不调用 AgentArts/Laya，不批准、写入、调度或改变任务终态；宿主仍负责真实来源、权限、原子提交及 Evidence。真实 Runtime 装配属于其文件负责人，本包只提供可调用的本地域消费者。

验证使用合成投影收据和 Fake 图谱；不能据此将生产能力标记 frozen 或宣称真实 AgentArts 修复完成。

## 已处理批次的认知侧交接

`decideDurableFactProjection` 接收已持久投影的回执，通过可信 Runtime 宿主按同一 `batchToken` 读回已处理影响报告。它从绑定图谱重算报告，检查 graph revision 与报告一致，再沿用局部 RECHECK 范围和有界 Laya 建议入口。其返回值只有局部范围与建议；显式修复候选仍走 `previewProjectedRepair`，不能自动提交或执行。

目前测试只覆盖合成公共 Fact 更正、批次不匹配、伪造报告和过期图谱。DEP02 #162 已在 `readCompletedImpact(batchToken)` 提供固定消费方作用域的持久完成回执；生产组合、真实来源撤回证明和一次联合验收不在本工作包内。单纯搜索不到来源不能触发撤回。

`decideDurableFactProjection` 直接调用上述固定作用域的持久读回；未处理批次不给建议，其他消费方批次保留宿主 `NOT_FOUND`。调用方必须在重启后仍知道原投影回执及 token；`drain()` 的批数和水位不足以恢复这些身份。当前 cognition 包不另建状态库或事实流。
