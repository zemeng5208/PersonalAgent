# 开发计划与进度

更新：2026-09-09 · 当前阶段：只实施华为 ICT AgentArts Competition Profile 架构与最小 Golden Path；通用 Local Profile 可选留存 · 已集成：ARCH-01/02/03、MOD-01/02/03/25、MOD-04/05 离线增量、PR #31/#34 会话与查询恢复、PR #33 桌面本地外壳 · Core Runtime Profile 1 已冻结；AgentArts 运行链与完整产品闭环未完成

本文维护工作状态，需求以 PRD 为准，当前交付顺序以[华为 ICT AgentArts Competition Profile](competition/HUAWEI_ICT_AGENTARTS_PROFILE.md)为先。模块负责人和独占目录唯一登记在 [模块分工](MODULE_ASSIGNMENTS.md)，契约见[公共开发协议](DEVELOPMENT_PROTOCOL.md)，逐接口冻结和可用性见[当前接口目录](interfaces/CURRENT_INTERFACE_CATALOG.md)。`goo122` 负责共享底座、公共协议、Runtime、工具、知识与记忆；`zemeng` 负责 Competition Profile、AgentArts、核心认知和桌面执行；`Potatos498` 负责 MOD-20～26 业务连接器。Local Profile 只作为可选保留，不进入当前比赛退出条件。阶段不代表承诺日期；正式排期需根据比赛时间、团队人数和接口验证结果确定。

### ARCH-03：Runtime Application 自主管理任务分派

- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`。
- 分支：`codex/arch-03-runtime-dispatch`；状态：`done`（PR #24 已合并为 `0f7dc1e`）。
- 范围：Runtime Application 持有 `TaskRuntime`、文本应用和活动执行注册表；`task.submit` 成功后由 Runtime 自动启动文本任务；Desktop 只提交任务、订阅事件、展示状态和管理可信模型配置。
- 验收：公开 `@personal-agent/runtime/application` 入口；重复提交不重复执行；Unavailable、取消、事件顺序和活动任务关闭保护有测试；Desktop 架构门禁禁止 Agent/Model 直连、旧 `runtime/text` 入口和直接 `runTask`。
- 限制：仍是 Electron 主进程内的 Runtime Application，不是独立守护进程或 IPC 服务；ARCH-03 本身未冻结工具或思考参数。PR #26 后续加入可选工具装配，但真实盘古和外部账号仍未调用。
### ARCH-01：目录与依赖治理

- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`。
- 分支：`codex/architecture-standard`；状态：`done`（PR #16 已由非作者评审并于 `87d0974` 合并）。
- 范围：项目目录规范、ADR、模块模板、架构门禁，以及移除 `packages/agents → apps/runtime` 反向生产依赖；不新增业务能力、不拆 Runtime 进程、不移动其他协作者 worktree。
- 验收：根级生产 `src/` 移除；`npm run check:architecture` 已检查 11 个 workspace 的 README、公开入口、依赖声明、依赖方向、连接器边界、公共 exports、跨包相对导入和循环依赖；全 workspace 类型检查通过，测试 106 项为 105 通过、1 项真实 Open-Meteo 验收按设计跳过。
- 完成边界：已满足目录、依赖门禁和测试验收，并完成非作者评审与主分支合并；ARCH-01 不包含 Runtime 进程拆分或 Agent/Model 编排迁移。

### ARCH-02：Runtime Application 编排边界

- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`。
- 分支：`codex/arch-02-runtime-application`；状态：`done`（PR #21 随堆叠集成在 PR #24 回流 `main`）。
- 范围：将 Agent/Model 选择、ModelGateway、文字 Agent 执行、Fake/Unavailable/Pangu 模式和连接测试移入 `apps/runtime/src/application/`；通过 `@personal-agent/runtime/text` 公开入口供 Desktop 调用。
- 不在范围：不拆 Runtime 进程、不新增 IPC 协议、不把 API Key 暴露给 Renderer、不接入工具调用或真实付费模型。
- 验收：Desktop Electron 生产代码不再导入 `@personal-agent/agents` 或 `@personal-agent/models`；Runtime 显式声明 Agent/Model 依赖；Fake、Unavailable、取消语义保持有效；架构门禁、全 workspace 类型检查和全仓测试通过。
- 剩余限制：模型配置与 Windows 加密存储仍由可信 Desktop 主进程负责；PR #26 后续提供可选工具装配，但真实模型工具链未验收；Runtime 仍是 Electron 进程内的模块化应用层，不等同于独立守护进程。

## 1. 里程碑

### COMPETITION-01：华为 ICT AgentArts Competition Profile（2026-09-09）

- 决策：项目参加华为 ICT 大赛创新赛道的 AgentArts 赛题；当前只实施 Competition Profile，通用 Local Profile 可选保留。
- 主路径：Desktop/Voice → Runtime/World State/Goal/Event → AgentArts Agent/Workflow → Tool Proposal → 本地 Policy/Approval/ToolGateway → 目标系统读回/Evidence → AgentArts 最终结果。
- 强制边界：AgentArts 必须真实承担构建、编排、评估与部署；云端不能持有本地授权或设置本地任务终态；正式 Demo 不静默回退 Local。
- 当前状态：架构 `accepted`；AgentArts Adapter、云端部署/API、Golden Path、统一世界状态和评估均为 `unavailable`。
- 依据：[Competition Profile](competition/HUAWEI_ICT_AGENTARTS_PROFILE.md)、[ADR-0007](adr/0007-huawei-ict-agentarts-competition-profile.md)。

### INTERFACE-01：分层接口冻结（2026-09-09）

- 决策：不冻结整套 wire 1.0.0，只冻结有完整证据的 Core Runtime Profile 1；其余接口逐项登记为 `provisional` 或 `unavailable`。
- 冻结范围：Request/Response/Event 信封与错误语义，`system.handshake`、`task.submit/get/list/cancel`、`conversation.list`、`approval.list` 及 TaskSnapshot 基础字段。
- 证据：PR #31 会话上下文已合并；PR #34 实现提交 `e5e20cad16566c6bdf821b7880efad96f0513ef1` 已由 `zemeng` 非作者批准、Foundation CI 通过并合并为 `bcbeaa2`；Desktop 通过公共 Client 恢复任务、会话和脱敏审批。
- 不冻结：事件订阅生命周期、Host 生命周期、Model/Agent/Tool、持续授权、Evidence/Artifact、设置、连接器、语音、知识/记忆、MCP/Skills、Windows、AgentArts 与分发。
- 依据：[接口目录](interfaces/CURRENT_INTERFACE_CATALOG.md)、[ADR-0005](adr/0005-layered-interface-freeze.md)、[Runtime 查询接口](modules/RUNTIME_QUERY_API.md)。

### MOD-04/05 离线验收增量（2026-09-07，已集成）

历史工作包负责人 goo122；分支 `codex/mod-04-05-acceptance`；PR #26 已合并为 `29bf54a`。本轮新增文字 JSON 工具提案、模型网关超时取消、SQLite 授权与参数绑定、持久审批和 Agent 恢复、工具执行证据与幂等重放。全仓 check、18 项定向测试和两项桌面 smoke 通过，详见[本轮验收记录](modules/MOD-04-05-ACCEPTANCE.md)。后续模型与 Agent 工作按 MOD-04A（goo122）/04B（zemeng）拆分，历史归属不变。

离线工作包已完成非作者评审并集成。真实模型与天气组合调用仍未执行，因此 MOD-04/05 整体保持 review；已补齐任务级持久授权、审批恢复和 Evidence，但不代表跨任务持续授权、真实 SecretStore、流式、多 Agent 或真实写入恢复已经完成。真实盘古验收仅在 Local Profile 以后被明确启用时安排，不阻塞当前 AgentArts 比赛路径。

| 阶段 | 交付 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| M0 设计基线 | PRD、架构、协作规范、工作包 | 文档检查通过；待决项登记 | 已建立并在 2026-09-09 同步分工、接口目录和 ADR |
| M1 基础闭环 | 窗口、Runtime、盘古、工具、语音基础 | 真实请求到工具与验证链路；取消有效 | MOD-01/02/03 已集成；Core Runtime Profile 1 已冻结；真实模型工具链未完成 |
| M1.5 Competition Profile | AgentArts 基础、Agent/Workflow、部署 API、可信工具 Golden Path、Demo/trace | AgentArts 构建/编排/部署可读回；一条真实工具闭环；不静默回退 Local | 架构 accepted；MOD-29～32 未实现 |
| M1.6 持续认知创新 | 版本化世界状态、Goal/Event、目标/事实/决策图谱、最小计划修复 | 事实变化产生可回放影响；AgentArts 只更新受影响计划；Evidence 闭环 | 架构 accepted；MOD-09/27/28 未实现 |
| M2 首次可用 | Obsidian、提醒、研究天气、TraceGuard 只读、全部 P0 | 所有 P0 逐项验收，不只演示单场景 | 未开始 |
| M3 信息管家 | 邮件、日历、订阅、通知、专业协作 | 真实连接器增量同步与授权写入验证 | 未开始 |
| M4 行动与扩展 | 电脑控制、编程、治理、流程学习、社交扩展 | 指定应用可控可验证；平台能力矩阵有证据 | 未开始 |
| M5 参赛/分发 | 演示、打包、技术贡献材料 | 规则核验、真实证据、隔离安装运行卸载 | 未开始 |

## 2. 模块执行台账

MOD-01/02 已通过 PR #1 评审并集成，MOD-03 已通过 PR #5 集成；PR #31 的多轮上下文和 PR #34 的公开查询/恢复面均已合并。MOD-25 的源码、Runtime 根装配和地理编码修复已完成评审并合并。MOD-04/05 的离线持久审批、Evidence 与 Fake 垂直链路已随 PR #26 集成，但真实模型工具链和完整持续授权仍未验收。桌面 PR #18/#25/#33 与查询消费 PR #34 已合并，MOD-11/12/13 仍按未完成项保持 in_progress。PR #8 的历史冲突仍由原负责人处理；PR #19 已合并并移除误提交报告。每行可拆多个子任务，只有全部约定交付通过后模块才为 done。

| 模块 ID | 计划阶段 | 状态 | 当前执行人 / PR / 证据 |
| --- | --- | --- | --- |
| MOD-01 | M1 起步门槛 | done | goo122 / PR #1 / 合并提交 dbbc547 / 构建、迁移和存储测试通过 |
| MOD-02 | M1 起步门槛 | done | goo122 / PR #1 原始 14 operation；PR #34 增至 17 operation 并完成 Desktop 消费验证；只冻结 Core Runtime Profile 1，不冻结整包 |
| MOD-03 | M1/M2 | done | goo122 / PR #5 / 合并提交 e14aebf / 7 项 Runtime 测试及评审通过 |
| MOD-04A | Local Profile 可选模型层 | review | `goo122` / 历史 PR #10、#11、#26 已合并；ModelGateway、Pangu 文本 Provider、JSON 提案适配离线通过；代码保留，但新增 Local 能力不进入当前比赛优先级 |
| MOD-04B | Competition Coordination；Local Agent 可选 | in_progress | `zemeng` / 需先交付 Competition Profile 的 Coordination/CloudAgent 消费边界；既有有界 Agent 与 PR #31 上下文保留为可选 Local baseline |
| MOD-05 | M1/M2 | review | goo122 / PR #7、#26 已合并；任务级 SQLite 授权、参数绑定、审批恢复、工具 Evidence 与幂等重放已离线验证；跨任务持续授权、真实 SecretStore 和真实写入恢复尚未完成 |
| MOD-06 | M2 | todo | 未启动 |
| MOD-07 | M2 | todo | 未启动 |
| MOD-08 | M2 | todo | 未启动 |
| MOD-09 | M1.6/M4 | todo | `goo122` / Competition Profile 需要的记忆查询、事实变化和流程学习；未启动 |
| MOD-10 | M4 后研究，无交付日期承诺 | todo | 未启动 |
| MOD-11 | M1 | in_progress | `zemeng` / PR #13、#14、#18、#25、#33、#34 已合并；窗口、安全桥、托盘、公开恢复和本地外壳可运行，DPI/透明命中及实机验收仍未完成 |
| MOD-12 | M1 | in_progress | `zemeng` / PR #18、#25、#34 已合并；文字交互、会话恢复、状态展示、取消和大工作区可用，真实盘古对话与语音仍未验收 |
| MOD-13 | M1 基础页面、M2 配置闭环 | in_progress | `zemeng` / PR #13、#18、#25、#34 已合并；脱敏审批恢复、后台导航和模型配置可用，设置/连接器生产 API 与完整授权管理仍未完成 |
| MOD-14 | M1 基础、M2 验收 | todo | `zemeng` 已确定，未启动 |
| MOD-15 | M4 后扩展 | todo | `zemeng` 已确定，未启动 |
| MOD-16 | M2 TraceGuard 所需只读端口、M4 电脑操作 | todo | `zemeng` 已确定，未启动 |
| MOD-17 | M2 只读、M4 治理 | todo | `zemeng` 已确定，未启动 |
| MOD-18 | M4 | todo | `zemeng` 已确定，未启动 |
| MOD-19 | M5 | todo | `zemeng` 已确定，未启动 |
| MOD-20 | M2 本地提醒、M3 日历 | todo | `Potatos498` 已登记，未授权启动 |
| MOD-21 | M3 | todo | `Potatos498` 已登记，未授权启动 |
| MOD-22 | M3 | review | `Potatos498` / PR #8；RSS 2.0/Atom 增量、去重、脱敏和 Fake 验收已完成，当前与最新 main 冲突，等待负责人更新分支后合并 |
| MOD-23 | M3 | todo | `Potatos498` 已登记，未授权启动 |
| MOD-24 | M2 | todo | `Potatos498` 已登记，未授权启动 |
| MOD-25 | M2 | done | `Potatos498` / PR #4、#12、#23 与 Runtime 装配 PR #9 已合并；GeoNames 增强下 26 个世界大城市简体查询 26/26 高置信，真实门控测试 66/66；manifest 仍为 `conditional`，不等于长期生产稳定性验收 |
| MOD-26 | M4 起逐平台验收 | todo | `Potatos498` 已登记，未授权启动 |
| MOD-27 | M1.6 | todo | `zemeng` / Competition Profile 的目标、事实与决策图谱；类型、存储和 Fake 未提供 |
| MOD-28 | M1.6 | todo | `zemeng` / AgentArts 驱动的持续认知与 KEEP/RECHECK/REVISE 最小计划修复；未提供 |
| MOD-29 | M1.5 第一优先 | todo | `zemeng` / AgentArts 云端基础、身份、MaaS/模型和部署适配；无部署/API 证据 |
| MOD-30 | M1.5 第一优先 | todo | `zemeng` / AgentArts Agent/Workflow、知识、MCP/Skill 与工具提案映射；未提供 |
| MOD-31 | M1.5/M3 | todo | `zemeng` / AgentArts 多 Agent 与评估；未提供 |
| MOD-32 | M1.5/M5 第一优先 | todo | `zemeng` / AgentArts 发布、API、观测、profile 证据与端到端验收；未提供 |

### 2.1 开工顺序与阻塞边界

1. Core Runtime Profile 1 已冻结，可供 Competition Profile 复用；事件/Host/Agent/Tool 等未冻结面固定精确提交并保留迁移空间。
2. 先交付 `CoordinationPort`、`CloudAgentPort`、`ToolExecutionPort` 和 Evidence 最小消费语义、Fake 与注入槽；ModelPort 仅为可选 Local Profile 所需，不阻塞比赛主路径。
3. MOD-29 建立 AgentArts 项目、身份、Agent/Workflow、版本、部署和 API 读回；MOD-30 先完成一条工具提案路径；MOD-32 从第一天记录 deployment、trace、usage、失败和回滚。
4. 首条真实闭环为任务→AgentArts Agent/Workflow→只读工具提案→本地 Policy/ToolGateway→目标系统读回→AgentArts 最终回答→Evidence。正式 Demo 不静默回退 Local。
5. 在 Golden Path 后接入 MOD-09/27/28，演示版本化世界状态和 `KEEP/RECHECK/REVISE`；再扩大知识、MCP/Skill、多 Agent 和评估。
6. 现有 `runAgent()`、ModelGateway、盘古/自有 Provider 代码保留为可选 Local baseline；当前不投入独立新功能，不计入比赛退出条件。
7. MOD-25 当前工作包已由 `Potatos498` 完成；MOD-20～26 分工不因 AgentArts 调整而改变。
8. 公共目录、锁文件和迁移由 `goo122` 集成；`zemeng` 与业务模块交付公开注册入口，不同时编辑应用根装配。

### 2.2 原工作包迁移关系

旧 W 编号保留用于历史检索，执行状态只更新上方 MOD 台账，不维护两套状态。

| 旧 ID | 新模块 | 拆分说明 |
| --- | --- | --- |
| W-001 | MOD-04A | 历史盘古环境验证工作；当前仅在 Local Profile 以后被明确启用时继续 |
| W-002 | MOD-01 | 根工程与存储底座 |
| W-003 | MOD-02、MOD-03、MOD-05 | 分开协议、任务和授权 |
| W-004 | MOD-11、MOD-12、MOD-13 | 分开外壳、悬浮交互与后台 |
| W-005 | MOD-04A、MOD-04B | 历史盘古 Provider 与主 Agent/专业协作拆分；现改由 Competition Coordination/AgentArts 优先 |
| W-006 | MOD-06、MOD-07 | MCP 与 Skills 独立交付 |
| W-007 | MOD-14 | 基础语音归 `zemeng` |
| W-008 | MOD-08 | Obsidian 归 `goo122` |
| W-009 | MOD-03、MOD-20、MOD-24、MOD-25 | 调度核心、日程、搜索、天气分开 |
| W-010 | MOD-17 | TraceGuard 适配归 `zemeng` |

## 3. 待决与风险

- 赛事：华为 ICT 创新赛道及 AgentArts 赛题已确认；仍需正式通知确认届次、截止时间、评分细则和提交材料。
- 模型：未验证盘古账号、具体部署、工具调用、成本与限流。
- AgentArts：区域、项目、身份、模型、Workflow/API、费用和日志条件均未读回；当前没有仓库适配或云端验收证据。
- Profile：当前只实施 Competition Profile；若 Local 兼容工作抢占比赛主路径、或 Competition 失败后静默回退 Local，会造成赛题证据失真。
- 接口：只有 Core Runtime Profile 1 冻结；未提供能力若被 UI、Fake 或 Schema 误当作可用，会形成错误依赖。
- 平台：首批邮箱/日历/社交账号类型未知；先做可替换契约，不虚构全平台能力。
- 运行环境：Windows 兼容范围和基准机器待定。
- 自训练：首期仅偏好与流程学习；参数训练作为研究项。
- 视觉：尚无渲染稿；进入设计时使用用户指定的 Open Design 位置。
- 依赖：2026-09-06 `npm audit` 报告 AJV 8.17.1 存在 1 项中危 `$data` ReDoS 公告；当前实例未启用 `$data`，未发现现有路径可触发，仍应在独立维护 PR 中升级至修复版本并重跑契约测试。

## 4. 文档检查记录

- 2026-09-05：已建立 7 份 Markdown 文档（含 README 和 PR 模板）；仓库链接检查通过，23 个需求编号无重复、无未知引用。Git 已跟踪改动的差异空白检查通过。
- 2026-09-05：新增模块分工与公共开发协议草案；拆为 26 个模块并同步 `goo122`、`zemeng` 与待认领协作者职责，保留旧 W 编号映射。协议尚未冻结、SDK 尚未实现。
- 2026-09-05：检查 10 份 Markdown 文档，仓库链接及编号检查通过；23 项需求全部有模块承接，26 个模块全部进入台账，无重复模块编号或冲突标记。已跟踪差异空白检查通过。
- 2026-09-06：PR #1 已评审并合并，MOD-01/02 转为 done；登记第三位协作者 `Potatos498`。Windows CRLF 下生成文件检查误报已在 MOD-03 分支修复并通过根 check。
- 2026-09-06：登记 MOD-25 天气连接器工作包与执行人 `Potatos498`，同步台账状态、开工顺序与风险项；ROADMAP 相对链接与模块编号一致性检查通过。
- 2026-09-06：PR #5 已合并，MOD-03 转为 done；PR #4 合并最新 main、修复取消语义和静默启用 Fake 的问题，全仓 46 项测试通过，MOD-25 保持 review。
- 2026-09-06：MOD-25 接入 Open-Meteo 真实提供商，并合并上述评审修复（`provider` 必填、stale 回退收窄至可重试外部失败、取消语义、`retryAfterMs`）；更新工作包的交付、验收、证据与限制及台账证据。真实读回与模拟验证分开记录，manifest `verification` 由 `mock` 改为 `conditional`。实测：根 `npm run check` 退出码 0，模块 29 项（28 通过 + 1 项真实读回默认跳过）、全仓 62 项测试通过。ROADMAP 相对链接检查通过。
- 2026-09-06：MOD-25 修复地理编码跨语言解析缺陷。对生产端点实测发现：Open-Meteo 按语言分别建索引且不跨文字系统匹配，`zh` 索引为繁体且不完整，`New York` 在 `zh` 轮查不到纽约市却查到英格兰同名村庄，原实现因此把时区解析成 `Europe/London`。改为非英文配置下并行查询「配置语言＋`en`」两轮、按 GeoNames `id` 合并、名称完全相等优先再按人口降序排序，展示名仍取配置语言。模块测试由 29 项增至 34 项（新增 5 项离线测试，夹具取自真实响应）。实测：根 `npm run check` 退出码 0，全仓 67 项（66 通过＋1 项真实读回默认跳过）；`PA_WEATHER_LIVE=1` 下 21 项全部通过。仍未解决且已记入已知限制：简体书写的外国地名（`东京` 命中江苏同名地点、`纽约` 返回 `NOT_FOUND`），修复需简繁映射表，与零新增依赖约束冲突。ROADMAP 相对链接检查通过。
- 2026-09-06：PR #4 已合并为 main `9f27e9b`。由于 `0da1ccc`、`145fea0`、`b5eed33`、`4c0ec0f` 晚于 `goo122` 原批准，`goo122` 在独立工作树从最终 main 补做合并后审计：Node 24.15.0 / npm 11.12.1 下根 `npm run check` 通过，全仓 67 项为 66 通过＋1 项默认跳过；显式启用真实读回后 Open-Meteo 测试 21/21 通过。审计未发现新增提交破坏既有取消、错误映射或显式 Provider 注入，但确认两项完成阻碍：简体国外城市可误解析；未传日期时 `WeatherService` 按 UTC 日历日取默认值，可能与用户或目标地点当天不一致。MOD-25 保持 review。
- 2026-09-06：MOD-25 修复地点正确性与缺省日期两项审计阻碍（分支 `fix/mod-25-geocoding`，PR #12）。对生产端点实测确认前一轮「两轮查询使解析与语言无关」的声称对中文输入不成立：`language` 同时决定搜索名字集，任何中文串在 `en` 轮恒返回空。改为检索轮由输入文字决定；用 `feature_code` 与人口下限 500000（实测空档 422324↔8804190）判 `confidence`；`locationQuery` 作兜底轮；`strict` 改拒绝低置信度；缺省日期按目标地时区取当地日。实测：根 `npm run check` 退出码 0，全仓 119 项 116 通过＋3 跳过；`PA_WEATHER_LIVE=1` 下 38/38 通过。ROADMAP 相对链接检查通过。
- 2026-09-07：现有 PR 验收同步：PR #12 已由 `goo122` 批准并合并为 `5b833c9`；PR #8 已通过 `goo122` 代码评审且 Foundation CI 通过，但因 PR #12 先合并而与 main 冲突，等待 `Potatos498` 更新分支；PR #19 的 CI 通过但作者为 `goo122`，按协作规范等待非作者评审。PR #16（ARCH-01）与 PR #18（桌面交互里程碑）均已合并，相关模块状态按当前未完成边界更新。
- 2026-09-07：登记 MOD-25 增强工作包「地理编码 GeoNames 第二源」（分支 `feat/mod-25-geonames`，用户明确授权）。动机与实测证据：合并 main 后对 26 个世界大城市以简体中文查询，16 高置信命中、7 个 `NOT_FOUND`（纽约/首尔/温哥华/利马/内罗毕/伊斯坦布尔/胡志明市）、3 个低置信误解析（东京→江苏、伦敦→安大略、罗马→昆士兰）、1 个高置信静默错误（开罗→美国伊利诺伊州 Cairo，PPLA2 人口 1733 被 `ADMIN_SEAT_CODES` 无条件信任，而埃及开罗根本不在 `zh` 索引返回里）。范围：`OpenMeteoProvider` 增加可选 `geonamesUsername`（装配层注入，不进仓库），配置后对汉字输入增加 GeoNames 官方 API `name_equals` 精确名检索层——返回 geonameId 再经 Open-Meteo `/v1/get?id=` 取规范记录（时区/人口/feature_code 齐全，两源同为 GeoNames id 可按 id 合并），命中即「输入串是该地点已知名」的精确语义，参与 exact-match 排序。`secure.geonames.org` 已实测可达（免费账号，日 3 万次额度）；Wikidata/Nominatim 从本机不可达已排除。失败语义：GeoNames 层任何错误降级为跳过该层，回退现有 Open-Meteo 行为。不在范围：`ADMIN_SEAT_CODES` 置信度规则收紧与提示串 exact-match 修复（另行授权）、显示名简繁统一、非汉字输入的第二源检索。本条只是登记，本工作包尚无实现、无测试证据。
- 2026-09-07：MOD-25 增强工作包「地理编码 GeoNames 第二源」实现完成。交付：`OpenMeteoProvider` 新增可选 `geonamesUsername`/`geonamesBaseUrl` 装配项；配置后汉字输入增加 GeoNames 官方 API `name_equals` 精确名检索层（并行于既有语言轮，展示名优先序置于最前），命中 id 经 Open-Meteo `/v1/get` 规范化（与搜索同 id 体系、同字段），`name_equals` 命中作为「输入串是已知名」参与 exact-match 排序（`伦敦`→`倫敦` 不同写法不阻断）；该层尽力而为——账号缺失不发请求、401/额度超限/网络失败降级为仅 Open-Meteo、`/v1/get` 404 只丢该候选、层内取消不被吞。manifest `configSchema` 与工具描述同步。实测：**26 个世界大城市简体查询从 16/26 高置信（7 个 NOT_FOUND、3 个误解析、1 个开罗静默错）提升到 26/26 高置信**（纽约→America/New_York、开罗→Africa/Cairo、东京→Asia/Tokyo 等）；根 `npm run check` 退出码 0；weather 包离线 66 项 62 通过＋4 项门控跳过，`PA_WEATHER_LIVE=1 PA_GEONAMES_USERNAME=<账号>` 下 66/66 全过（新增 GeoNames 端到端 live 测试）。账号不进仓库，由装配层从环境变量注入（README 已写明 `PA_GEONAMES_USERNAME` 约定与 `apps/runtime` 接线归 `goo122`）。未在本工作包内：`ADMIN_SEAT_CODES` 置信度规则收紧、提示串 exact-match 修复（`开罗+Cairo` 类场景现由 GeoNames 层覆盖，机制 bug 仍在）、显示名简繁统一。ROADMAP 相对链接检查通过。
- 2026-09-07：PR #24（ARCH-03）、PR #26（MOD-04/05 离线审批与工具执行）和 PR #25（Desktop 工作区与模型管理）已进入 `main`。合并后复查中，完整 `npm run check`、Runtime Application smoke 与文字 smoke 通过；基础 Electron smoke 仍保留 372px 旧断言而与 420px 实现不一致，workspace smoke 在当前 Windows/DPI 下出现 1.5px 居中偏差。用户决定先保留合并结果，这两项作为 Desktop 回归债务继续跟踪，不据此把 MOD-11/12/13 标为 done。
- 2026-09-08：MOD-04C（Runtime-owned 多轮文字上下文）在分支 `codex/mod-04-conversation-context` 完成离线实现：Runtime 从既有 `tasks`/`task_events` 读取同一会话最近 20 个成功任务，过滤失败/取消任务并剥离模型元数据；Agent 支持 `initialMessages`，应用检查点覆盖审批恢复与重启入口。Runtime 定向回归 30/30、根构建通过；尚未由非作者评审、合并或进行真实盘古验收，状态保持 `in_progress`。
- 2026-09-09：PR #31 已合并多轮上下文；接口请求 PR #32 已合并；PR #34 的 `task.list`、`conversation.list`、`approval.list` 和 Desktop 恢复已由 `zemeng` 非作者批准、Foundation CI 通过并合并。PR #33 的桌面本地外壳增量也已合并。
- 2026-09-09：完成接口冻结评估。只冻结 Core Runtime Profile 1；事件生命周期、Host、Model/Agent/Tool、连接器、Evidence/Artifact 和持续授权保持 `provisional`，无生产提供者的设置、语音、知识/记忆、MCP/Skills、Windows、AgentArts 与分发接口列为 `unavailable`。
- 2026-09-09：按新分工拆分 MOD-04A/04B，新增 MOD-27～32，并接受核心认知依赖倒置和 AgentArts 本地信任边界；这些新接口和模块尚未实现，不能因文档完成而提升状态。
- 2026-09-09：确认华为 ICT 创新赛 AgentArts 赛题；新增 Competition Profile 与 ADR-0007，当前只实施比赛主路径，Local Profile 仅可选留存现有代码，不新增且不进入比赛退出条件。
- 此记录不构成任何运行时能力通过证明。

## 5. 继续入口

### MOD-28-IMPACT-01（本地依赖影响与显式修订提案）

- 负责人 zemeng；状态 review（待非作者评审与集成）；串行延续 `codex/zemeng/mod27-goal-graph` 的 MOD-27 增量。
- 范围 `packages/cognition`：KEEP/RECHECK 影响分析及显式 summary 候选的 REVISE 差异；不接云、不写 Runtime。
- 依赖、验收与剩余边界见[工作包](modules/MOD-28-IMPACT-01.md)。

### MOD-27-GRAPH-01（云审批期间的本地工作包）

- 负责人 zemeng；基线 5944061；状态 review（待非作者评审与集成）；分支 `codex/zemeng/mod27-goal-graph`。
- 范围 `packages/goals`：版本化 Fact/Goal/Decision/Plan、依赖引用、修正/撤回历史和冲突校验。
- 纯领域增量，无云调用、生产持久化或公共存储端口变更；详见[工作包](modules/MOD-27-GRAPH-01.md)。

### COMPETITION-PORTS-01（本地开发增量）

- Profile：huawei_ict_agentarts；负责人 goo122；消费评审 zemeng；状态 in_progress。
- 基线 bafb541；分支 codex/competition-coordination-ports，工作树 .worktrees/competition-coordination-ports。
- 新增 CoordinationPort / CloudAgentPort 文字首片、显式 Fake、Runtime 注入；不调用真实服务、不扩展 Local。
- 端口 provisional，真实 AgentArts 仍 unavailable；完整范围与验证见 [工作包](modules/COMPETITION-PORTS-01.md)。
- 下一步为 zemeng 消费评审，然后补云适配与工具提案/执行结果契约；不能将文字 Fake 视为 Golden Path 完成。

当前继续入口以[接口目录](interfaces/CURRENT_INTERFACE_CATALOG.md)和模块台账为准。Core Runtime Profile 1 可稳定消费；下一公共接口工作是 Model/Coordination/Memory/ToolExecution/Evidence/Artifact 的最小端口与 Fake。MOD-05 已具备任务级 SQLite 授权、审批恢复和本地 Evidence，但跨任务持续授权、真实 SecretStore、公开 Evidence 内容和真实写入恢复仍未完成。PR #8 的历史冲突由原负责人处理；PR #19 已合并。

### MOD-25 地理编码修复工作包（PR #12，历史验收）

- 任务：M2-C-025 / 天气连接器；关联 MOD-25 / PA-010。
- 负责人：`Potatos498`；评审者：`goo122`；PR #4 已合并（main `9f27e9b`），本轮修复 PR #12 已由非作者评审并合并（main `5b833c9`）；状态：`done`（仅针对本工作包边界）。
- 范围：`packages/connectors/weather/`；不修改公共契约、根锁文件与根装配（均归 `goo122`）。
- 输入与依赖：明确地点或配置的默认地点、可选 `locationQuery`（拉丁/英文名提示）、日期、单位；依赖 MOD-02 的 `ConnectorItem` 契约与 `ConnectorPort`，以及 testkit 的假时钟和假 ToolHost。真实数据来自 Open-Meteo（免密钥、无账号）。
- 交付：`WeatherProvider` 新增必需方法 `resolvePlace`（解析与取预报共用同一地点，避免缺省日期与坐标裂脑）；`ResolvedPlace` 新增 `confidence` 与 `featureCode`；`ForecastRequest`/`WeatherQuery` 新增 `locationQuery`；地理编码检索轮由输入文字决定（配置语言 + `en` + 输入含汉字时的 `zh`），按 GeoNames `id` 合并、保留配置语言的显示名、删去按 `admin1`/`country` 相等的排名子句；`assessConfidence` 用 `feature_code` + 人口下限 500000（可经 `minCorroboratedPopulation` 配置）判 `high`/`low`；`locationQuery` 是兜底轮（仅原始输入零候选或 `low` 时并入）；`strict` 语义改为拒绝 `low` 而非拒绝同名；缺省日期按目标地时区取当地日；工具入出参 schema 同步（`locationQuery`、`confidence`、三处 `description` 注解）；59 项测试与包 README。
- 验收：根 `npm run check` 退出码 0；weather 59 项 56 通过 + 3 项真实读回默认跳过（全仓 119 项 116 通过 + 3 跳过）。汉字输入在 `language:'en'` 下仍解析到正确地点；`东京`/`伦敦`/`罗马`/`丽江`/`广东` 判 `low`，`北京`/`巴黎`/`纽约市`（`PPL` 8.8M）判 `high`；`England`/`Texas`/`France` 判 `low`；`strict` 下 `北京`/`巴黎` 可用、`东京`/`England` 被拒且消息含候选与「改用英文名」提示；`婺源`（high）忽略会排错的 `Wuyuan`、`丽江`（low）+ `Lijiang` → 云南；`feature_code` 缺失保守判 `low`；缺省日期 `Pacific/Kiritimati` 在 `2026-09-05T12:00Z` 取 `2026-09-06`、显式 `date` 不触发解析；解析失败无 stale 回退、显式 `date` 保留 stale 回退；`FakeToolHost` 经 ajv 真校验工具入参与出参。
- 证据：[weather 说明](../packages/connectors/weather/README.md)（含 2026-09-06 对生产端点的真实读回原始输出、`curl` 直取交叉核对、20 行地名实测解析表与置信度误判清单）。manifest `verification` 保持 `conditional`。
- 限制：见包 README「已知限制」——简体外国城市是「被检出并标注」而非「被纠正」，`ranked` 仍会返回 伦敦/安大略（带 `confidence:'low'`）；置信度有实测误报（阳朔、同里）与漏报（凤凰、Pingyao、Wuyuan），最差组合是零候选 + 提示串落错省却标 `high`（平遥）；显示名简繁混杂（D7）不可在包内修；`locationResolution:'strict'` 的语义改变影响 `apps/runtime` 生产装配，已在 PR 点名；`record.externalId`/`dedupeKey`/`contentRef` 取值语义变更（并入 `locationQuery`、缺省日期变当地日）；缺省日期时解析自身失败无法回退 stale。

### MOD-03 完成记录

- 任务：M1-A-003 / 持久任务与事件核心；关联 MOD-03 / PA-004、PA-009。
- 负责人：goo122；PR #5 已评审并集成，合并提交 e14aebf。
- 范围：apps/runtime、根工作区装配和 Runtime CI 示例；依赖 MOD-01/02。
- 交付：SQLite 持久任务、状态转换、事件回放、进度、检查点、取消信号、异常退出待核实恢复、外部写入超时防重、一次性调度补跑/跳过，以及公共 Client 最小往返。
- 验收：Runtime 7 项测试通过；根 check 共 33 项测试通过；demo:runtime 输出 succeeded 和 7 个持久事件。
- 证据：[Runtime 说明](../apps/runtime/README.md)；测试只使用本地 SQLite 与固定 worker，不调用真实模型、账号或平台。
- 限制：不是后台守护进程；没有 IPC、循环调度、事件裁剪、真实模型、权限工具或连接器；真实 PA-004/PA-009 闭环未完成。

### MOD-02 完成记录

- 任务：M1-A-002 / 公共协议与联调 SDK；关联 MOD-02 / PA-004、PA-023。
- 负责人：goo122；PR #1 已评审并集成，合并提交 dbbc547。
- 范围：packages/contracts、packages/client、packages/testkit、对应示例与根依赖装配；依赖 MOD-01 的本地底座。
- 交付：PR #1 初始 14 operation 与 9 类事件 Schema、生成 TypeScript 类型和漂移检查、客户端、JSONL 分帧、六种 Fake 场景、Fake 工具/时钟/存储/连接器、消费者和提供者示例；PR #34 增加 3 个查询 operation，当前共 17 个。
- 验收：根 npm run check 共 26 项测试通过（storage 4、contracts 4、client 5、testkit 13），包含 SQLite 事件持久化后迁移及回放；npm run demo:protocol 通过。
- 证据：[testkit 说明](../packages/testkit/README.md)；wire 1.0.0、开发包 0.1.0-alpha.1。PR #34 的查询子集已完成 Desktop 消费验证；项目内独立源码副本 .cache/clean-mod-02 的早期 npm ci、check（26/26）、dev、demo:protocol 全部通过。
- 限制：进程内 Mock 不能替代 C#、第三方连接器或真实平台联调；只有 Core Runtime Profile 1 冻结，整包不按单一状态宣称。

### MOD-01 完成记录

- 任务：M1-A-001 / 工程与存储底座；关联 MOD-01 / PA-004。
- 负责人：goo122；PR #1 已评审并集成，合并提交 dbbc547。
- 范围：根配置与锁文件、packages/storage、scripts/dev、公共 CI，以及对应说明和状态文档。
- 依赖：无模型或真实账号；使用本机已验证 Node 24.15.0、npm 11.12.1。
- 交付：npm 工作区、严格 TypeScript 构建、SQLite WAL 连接和事务迁移、独立存储示例。
- 验收：类型检查和 4 项存储测试通过；跨进程持久化、迁移保留数据、失败回滚通过；独立源码副本 npm ci/check/dev 通过。
- 证据：[存储说明与验证记录](../packages/storage/README.md)、PR #1 和合并提交 dbbc547。
- 排除：公共 SDK、桌面、Runtime 任务状态机、模型与真实平台调用；PA-004 整体未完成。

### MOD-05 初始宿主工作包（PR #7，历史验收）

- 任务：M1-A-005 / 权限、工具与连接器宿主首片；关联 MOD-05 / PA-023。
- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`；状态：review。
- 范围：`packages/policy/`、`packages/tool-gateway/`、`packages/connector-host/`，以及 `packages/client/`、`apps/runtime/` 和根工作区的必要兼容装配；不接真实账号或天气生产请求。
- 交付：授权引用绑定任务、工具、scope、到期时间和可选次数并支持撤销；工具输入/输出校验、用户在场、deadline、取消与外部写入 `RESULT_UNKNOWN`；连接器声明式凭据白名单、注册/健康/生命周期和同连接器并发连接锁；公共 Client 可携带任务 ID，经 Runtime 发现并调用工具，Runtime 仅允许 running 任务执行并记录 confirmed/unknown 的 `tool.completed` 事件。
- 验收：无授权或伪造引用拒绝；调用者不能自报 scope；一次性授权只在通过输入与权限检查后消耗；外部写入中断不盲目重试；未声明凭据拒绝；并发连接只创建一个实例；全部测试只使用内存策略、假工具和假 SecretStore。
- 证据：[授权策略](../packages/policy/README.md)、[工具网关](../packages/tool-gateway/README.md)、[连接器宿主](../packages/connector-host/README.md)；Node 24.15.0 / npm 11.12.1 下根 `npm run check` 通过，全仓 82 项为 81 通过＋1 项天气真实读回默认跳过，其中 MOD-05 定向 14 项、Runtime 8 项（含公共 Client→授权工具闭环）；`npm run dev`、`demo:protocol`、`demo:runtime` 均通过。
- 当时限制：授权和账号会话尚未持久化，重启后失效；无审批 UI、持续授权管理、真实 SecretStore、工具运行证据存储和恢复执行器。PR #26 后续补齐任务级 SQLite 授权、审批恢复、执行记录和本地 Evidence；账号会话、跨任务持续授权、真实 SecretStore、公开 Evidence 内容与真实写入核实仍未完成。

### MOD-05 × MOD-25 初始垂直集成（历史验收）

- 任务：M1-A-005I / MOD-05 与 MOD-25 首条 Runtime 垂直集成；关联 PA-010、PA-023。
- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`；状态：review。
- 范围：`apps/runtime/src/weather-runtime.ts`、Runtime package/export、根 workspace/build 装配和 Runtime 集成测试；不修改 `packages/connectors/weather/` 内部实现。
- 交付：`createWeatherRuntime` 组合入口、严格模式 `createOpenMeteoRuntime`、显式 Provider 注入、Client→Runtime→Policy→ToolGateway→weather.forecast 链路测试。
- 验收证据：Runtime 定向测试 11/11；根 `npm run check` 通过；`npm run dev`、`npm run demo:protocol`、`npm run demo:runtime` 通过；weather 全包 34 项为 33 通过 + 1 项真实读回默认跳过。
- 已验证：授权成功、撤销后拒绝、非 running 任务在 Provider 调用前拒绝、生产严格 Open-Meteo 注册不发起网络请求；测试仅使用显式 `FakeWeatherProvider`。
- 剩余限制：授权、连接器会话和 Evidence 仍为内存能力；真实 Open-Meteo 长期稳定性与多时段采样未验收；这些是 MOD-05 或真实生产验收边界，不否定 MOD-25 当前工作包已完成。

### MOD-04A/04B 已集成工作包与后续边界

- 任务：M1-A-004A / 模型网关与单主 Agent 有界执行循环；关联 MOD-04A/04B / PA-003、PA-012。
- 历史负责人：goo122；PR #10、#11 已由非作者评审并合并；后续负责人：MOD-04A `goo122`、MOD-04B `zemeng`。状态：review/in_progress（历史工作包已合并，真实盘古与完整 Agent 能力仍未验收）。
- 范围：packages/models、packages/agents、根构建入口与对应测试/说明。
- 交付：能力声明与验证等级、Fake/Unavailable/Pangu 占位 Provider、模型 deployment/usage 记录、工具提案校验、一次修复上限、maxSteps/maxTokens/deadline/取消边界、RuntimeToolInvoker 和 unknown reconciliation 回调。
- 验收：模型测试 4/4；Agent 测试 4/4；Fake 天气请求经过 Runtime、Policy、ToolGateway；模型不能提供授权；unknown 不生成成功回答；仓库 npm run check、npm run dev、npm run demo:protocol、npm run demo:runtime 均通过。
- 证据：仅使用 Fake Provider 和本地 Runtime；没有真实盘古、付费模型或网络调用。
- 限制：Pangu Provider 明确不声明 toolCalling/structuredOutput/vision；文字 JSON 提案只有离线验证。真实盘古工具闭环、ModelPort/CoordinationPort 依赖倒置、多 Agent、流式输出和真实连接器仍未完成；ARCH-03 已将 `task.submit` 后的执行分派和生命周期管理收归 Runtime Application。

### DESKTOP-01 当前工作包（2026-09-05）

- 任务：原版定稿移植；MOD-11/12/13；PA-001/002/004。负责人 zemeng；待评审者 goo122（未发出评审请求）。
- 分支 codex/desktop-final；依赖底座提交 002e88a，公共客户端/契约 0.1.0-alpha.1。根配置、锁文件与公共 Schema 保持原样。
- 范围：apps/desktop 内 Electron 窗口、orb/conversation/admin/ui、模块入口与测试；状态 review，未提交、未合并，不代表整个模块完成。
- 实测：底座 build；关键测试 2/2；Electron 44.2.0 原生 90px 热区、离开收起、拖动抑制、372px 面板、SDK 提交取消、独立后台关闭后任务保留及取消确认终态；无页面异常。实际截图已直接观察。
- 外观证据：恢复后的原版与产品待机球体在原稿 132px 画布下逐像素一致，170 点。恢复覆盖 10 个设计源码/说明文件，修改前内容另留备份。
- 环境：Windows，Node 26.3.0 / npm 11.16.0；与底座声明的 Node 24.15.x 不同，目标 Node 版本待集成环境验证。
- 继续入口：[桌面模块说明](../apps/desktop/README.md)。真实 Runtime、语音、模型、账号配置、物理多屏/DPI、系统背景模糊及分发仍待接入/验收；fake 仅在显式联调模式使用。
