# P5 同 Runtime 的持久认知状态

目标 profile 为 `huawei_ict_agentarts`。`cognition-p5-composition.js` 使用 P8 的 `application.createHostStateStore('proactive-receipts')` 注入 `p5-runtime-checkpoints.js`，不创建状态 anchor 任务、第二个 Runtime、数据库、调度器或模型。同步 get/set KV 已由现有 Runtime 按宿主用户和 domain 绑定 namespace。snapshot 的 `persistence` 为 `runtime_sqlite`。没有任何 key 或 metadata 成为模型执行授权。

设备服务的 `DeviceAnomalyCheckpointPort` 与会议的 `MeetingDecisionReceiptStorePort` 原样注入。设备配置 digest、各 source 连续计数、最后样本、最后真实通知时间、pendingDelivery 和最后 receipt 保存在同一个设备 checkpoint；恢复不重置冷却，不把 unknown 当未执行，不恢复采样或云授权。相同时间戳重放不会调用 chooser。会议 records 和查询索引是一个原子 checkpoint 替换，按 namespace/source/eventId 隔离。

第一次读取先迁移现有 `device-anomaly-checkpoint.json` 和 `meeting-receipts/receipt-*.json`，原文件完全保留。已存在 SQLite checkpoint 时不再重新导入旧文件。损坏会议文件阻止迁移，不能跳过丢失去重状态；设备内容仍由现有服务校验 configDigest/状态。本消费增量没有新 Schema 或数据库迁移；底层 host KV 迁移由 P8 提供。旧版本仍可读原文件，但不会看到本次新增 SQLite 状态；回退不能被当成新的执行许可或删除 pending 记录。

只有明确的最小离线宿主缺少 host KV API 时沿用旧文件端口，snapshot 为 `legacy_files`。生产不能据此声称 SQLite 恢复已验收。

组合增加可选 trusted `meetingExecutionPort`，优先于旧 `policyEvaluator`。生产 writer 应注入真实 Runtime/Policy/ToolGateway 的执行端口；旧 `createPolicyGuardedExecutionPort` 的 `allowed` 和直接 CAS 不构成工具 Evidence。端口未装配时会议仍为 proposal。calendar provider 写入与内部图谱修复分别验证，内部 applied 不代表真实日历已改期。

本次最小验证：最初 TaskRuntime checkpoint 方案的真实 SQLite 2/2 通过；随后按 P8 同 namespace host KV 接口调整，不再创建 anchor 任务，最终 KV 2-case 由 P8 在其新 Runtime 编译完成后执行。不得用旧方案通过替代最终 KV 验证。helper、组合及邮件验收函数语法检查通过，diff 检查通过。chooser 明确不可调用，没有模型、真实设备或云调用；不重复旧设备通知和 deadline 测试。
