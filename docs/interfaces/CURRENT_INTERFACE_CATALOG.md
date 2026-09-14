# 当前接口目录与冻结登记

版本：1.2 · 日期：2026-09-14 · 基线提交：`cdb69a265b9bfa42ee32311b8183749376c671dc`

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
| `huawei_ict_agentarts` | 当前唯一优先实现与比赛验收路径 | 架构 accepted；文字 HTTP/Runtime/Desktop 离线首片 `provisional`；真实云运行 `unavailable` | 继续交付 Tool/Evidence 端口与真实部署证据；正式路径不静默回退 |
| `local` | 可选保留 | 现有 Agent/Model 部分实现为 `provisional` | 不删除既有代码；新增 Local 能力不阻塞 Competition，也不计入比赛验收 |

## 2. 状态定义与冻结门槛

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
| `authorization.respond` | SQLite 审批、revision、一次性授权、恢复测试 | 真实模型提出工具请求的闭环未验证；持续授权未实现 | `provisional` |
| `capability.list`、`tool.invoke` | ToolGateway、Policy、Runtime、Fake 工具闭环 | 真实盘古工具提案与真实工具读回未执行；核实入口不完整 | `provisional` |
| `ToolDescriptor`、`RegisteredTool`、`ToolContext`、`ToolHost` | contracts 类型、FakeToolHost、生产 ToolGateway | Windows/MCP/Skill/第三方写工具尚未作为独立消费者验证 | `provisional` |
| `PolicyPort`、`AuthorizationPolicy` | 参数摘要、任务/工具/scope/期限/次数绑定及 SQLite 事务测试 | 跨任务持续授权、撤销管理面和真实宿主消费未完成 | `provisional` |
| `ModelProvider`、`ModelGateway`、Agent 执行循环 | Fake Provider、Mock fetch、离线 Agent/工具测试 | Agent 依赖具体 `ModelGateway`；真实盘古工具调用未通过 | `provisional` |
| `StructuredToolProvider` | 严格 JSON 解析、工具名/版本/参数校验单测 | 只是文字 JSON 提案适配器；没有真实盘古闭环，不是原生 function calling | `provisional` |
| `CoordinationPort`、`CloudAgentPort`、`CompetitionCoordinator` | PR #36/#42 的文字端口、Fake、取消/deadline、Runtime 注入与防静默回退测试 | 结果仅允许文字；PR #36 缺正式非作者评审；工具、deployment/version/trace/usage 未进入端口 | `provisional` |
| `AgentArtsCloudAgentPort` 与 Competition Runtime/Desktop 装配 | PR #41/#43 的严格 HTTP 响应校验、mock-fetch、配置选择和 Desktop smoke | 尚无真实项目、身份、部署/API/trace/usage 读回；不能作为真实 AgentArts 可用证据 | `provisional` |
| `ConnectorPort`、`ConnectorHost`、`SecretStorePort.read` | 类型、FakeConnector、宿主单测 | 账号会话未持久化；wire connect/disconnect 未接 Runtime；无真实账号 | `provisional` |
| `StoragePort` | contracts 类型、FakeStorage | 只有同步 get/set/delete；没有 revision、事务、容量和失败语义 | `provisional` |

这些接口可以继续迭代，但消费者必须固定精确包版本或提交，并准备迁移；不能称为“冻结接口”。

## 5. 当前不可用接口与能力

下表中的条目可能已经在 Schema、设计文档或 UI 中出现，但当前没有满足要求的生产提供者。状态统一为 `unavailable`。

| 分组 | 不可用接口或能力 | 缺口 / 解锁条件 | 负责人 |
| --- | --- | --- | --- |
| 模型 | 盘古原生 function calling | Pangu Provider 明确声明 `toolCalling=false`；需真实部署能力探测和闭环验收 | MOD-04A `goo122` |
| 模型 | 盘古文字 JSON 工具提案的真实闭环 | 手动脚本默认 SKIPPED；需真实盘古→提案→审批→工具→读回→回答证据 | MOD-04A/04B |
| 模型 | 流式、视觉、稳定结构化输出 | 当前 Pangu Provider 均声明不支持 | MOD-04A `goo122` |
| Agent | Competition 工具提案、执行结果续跑与最终回答契约 | 当前 Coordination 结果只允许文字；需经本地 Policy/Approval/ToolGateway 执行并把受信结果回传云端，不能让云端设置本地终态 | MOD-04B/MOD-30 `zemeng`、MOD-05 `goo122` |
| 结果 | 结构化 `TaskResult` | 当前仅 `resultSummary` 字符串；需正文、模型、usage、verification、plan/evidence 分离 | MOD-02/03 `goo122` |
| 会话 | 显式创建、重命名、归档、删除、重试关联 | 当前只有 `task.submit` 携带 conversationId 和只读列表 | MOD-02/03 `goo122` |
| 调度 | 循环规则、唤醒计时器、睡眠恢复公共 API | Runtime 只有内部一次性调度，没有 wire operation | MOD-03 `goo122` |
| Evidence | 公开 list/get/content 与提交端口 | Runtime 只有内部 `readEvidence(taskId)`，没有 wire operation 或访问控制 | MOD-03/05 `goo122` |
| Artifact | 创建、读取、过期、释放、分片和背压 | 仅有 attachment/artifact 引用原则，没有服务和 Fake | MOD-01/02/05 `goo122` |
| 设置 | 生产 `settings.get` / `settings.update` | Schema 和 Fake 存在；生产 Runtime 不公布也不处理 | MOD-02/03 `goo122` |
| 连接器 | 生产 `connector.connect` / `connector.disconnect` wire 路由 | Schema 与 ConnectorHost 存在，但 Runtime 未公布/分派，账号语义不一致 | MOD-05 `goo122` |
| 凭据 | SecretStore save/replace/delete/status 与迁移 | 只有 ConnectorHost 私有 read 端口；无公共管理面或 Windows 适配 | MOD-05 `goo122`、MOD-16 `zemeng` |
| 通知 | 列表/恢复、已读/隐藏、策略配置 | 只有 `notification.created` Schema，无生产模块或查询 operation | MOD-23 `Potatos498`、MOD-13 `zemeng` |
| 语音 | `voice.start` / `voice.stop` 和 ASR/TTS 流 | 只有 Schema 声明，无 VoicePort、生产实现或流协议 | MOD-14/15 `zemeng` |
| 知识 | `KnowledgePort`、Obsidian/LLM Wiki | 对应 package 和 Fake 未提供 | MOD-08 `goo122` |
| 记忆 | `MemoryQueryPort`、`FactChangeFeed`、修正/删除 | MOD-09A 场景、合成夹具与自检已随 PR #45 合并；package、公开类型、存储、Fake 和真实删除仍未提供 | MOD-09 `goo122` |
| MCP | 本地 MCP Host/Client 端口 | 对应 package、注册适配和真实调用未提供 | MOD-06 `goo122` |
| Skills | 本地 Skill 加载/版本/执行端口 | 对应 package 和闭环未提供 | MOD-07 `goo122` |
| 决策 | 目标/事实/决策图谱的生产集成 | PR #37/#38/#40 已集成版本图、SQLite 存储与离线持久消费者；真实事实输入、Runtime/AgentArts 接线和删除未完成 | MOD-27 `zemeng`，存储 `goo122` |
| 认知 | 事件驱动的完整计划修复 | PR #37 已集成离线影响分析与显式候选差异；持久事件消费和真实验收未完成 | MOD-28 `zemeng` |
| AgentArts | Competition Profile 的身份、Agent/Workflow、MaaS/模型、知识、MCP/Skill、工具提案与多 Agent | 文字 HTTP Adapter 与 Runtime/Desktop 离线接线已集成；仍无真实项目、deployment/API/trace、工具闭环或多 Agent 读回 | MOD-29～31 `zemeng` |
| AgentArts | Competition 发布、API、trace、评估、成本、回滚和端到端证据 | 无云资源读回、本地 Policy/ToolGateway 闭环或 profile 防静默回退证据 | MOD-32 `zemeng` |
| Windows | Named Pipe、DesktopActionPort、资源锁、用户接管 | 对应 Host/Client package 与真实应用验收未提供 | MOD-16 `zemeng` |
| TraceGuard | 公开工具和 Evidence/恢复端口 | 仓库适配 package 未提供 | MOD-17 `zemeng` |
| 编程 | Workspace/patch/command/artifact 端口 | 仓库 package 和隔离验收未提供 | MOD-18 `zemeng` |
| 分发 | 生产装配、安装、升级、卸载生命周期契约 | 无安装包与隔离安装证据 | MOD-19 `zemeng`、根装配 `goo122` |

生产 Runtime 对 Schema 已知但未公布的 operation 必须返回 `UNSUPPORTED_CAPABILITY`。管理界面可以展示规划项，但必须显示“不可用”，不能通过读取配置文件、私有数据库或启用 Fake 来伪装能力。

## 6. 新分工需要的接口冻结包

### COMPETITION-PORTS-01 分支增量

PR #36 在 `@personal-agent/coordination` 新增 provisional 的文字
CoordinationPort / CloudAgentPort 和 testing Fake，Runtime Application 可显式注入；
PR #42 完成 CompetitionCoordinator 消费。PR #36 已合并为 `5944061`，但尚缺正式
非作者评审，不能冻结。当前只传 taskId/revision/goal/deadline/signal，只返回
kind/text/verification；工具提案、deployment/version/trace、usage、世界状态、云端续跑
与出机同意尚未交付。详见[工作包](../modules/COMPETITION-PORTS-01.md)。

### COMPETITION-HTTP-01 已集成离线首片

PR #41 提供严格校验的 AgentArts 文字 HTTP Adapter，PR #43 将其接入 Runtime/Desktop
Competition profile；两者均已批准合并。现有证据只覆盖 mock-fetch、错误脱敏、取消/
deadline、配置选择和离线 smoke。没有真实项目、身份、Agent/Workflow、deployment、
API/trace/usage 读回，也没有工具提案与执行结果续跑，因此保持 provisional。

### COORDINATION-STORE-01 已集成增量

基于 PR #37 的 `41ea79d`，PR #38（合并提交 `87ee444`）在 `@personal-agent/goals/store` 提供
provisional CoordinationStorePort、Fake，Runtime 提供绑定命名空间的 SQLite 适配。
显式 provision/bind、read(revision?) 与事务 append(expectedRevision,node) 详见
[工作包](../modules/COORDINATION-STORE-01.md)。该存储首片已由非作者评审并集成，但尚缺真实消费者纵向验收，因此保持 provisional；不增加 wire capability；
MemoryQueryPort、FactChangeFeed、AgentArts 和真实数据生产授权仍 unavailable。

### MOD-09A-WORLD-STATE-CONTRACT 准备

当前仅在[工作包](../modules/MOD-09A-WORLD-STATE-CONTRACT.md)登记查询、变化流、
敏感范围、修正/撤回/删除和合成会议夹具。该准备不定义公共方法签名，不增加 package、
exports、Schema operation、数据库迁移或 capability；MemoryQueryPort 与
FactChangeFeed 继续保持 unavailable，直到消费语义确认并完成实现、Fake、重启/游标
测试和非作者评审。

以下是完整接口的待交付要求；已提供的文字与存储子集以上述增量为准，不代表完整接口冻结：

| 待交付接口 | 语义提出方 | 公共类型/宿主提供方 | 最小验收 |
| --- | --- | --- | --- |
| `CoordinationPort` | `zemeng` | 类型由消费模块拥有；Runtime 由 `goo122` 注入 | Competition 为默认实现目标；FakeCoordination 可让 Runtime 独立跑任务；真实实现不直接改 TaskRuntime |
| `CloudAgentPort` | `zemeng` | `zemeng` | 第一优先；Fake AgentArts 与真实 deployment/version/trace/提案/usage/error；云端不能携带本地授权或设置任务终态 |
| `MemoryQueryPort` / `FactChangeFeed` | `zemeng` 提供事实消费语义 | `goo122` | 游标、revision、来源、撤回、敏感范围和跨重启 Fake |
| `CoordinationStorePort` | `zemeng` | `goo122` 提供命名空间存储适配 | expectedRevision、事务、冲突和隔离测试 |
| `ToolExecutionPort` | `zemeng` 消费 | `goo122` | 保持 pending/confirmed/unknown、授权绑定和读回核实 |
| `EvidencePort` / `ArtifactPort` | 双方共同给出用例 | `goo122` | 越权、过期、超限、乱序、取消、敏感内容不入日志 |
| `ModelPort` 最小稳定面 | 可选 Local Agent 提供消费场景 | `goo122` | 可选后续；Agent 只依赖接口而非 `ModelGateway`；不阻塞 Competition Profile |

交付顺序：Competition 文字 Coordination/CloudAgent 与离线 HTTP/Runtime/Desktop 消费首片已完成；下一步提交工具提案、ToolExecution/Approval、结果续跑与 Evidence 最小语义、公开类型/Fake 和消费者测试，同时补真实 AgentArts deployment/API/trace 读回。Memory/Goal/Event 与完整评估在此基础上扩展。Local ModelPort 为可选后续。

## 7. 兼容与变更规则

1. `frozen` 项删除字段、改变字段含义、收窄原有合法输入或新增消费者无法处理的必需状态，必须升级不兼容版本。
2. 新增可选字段和新 operation 可以在 wire 1.x 中交付，但必须先通过 handshake/capability 公布；旧消费者可以忽略。
3. `provisional` 项仍需记录精确提交、迁移说明和消费影响，不能无提示破坏。
4. `unavailable` 项不得占用生产 capability；实现完成后按冻结检查表重新评估，不能直接从文档规划跳到 `frozen`。
5. Fake 只证明接口和状态分支。真实盘古、AgentArts、账号、Windows 或外部写入能力必须保留独立的 `conditional`/`verified` 证据。

## 8. 当前结论

截至 2026-09-14，**适合冻结的是 Core Runtime Profile 1 的消息、任务、会话与审批只读查询子集；不适合冻结整套协议、模型工具调用或 Agent 编排接口。** 产品当前只实施 Huawei ICT AgentArts Competition Profile；Local Profile 仅留存现有代码、当前不新增。该范围决定不改变接口证据状态。

盘古当前没有已验证的原生工具调用，文字 JSON 工具提案也未完成真实闭环。因此 MOD-04/05 的离线实现继续保持 `review`，Local Model/Agent/Tool 相关接口保持 `provisional`。Competition 的文字 Coordination/CloudAgent、HTTP/Runtime/Desktop 离线首片、版本图/持久影响分析和 MOD-09A 契约夹具已集成但未冻结。真实 AgentArts 资源、工具闭环、统一世界状态接口、事实流与完整认知集成仍 `unavailable`。
