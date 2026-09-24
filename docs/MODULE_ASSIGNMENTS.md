# 模块分工与独立交付清单

版本：0.6 · 日期：2026-09-09 · 状态：只实施 Huawei ICT AgentArts Competition Profile；Local Profile 可选留存

本文件是未来工作负责人、文件所有权和交付边界的唯一登记处。[Competition Profile](competition/HUAWEI_ICT_AGENTARTS_PROFILE.md) 定义当前优先参赛路径，[PRD](PRD.md) 定义需求，[公共开发协议](DEVELOPMENT_PROTOCOL.md) 定义互通语义，[当前接口目录](interfaces/CURRENT_INTERFACE_CATALOG.md) 决定接口是否冻结或可用，[ROADMAP](ROADMAP.md) 维护执行状态。

## 1. 人员与决策权

| GitHub 用户名 | 当前职责 |
| --- | --- |
| goo122 | 工程与存储底座、公共协议、TaskRuntime、ModelGateway/Provider、本地 Policy/工具/MCP/Skills、知识与记忆 |
| zemeng | 主 Agent 与核心认知架构、桌面/语音/Windows/TraceGuard/编程/分发、目标决策图谱、持续认知、AgentArts |
| Potatos498 | 待办、日历、邮件、订阅、通知、搜索、天气、微信与社交连接器；保留 MOD-20～26 的长期目录所有权，当前工作顺序见 §5 |

产品负责人决定当前只实施华为 ICT AgentArts Competition Profile，通用 Local Profile 仅留存现有代码。核心认知、Goal/Decision/Plan 语义、Competition Profile 及 AgentArts 本地—云边界由 zemeng 负责；公共 Schema、根配置、迁移、锁文件和根装配由 goo122 维护。历史 PR 的作者、评审者和 Evidence 按事实保留，不能因新分工改写。

2026-09-24 的 MVP 协作优先级不改变上述模块所有权：goo122 优先复核 #106 的最终 head 并裁定 #88 的公共接线边界；zemeng 统筹的 AgentArts、Runtime/本地修复、Laya 与 Desktop 实际整合继续由现有 A/B/C/D2 工作包推进。Potatos498 今日只处理 §5 的业务侧文档工作，不承接共享 Runtime、SecretStore 或根装配。

## 2. 共同所有权规则

- 每个工作包只有一个实现负责人。跨负责人只通过公开 package exports 和接口目录中的冻结接口协作。
- 未标记 frozen 的接口必须固定精确提交并使用 Fake；unavailable 能力不得由消费者猜字段、读取私有实现或静默回退。
- goo122 维护 packages/contracts、根 package/lock、公共迁移与根 composition；zemeng 提供新认知语义和消费者测试，由 goo122 发布需要进入公共 wire 的部分。
- 新模块目录是规划边界，不因本文出现而创建空包。模块负责人开工时创建入口、README、测试和 Fake。
- apps/desktop 按功能子目录分工；Renderer 不导入 Runtime、模型、数据库、Node/Shell 或连接器。
- 一个 PR 只覆盖一个可审查工作包；共享文件通过单独集成 PR 修改，保留其他协作者及用户未提交内容。
- 新工作默认服务 `huawei_ict_agentarts`；Local Profile 只有被明确列入范围时才新增能力。保留现有 Local 代码不等于当前必须为它扩展接口或通过比赛验收。

## 3. goo122：底座、模型、工具、知识与记忆

| ID | 模块 / 需求 | 独占目录 | 依赖 | 独立交付与验收 |
| --- | --- | --- | --- | --- |
| MOD-01 | 工程与存储底座 / PA-004 | 根配置、packages/storage、scripts/dev、.github/workflows | 无 | 可启动工程；有序迁移保留数据；根构建和 CI 可复现 |
| MOD-02 | 公共协议与联调 SDK / PA-004、PA-023 | packages/contracts、packages/client、packages/testkit | MOD-01 | Schema、生成类型、Client、Fake 和兼容记录一致；逐接口登记冻结状态 |
| MOD-03 | 任务与事件核心 / PA-004、PA-009 | apps/runtime 的任务、事件、调度核心和公共 Host 边界 | MOD-01、02 | 持久任务、恢复、取消、幂等和未知结果；通过 FakeCoordination 可独立运行 |
| MOD-04A | 可选 Local Profile 的 ModelGateway 与模型供应商适配 / PA-003、PA-012 | packages/models | MOD-02、03 | 保留 ModelGateway、能力探测、Fake/Unavailable/Provider；当前只做 Competition Profile 明确需要的兼容工作 |
| MOD-05 | 权限、工具与连接器宿主 / PA-023 | packages/policy、packages/tool-gateway、packages/connector-host | MOD-02、03 | 越权拒绝、一次性授权事务消费、结果未知待核实、受限凭据注入 |
| MOD-06 | 本地 MCP 适配 / PA-005 | packages/mcp | MOD-02、05 | 工具发现、调用、断连；Fake 和至少一个真实本地 MCP 分开验收 |
| MOD-07 | 本地 Skills 加载与运行 / PA-006 | packages/skills | MOD-02、05 | Skill 版本、启停、受控工具调用和执行记录；不能自行授权 |
| MOD-08 | 知识库、Obsidian 与 LLM Wiki / PA-008 | packages/knowledge、plugins/obsidian | MOD-01、02、05 | KnowledgePort、来源引用、冲突写入和测试 Vault；真实 Vault 单独验收 |
| MOD-09 | 时序个人记忆与流程学习 / PA-020、PA-024 | packages/memory、packages/learning | MOD-01、02、07、08 | MemoryQueryPort、FactChangeFeed、修正/撤回/删除、来源和版本；不修改 Goal/Task |

goo122 必须让上述模块在没有真实 Desktop、AgentArts 或 zemeng 私人环境时，通过 FakeCoordinationPort 和固定夹具运行。

## 4. zemeng：核心认知、桌面执行与 AgentArts

| ID | 模块 / 需求 | 独占目录 | 依赖 | 独立交付与验收 |
| --- | --- | --- | --- | --- |
| MOD-04B | Competition Coordination 与可选 Local Agent / PA-003、PA-012 | packages/coordination、packages/agents | MOD-02、03、05；Local 才依赖 04A | Competition 路径只消费 CloudAgent/Memory/Tool 端口；既有 Local Agent 代码保留为可选 baseline |
| MOD-10 | 模型与 AgentArts 能力研究 / PA-022、PA-026 | docs/research/model-training、docs/research/agentarts | 供应商能力与数据条件 | 给出来源、实验、成本和条件结论；不把提示或记忆称为参数训练 |
| MOD-11 | 桌面外壳与桥接 | apps/desktop/electron、apps/desktop/src/app | MOD-02 | 窗口、托盘、受控 IPC；Renderer 无系统权限 |
| MOD-12 | 悬浮球与展开面板 / PA-001 | apps/desktop/src/features/orb、apps/desktop/src/features/conversation | MOD-02、11 | ORB、单面板、多屏、取消与状态映射；真实桌面合成验收 |
| MOD-13 | 管理后台与授权界面 / PA-002、PA-023 | apps/desktop/src/features/admin、apps/desktop/src/ui | MOD-02、11 | 能力、任务、审批、配置界面；未公布能力明确显示不可用 |
| MOD-14 | 语音会话 / PA-007 | packages/voice、apps/desktop/src/features/voice | MOD-02、04B、11 | ASR/TTS、播放、停止播报；与 task.cancel 保持分离 |
| MOD-15 | 唤醒词与连续语音 / PA-021 | packages/voice-wake | MOD-14 | 授权音频流、默认关闭、撤销停止、误触和回声实机测试 |
| MOD-16 | Windows 执行与凭据适配 / PA-016 | apps/windows-host、packages/windows-client | MOD-02、05 | Named Pipe、目标确认、输入串行、用户接管、后置验证、安全存储 |
| MOD-17 | 电脑状态读取 / PA-011（不集成 TraceGuard） | packages/windows-client（与 MOD-16 同一提供者，不另建 TraceGuard 包） | MOD-02、05、16 | 普通用户权限、必要真实观测与不可观测声明；PA-018 治理/恢复按 2026-09-17 用户修订排除 |
| MOD-18 | 编程执行工具 / PA-017 | packages/coding-tools | MOD-02、05 | 授权工作区、patch/command、保留用户改动、输出 Artifact 和验证状态 |
| MOD-19 | 打包与安装验收 | packaging、scripts/release | 已验收模块、MOD-01 | 独立安装、启动、升级、卸载和数据保留；发布授权另行处理 |
| MOD-27 | 目标、事实与决策图谱 / PA-024 | packages/goals | MOD-02、03、09、04B | 版本化 Goal/Fact/Decision/Plan 依赖图、来源、冲突和回退；不直接读记忆数据库 |
| MOD-28 | 持续认知与最小计划修复 / PA-025 | packages/cognition | MOD-03、04B、09、27 | 事实变化影响分析；输出 KEEP/RECHECK/REVISE 和最小差异，不直接改 TaskRuntime |
| MOD-29 | AgentArts 云端基础、身份、MaaS 与部署 / PA-026 | packages/agentarts/src/foundation 与云资源说明 | MOD-02、03、05、16 | 第一优先；CloudAgentPort、项目/Agent/deployment 引用、Fake 和真实 API 读回；凭据不进入云提示或仓库 |
| MOD-30 | AgentArts Agent/Workflow、知识、MCP/Skill 与工具提案 / PA-026、PA-027 | packages/agentarts/src/workflows | MOD-05、29；本地 MCP/Skills 为可选依赖 | 第一优先；云流程产生受限提案，一条部署 API 经本地 Policy/ToolGateway 和目标系统读回验收 |
| MOD-31 | AgentArts 多 Agent 与效果评估 / PA-012、PA-027 | packages/agentarts/src/multi-agent、packages/agentarts/src/evaluation | MOD-28～30 | 角色必要性、路由、交接、预算、固定评估集、失败降级和完整 trace；不能提升本地权限 |
| MOD-32 | AgentArts 发布、API、观测与 Competition 验收 / PA-027 | packages/agentarts/src/observability、tests/manual/agentarts | MOD-03、05、19、29～31 | 第一优先；版本、部署、API 实调、profile、日志、成本、回滚、Demo 和本地执行读回证据 |

zemeng 必须优先交付 MOD-29/30/32 的 Competition Golden Path，并让模块在没有 goo122 的真实数据库或未合并实现时使用 Fake Memory/Tool/Runtime 独立开发。AgentArts 成功不能直接把本地任务标为完成；Local Agent 新能力当前不作为必交项。

## 5. Potatos498：业务连接器与当前工作顺序

| ID | 模块 / 需求 | 独占目录 | 依赖 | 独立交付与验收 |
| --- | --- | --- | --- | --- |
| MOD-20 | 待办与日历 / PA-009、PA-013 | packages/productivity、packages/connectors/calendar | MOD-02、03、05 | Fake 时钟/日历；时区、修改读回；不另建调度器 |
| MOD-21 | 邮件连接器 / PA-014 | packages/connectors/mail | MOD-02、05 | 分页、重复事件、草稿和写入核实；真实账号单独验收 |
| MOD-22 | 订阅采集 / PA-015 | packages/connectors/feeds | MOD-02、05 | 固定 feed 增量、去重和来源；通知交 MOD-23 |
| MOD-23 | 通知汇总策略 / PA-015 | packages/notifications | MOD-02、03 | 安静时段、聚合和暂停；只用 Runtime 调度 |
| MOD-24 | 搜索与资料获取 / PA-010 | packages/connectors/research | MOD-02、05 | 固定响应、来源/时间、失败与过期区分 |
| MOD-25 | 天气 / PA-010 | packages/connectors/weather | MOD-02、05 | 地点不静默猜测；缓存状态和真实提供商证据分开 |
| MOD-26 | 微信与社交扩展 / PA-019 | packages/connectors/social/platform | MOD-02、05；交互模式另依赖 MOD-16 | 每个平台单独子任务；账号类型、能力和不支持项明确 |

MOD-20～26 的长期负责人和目录所有权保持不变。AgentArts 只消费这些连接器经 MOD-05 公布的工具能力，不接管连接器实现。2026-09-24 的串行安排如下；这是当前 MVP 的任务顺序，不表示这些能力已进入生产 Competition 装配：

1. **P0：维护现有 #88 设计 PR。** Potatos498 从最新 main 安全同步该分支，收敛五包接线方案的工具清单和状态：`feeds.collect`、`feeds.subscriptions`、`mail.inbox`、`mail.accounts`、`todo.list`、`todo.create`、`todo.update`、`notifications.status`、`research.search` 共 9 个已实现的模块工具；`calendar.events` 和 weather 不属于 #88 的五包清单。模块公开 `register` 不等于 Runtime 已注册或 Competition capability 已公布。Competition 工具注入、ConnectorHost 凭据错误规范化和 StoragePort 适配器由 goo122 作公共边界裁定；#88 的设计或 CI 通过不授权五包广域接线。当前合成会议 MVP 使用受限 `workspace.read_text`，不等待这五包接入。
2. **P1：仅在 D2 明确需要业务输入说明时补现有演示说明。** 复用已有合成会议资料，说明会议由 15:00 改至 17:00、准备由 14:00 改至 16:00（均后移两小时，准备仍比会议早一小时），无关计划不变；不新增 DTO、工具或另一套夹具。

今日不安排多连接器广域生产接线、真实 mail/social 账号写入或 Windows 打包安装。公共协议、SecretStore、Runtime 与根装配继续由 goo122 负责；业务连接器的独立源码增量如以后确有需求，再按对应 MOD 单独登记。

## 6. 跨负责人冻结边界

| 方向 | 必须使用的接口 | 当前状态 |
| --- | --- | --- |
| goo122 Runtime → zemeng 核心认知 | CoordinationPort | unavailable；需交付类型、Fake 和注入槽 |
| zemeng Competition Coordination → AgentArts | CloudAgentPort | unavailable；当前第一优先，需交付 deployment/version/trace、提案和错误语义 |
| 可选 Local Agent → goo122 模型 | 最小 ModelPort | unavailable；现有 ModelProvider/ModelGateway 为 provisional，不阻塞 Competition Profile |
| zemeng 核心认知 → goo122 记忆 | MemoryQueryPort、FactChangeFeed | provisional；MOD-09B 重建分支已有公开类型与进程内 Fake，生产提供者和持久确认仍 unavailable |
| zemeng 核心认知 → goo122 工具 | ToolExecutionPort | unavailable；现有 ToolHost/ToolGateway 为 provisional，稳定消费端口尚未定义 |
| zemeng 目标/决策 → goo122 存储 | CoordinationStorePort | unavailable |
| 所有模块 → Evidence/Artifact | EvidencePort、ArtifactPort | unavailable |

上表的 ToolExecutionPort 名称为待冻结接口，不允许在实现前私设第二套 DTO。已冻结和不可用的精确清单以当前接口目录为准。

## 7. 工作包与完成标准

每个模块必须交付：目标 profile、公开入口、消费的接口版本、README、Fake/夹具、代表性验证、接入说明、已知限制和真实验证条件。当前新增工作默认以 Competition Profile 验收；只有接口冻结不等于模块完成，只有 Fake 通过也不等于真实服务可用。

模块负责人从同一冻结提交建立分支。根配置、锁文件、公共迁移和生产 composition 通过 goo122 的独立集成 PR 接入；模块实现 PR 不并发修改共享文件。作者不能自评，合并后才更新 done。
