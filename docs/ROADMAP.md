# 开发计划与进度

更新：2026-09-06 · 当前阶段：M1 权限与工具宿主、M2 天气连接器垂直集成 · 应用实现：MOD-01/02/03 已集成，MOD-05 首片与 MOD-25 源码已合并，垂直集成待评审

本文维护工作状态，需求以 PRD 为准。模块负责人和独占目录唯一登记在 [模块分工](MODULE_ASSIGNMENTS.md)，契约见 [公共开发协议](DEVELOPMENT_PROTOCOL.md)。`goo122`（A）负责底座、公共协议和 Obsidian；`zemeng`（B）负责桌面与执行模块；`Potatos498`（C）负责分配到的信息连接器。阶段不代表承诺日期；正式排期需根据比赛时间、团队人数和接口验证结果确定。

### ARCH-01：目录与依赖治理

- 负责人：`goo122`；评审者：`zemeng` 或 `Potatos498`。
- 分支：`codex/architecture-standard`；状态：`review`。
- 范围：项目目录规范、ADR、模块模板、架构门禁，以及移除 `packages/agents → apps/runtime` 反向生产依赖；不新增业务能力、不拆 Runtime 进程、不移动其他协作者 worktree。
- 验收：根级生产 `src/` 移除；`npm run check:architecture` 已检查 11 个 workspace 的 README、公开入口、依赖声明、依赖方向、连接器边界、公共 exports、跨包相对导入和循环依赖；全 workspace 类型检查通过，测试 106 项为 105 通过、1 项真实 Open-Meteo 验收按设计跳过。
- 完成边界：本地通过后进入 review，非作者评审并合并前不视为完成。

## 1. 里程碑

| 阶段 | 交付 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| M0 设计基线 | PRD、架构、协作规范、工作包 | 文档检查通过；待决项登记 | 文档已建立，见下方检查记录 |
| M1 基础闭环 | 窗口、Runtime、盘古、工具、语音基础 | 真实请求到工具与验证链路；取消有效 | MOD-01/02 已集成；MOD-03 本地验证通过，闭环未完成 |
| M2 首次可用 | Obsidian、提醒、研究天气、TraceGuard 只读、全部 P0 | 所有 P0 逐项验收，不只演示单场景 | 未开始 |
| M3 信息管家 | 邮件、日历、订阅、通知、专业协作 | 真实连接器增量同步与授权写入验证 | 未开始 |
| M4 行动与扩展 | 电脑控制、编程、治理、流程学习、社交扩展 | 指定应用可控可验证；平台能力矩阵有证据 | 未开始 |
| M5 参赛/分发 | 演示、打包、技术贡献材料 | 规则核验、真实证据、隔离安装运行卸载 | 未开始 |

## 2. 模块执行台账

MOD-01/02 已通过 PR #1 评审并集成，MOD-03 已通过 PR #5 集成；`Potatos498` 的 MOD-25 源码已通过 PR #4 合并。PR #4 在 `goo122` 原批准后追加了真实提供商与跨语言解析提交，因此已补做合并后审计；模块仍需修复地点正确性并完成 MOD-05 权限宿主和 Runtime 根装配后才能转为 done。其他具体模块仍需用户明确授权后开工。每行可拆多个子任务，只有全部约定交付通过后模块才为 done。

| 模块 ID | 计划阶段 | 状态 | 当前执行人 / PR / 证据 |
| --- | --- | --- | --- |
| MOD-01 | M1 起步门槛 | done | goo122 / PR #1 / 合并提交 dbbc547 / 构建、迁移和存储测试通过 |
| MOD-02 | M1 起步门槛 | done | goo122 / PR #1 / 合并提交 dbbc547 / 26 项联合测试及评审通过；协议待多消费端冻结 |
| MOD-03 | M1/M2 | done | goo122 / PR #5 / 合并提交 e14aebf / 7 项 Runtime 测试及评审通过 |
| MOD-04 | M1 主模型、M3 专业协作 | review | goo122 / codex/feat-mod-04-model-gateway / Fake 垂直集成与仓库 check 通过，待 PR 评审 |
| MOD-05 | M1/M2 | review | goo122 / codex/feat-mod-05-tool-host / 任务绑定授权、策略校验工具网关、受限凭据连接器宿主及公共 Client→Runtime→工具闭环已本地验证，待非作者评审 |
| MOD-06 | M2 | todo | 未启动 |
| MOD-07 | M2 | todo | 未启动 |
| MOD-08 | M2 | todo | 未启动 |
| MOD-09 | M4 | todo | 未启动 |
| MOD-10 | M4 后研究，无交付日期承诺 | todo | 未启动 |
| MOD-11 | M1 | in_progress | `zemeng`：桌面窗口增量待评审；托盘、根装配未完成 |
| MOD-12 | M1 | in_progress | `zemeng`：原版 ORB-02 / 面板增量待评审；真实事件接入未完成 |
| MOD-13 | M1 基础页面、M2 配置闭环 | in_progress | `zemeng`：独立后台与真实空状态增量待评审；配置闭环未完成 |
| MOD-14 | M1 基础、M2 验收 | todo | `zemeng` 已确定，未启动 |
| MOD-15 | M4 后扩展 | todo | `zemeng` 已确定，未启动 |
| MOD-16 | M2 TraceGuard 所需只读端口、M4 电脑操作 | todo | `zemeng` 已确定，未启动 |
| MOD-17 | M2 只读、M4 治理 | todo | `zemeng` 已确定，未启动 |
| MOD-18 | M4 | todo | `zemeng` 已确定，未启动 |
| MOD-19 | M5 | todo | `zemeng` 已确定，未启动 |
| MOD-20 | M2 本地提醒、M3 日历 | todo | `Potatos498` 已登记，未授权启动 |
| MOD-21 | M3 | todo | `Potatos498` 已登记，未授权启动 |
| MOD-22 | M3 | todo | `Potatos498` 已登记，未授权启动 |
| MOD-23 | M3 | todo | `Potatos498` 已登记，未授权启动 |
| MOD-24 | M2 | todo | `Potatos498` 已登记，未授权启动 |
| MOD-25 | M2 | review | `Potatos498` / PR #4 已合并（main `9f27e9b`）/ `goo122` 已补做最终提交审计；Open-Meteo 真实读回 21/21、离线全仓 66 通过＋1 跳过。仍有简体国外城市误解析、默认日期按 UTC 取值、MOD-05 权限宿主与 Runtime 根装配未完成，不能转为 done |
| MOD-26 | M4 起逐平台验收 | todo | `Potatos498` 已登记，未授权启动 |

### 2.1 开工顺序与阻塞边界

1. `goo122` 已交付并集成 MOD-01/MOD-02/MOD-03；协议包可用于开发联调，但尚未冻结。
2. `Potatos498` 已推进 MOD-25 并接入 Open-Meteo 真实提供商，假时钟与假 ToolHost 仅用于离线测试；`zemeng` 和其他模块仍需获得用户授权后开工。
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
- 此记录不构成任何运行时能力通过证明。

## 5. 继续入口

MOD-03 已通过 PR #5 集成，PR #4 与 PR #7 已合并；当前由 goo122 在独立工作包完成 MOD-05 与 MOD-25 的 Runtime 垂直集成。已验证 Fake Provider 下的 Client→Runtime→Policy→ToolGateway→weather.forecast 链路，生产 Open-Meteo 仅以 strict 组合入口注册，真实网络读回仍需单独验证。MOD-05 与 MOD-25 继续保持 review，待非作者评审、城市解析/日期语义问题处理及持久化权限能力另行完成。

### MOD-25 当前工作包

- 任务：M2-C-025 / 天气连接器；关联 MOD-25 / PA-010。
- 负责人：`Potatos498`；评审者：`goo122`；PR #4 已合并（main `9f27e9b`），最终提交已补做合并后审计。
- 范围：`packages/connectors/weather/`、经 `goo122` 确认的根工作区与锁文件；不修改公共契约。
- 输入与依赖：明确地点或配置的默认地点、日期、单位；依赖 MOD-02 的 `ConnectorItem` 契约与 `ConnectorPort`，以及 testkit 的假时钟和假 ToolHost。真实数据来自 Open-Meteo（免密钥、无账号）。
- 交付：可替换的 `WeatherProvider` 抽象、**Open-Meteo 真实提供商**（**跨语言地理编码**：非英文配置下并行两轮查询、按 GeoNames `id` 合并、精确匹配优先再按人口降序；预报抓取、错误码映射、单位与 WMO 天气代码映射）、显式注入的 4 条离线夹具、`WeatherService`（地点不静默猜测、地点解析结果显式披露、缓存状态 fresh/fetched/stale 可见、发布/抓取/有效期三个时间分离且时间来源类型显式标注、取消处理）、`WeatherConnector` 清单与生命周期、`register(host, options)` 注册只读工具 `weather.forecast`、34 项测试与包 README。
- 验收：根 `npm run check` 退出码 0；`npm run typecheck --workspaces` 与 `npm run test --workspaces` 全绿（weather 34 项：33 通过 + 1 项真实读回默认跳过；全仓 67 项）。地点缺失时抛 `INVALID_ARGUMENT` 而非猜测；地名歧义时 `ranked` 披露解析结果与去重后的候选、`strict` 直接拒绝；配置语言索引缺失的地名仍能经英文轮解析到正确时区（`New York` → `America/New_York` 而非 `Europe/London`）；同名精确匹配由人口而非提供商顺序决定；缓存命中不调用提供商；仅可重试的外部失败回退 stale 缓存并带 `lastError`（含 `retryAfterMs`）；取消不返回 stale 或成功结果；Fake 不会在缺省配置时静默启用（`provider` 必填）；模拟与真实状态分开，真实读回需 `PA_WEATHER_LIVE=1` 显式开启。
- 证据：[weather 说明](../packages/connectors/weather/README.md)（含 2026-09-06 对生产端点的真实读回原始输出、与 `curl` 直取响应的交叉核对，以及 10 个地名的实测解析表——8 个正确、2 个已知失败）。manifest `verification` 为 `conditional`。
- 限制：Open-Meteo 不返回预报发布时间，`occurredAt` 是覆盖日起点，已由 `publishedTimeKind: 'coverage_start'` 显式标注而非用抓取时间冒充；`conditional` 依赖出站网络可达，本轮仅验证少量地点与近日日期；**简体书写的外国地名解析不到或解析错**（`纽约` → `NOT_FOUND`、`东京` → 江苏同名地点），因 `zh` 索引为繁体且不完整、`en` 索引不匹配中文；未传 `date` 时当前按 Runtime 的 UTC 日历日取默认值，目标地点处于另一日时可能请求错误日期；非英文配置下每个未命中缓存的地名产生两次地理编码请求；摘要文本仅中英两套；缓存仅进程内，地理编码缓存无 TTL；`ranked` 模式仍会在披露后选定一个候选；尚未接入 MOD-03 根装配，也未实现 MOD-05 权限隔离。

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
- 剩余限制：授权、连接器会话和 Evidence 仍为内存能力；MOD-25 的简体国外城市解析和省略日期时的 UTC 日期语义仍未修复；真实 Open-Meteo 读回未在本工作包执行；MOD-05/25 不得因此转为 done。

### MOD-04 当前工作包

- 任务：M1-A-004A / 模型网关与单主 Agent 有界执行循环；关联 MOD-04 / PA-003、PA-012。
- 负责人：goo122；分支：codex/feat-mod-04-model-gateway；状态：review。
- 范围：packages/models、packages/agents、根构建入口与对应测试/说明。
- 交付：能力声明与验证等级、Fake/Unavailable/Pangu 占位 Provider、模型 deployment/usage 记录、工具提案校验、一次修复上限、maxSteps/maxTokens/deadline/取消边界、RuntimeToolInvoker 和 unknown reconciliation 回调。
- 验收：模型测试 4/4；Agent 测试 4/4；Fake 天气请求经过 Runtime、Policy、ToolGateway；模型不能提供授权；unknown 不生成成功回答；仓库 npm run check、npm run dev、npm run demo:protocol、npm run demo:runtime 均通过。
- 证据：仅使用 Fake Provider 和本地 Runtime；没有真实盘古、付费模型或网络调用。
- 限制：真实盘古适配与 PA-003 真实请求验收、多 Agent 专家调度、流式输出和真实连接器仍未完成；需创建 PR 并由非作者评审。

### DESKTOP-01 当前工作包（2026-09-05）

- 任务：原版定稿移植；MOD-11/12/13；PA-001/002/004。负责人 zemeng；待评审者 goo122（未发出评审请求）。
- 分支 codex/desktop-final；依赖底座提交 002e88a，公共客户端/契约 0.1.0-alpha.1。根配置、锁文件与公共 Schema 保持原样。
- 范围：apps/desktop 内 Electron 窗口、orb/conversation/admin/ui、模块入口与测试；状态 review，未提交、未合并，不代表整个模块完成。
- 实测：底座 build；关键测试 2/2；Electron 44.2.0 原生 90px 热区、离开收起、拖动抑制、372px 面板、SDK 提交取消、独立后台关闭后任务保留及取消确认终态；无页面异常。实际截图已直接观察。
- 外观证据：恢复后的原版与产品待机球体在原稿 132px 画布下逐像素一致，170 点。恢复覆盖 10 个设计源码/说明文件，修改前内容另留备份。
- 环境：Windows，Node 26.3.0 / npm 11.16.0；与底座声明的 Node 24.15.x 不同，目标 Node 版本待集成环境验证。
- 继续入口：[桌面模块说明](../apps/desktop/README.md)。真实 Runtime、语音、模型、账号配置、物理多屏/DPI、系统背景模糊及分发仍待接入/验收；fake 仅在显式联调模式使用。
