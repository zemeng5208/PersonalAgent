# 开发计划与进度

更新：2026-09-06 · 当前阶段：M1 底座与联调 SDK 本地验证 · 应用实现：MOD-01/02/25 待评审，其余未开始

本文维护工作状态，需求以 PRD 为准。模块负责人和独占目录唯一登记在 [模块分工](MODULE_ASSIGNMENTS.md)，契约见 [公共开发协议](DEVELOPMENT_PROTOCOL.md)。`goo122`（A）负责底座、公共协议和 Obsidian；`zemeng`（B）负责桌面与执行模块。阶段不代表承诺日期；正式排期需根据比赛时间、团队人数和接口验证结果确定。

## 1. 里程碑

| 阶段 | 交付 | 退出条件 | 当前状态 |
| --- | --- | --- | --- |
| M0 设计基线 | PRD、架构、协作规范、工作包 | 文档检查通过；待决项登记 | 文档已建立，见下方检查记录 |
| M1 基础闭环 | 窗口、Runtime、盘古、工具、语音基础 | 真实请求到工具与验证链路；取消有效 | MOD-01 本地验证通过，闭环未完成 |
| M2 首次可用 | Obsidian、提醒、研究天气、TraceGuard 只读、全部 P0 | 所有 P0 逐项验收，不只演示单场景 | 未开始 |
| M3 信息管家 | 邮件、日历、订阅、通知、专业协作 | 真实连接器增量同步与授权写入验证 | 未开始 |
| M4 行动与扩展 | 电脑控制、编程、治理、流程学习、社交扩展 | 指定应用可控可验证；平台能力矩阵有证据 | 未开始 |
| M5 参赛/分发 | 演示、打包、技术贡献材料 | 规则核验、真实证据、隔离安装运行卸载 | 未开始 |

## 2. 模块执行台账

用户已授权启动并测试 MOD-01、MOD-02，并授权 `Potatos498` 启动 MOD-25；其余待认领模块的 GitHub 用户名尚未登记。启动时填写 GitHub 负责人、评审者、分支及子任务；模块级负责人以分工文档为准。每行可拆多个子任务，只有全部约定交付通过后模块才为 done。

| 模块 ID | 计划阶段 | 状态 | 当前执行人 / PR / 证据 |
| --- | --- | --- | --- |
| MOD-01 | M1 起步门槛 | review | goo122 / feat/mod-01-foundation / 本地验证通过，待 zemeng 评审及 PR 集成 |
| MOD-02 | M1 起步门槛 | review | goo122 / 当前 feat/mod-01-foundation / 26 项联合测试通过，待消费端验证、PR 和评审 |
| MOD-03 | M1/M2 | todo | 未启动 |
| MOD-04 | M1 主模型、M3 专业协作 | todo | 未启动 |
| MOD-05 | M1/M2 | todo | 未启动 |
| MOD-06 | M2 | todo | 未启动 |
| MOD-07 | M2 | todo | 未启动 |
| MOD-08 | M2 | todo | 未启动 |
| MOD-09 | M4 | todo | 未启动 |
| MOD-10 | M4 后研究，无交付日期承诺 | todo | 未启动 |
| MOD-11 | M1 | todo | `zemeng` 已确定，未启动 |
| MOD-12 | M1 | todo | `zemeng` 已确定，未启动 |
| MOD-13 | M1 基础页面、M2 配置闭环 | todo | `zemeng` 已确定，未启动 |
| MOD-14 | M1 基础、M2 验收 | todo | `zemeng` 已确定，未启动 |
| MOD-15 | M4 后扩展 | todo | `zemeng` 已确定，未启动 |
| MOD-16 | M2 TraceGuard 所需只读端口、M4 电脑操作 | todo | `zemeng` 已确定，未启动 |
| MOD-17 | M2 只读、M4 治理 | todo | `zemeng` 已确定，未启动 |
| MOD-18 | M4 | todo | `zemeng` 已确定，未启动 |
| MOD-19 | M5 | todo | `zemeng` 已确定，未启动 |
| MOD-20 | M2 本地提醒、M3 日历 | todo | 未启动 |
| MOD-21 | M3 | todo | 未启动 |
| MOD-22 | M3 | todo | 未启动 |
| MOD-23 | M3 | todo | 未启动 |
| MOD-24 | M2 | todo | 未启动 |
| MOD-25 | M2 | review | `Potatos498` / PR #4（feat/mod-25-weather）/ 本地 27 项测试通过（含真实读回），待评审与根装配集成 |
| MOD-26 | M4 起逐平台验收 | todo | 未启动 |

### 2.1 开工顺序与阻塞边界

1. `goo122` 交付 MOD-01/MOD-02：工程、契约、fake Runtime 与消费者示例。当前是协议草案，不是已冻结接口。
2. `zemeng` 用 fake 开发 MOD-11/12/13；`goo122` 推进 MOD-03/04/05/08；`Potatos498` 已用假时钟和假 ToolHost 推进 MOD-25，待认领协作者可按同一方式开发 MOD-22。
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
- 工程：合并后的 main 上根 `npm run check` 在 `packages/contracts` 的 `check:generated` 步骤失败（提示生成文件陈旧），`typecheck` 与 `test` 因此根本不执行。已在不含 MOD-25 改动的干净检出上复现，main 的 CI 运行 34006560474（PR #1 合并）与 34006694534（PR #3 合并）也失败在同一步，属既有问题；需 `goo122` 重新生成或修正漂移检查，否则各 PR 的 CI 验收受阻。
- 自训练：首期仅偏好与流程学习；参数训练作为研究项。
- 视觉：尚无渲染稿；进入设计时使用用户指定的 Open Design 位置。

## 4. 文档检查记录

- 2026-09-05：已建立 7 份 Markdown 文档（含 README 和 PR 模板）；仓库链接检查通过，23 个需求编号无重复、无未知引用。Git 已跟踪改动的差异空白检查通过。
- 2026-09-05：新增模块分工与公共开发协议草案；拆为 26 个模块并同步 `goo122`、`zemeng` 与待认领协作者职责，保留旧 W 编号映射。协议尚未冻结、SDK 尚未实现。
- 2026-09-05：检查 10 份 Markdown 文档，仓库链接及编号检查通过；23 项需求全部有模块承接，26 个模块全部进入台账，无重复模块编号或冲突标记。已跟踪差异空白检查通过。
- 2026-09-06：登记 MOD-25 天气连接器工作包与执行人 `Potatos498`，同步台账状态、开工顺序与风险项；ROADMAP 相对链接与模块编号一致性检查通过。
- 2026-09-06：MOD-25 接入 Open-Meteo 真实提供商，更新工作包的交付、验收、证据与限制及台账证据；真实读回与模拟验证分开记录，manifest `verification` 由 `mock` 改为 `conditional`。ROADMAP 相对链接检查通过。
- 此记录不构成任何运行时能力通过证明。

## 5. 继续入口

MOD-01、MOD-02 已在当前 feat/mod-01-foundation 实现。MOD-01 原有未提交改动完整保留；用户要求继续 MOD-02 后在同一工作分支追加，不擅自提交或切换共享分支。下一步按模块拆分评审工作包，运行远程 CI，由 zemeng 消费预发布 SDK、复验取消往返并记录实际版本和提交号；经评审集成后再冻结公共协议和开始后续模块。

### MOD-25 当前工作包

- 任务：M2-C-025 / 天气连接器；关联 MOD-25 / PA-010。
- 负责人：`Potatos498`；评审者：`goo122` 或 `zemeng`（待评审）；状态以模块台账为准。
- 范围：`packages/connectors/weather/` 独占目录。根 `package.json` 工作区通配和锁文件归 `goo122` 所有，本 PR 附带最小改动待其确认集成；不涉及公共契约修改。
- 输入与依赖：明确地点或配置的默认地点、日期、单位；依赖 MOD-02 的 `ConnectorItem` 契约与 `ConnectorPort`，以及 testkit 的假时钟和假 ToolHost。真实数据来自 Open-Meteo（免密钥、无账号）。
- 交付：可替换的 `WeatherProvider` 抽象、**Open-Meteo 真实提供商**（地理编码＋预报、错误码映射、单位与 WMO 天气代码映射）、4 条离线夹具、`WeatherService`（地点不静默猜测、地点解析结果显式披露、缓存状态 fresh/fetched/stale 可见、发布/抓取/有效期三个时间分离且时间来源类型显式标注）、`WeatherConnector` 清单与生命周期、`register(host)` 注册只读工具 `weather.forecast`、27 项测试与包 README。
- 验收：`npm run typecheck --workspaces` 与 `npm run test --workspaces` 全绿（weather 27 项：26 通过 + 1 项真实读回默认跳过；全仓 53 项）。地点缺失时抛 `INVALID_ARGUMENT` 而非猜测；地名歧义时 `ranked` 披露解析结果与候选、`strict` 直接拒绝；缓存命中不调用提供商；提供商失败时返回 stale 缓存并带 `lastError`。真实读回与模拟测试分开，需 `PA_WEATHER_LIVE=1` 显式开启。
- 证据：[weather 说明](../packages/connectors/weather/README.md)（含 2026-09-06 对生产端点的真实读回原始输出，并与 `curl` 直取的响应交叉核对）。manifest `verification` 为 `conditional`。根 `npm run check` 因下述既有 `check:generated` 失败未能整体通过。
- 限制：Open-Meteo 不返回预报发布时间，`occurredAt` 是覆盖日起点，已由 `publishedTimeKind: 'coverage_start'` 显式标注而非用抓取时间冒充；`conditional` 依赖出站网络可达，本轮仅验证少量地点与近日日期；摘要文本仅中英两套；缓存为实例内存级；未接入根装配，也未实现 MOD-05 权限隔离。

### MOD-02 当前工作包

- 任务：M1-A-002 / 公共协议与联调 SDK；关联 MOD-02 / PA-004、PA-023。
- 负责人：goo122；评审者：zemeng（待实际消费端验证）；状态以模块台账为准。
- 范围：packages/contracts、packages/client、packages/testkit、对应示例与根依赖装配；依赖 MOD-01 的本地底座。
- 交付：14 操作与 9 类事件 Schema、生成 TypeScript 类型和漂移检查、客户端、JSONL 分帧、六种 Fake 场景、Fake 工具/时钟/存储/连接器、消费者和提供者示例。
- 验收：根 npm run check 共 26 项测试通过（storage 4、contracts 4、client 5、testkit 13），包含 SQLite 事件持久化后迁移及回放；npm run demo:protocol 通过。
- 证据：[testkit 说明](../packages/testkit/README.md)；wire 1.0.0、开发包 0.1.0-alpha.1，未冻结。项目内独立源码副本 .cache/clean-mod-02 的 npm ci、check（26/26）、dev、demo:protocol 全部通过。
- 限制：进程内 Mock 不能替代 zemeng 的 Electron/C# 联调；未实现 MOD-03 持久任务引擎或 MOD-05 真实权限隔离；无真实平台调用、PR、他人评审与合并证据。

### MOD-01 当前工作包

- 任务：M1-A-001 / 工程与存储底座；关联 MOD-01 / PA-004。
- 负责人：goo122；评审者：zemeng（待评审）；状态以模块台账为准。
- 范围：根配置与锁文件、packages/storage、scripts/dev、公共 CI，以及对应说明和状态文档。
- 依赖：无模型或真实账号；使用本机已验证 Node 24.15.0、npm 11.12.1。
- 交付：npm 工作区、严格 TypeScript 构建、SQLite WAL 连接和事务迁移、独立存储示例。
- 验收：类型检查和 4 项存储测试通过；跨进程持久化、迁移保留数据、失败回滚通过；独立源码副本 npm ci/check/dev 通过。
- 证据：[存储说明与验证记录](../packages/storage/README.md)。PR 尚未创建；远程 CI、非作者评审、合并及干净机器验收未完成。
- 排除：公共 SDK、桌面、Runtime 任务状态机、模型与真实平台调用；PA-004 整体未完成。
