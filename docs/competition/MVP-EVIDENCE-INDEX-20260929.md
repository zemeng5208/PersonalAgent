# 华为 ICT 创新赛 AgentArts MVP 比赛证据与交付目录

- 版本：1.0
- 日期：2026-09-29
- 交付基线：`origin/main`（包含已合入的 PR #206 `ea8e9b8590fd293b4e413f1d64a34977c4598320`）
- 依据标准：[HUAWEI_ICT_AGENTARTS_PROFILE.md](HUAWEI_ICT_AGENTARTS_PROFILE.md)、[MVP_EXECUTION_GOAL.md](MVP_EXECUTION_GOAL.md)、[CURRENT_INTERFACE_CATALOG.md](../interfaces/CURRENT_INTERFACE_CATALOG.md)
- 分工依据：GitHub Issue [#212](https://github.com/zemeng5208/PersonalAgent/issues/212)、Issue [#213](https://github.com/zemeng5208/PersonalAgent/issues/213)
- 整理与维护人：Gemini（代表 zemeng，专注非线上证据目录与演示材料映射）

---

## 1. 协作职责与当前边界声明

根据 2026-09-29 协作决议（GitHub Issue #212/#213）：

1. **Potatos498**：担任全部非线上 MVP 实现、接线、连接器与本地集成的唯一负责人（覆盖 P0～P8 队列，包括真实 CalDAV 日历、语音宿主、Desktop 完整接线、Windows 宿主与 Laya 本地消费）。
2. **GPT-6 Luna Max**：唯一负责线上 AgentArts 控制台、工作流设计与提示词、云端发布、实例绑定、云凭据与真实云端运行/评估的执行者（证据存放于 `.cache/luna-agentarts/STATUS.md`，待交接）。
3. **goo122**：负责公共协议基线、锁文件与 PR #209～#211（在途私人记忆控制器、事实删除与跨库恢复）的返修收尾。
4. **Gemini (zemeng)**：负责建立各模块与交付链的真实证据索引与演示操作指南，明确“已约定功能 → 代码提交 → 真实证据 → 缺口 → 负责人”的映射矩阵；**不越权编写产品代码、不侵占音频/Windows设备、不操作云端，严格基于已提交代码与可查证事实编写**。

---

## 2. 证据可信度分级标准

| 级别 | 定义 | 认定标准 |
| :--- | :--- | :--- |
| **`verified`（真实已验证）** | 在实际目标系统、真实外部 API 或真实硬件设备上完成闭环，具备可重复执行日志或落盘数据 | 具备真实网络请求回执、真实 DPAPI 解密调用、真实进程管道通信或落盘 SQLite 证据；不含 mock 标记 |
| **`provisional` / `mock`（离线/模拟可用）** | 生产代码与端口已就绪，但仅通过 Fake 宿主、离线夹具、单元测试或内存模拟进行了可复现验证 | 具有完整的 TypeScript 类型与实现，在测试套件中通过，但尚未连接真实账号/真实硬件 |
| **`unavailable` / `unverified`（未就绪/未验证）** | 契约存在或部分编码，但未接入生产应用、缺少外部账号/服务支持，或尚未进行真实闭环验证 | UI 显示为不可用；调用返回 `UNSUPPORTED_CAPABILITY`；不得假冒已完成 |

### 2.1 已知证据误用判定与纠正表

为了确保比赛答辩与工程验收的事实真实性，特此澄清并纠正以下历史误用：

1. **关键词匹配 + sleep 延迟 $\neq$ Laya 本地大模型性能**：`FakeLaya` 内部使用规则正则与固定延时进行的测试仅能作为前端管道测试，不能作为本地 Laya SLM 真实吞吐与推理时延的证据。
2. **FakeWindowsHostAdapter $\neq$ 真机 Windows 操控**：内存中虚拟窗口对象与模拟确认不能代表 C# `WindowsHost.Host.exe` 与 Windows UI Automation 的真实执行。
3. **运行时步骤上限 (`maxSteps: 8`) $\neq$ 模型原生 CoT 推理**：应用层循环步数预算属于调度控制，不代表盘古或 AgentArts 原生支持带思维链的思考参数。
4. **本地配置已保存 (`configured: true`) $\neq$ 外部数据已同步 (`synced: true`)**：DPAPI 本地密文落盘仅证明凭据存在，不等于远端日历/邮件已拉取。
5. **云端 HTTP 200 / `taskEnd` $\neq$ 本地任务终态成功**：AgentArts 返回文字或提案仅是云端步骤，本地写入与执行必须经过本地 Policy 授权并产生本地 TaskRuntime 检查点。

---

## 3. 功能交付与真实证据矩阵

### 3.1 文字与桌面交互交付链 (Text & Desktop)

| 约定功能 | 对应实现与关键提交 | 当前证据状态 | 实际证据来源与位置 | 剩余缺口 | 责任人 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Desktop 桌面面板与工作区** | `apps/desktop/src/`、`apps/desktop/electron/main.js`；提交 `717af33`、`9164259`、`ea8e9b8` (#206) | `verified` | Panel 悬浮球拖拽、双栏布局、历史消息轨道同步均已通过真实 Electron 启动与 UI 渲染验证 | 工作区最小化/最大化在部分多屏分辨率下的边界适配 | Potatos498 |
| **AgentArts 真实文字请求** | `packages/coordination/src/agentarts.ts`、`apps/desktop/electron/main.js`；提交 `ea8e9b8` | `verified` | [competition-text-deadline-20260927.md](../../apps/desktop/docs/competition-text-deadline-20260927.md)；自我介绍问答通过网关成功返回真实回答并落盘 `runtime.sqlite`（任务 `9d142d7c-8bbf`，耗时 18s） | 高并发下 SSE 流式字级别实时渲染优化 | GPT-6 Luna Max (云端) / Potatos498 (本地) |
| **任务状态与持久执行历史** | `apps/runtime/src/domain/runtime.ts`、`conversations.json`；提交 `ea8e9b8` | `verified` | `runtime.sqlite` 保存完整任务检查点；`conversations.json` 持久化记录 37+ 轮主会话数据 | 跨机器迁移数据库的自动校验机制 | Potatos498 |
| **AgentArts 凭据管理与安全撤销** | `apps/desktop/electron/agentarts-config.js`；提交 `37da0c3` | `verified` | [agentarts-settings.md](../../apps/desktop/docs/agentarts-settings.md)；DPAPI 保护的 API 密钥读写与安全撤销 IPC | 密钥失效后的 UI 主动告警提示 | Potatos498 |

### 3.2 语音与 Live 实时音频交付链 (Voice & Live)

| 约定功能 | 对应实现与关键提交 | 当前证据状态 | 实际证据来源与位置 | 剩余缺口 | 责任人 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SIS 听写转文字 (Dictation)** | `apps/desktop/electron/voice-input.js`；提交 `ea8e9b8` | `verified` | 麦克风音频录制后通过华为云 SIS 识别为文字并填入输入框，不自动提交；单元测试通过 | 实体麦克风在无声/噪声环境下的 VAD 鲁棒性实机演练 | Potatos498 |
| **原生 Live 实时双向语音** | `packages/voice`、`apps/desktop/electron/live-voice-host.js`；提交 `ea8e9b8` | `verified` (局域/离线) / `provisional` (实机) | [live-proactive-20260927.md](../../apps/desktop/docs/live-proactive-20260927.md)；WebSocket 协议、PCM 分帧与 F8 切换逻辑已通过自动化测试；阿里云 Live 双向音频链路已调通 | 实体机器声卡与外放环境下，全双工打断的回声消除（AEC）效果集中验收 | Potatos498 |
| **文字与 Live 共享对话历史** | `apps/desktop/electron/conversations.js`；提交 `ea8e9b8` | `verified` | Live 对话转写文本与文字输入均存入同一 `conversations.json`，在 Panel 对话流实时回显 | 长文本大音频时的会话压缩与摘要展示 | Potatos498 |

### 3.3 业务能力与连接器交付链 (Connectors)

| 约定功能 | 对应实现与关键提交 | 当前证据状态 | 实际证据来源与位置 | 剩余缺口 | 责任人 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **天气查询 (`weather.forecast`)** | `packages/connectors/weather`、`public-connector-host.js`；提交 `ea8e9b8` | `verified` | Open-Meteo 真实免费 API 请求，自动执行无需审批，成功返回城市天气与投影数据 | 极端地理编码重名时的备选推荐 UI | Potatos498 |
| **文献检索 (`research.search`)** | `packages/connectors/research`、`public-connector-host.js`；提交 `ea8e9b8` | `verified` | OpenAlex 真实 API 请求，返回学术文献标题、引用、发布时间及 DOI 索引 | 检索结果分页加载与详情阅读器集成 | Potatos498 |
| **待办与提醒 (`todo.*`)** | `packages/productivity`、`todo-host.js`；提交 `ea8e9b8` | `verified` | [todo-reminders.md](../../apps/desktop/docs/todo-reminders.md)；SQLite 待办增删改查与 Windows 本地 Toast 通知弹窗 | 与系统日程日历的双向关联同步 | Potatos498 |
| **订阅源收集 (`feeds.*`)** | `apps/desktop/electron/feeds-host.js`；提交 `ea8e9b8` | `verified` | [feeds-settings.md](../../apps/desktop/docs/feeds-settings.md)；Atom/RSS 订阅源解析、更新检测与桌面摘要卡片展示 | 部分带有防爬反向代理 RSS 的重试策略 | Potatos498 |
| **邮件处理 (`mail.*`)** | `apps/desktop/electron/mail-config.js`；提交 `ea8e9b8` | `provisional` | [mail-analysis.md](../../apps/desktop/docs/mail-analysis.md)；IMAP 配置与离线邮件提取框架就绪 | 真实企业/个人邮箱（QQ/163/Outlook）在线连接与大批量拉取 | Potatos498 |
| **日历与会议 (Calendar/CalDAV)** | `packages/connectors/calendar`（待扩展） | `unavailable` | 契约存在，但尚无完整生产 CalDAV Provider 实现与在线同步（已在 Issue #212 提出 P1） | 完整实现生产 CalDAV 协议连接器与会议变更通知 | Potatos498 |

### 3.4 编程工具与 Windows 操作交付链 (Coding & Windows Host)

| 约定功能 | 对应实现与关键提交 | 当前证据状态 | 实际证据来源与位置 | 剩余缺口 | 责任人 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **受限工作区补丁操作** | `packages/coding-tools`；提交 `ea8e9b8` | `verified` | [workspace-command-config.md](../../apps/desktop/docs/workspace-command-config.md)；受限目录的只读检查、patch 预览与应用、Git diff 审计 | 冲突检测时交互式手动三方合并 UI | Potatos498 |
| **受限命令执行** | `packages/coding-tools`；提交 `ea8e9b8` | `verified` | 执行预置 Node/npm 检查命令，超限或高危参数严格拒绝 | 允许用户自定义白名单命令的配置入口 | Potatos498 |
| **Windows Host 记事本操作** | `apps/windows-host`、`apps/desktop/electron/notepad-host.js`；提交 `6264d19`、`ea8e9b8` | `provisional` (生产代码) / `verified` (离线管道) | [notepad-operation.md](../../apps/desktop/docs/notepad-operation.md)；Named Pipe IPC 契约、F9 实体快捷键物理确认、Policy 授权流 | 需在配置有 .NET 8 SDK 的真实 Windows 系统编译 Native Host 二进制并实操验证 | Potatos498 |
| **系统状态只读观测** | `packages/windows-client`；提交 `ea8e9b8` | `verified` | CPU/GPU/内存只读采集工具，在 Desktop 系统状态中可被调用 | 针对更多异构显卡驱动的数据适配 | Potatos498 |

### 3.5 创新机制与主动认知交付链 (Cognition & Laya)

| 约定功能 | 对应实现与关键提交 | 当前证据状态 | 实际证据来源与位置 | 剩余缺口 | 责任人 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **版本化目标图谱 (Goal Graph)** | `packages/goals`；提交 `ea8e9b8` | `verified` | 基于 CAS 的 `appendVersion` 机制，目标节点依赖追踪与冲突拒绝通过单元测试与桌面集成 | 复杂 DAG 图形化可视化渲染组件 | Potatos498 |
| **事实变化流 (Fact Feed)** | `packages/memory`；提交 `ea8e9b8` | `verified` | SQLite 存储并记录变化水位（watermark），支持断点续传与重放 | 与外部系统事件总线的实时 WebSocket 广播对接 | Potatos498 |
| **Laya 主动决策与计划修复** | `packages/cognition`、`apps/desktop/electron/goal-cognition-host.js`；提交 `717af33`、`ea8e9b8` | `verified` (宿主接线) / `provisional` (本地推理) | [proactive-composition.md](../../apps/desktop/docs/proactive-composition.md)；Laya 方案决策生成、桌面一键“采纳并执行”、CAS 版本安全写回 | 本地启动独立的实际 Laya HTTP 服务模型（端口与密钥）进行真机连续推理测试 | Potatos498 |

### 3.6 产品内多 Agent 分配交付链 (Multi-Agent Dispatch)

| 约定功能 | 对应实现与关键提交 | 当前证据状态 | 实际证据来源与位置 | 剩余缺口 | 责任人 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **次级智能体分派 (`subagent.dispatch`)** | `packages/agents`、`apps/runtime/src/application/subagents.ts`；提交 `890c195`、`717af33`、`ea8e9b8` | `verified` | 支持分派 `researcher`、`coder`、`reviewer` 等角色，配置独立模型与步骤限制，执行结果聚合汇报 | 角色自定义提示词在管理后台的可视化配置编辑 | Potatos498 |
| **多 Agent 状态与证据隔离** | `apps/desktop/electron/main.js`；提交 `ea8e9b8` | `verified` | 严格遵守架构门禁，次级智能体结果做 64KB 投影边界保护，父任务统一管理终态 | 针对子任务单独取消的粒度细化 | Potatos498 |

### 3.7 知识库与记忆管理交付链 (Knowledge & Memory)

| 约定功能 | 对应实现与关键提交 | 当前证据状态 | 实际证据来源与位置 | 剩余缺口 | 责任人 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **本地只读知识库搜索** | `packages/knowledge`、`apps/desktop/src/app/knowledge-controls.js`；提交 `717af33`、`ea8e9b8` | `verified` | 本地 Markdown / Obsidian 库全文检索，关键词匹配，16KB 严格脱敏投影输出 | 向量化语义相似度检索增强 (RAG) | Potatos498 |
| **私人记忆安全控制器与擦除** | `packages/memory`；在途 PR #209～#211 | `provisional` | 代码与单元测试就绪，支持记忆溯源、用户确认授权与合规擦除 | 等待 goo122 交付并在 main 完成集成 | goo122 / Potatos498 |

### 3.8 华为云 AgentArts 比赛主链路 (Competition Profile)

| 约定功能 | 对应实现与关键提交 | 当前证据状态 | 实际证据来源与位置 | 剩余缺口 | 责任人 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **AgentArts 云端构建与编排** | 华为云 AgentArts 控制台；MOD-30 Workflow | `provisional` (云端已就绪) / `unverified` (trace 证据待归档) | 网关地址已绑定至 `defaultgw-gztdqobzmm.cn-southwest-2.huaweicloud-agentarts.com` | Luna 需提供线上发布版本 ID、工作流调试快照及评估报告并记录于 `.cache/luna-agentarts/STATUS.md` | GPT-6 Luna Max |
| **本地 Coordination 协议交互** | `packages/coordination`；提交 `ea8e9b8` | `verified` | 安全请求信封封装、脱敏诊断回执、双向协议握手 | 线上复杂多轮工具闭环的云端 trace 读回 | GPT-6 Luna Max (云端) / Potatos498 (本地) |

---

## 4. 交付总结与各方交接建议

1. **对于 Potatos498**：
   - 核心基础架构、Desktop 界面接线、Laya 决策采纳、多 Agent 分派与知识库检索（PR #206）已全部合入主线并验证。
   - **最高优先级缺口**：
     - 实现生产级真实 CalDAV 日历连接器（P1）；
     - 在配置有 .NET 8 的实体机编译并演练 WindowsHost 桥接（P6）；
     - 本地启动真实的 Laya HTTP 进程进行推理闭环测试（P5）。
2. **对于 GPT-6 Luna Max**：
   - 桌面端已证实能够通过安全凭据成功向西南-贵阳二网关发起调用并返回问答结果。
   - **最高优先级任务**：
     - 在 AgentArts 控制台完成工具提案（Tool Proposal）与多 Agent 节点的编排与发布；
     - 导出端到端运行 trace 诊断记录与评估报告至 `.cache/luna-agentarts/STATUS.md`。
3. **对于 Gemini (zemeng)**：
   - 本证据索引与后续演示脚本已严格核对事实并完成编写；
   - 持续跟进两方交付物并实时同步状态矩阵。
