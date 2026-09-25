# 当前接口目录与冻结登记

版本：1.3 · 日期：2026-09-22 · 基线提交：`d78613a226b5d490f8f2dd47f3e5c8236a3d7ec2`

协议负责人：`goo122` · 核心认知与 AgentArts 消费负责人：`zemeng` · 连接器消费负责人：`Potatos498`

## 1. 目的

本文是当前跨模块接口的唯一状态登记。它回答四个不同问题：

1. 接口形状是否已经冻结；
2. 本地生产实现是否存在并在握手中公布；
3. Fake、单元测试或真实外部服务分别验证了什么；
4. 尚未提供的能力应如何被消费者处理。

**冻结只承诺列出的接口形状和语义保持兼容，不代表盘古、AgentArts、第三方账号、语音或 Windows 执行已经可用。** Schema 中出现但生产 Runtime 未公布的 operation 一律按 `unavailable` 处理。

当前产品部署优先级由[华为 ICT AgentArts Competition Profile](../competition/HUAWEI_ICT_AGENTARTS_PROFILE.md)定义：只实施 `huawei_ict_agentarts` 比赛主路径，`local` 作为可选保留。这里的 **Core Runtime Profile 1 是接口冻结集合**，不是部署 profile；两者不能混同。Competition 架构已接受不代表 AgentArts 能力已可用或接口已冻结。

### 1.1 部署 profile 状态

| 部署 profile | 优先级 | 当前能力 | 接口规则 |
| --- | --- | --- | --- |
| `huawei_ict_agentarts` | 当前唯一优先实现与比赛验收路径 | 架构 accepted；离线 Runtime/工具循环为 `provisional`；真实云运行 `unavailable` | 已有端口与 Fake 仅供受控开发；正式证据不静默回退 |
| `local` | 可选保留 | 现有 Agent/Model 部分实现为 `provisional` | 不删除既有代码；新增 Local 能力不阻塞 Competition，也不计入比赛验收 |

## 2. 状态定义与冻结门槛

### 事实变化消费开发增量

PR #89～#91 已合入 provisional 的 `MemoryQueryPort`、`FactChangeFeedPort`、批次解析、
Fake、SQLite 提供者与可恢复投影。它区分 query snapshot、feed 水位、消费 checkpoint
和 graphRevision；读者不能任意 ack 序号。离线持久实现不证明真实事实来源或生产自动消费，
不得新增 wire capability 或宣称 frozen。详见
[MOD-28-FACT-CHANGE-FEED-01](../modules/MOD-28-FACT-CHANGE-FEED-01.md)。

| 状态 | 含义 | 消费者规则 |
| --- | --- | --- |
| `frozen` | 单一来源、实现、Fake/失败夹具、消费端验证、非作者评审和 CI 均有证据；外部行为会改变语义时还需真实目标验证 | 可以并行开发；同一主版本内只做向后兼容扩展 |
| `provisional` | 已有部分类型或实现，但仍缺消费验证、完整语义、真实关键路径或稳定注入边界 | 只用于受控开发；不得据此形成不可逆依赖 |
| `unavailable` | 没有生产提供者、没有能力公布，或关键接口尚未定义 | UI 显示不可用；调用返回 `UNSUPPORTED_CAPABILITY`；不得静默回退 Fake |
| `deprecated` | 已有替代接口并处于迁移期 | 只维持登记的兼容窗口，不新增消费者 |

冻结检查表：

- [x] JSON Schema 或公开 TypeScript 类型有单一来源；生成产物一致。
- [x] 对应生产实现存在并只公布实际支持的 capability。
- [x] Fake 和关键错误/取消/冲突路径可重复运行。
- [x] 至少一个真实消费端通过公开入口使用，没有读取私有数据库或 checkpoint。
- [x] 非作者评审与 CI 已通过，冻结基线可定位到提交。
- [ ] 对依赖外部平台且外部行为会影响接口语义的能力，完成真实目标系统闭环。

最后一项只适用于盘古工具调用、AgentArts、真实连接器、语音、Windows 操作等外部能力。它目前没有满足，因此这些能力不进入冻结集合。

## 3. 已冻结：Core Runtime Profile 1

冻结基线由 PR #1 的公共协议实现和 PR #34 的查询/恢复接口共同形成。PR #34 的精确实现提交为 `e5e20cad16566c6bdf821b7880efad96f0513ef1`，已由 `zemeng` 非作者批准，Foundation CI 通过并合并。PR #31 的 Runtime-owned 模型上下文也已合并，但它是内部编排策略，不属于本 profile 的冻结承诺。

### 3.1 消息与错误

| 接口 | 单一来源 | 冻结内容 | 运行时状态 |
| --- | --- | --- | --- |
| `Request` / `Response` / `Event` 信封 | `packages/contracts/schema/protocol.json` | `protocolVersion`、关联 ID、deadline、operation、结构化 data/error、`evidenceRefs` | `frozen` / 可用 |
| wire 主版本 | `PROTOCOL_VERSION = "1.0.0"` | 主版本不兼容拒绝；新增 operation 必须经能力发现 | `frozen` / 可用 |
| JSONL 帧 | `encodeFrame` / `FrameDecoder` | UTF-8、LF 分帧、最大 1 MiB、残帧拒绝 | `frozen` / 可用；不代表 Named Pipe 已实现 |
| 公共错误码 | contracts `Error.code` | 输入、版本、授权、范围、缺失、不支持、冲突、限流、超时、外部失败、结果未知、游标失效和取消的区分 | `frozen` / 可用 |

这里只冻结三类信封的公共字段和本 profile 所列 operation 的 payload/result；不把九类 Event 的所有业务 payload 或任何未公布 operation 一并冻结。错误码登记被冻结，但某个 capability 是否会产生特定错误仍由该 capability 的状态决定。

### 3.2 任务、会话和审批只读面

| operation | 冻结请求/结果 | 提供证据 | 可用性 |
| --- | --- | --- | --- |
| `system.handshake` | `supportedMajor`、客户端能力 → 协议版本、实际 capabilities、sessionRef | Runtime、Client、Fake、桌面 | 可用 |
| `task.submit` | goal、conversationId、附件引用、幂等键 → taskId/state/revision | Runtime 持久实现、Client/Fake | 可用 |
| `task.get` | taskId → TaskSnapshot | Runtime、Client/Fake | 可用 |
| `task.list` | conversationId/states/分页/固定水位 → 任务页 | PR #34 Runtime、Fake、Desktop 恢复 | 可用 |
| `conversation.list` | conversationId/分页/固定水位 → 会话及完整任务历史 | PR #34 Runtime、Fake、Desktop 恢复 | 可用 |
| `approval.list` | approvalId/taskId/state/分页 → 脱敏审批快照 | PR #34 Runtime、Fake、Desktop；不返回原始参数 | 可用；无工具审批时为空 |
| `task.cancel` | taskId/reason → cancelAccepted 与当前状态 | Runtime、Client/Fake | 可用；受理不等于已停止 |

冻结的 `TaskSnapshot` 基础字段为 taskId、state、revision、updatedAt、steps、evidenceRefs，以及当前可选的 goal、conversationId、attachmentRefs、resultSummary、error、cancelRequested。后续增加结构化结果只能作为兼容扩展；在新字段可用前，消费者不得解析 `resultSummary` 中的模型元数据尾缀形成新协议。

`task.list` 和 `conversation.list` 首次读取取得 `snapshotSequence`，续页保持同一水位，快照完成后从该水位读取任务事件。审批参数只暴露摘要哈希和固定的 `argumentSummary: "redacted"`。

### 3.3 全部 17 个 operation 状态矩阵

| operation | 契约状态 | 基础 Runtime 公布 | 条件公布 / 当前处理 |
| --- | --- | --- | --- |
| `system.handshake` | `frozen` | 是 | 返回实际 capability，不按 Schema 推测 |
| `task.submit` | `frozen` | 是 | 成功仅表示受理，自动分派由 Runtime Application 管理 |
| `task.get` | `frozen` | 是 | 返回持久 TaskSnapshot |
| `task.list` | `frozen` | 是 | 固定水位分页 |
| `conversation.list` | `frozen` | 是 | 固定水位分页；不是模型上下文策略 |
| `approval.list` | `frozen` | 是 | 返回持久脱敏记录；是否配置 ToolGateway 不改变只读查询能力 |
| `task.cancel` | `frozen` | 是 | `cancelAccepted` 不等于执行已停止 |
| `event.subscribe` | `provisional` | 是 | 需配合进程内 `readEvents`；完整生命周期未冻结 |
| `capability.list` | `provisional` | 否 | 仅配置 ToolGateway 时公布 |
| `authorization.respond` | `provisional` | 否 | 仅配置 ToolGateway 时公布 |
| `tool.invoke` | `provisional` | 否 | 仅配置 ToolGateway 时公布；真实模型工具链未验收 |
| `settings.get` | `unavailable` | 否 | Schema/Fake 已有；生产返回 `UNSUPPORTED_CAPABILITY` |
| `settings.update` | `unavailable` | 否 | Schema/Fake 已有；生产返回 `UNSUPPORTED_CAPABILITY` |
| `connector.connect` | `unavailable` | 否 | ConnectorHost 存在但未接 wire 路由 |
| `connector.disconnect` | `unavailable` | 否 | ConnectorHost 内部参数与 wire 账号语义尚未统一 |
| `voice.start` | `unavailable` | 否 | 只有 Schema；无 VoicePort 或生产提供者 |
| `voice.stop` | `unavailable` | 否 | 只有 Schema；“停止播报”不能替代 `task.cancel` |

### 3.4 九类事件状态矩阵

| event type | payload / 生产者状态 | 传输状态 |
| --- | --- | --- |
| `task.created` | Core Runtime payload `frozen` / 可产生 | `event.subscribe` 与 `readEvents` 仍为 `provisional` |
| `task.state_changed` | Core Runtime payload `frozen` / 可产生 | 同上 |
| `task.progress` | Core Runtime payload `frozen` / 可产生 | 同上 |
| `task.completed` | Core Runtime payload `frozen` / 可产生 | 同上 |
| `task.failed` | Core Runtime payload `frozen` / 可产生 | 同上 |
| `task.cancelled` | Core Runtime payload `frozen` / 可产生 | 同上 |
| `approval.requested` | `provisional` / 仅工具装配路径 | 同上 |
| `tool.completed` | `provisional` / 仅工具装配路径 | 同上 |
| `notification.created` | `unavailable` / 当前无生产通知模块 | 同上；不能因 Schema 存在显示为已接通 |

### 3.5 冻结范围之外

Core Runtime Profile 1 **不包含**模型工具调用、工具执行、持续授权、Evidence 内容、Artifact、设置管理、连接器账号、语音、MCP、Skills、知识/记忆、Windows Host、AgentArts 或打包生命周期。它们不得借用 wire 1.0.0 的版本号宣称已经冻结。

## 4. 已实现但尚未冻结

| 接口或实现 | 当前证据 | 未满足门槛 | 状态 |
| --- | --- | --- | --- |
| `event.subscribe`、`RuntimeApplication.readEvents`、Client `EventCursor` | 本地顺序、去重、缺口检测和桌面恢复测试 | 无 unsubscribe；服务端不裁剪事件，尚不产生真实 `CURSOR_EXPIRED`；未来跨进程通道未冻结 | `provisional` |
| `RuntimeApplicationTransport.send`、`activeTaskCount`、`close`、模型配置入口 | 进程内 Runtime Application 与 Desktop smoke | Host 健康/关闭/升级/未结束等待任务语义不完整 | `provisional` |
| `RuntimeApplication.submitHostToolTask`、`readHostToolTask` | DEP01 可信宿主单工具任务、SQLite checkpoint、既有审批/Policy/ToolGateway 恢复及定向测试 | 仅限宿主注入；Goal/Windows 等具体生产工具与 Desktop 消费、真实写入读回和非作者评审尚未完成；不公布新 wire capability | `provisional` |
| `authorization.respond` | SQLite 审批、revision、一次性授权、恢复测试 | 真实模型提出工具请求的闭环未验证；持续授权未实现 | `provisional` |
| `capability.list`、`tool.invoke` | ToolGateway、Policy、Runtime、Fake 工具闭环 | 真实盘古工具提案与真实工具读回未执行；核实入口不完整 | `provisional` |
| `RuntimeApplication.prepareCompetitionToolCatalog`、`assertCompetitionToolCatalogAllowed` | DEP05 按任务选择已注册 ToolDescriptor、显式结果出口和宿主动态可用性，持久绑定精简 Schema 并在提案前复核；写工具仍走本地 Policy 审批与结果核实 | AgentArts 初始目录载荷由 MOD-04B/30 另行接线与真实发布验收；目录本身不授予执行或外发结果权限 | `provisional` |
| `ToolDescriptor`、`RegisteredTool`、`ToolContext`、`ToolHost` | contracts 类型、FakeToolHost、生产 ToolGateway | Windows/MCP/Skill/第三方写工具尚未作为独立消费者验证 | `provisional` |
| `PolicyPort`、`AuthorizationPolicy` | 参数摘要、任务/工具/scope/期限/次数绑定及 SQLite 事务测试 | 跨任务持续授权、撤销管理面和真实宿主消费未完成 | `provisional` |
| `ModelProvider`、`ModelGateway`、Agent 执行循环 | Fake Provider、Mock fetch、离线 Agent/工具测试 | Agent 依赖具体 `ModelGateway`；真实盘古工具调用未通过 | `provisional` |
| `StructuredToolProvider` | 严格 JSON 解析、工具名/版本/参数校验单测 | 只是文字 JSON 提案适配器；没有真实盘古闭环，不是原生 function calling | `provisional` |
| `ConnectorPort`、`ConnectorHost`、`SecretStorePort.read` | 类型、FakeConnector、宿主单测 | 账号会话未持久化；wire connect/disconnect 未接 Runtime；无真实账号 | `provisional` |
| `StoragePort` | contracts 类型、FakeStorage | 只有同步 get/set/delete；没有 revision、事务、容量和失败语义 | `provisional` |
| `CoordinationPort`、`CloudAgentPort`、Competition Runtime/工具循环 | PR #36、#49：Fake、审批恢复和 continuation 离线循环 | Workflow 输入 #72 与载荷边界 #80 尚未进入 main；真实 deployment/version/trace、成功云 API、MCP/Skill 和目标系统读回未验证 | `provisional` |
| NotificationService | PR #27、#81：持久批次、ack、DST、摘要与毫秒窗口测试 | 无 Runtime wire 查询、Desktop 展示和真实通知通道 | `provisional` |

这些接口可以继续迭代，但消费者必须固定精确包版本或提交，并准备迁移；不能称为“冻结接口”。

## 5. 当前不可用接口与能力

下表中的条目可能已经在 Schema、设计文档或 UI 中出现，但当前没有满足要求的生产提供者。状态统一为 `unavailable`。

| 分组 | 不可用接口或能力 | 缺口 / 解锁条件 | 负责人 |
| --- | --- | --- | --- |
| 模型 | 盘古原生 function calling | Pangu Provider 明确声明 `toolCalling=false`；需真实部署能力探测和闭环验收 | MOD-04A `goo122` |
| 模型 | 盘古文字 JSON 工具提案的真实闭环 | 手动脚本默认 SKIPPED；需真实盘古→提案→审批→工具→读回→回答证据 | MOD-04A/04B |
| 模型 | 流式、视觉、稳定结构化输出 | 当前 Pangu Provider 均声明不支持 | MOD-04A `goo122` |
| Agent | 真实 AgentArts deployment/version/trace 与多 Agent 结果 | provisional Competition 适配和 Fake 已集成；真实云端成功路径、结果解析和完整 trace 未验收 | MOD-29～32 `zemeng` |
| 结果 | 结构化 `TaskResult` | 当前仅 `resultSummary` 字符串；需正文、模型、usage、verification、plan/evidence 分离 | MOD-02/03 `goo122` |
| 会话 | 显式创建、重命名、归档、删除、重试关联 | 当前只有 `task.submit` 携带 conversationId 和只读列表 | MOD-02/03 `goo122` |
| 调度 | 循环规则、唤醒计时器、睡眠恢复公共 API | Runtime 只有内部一次性调度，没有 wire operation | MOD-03 `goo122` |
| Evidence | 公开 list/get/content 与提交端口 | Runtime 只有内部 `readEvidence(taskId)`，没有 wire operation 或访问控制 | MOD-03/05 `goo122` |
| Artifact | 创建、读取、过期、释放、分片和背压 | 仅有 attachment/artifact 引用原则，没有服务和 Fake | MOD-01/02/05 `goo122` |
| 设置 | 生产 `settings.get` / `settings.update` | Schema 和 Fake 存在；生产 Runtime 不公布也不处理 | MOD-02/03 `goo122` |
| 连接器 | 生产 `connector.connect` / `connector.disconnect` wire 路由 | Schema 与 ConnectorHost 存在，但 Runtime 未公布/分派，账号语义不一致 | MOD-05 `goo122` |
| 凭据 | SecretStore save/replace/delete/status 与迁移 | 只有 ConnectorHost 私有 read 端口；无公共管理面或 Windows 适配 | MOD-05 `goo122`、MOD-16 `zemeng` |
| 通知 | Runtime 列表/恢复、已读/隐藏、策略配置与 Desktop 展示 | NotificationService 已集成但尚未接 wire 或 Desktop；`notification.created` 仍无生产发布链 | MOD-23 `Potatos498`、MOD-13 `zemeng` |
| 语音 | `voice.start` / `voice.stop`、ASR/TTS 流和设备适配 | session/wake/transcript consumer 仍在冲突的堆叠分支，main 无生产提供者；真实供应商、流协议和设备验收未提供 | MOD-14/15 `zemeng` |
| 知识 | `KnowledgePort`、Obsidian/LLM Wiki | PR #93～#95、#97、#98 已合并：provisional `KnowledgePort`、脱机及 Obsidian 只读适配器、显式 `knowledge.search` ToolGateway/Policy 接线、公开演示资料的 Fake Competition 审批链已完成离线验收。真实 Vault 授权/验收、生产 Runtime 注册、可安装插件、私人结果云端发送控制和 LLM Wiki 仍 unavailable | MOD-08 `goo122` |
| 记忆 | 生产 `MemoryQueryPort` / `FactChangeFeed` 提供者、确认消费、修正/删除 | PR #89、#90、#91 已合并 provisional 端口、Fake、SQLite 恢复与确认后原子激活投影；生产 Runtime capability、真实来源和删除验收仍未提供 | MOD-09 `goo122` |
| MCP | 本地 MCP Host/Client 端口 | 对应 package、注册适配和真实调用未提供 | MOD-06 `goo122` |
| Skills | 本地 Skill 加载/版本/执行端口 | 对应 package 和闭环未提供 | MOD-07 `goo122` |
| 决策 | 目标/事实/决策图谱的生产集成 | main 已有版本图及 SQLite/Fake 原子 `appendBatch`；自动事实投影、真实事实来源与生产消费未完成 | MOD-27 `zemeng`，存储 `goo122` |
| 认知 | 事件驱动的完整计划修复 | main 已有离线影响分析与显式修复预览/提交，并通过原子 `appendBatch` 写入；事实变化流、自动投影和真实 Evidence 未完成 | MOD-28 `zemeng` |
| AgentArts | Competition Profile 的真实身份、Agent/Workflow、MaaS/模型、知识、MCP/Skill、工具提案与多 Agent | main 已有 provisional adapter 和离线工具循环；Workflow 输入仍在堆叠分支，没有成功 deployment/API/trace 与真实 MCP/Skill 读回 | MOD-29～31 `zemeng` |
| AgentArts | Competition 发布、API、trace、评估、成本、回滚和端到端证据 | 无云资源读回、本地 Policy/ToolGateway 闭环或 profile 防静默回退证据 | MOD-32 `zemeng` |
| Windows | Named Pipe、DesktopActionPort、资源锁、用户接管 | 对应 Host/Client package 与真实应用验收未提供 | MOD-16 `zemeng` |
| TraceGuard | 公开工具和 Evidence/恢复端口 | 仓库适配 package 未提供 | MOD-17 `zemeng` |
| 编程 | 正文读取、patch、command、artifact 端口 | PR #83 已集成受限 `workspace.list` 与 `workspace.read_text`；两者仍为 provisional，patch、command、artifact 和完整隔离验收未提供 | MOD-18 `zemeng` |
| 分发 | 生产装配、安装、升级、卸载生命周期契约 | 无安装包与隔离安装证据 | MOD-19 `zemeng`、根装配 `goo122` |

生产 Runtime 对 Schema 已知但未公布的 operation 必须返回 `UNSUPPORTED_CAPABILITY`。管理界面可以展示规划项，但必须显示“不可用”，不能通过读取配置文件、私有数据库或启用 Fake 来伪装能力。

## 6. 已集成增量与下一冻结包

### 6.1 Competition 执行面（provisional）

PR #36、#49 已进入 main，提供文字 Coordination/CloudAgent 与 Runtime 审批工具循环。Workflow 输入 #72 和总载荷边界 #80 只合并到堆叠分支，尚未进入 main。现有 Fake 证据不包含成功真实 AgentArts 调用、deployment/version/trace、MCP/Skill 或目标系统读回。

### 6.2 世界状态与认知面（provisional）

main 已包含版本化 CoordinationStore、SQLite/Fake `AtomicCoordinationStorePort.appendBatch`、事务 revision 校验与 rollback，以及通过该原子端口执行的显式修复预览/提交；PR #89～#91 已合并 provisional Memory 端口/Fake、SQLite 查询与 delivery checkpoint、Goal 侧未生效暂存及确认后原子激活投影。生产自动消费、真实事实来源、删除和 AgentArts/Evidence 闭环仍未交付。

### 6.3 桌面、语音、工具与通知增量（provisional）

PR #54、#77、#81 已进入 main，分别补充取消受理、过期审批展示和通知时间精度；PR #83 已集成受限 `workspace.list` 与 `workspace.read_text`。旧 #63、#65 已关闭且未直接进入 main；语音/唤醒、转写消费和合成语音记录仍只存在于 #61 及其堆叠分支。

### 6.4 下一冻结候选

PR #84 已将这条离线 Competition 消费链合入 main：Runtime → Fake AgentArts → `workspace.read_text` proposal → waiting_approval → allow_once → ToolGateway → continuation → 最终回答/Evidence。该链仍保持 provisional/mock；只有真实 AgentArts 部署/API/trace 与目标系统读回完成，才重新评估相关外部语义。

| 待交付接口 | 语义提出方 | 公共类型/宿主提供方 | 下一验收 |
| --- | --- | --- | --- |
| Competition 工具消费链 | `zemeng` | `goo122` 维护 Runtime/Policy/Tool 边界 | PR #84 与 #86 已进入 main；离线 Fake 链保持 provisional，真实 AgentArts 验收按当前安排暂缓 |
| `EvidencePort` / `ArtifactPort` | 双方共同给出用例 | `goo122` | 越权、过期、超限、乱序、取消、敏感内容不入日志 |
| 真实 AgentArts adapter 验收 | `zemeng` | `zemeng`，`goo122` 复核本地终态边界 | deployment/version/trace、成功 API、失败读回、无静默 Local 回退 |
| 事实流投影与确认 | `zemeng` 提供消费语义 | `goo122` | 精确 FactRef 映射、事务 Inbox、待重检记录、崩溃重放和提交后 provider 确认 |
| `ModelPort` 最小稳定面 | 可选 Local Agent 提供消费场景 | `goo122` | 可选后续；不阻塞 Competition Profile |

## 7. 兼容与变更规则

### MOD-09B-MEMORY-PORTS-01 开发登记（2026-09-22）

`@personal-agent/memory` 公开 provisional `MemoryQueryPort`：`listCurrent`、`listHistory`、
`getVersion`，并由 `/testing` 提供显式 `FakeMemoryHost`。可信宿主预绑定 namespace 和允许的
sensitivity 集合；消费者无 namespace 选择、写入或出机许可入口。固定水位与不透明分页 token
仅存在于 Fake 内存，精确版本隐藏/不存在统一拒绝，返回副本隔离；详见
[工作包记录](../modules/MOD-09B-MEMORY-PORTS-01.md)。
同一包还公开 provisional `FactChangeFeedPort`、批次边界解析与 host-bound Fake 确认语义。
这些类型和离线 Fake 本身不代表生产事实库可用。PR #90 后，独立 SQLite 提供者、
持久确认和重启恢复已进入 main；Runtime 注入、Goal/认知投影、真实来源、删除及私人数据
验收仍未交付，运行能力继续 unavailable。无新增 wire Schema 或 capability；完整消费验收前不得冻结。

### MOD-09C-MEMORY-SQLITE-01 开发登记（2026-09-22）

PR #90 已由非作者批准并合并为 `f56059a`。`@personal-agent/memory/sqlite` 增加专用 SQLite 适配器：事实版本与变化事件
同事务追加，query snapshot/cursor、未确认批次、checkpoint 和幂等回执可跨重启恢复。
它复用 `@personal-agent/storage` 的有序迁移与 WAL，数据库文件不得与其他独立迁移序列共用。

本片仍不公布 Runtime capability，也不把端口升级为 frozen。delivery checkpoint 的持久 CAS
不等于 MOD-27/28 的 graph/impact 投影与确认同事务；真实 ingest、物理删除、保留/备份策略、
自动认知投影和私人数据验收继续 unavailable。详见
[MOD-09C 工作包](../modules/MOD-09C-MEMORY-SQLITE-01.md)。

### MOD-09D-MEMORY-GOAL-PROJECTION-01 开发登记（2026-09-22）

PR #91 已经非作者评审、Foundation CI 通过并合并；采用未生效暂存 → Memory provider
确认 → 本地原子激活：事实节点、精确 FactRef → NodeRef 映射、event/batch 去重、待重检
记录和本地回执同事务提交。确认拒绝不暴露旧 scope 事实；确认后、激活前中断从暂存恢复。
它不宣称跨数据库原子。修复后的 Runtime 68/68、架构门禁 3/3 与根 `npm run check`
已通过；本记录只覆盖离线与合成数据。
该入口仍为 provisional，未注册生产 composition、自动调度或 capability；详见
[MOD-09D 工作包](../modules/MOD-09D-MEMORY-GOAL-PROJECTION-01.md)。

1. `frozen` 项删除字段、改变字段含义、收窄原有合法输入或新增消费者无法处理的必需状态，必须升级不兼容版本。
2. 新增可选字段和新 operation 可以在 wire 1.x 中交付，但必须先通过 handshake/capability 公布；旧消费者可以忽略。
3. `provisional` 项仍需记录精确提交、迁移说明和消费影响，不能无提示破坏。
4. `unavailable` 项不得占用生产 capability；实现完成后按冻结检查表重新评估，不能直接从文档规划跳到 `frozen`。
5. Fake 只证明接口和状态分支。真实盘古、AgentArts、账号、Windows 或外部写入能力必须保留独立的 `conditional`/`verified` 证据。

## 8. 当前结论

### MOD-16-SYSTEM-OBSERVATION-01 开发登记（2026-09-17）

`@personal-agent/windows-client` 本机聚合状态只读工具正在独立工作包中实现，消费基线
`72cc76b` 的 `RegisteredTool`/`ToolContext`，不新增 wire operation，也不自动公布生产 capability。
范围仅 CPU、内存和 uptime 等必要聚合观测；不依赖独立 TraceGuard 项目，不读取身份、
进程命令行、文件或网络内容。PA-018 治理/恢复按用户修订排除。
提供者、Fake 与实际本机读取验收按 [模块记录](../modules/MOD-16-SYSTEM-OBSERVATION-01.md) 分别登记；
Competition 工具提案/Runtime Application/Desktop 装配仍未由此项交付，运行能力保持 unavailable。
本包接口保持 provisional，非作者评审前不冻结。

截至 2026-09-24，**冻结范围仍只有 Core Runtime Profile 1 的消息、任务、会话与审批只读查询子集；不冻结整套协议、外部模型工具调用或 AgentArts 编排。** main 中已有 Competition 的离线 Coordination/审批工具循环、版本图、原子存储、显式修复预览/提交、受限工作区读取、公开演示知识检索，以及 provisional 的 SQLite 事实查询/变化流与可恢复投影；生产自动消费、Runtime Memory capability 和语音消费仍未进入 main。

真实 AgentArts deployment/API/trace、目标系统工具读回、完整 Evidence、真实语音设备和外部事实提供者仍 `unavailable`。Fake、合成评估、HTTP 200、配置成功或平台截图都不能提升这些状态；正式比赛路径不得静默回退 Local。
