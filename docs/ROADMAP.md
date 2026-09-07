# 开发计划与进度

更新：2026-09-07 · 当前阶段：M1 Runtime Application 与权限/工具宿主、M2 天气连接器垂直集成 · 应用实现：MOD-01/02/03/25 已按当前边界集成，ARCH-03 进入评审，MOD-04/05 与桌面增量继续评审

本文维护工作状态，需求以 PRD 为准。模块负责人和独占目录唯一登记在 [模块分工](MODULE_ASSIGNMENTS.md)，契约见 [公共开发协议](DEVELOPMENT_PROTOCOL.md)。`goo122`（A）负责底座、公共协议和 Obsidian；`zemeng`（B）负责桌面与执行模块；`Potatos498`（C）负责分配到的信息连接器。阶段不代表承诺日期；正式排期需根据比赛时间、团队人数和接口验证结果确定。

### ARCH-03：Runtime Application 自主管理任务分派

- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`。
- 分支：`codex/arch-03-runtime-dispatch`；状态：`review`（基于已合并到 DOC-01 堆叠分支的 ARCH-02）。
- 范围：Runtime Application 持有 `TaskRuntime`、文本应用和活动执行注册表；`task.submit` 成功后由 Runtime 自动启动文本任务；Desktop 只提交任务、订阅事件、展示状态和管理可信模型配置。
- 验收：公开 `@personal-agent/runtime/application` 入口；重复提交不重复执行；Unavailable、取消、事件顺序和活动任务关闭保护有测试；Desktop 架构门禁禁止 Agent/Model 直连、旧 `runtime/text` 入口和直接 `runTask`。
- 限制：仍是 Electron 主进程内的 Runtime Application，不是独立守护进程或 IPC 服务；当前文本切片不注册工具，思考参数尚未进入 Runtime 公共契约；真实盘古和外部账号未在本轮调用。
### ARCH-01：目录与依赖治理

- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`。
- 分支：`codex/architecture-standard`；状态：`done`（PR #16 已由非作者评审并于 `87d0974` 合并）。
- 范围：项目目录规范、ADR、模块模板、架构门禁，以及移除 `packages/agents → apps/runtime` 反向生产依赖；不新增业务能力、不拆 Runtime 进程、不移动其他协作者 worktree。
- 验收：根级生产 `src/` 移除；`npm run check:architecture` 已检查 11 个 workspace 的 README、公开入口、依赖声明、依赖方向、连接器边界、公共 exports、跨包相对导入和循环依赖；全 workspace 类型检查通过，测试 106 项为 105 通过、1 项真实 Open-Meteo 验收按设计跳过。
- 完成边界：已满足目录、依赖门禁和测试验收，并完成非作者评审与主分支合并；ARCH-01 不包含 Runtime 进程拆分或 Agent/Model 编排迁移。

### ARCH-02：Runtime Application 编排边界

- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`。
- 分支：`codex/arch-02-runtime-application`；状态：`merged-to-stack`（PR #21 已合并到 DOC-01 堆叠分支，待随集成分支回流 main）。
- 范围：将 Agent/Model 选择、ModelGateway、文字 Agent 执行、Fake/Unavailable/Pangu 模式和连接测试移入 `apps/runtime/src/application/`；通过 `@personal-agent/runtime/text` 公开入口供 Desktop 调用。
- 不在范围：不拆 Runtime 进程、不新增 IPC 协议、不把 API Key 暴露给 Renderer、不接入工具调用或真实付费模型。
- 验收：Desktop Electron 生产代码不再导入 `@personal-agent/agents` 或 `@personal-agent/models`；Runtime 显式声明 Agent/Model 依赖；Fake、Unavailable、取消语义保持有效；架构门禁、全 workspace 类型检查和全仓测试通过。
- 剩余限制：模型配置与 Windows 加密存储仍由可信 Desktop 主进程负责；文字任务当前只读且不注册工具；Runtime 仍是 Electron 进程内的模块化应用层，不等同于独立守护进程。

## 1. 里程碑

### MOD-04/05 离线验收增量（2026-09-07，待评审）

负责人 goo122；分支 `codex/mod-04-05-acceptance`，工作树 `.worktrees/mod-04-05-acceptance`；基线 `0f7dc1e` 已包含合并后的 ARCH-03 / PR #24。本轮新增文字 JSON 工具提案、模型网关超时取消、SQLite 授权与参数绑定、持久审批和 Agent 恢复、工具执行证据与幂等重放。全仓 check、18 项定向测试和两项桌面 smoke 通过，详见 [本轮验收记录](modules/MOD-04-05-ACCEPTANCE.md)。

用户选择先完成离线交付，真实模型与天气调用未执行。MOD-04/05 保持 review；历史记录中的“授权完全为内存”描述由本轮增量补齐，但不代表跨任务持续授权、真实 SecretStore、流式、多 Agent 或真实写入恢复已经完成。后续先评审本地提交，再安排真实盘古验收。

| 阶段 | 交付 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| M0 设计基线 | PRD、架构、协作规范、工作包 | 文档检查通过；待决项登记 | 文档已建立，见下方检查记录 |
| M1 基础闭环 | 窗口、Runtime、盘古、工具、语音基础 | 真实请求到工具与验证链路；取消有效 | MOD-01/02 已集成；MOD-03 本地验证通过，闭环未完成 |
| M2 首次可用 | Obsidian、提醒、研究天气、TraceGuard 只读、全部 P0 | 所有 P0 逐项验收，不只演示单场景 | 未开始 |
| M3 信息管家 | 邮件、日历、订阅、通知、专业协作 | 真实连接器增量同步与授权写入验证 | 未开始 |
| M4 行动与扩展 | 电脑控制、编程、治理、流程学习、社交扩展 | 指定应用可控可验证；平台能力矩阵有证据 | 未开始 |
| M5 参赛/分发 | 演示、打包、技术贡献材料 | 规则核验、真实证据、隔离安装运行卸载 | 未开始 |

## 2. 模块执行台账

MOD-01/02 已通过 PR #1 评审并集成，MOD-03 已通过 PR #5 集成；MOD-25 的源码、Runtime 根装配和地理编码/缺省日期修复已分别通过 PR #4、PR #9、PR #12 完成非作者评审并合并。MOD-04/05 的本地 Fake 验收已完成，但真实模型、持久化授权和 Evidence 等边界仍保持 review。桌面 PR #18 已合并为交互里程碑，MOD-11/12/13 仍按未完成项保持 in_progress。PR #8 已通过代码评审但当前与 main 冲突，PR #19 已通过 CI 但作者为 `goo122`，仍等待非作者评审。其他具体模块仍需用户明确授权后开工。每行可拆多个子任务，只有全部约定交付通过后模块才为 done。

| 模块 ID | 计划阶段 | 状态 | 当前执行人 / PR / 证据 |
| --- | --- | --- | --- |
| MOD-01 | M1 起步门槛 | done | goo122 / PR #1 / 合并提交 dbbc547 / 构建、迁移和存储测试通过 |
| MOD-02 | M1 起步门槛 | done | goo122 / PR #1 / 合并提交 dbbc547 / 26 项联合测试及评审通过；协议待多消费端冻结 |
| MOD-03 | M1/M2 | done | goo122 / PR #5 / 合并提交 e14aebf / 7 项 Runtime 测试及评审通过 |
| MOD-04 | M1 主模型、M3 专业协作 | review | goo122 / PR #10、#11 已由 `zemeng` 评审并合并；Fake 垂直集成与仓库 check 通过，真实盘古、流式输出、多 Agent 尚未验收 |
| MOD-05 | M1/M2 | review | goo122 / PR #7 已由 `zemeng` 评审并合并；任务绑定授权、策略校验工具网关、受限凭据连接器宿主及公共 Client→Runtime→工具闭环已本地验证，持久化权限与 Evidence 尚未完成 |
| MOD-06 | M2 | todo | 未启动 |
| MOD-07 | M2 | todo | 未启动 |
| MOD-08 | M2 | todo | 未启动 |
| MOD-09 | M4 | todo | 未启动 |
| MOD-10 | M4 后研究，无交付日期承诺 | todo | 未启动 |
| MOD-11 | M1 | in_progress | `zemeng` / PR #13、#14、#18 已合并；窗口与安全桥可运行，但托盘、真实 Runtime 稳定性和 DPI 透明命中区域问题仍未关闭 |
| MOD-12 | M1 | in_progress | `zemeng` / PR #18 已合并；文字交互、状态展示和取消入口可用，连续上下文、真实事件与语音仍未接入 |
| MOD-13 | M1 基础页面、M2 配置闭环 | in_progress | `zemeng` / PR #13、#18 已合并；后台骨架与空状态可用，模型/连接器配置和授权闭环未完成 |
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
| MOD-25 | M2 | done | `Potatos498` / PR #4（`9f27e9b`）、PR #12（`5b833c9`）与 Runtime 装配 PR #9（`89c0464`）均已合并并完成非作者评审；根 `npm run check` 退出码 0，全仓 119 项 116 通过＋3 跳过，`PA_WEATHER_LIVE=1` 下 38/38 通过。manifest 仍为 `conditional`，不等同于长期生产稳定性验收。后续增强工作包进行中：地理编码 GeoNames 第二源（分支 `feat/mod-25-geonames`，用户 2026-09-07 授权，见下方变更记录） |
| MOD-26 | M4 起逐平台验收 | todo | `Potatos498` 已登记，未授权启动 |

### 2.1 开工顺序与阻塞边界

1. `goo122` 已交付并集成 MOD-01/MOD-02/MOD-03；协议包可用于开发联调，但尚未冻结。
2. MOD-25 已由 `Potatos498` 完成当前工作包边界并合并；假时钟与假 ToolHost 用于离线测试，Open-Meteo 真实读回保持 `conditional`。`zemeng` 和其他未启动模块仍需获得用户授权后开工。
3. 真实联调依赖盘古凭据、授权测试 Vault 和 Runtime。缺少账号时可继续无账号模块，但不标记真实连接通过。
4. 首次联调为面板→盘古→知识检索→来源展示。语音、提醒、天气、MCP、Skills、TraceGuard 只读及权限的 P0 验收随后逐项完成。
5. 公共目录、锁文件和迁移由 `goo122` 集成；`zemeng` 与待认领协作者交付注册入口，不同时编辑应用根装配。

### 2.2 原工作包迁移关系

旧 W 编号保留用于历史检索，执行状态只更新上方 MOD 台账，不维护两套状态。

| 旧 ID | 新模块 | 拆分说明 |
| --- | --- | --- |
| W-001 | MOD-04 | 盘古环境验证作为模型模块前置工作 |
| W-002 | MOD-01 | 根工程与存储底座 |
| W-003 | MOD-02、MOD-03、MOD-05 | 分开协议、任务和授权 |
| W-004 | MOD-11、MOD-12、MOD-13 | 分开外壳、悬浮交互与后台 |
| W-005 | MOD-04 | 盘古与专业模型适配 |
| W-006 | MOD-06、MOD-07 | MCP 与 Skills 独立交付 |
| W-007 | MOD-14 | 基础语音归 `zemeng` |
| W-008 | MOD-08 | Obsidian 归 `goo122` |
| W-009 | MOD-03、MOD-20、MOD-24、MOD-25 | 调度核心、日程、搜索、天气分开 |
| W-010 | MOD-17 | TraceGuard 适配归 `zemeng` |

## 3. 待决与风险

- 赛事：需正式通知确认届次、截止时间和华为技术要求。
- 模型：未验证盘古账号、具体部署、工具调用、成本与限流。
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
- 此记录不构成任何运行时能力通过证明。

## 5. 继续入口

MOD-03 已通过 PR #5 集成，PR #4、#7、#9、#12 已合并；goo122 的 MOD-05×MOD-25 Runtime 垂直集成已验证 Fake Provider 下的 Client→Runtime→Policy→ToolGateway→weather.forecast 链路，生产 Open-Meteo 以 `strict` 组合入口注册。MOD-25 当前工作包已完成；MOD-05 仍因权限持久化、真实 SecretStore、Evidence 和恢复执行器保持 review。PR #8 等待负责人解决合并冲突，PR #19 等待非作者评审。

### MOD-25 当前工作包

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
- 交付：14 操作与 9 类事件 Schema、生成 TypeScript 类型和漂移检查、客户端、JSONL 分帧、六种 Fake 场景、Fake 工具/时钟/存储/连接器、消费者和提供者示例。
- 验收：根 npm run check 共 26 项测试通过（storage 4、contracts 4、client 5、testkit 13），包含 SQLite 事件持久化后迁移及回放；npm run demo:protocol 通过。
- 证据：[testkit 说明](../packages/testkit/README.md)；wire 1.0.0、开发包 0.1.0-alpha.1，未冻结。项目内独立源码副本 .cache/clean-mod-02 的 npm ci、check（26/26）、dev、demo:protocol 全部通过。
- 限制：进程内 Mock 不能替代 Electron/C# 和第三方连接器联调；协议尚未冻结；无真实平台调用。

### MOD-01 完成记录

- 任务：M1-A-001 / 工程与存储底座；关联 MOD-01 / PA-004。
- 负责人：goo122；PR #1 已评审并集成，合并提交 dbbc547。
- 范围：根配置与锁文件、packages/storage、scripts/dev、公共 CI，以及对应说明和状态文档。
- 依赖：无模型或真实账号；使用本机已验证 Node 24.15.0、npm 11.12.1。
- 交付：npm 工作区、严格 TypeScript 构建、SQLite WAL 连接和事务迁移、独立存储示例。
- 验收：类型检查和 4 项存储测试通过；跨进程持久化、迁移保留数据、失败回滚通过；独立源码副本 npm ci/check/dev 通过。
- 证据：[存储说明与验证记录](../packages/storage/README.md)、PR #1 和合并提交 dbbc547。
- 排除：公共 SDK、桌面、Runtime 任务状态机、模型与真实平台调用；PA-004 整体未完成。

### MOD-05 当前工作包

- 任务：M1-A-005 / 权限、工具与连接器宿主首片；关联 MOD-05 / PA-023。
- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`；状态：review。
- 范围：`packages/policy/`、`packages/tool-gateway/`、`packages/connector-host/`，以及 `packages/client/`、`apps/runtime/` 和根工作区的必要兼容装配；不接真实账号或天气生产请求。
- 交付：授权引用绑定任务、工具、scope、到期时间和可选次数并支持撤销；工具输入/输出校验、用户在场、deadline、取消与外部写入 `RESULT_UNKNOWN`；连接器声明式凭据白名单、注册/健康/生命周期和同连接器并发连接锁；公共 Client 可携带任务 ID，经 Runtime 发现并调用工具，Runtime 仅允许 running 任务执行并记录 confirmed/unknown 的 `tool.completed` 事件。
- 验收：无授权或伪造引用拒绝；调用者不能自报 scope；一次性授权只在通过输入与权限检查后消耗；外部写入中断不盲目重试；未声明凭据拒绝；并发连接只创建一个实例；全部测试只使用内存策略、假工具和假 SecretStore。
- 证据：[授权策略](../packages/policy/README.md)、[工具网关](../packages/tool-gateway/README.md)、[连接器宿主](../packages/connector-host/README.md)；Node 24.15.0 / npm 11.12.1 下根 `npm run check` 通过，全仓 82 项为 81 通过＋1 项天气真实读回默认跳过，其中 MOD-05 定向 14 项、Runtime 8 项（含公共 Client→授权工具闭环）；`npm run dev`、`demo:protocol`、`demo:runtime` 均通过。
- 限制：授权和账号会话尚未持久化，重启后失效；无审批 UI、持续授权管理、真实 SecretStore、工具运行证据存储和恢复执行器；这些条件未满足前 MOD-05 不得转为 done。

### MOD-05 × MOD-25 垂直集成当前工作包

- 任务：M1-A-005I / MOD-05 与 MOD-25 首条 Runtime 垂直集成；关联 PA-010、PA-023。
- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`；状态：review。
- 范围：`apps/runtime/src/weather-runtime.ts`、Runtime package/export、根 workspace/build 装配和 Runtime 集成测试；不修改 `packages/connectors/weather/` 内部实现。
- 交付：`createWeatherRuntime` 组合入口、严格模式 `createOpenMeteoRuntime`、显式 Provider 注入、Client→Runtime→Policy→ToolGateway→weather.forecast 链路测试。
- 验收证据：Runtime 定向测试 11/11；根 `npm run check` 通过；`npm run dev`、`npm run demo:protocol`、`npm run demo:runtime` 通过；weather 全包 34 项为 33 通过 + 1 项真实读回默认跳过。
- 已验证：授权成功、撤销后拒绝、非 running 任务在 Provider 调用前拒绝、生产严格 Open-Meteo 注册不发起网络请求；测试仅使用显式 `FakeWeatherProvider`。
- 剩余限制：授权、连接器会话和 Evidence 仍为内存能力；真实 Open-Meteo 长期稳定性与多时段采样未验收；这些是 MOD-05 或真实生产验收边界，不否定 MOD-25 当前工作包已完成。

### MOD-04 当前工作包

- 任务：M1-A-004A / 模型网关与单主 Agent 有界执行循环；关联 MOD-04 / PA-003、PA-012。
- 负责人：goo122；PR #10、#11 已由非作者评审并合并；状态：review（当前工作包已合并，真实盘古与完整 Agent 能力仍未验收）。
- 范围：packages/models、packages/agents、根构建入口与对应测试/说明。
- 交付：能力声明与验证等级、Fake/Unavailable/Pangu 占位 Provider、模型 deployment/usage 记录、工具提案校验、一次修复上限、maxSteps/maxTokens/deadline/取消边界、RuntimeToolInvoker 和 unknown reconciliation 回调。
- 验收：模型测试 4/4；Agent 测试 4/4；Fake 天气请求经过 Runtime、Policy、ToolGateway；模型不能提供授权；unknown 不生成成功回答；仓库 npm run check、npm run dev、npm run demo:protocol、npm run demo:runtime 均通过。
- 证据：仅使用 Fake Provider 和本地 Runtime；没有真实盘古、付费模型或网络调用。
- 限制：真实盘古适配与 PA-003 真实请求验收、多 Agent 专家调度、流式输出和真实连接器仍未完成；后续 ARCH-03 将把 task.submit 后的执行分派和生命周期管理收归 Runtime Application。

### DESKTOP-01 当前工作包（2026-09-05）

- 任务：原版定稿移植；MOD-11/12/13；PA-001/002/004。负责人 zemeng；待评审者 goo122（未发出评审请求）。
- 分支 codex/desktop-final；依赖底座提交 002e88a，公共客户端/契约 0.1.0-alpha.1。根配置、锁文件与公共 Schema 保持原样。
- 范围：apps/desktop 内 Electron 窗口、orb/conversation/admin/ui、模块入口与测试；状态 review，未提交、未合并，不代表整个模块完成。
- 实测：底座 build；关键测试 2/2；Electron 44.2.0 原生 90px 热区、离开收起、拖动抑制、372px 面板、SDK 提交取消、独立后台关闭后任务保留及取消确认终态；无页面异常。实际截图已直接观察。
- 外观证据：恢复后的原版与产品待机球体在原稿 132px 画布下逐像素一致，170 点。恢复覆盖 10 个设计源码/说明文件，修改前内容另留备份。
- 环境：Windows，Node 26.3.0 / npm 11.16.0；与底座声明的 Node 24.15.x 不同，目标 Node 版本待集成环境验证。
- 继续入口：[桌面模块说明](../apps/desktop/README.md)。真实 Runtime、语音、模型、账号配置、物理多屏/DPI、系统背景模糊及分发仍待接入/验收；fake 仅在显式联调模式使用。
