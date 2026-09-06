# 模块分工与独立交付清单

版本：0.3 · 日期：2026-09-06 · 状态：MOD-01/02/03 已评审集成，MOD-25 源码已合并、保持 review，其他模块未启动

本文件是模块负责人、文件所有权和交付边界的唯一登记处。[PRD](PRD.md) 定义需求，[公共开发协议](DEVELOPMENT_PROTOCOL.md) 定义互通契约，[ROADMAP](ROADMAP.md) 维护执行状态。

## 1. 人员与决策权

| GitHub 用户名 | 角色 | 固定职责 |
| --- | --- | --- |
| `goo122` | A | 工程底座、公共协议、公共集成；Agent 核心、Obsidian 与记忆 |
| `zemeng` | B | 桌面交互、语音、Windows 执行、TraceGuard 适配、开发工具与分发 |
| `Potatos498` | C | 日程、邮件、订阅、搜索、天气与社交连接器 |

以上是 GitHub 协作者身份，不是软件运行中的 Agent 角色。未提供用户名的模块必须在认领时补充 GitHub 用户名；文档建立不等于任务已经启动。

用户负责产品范围和重大取舍；`goo122` 负责公共接口技术维护及根工程集成，`zemeng` 提供消费端反馈并参与交叉评审。`zemeng` 不代替 `goo122` 修改公共底座。

三人模式：`goo122`、`zemeng` 与 `Potatos498` 按独占模块并行开发。业务连接器按小工作包分配给 `Potatos498`；不能两人同时持有同一模块。

## 2. 文件所有权规则

- 下表路径是未来代码规划，不代表已创建。现有 `src/` 占位目录保留；`goo122` 在 MOD-01 明确目录入口，不产生第二套实现。
- 每行指定一个拥有者。模块 README、模块内测试/夹具与实现由同一拥有者维护；其他人以 PR 提出修改。
- 根配置、锁文件、工作区清单、公共 CI、公共迁移与启动装配只由 `goo122` 修改。`zemeng` 拥有桌面和 Windows Host 的入口实现，`goo122` 拥有根启动配置；二者不重叠。
- 模块所需新依赖先由模块负责人提出，`goo122` 合并根清单与锁文件。普通模块内部文件不需要 `goo122` 逐行代写。
- 公共 Schema 仅放 `packages/contracts/`。`zemeng` 和待认领模块负责人不复制接口定义，不直接访问其他模块的数据库表、私有类或密钥。
- 根装配通过模块导出注册函数接入；模块负责人交付注册说明，`goo122` 完成接线。`zemeng` 维护后台路由与页面，连接器负责人仅交付业务配置 Schema 和服务能力。
- 范围有交集时，以更精确的下表子目录为准；`apps/desktop/` 不是单一工作包可任意修改的范围。

## 3. `goo122`：底座与智能核心

“独立输入”可以来自 MOD-02 的固定夹具和 fake 端口；“集成依赖”用于真实联调，依赖未实现不等于允许临时绕过契约。

| ID | 模块 / 需求 | 拥有目录 | 集成依赖 | 输入 → 输出 | 独立验收 |
| --- | --- | --- | --- | --- | --- |
| MOD-01 | 工程与存储底座 / PA-004 | 根配置、`packages/storage/`、`scripts/dev/`、`.github/workflows/` | 无 | 配置/存储命令 → 可启动工程/持久记录 | 给出实测构建启动命令；数据库迁移保留数据；模块可单独运行 |
| MOD-02 | 公共协议与联调 SDK / PA-004, PA-023 | `packages/contracts/`、`packages/client/`、`packages/testkit/` | MOD-01 | 请求/事件 Schema → TS 类型、JSON Schema、fake Runtime | 不用模型账号可跑成功、失败、授权、取消和事件恢复；形成版本化契约 |
| MOD-03 | 任务与事件核心 / PA-004, PA-009 | `apps/runtime/`，不内嵌业务连接器 | MOD-01, MOD-02 | 目标/触发器 → 持久任务、进度、检查点 | 重启后恢复；超时写入不重复执行；调度补跑策略明确 |
| MOD-04 | 模型与专业 Agent / PA-003, PA-012 | `packages/models/`、`packages/agents/` | MOD-02, MOD-03, MOD-05 | 目标/上下文 → 规划、工具提案、结果汇总 | fake 端口跑规划；真实盘古调用单独验证；实际模型和预算可见 |
| MOD-05 | 权限、工具与连接器宿主 / PA-023 | `packages/policy/`、`packages/tool-gateway/`、`packages/connector-host/` | MOD-02, MOD-03 | 动作/范围 → 授权判断、执行结果 | 越权拒绝；未知结果待核实；宿主注入凭据，不交给模型或 UI |
| MOD-06 | MCP 适配 / PA-005 | `packages/mcp/` | MOD-02, MOD-05 | 服务定义 → 工具目录/调用结果 | fake 服务契约通过；至少一个真实 MCP 调用；断连可诊断 |
| MOD-07 | Skills 加载与运行 / PA-006 | `packages/skills/` | MOD-02, MOD-05 | Skill 包/版本 → 可用流程/执行记录 | 禁止自授权限；启停和版本绑定有效；一个 Skill 闭环 |
| MOD-08 | Obsidian 索引与读写 / PA-008 | `packages/knowledge/`、`plugins/obsidian/` | MOD-01, MOD-02, MOD-05 | Vault 范围/查询/版本化修改 → 来源片段/写入结果 | 测试 Vault 独立检索；链接保留；版本冲突拒绝覆盖；插件读写单测与真实验证分开 |
| MOD-09 | 个人记忆与流程学习 / PA-020 | `packages/memory/`、`packages/learning/` | MOD-07, MOD-08 | 已确认反馈/成功证据 → 记忆/候选流程版本 | 纠正、删除、索引失效；流程验证后启用并可回退 |
| MOD-10 | 微调可行性研究 / PA-022 | `docs/research/model-training/` | 供应商能力/数据条件 | 来源与评估设想 → 条件性可行性结论 | 无需修改运行代码；不把偏好记忆称为参数训练；不默认调用付费训练 |

MOD-05 拥有凭据服务接口与宿主编排；Windows 安全存储实现归 MOD-16。两者通过 `SecretStorePort` 接入，前期可使用仅存测试值的内存 fake。

## 4. `zemeng`：桌面与执行模块

| ID | 模块 / 需求 | 拥有目录 | 集成依赖 | 输入 → 输出 | 独立验收 |
| --- | --- | --- | --- | --- | --- |
| MOD-11 | 桌面外壳与桥接 | `apps/desktop/electron/`、`apps/desktop/src/app/` | MOD-02 | 启动配置/连接 → 窗口、托盘、受控 IPC | fake Runtime 可启动；关闭后台不误停任务；渲染器无直接系统权限 |
| MOD-12 | 悬浮球与展开面板 / PA-001 | `apps/desktop/src/features/orb/`、`apps/desktop/src/features/conversation/` | MOD-02, MOD-11 | 状态事件/用户输入 → 界面/任务请求 | 靠近、拖动、固定、取消、多屏关键场景真实渲染；状态不靠定时器假造 |
| MOD-13 | 管理后台与授权界面 / PA-002, PA-023 | `apps/desktop/src/features/admin/`、`apps/desktop/src/ui/` | MOD-02, MOD-11 | 配置/能力/任务快照 → 配置请求/授权决定 | fake 下覆盖全部页面；真实服务未连接明确展示；不接收密钥回显 |
| MOD-14 | 语音会话 / PA-007 | `packages/voice/`、`apps/desktop/src/features/voice/` | MOD-02, MOD-04, MOD-11 | 音频片段/文本 → 转写事件/播放流 | 录音与播放可见；打断不等于任务已取消；供应商调用经宿主注入凭据 |
| MOD-15 | 唤醒词和连续语音 / PA-021 | `packages/voice-wake/` | MOD-14 | 授权音频流 → 唤醒事件 | 用音频夹具开发，实机检查误触和回声；默认不开持续录音 |
| MOD-16 | Windows 执行与凭据适配 / PA-016 | `apps/windows-host/`、`packages/windows-client/` | MOD-02, MOD-05 | 受限操作/目标 → 观察/执行/验证结果 | 用独立测试应用验证；接管暂停、输入串行；凭据读取限宿主身份 |
| MOD-17 | TraceGuard 适配 / PA-011, PA-018 | `packages/traceguard/` | MOD-02, MOD-05, MOD-16 | 查询/受限动作 → 观测证据/恢复信息 | 先只读评估旧项目；真实数据归因；普通用户权限；可逆动作真实恢复 |
| MOD-18 | 编程执行工具 / PA-017 | `packages/coding-tools/` | MOD-02, MOD-05 | 工作区/补丁/命令 → diff、输出和验证状态 | 临时测试仓库独立验收；保留用户改动；越界拒绝；编程规划由 MOD-04 提供 |
| MOD-19 | 打包与安装验收 | `packaging/`、`scripts/release/` | 已验收模块、MOD-01 | 构建物 → 安装包/验收记录 | 独立安装、启动、卸载；必要文件自包含；根构建改动交 `goo122` 集成 |

MOD-14 包含 ASR/TTS 适配的完整交付责任，`goo122` 不再另写一套语音模块。视觉模型请求由 MOD-04 的模型端口提供给 MOD-16，`zemeng` 负责定位与操作验证。

## 5. `Potatos498`：可逐项领取的业务模块

| ID | 模块 / 需求 | 拥有目录 | 集成依赖 | 输入 → 输出 | 独立验收 |
| --- | --- | --- | --- | --- | --- |
| MOD-20 | 待办与日历 / PA-009, PA-013 | `packages/productivity/`、`packages/connectors/calendar/` | MOD-02, MOD-03, MOD-05 | 待办/时间/账号 → 条目、触发定义、日历结果 | 注入 fake 时钟/日历；时区和修改读回；不另建常驻调度器 |
| MOD-21 | 邮件连接器 / PA-014 | `packages/connectors/mail/` | MOD-02, MOD-05 | 账号游标/查询/动作 → 邮件页、草稿、动作结果 | fake 提供商分页与重复事件；真实账号单独验证；发送超时不盲重试 |
| MOD-22 | 订阅采集 / PA-015 | `packages/connectors/feeds/` | MOD-02, MOD-05 | 订阅地址/游标 → 标准事件和来源 | 固定 feed 夹具增量采集/去重；真实来源至少一个；通知交 MOD-23 |
| MOD-23 | 通知汇总策略 / PA-015 | `packages/notifications/` | MOD-02, MOD-03 | 标准事件/用户规则 → 通知条目或摘要请求 | fake 时钟验证安静时段、聚合和暂停；只用 Runtime 调度；界面交 `zemeng` |
| MOD-24 | 搜索与资料获取 / PA-010 | `packages/connectors/research/` | MOD-02, MOD-05 | 查询/来源 → 带时间与来源的材料 | 固定响应夹具；失败/过期区分；研究规划和汇总由 MOD-04 执行 |
| MOD-25 | 天气 / PA-010 | `packages/connectors/weather/` | MOD-02, MOD-05 | 明确地点/日期 → 预报、单位、来源时间 | 地点不静默猜测；缓存状态可见；真实提供商结果验证 |
| MOD-26 | 微信与社交扩展 / PA-019 | `packages/connectors/social/<platform>/` | MOD-02, MOD-05；交互模式另依赖 MOD-16 | 账号/游标/动作 → 平台能力、事件、结果 | 每个平台单独工作包；账号类型和不支持项明确；真实读写证据分别登记 |

MOD-26 是工作包族。领取时创建如 `MOD-26-wechat` 的子任务，指定唯一 GitHub 负责人和独占子目录；可交给 `goo122`、`zemeng` 或已登记的第三位协作者，不要求同一个人实现所有平台。邮件和日历也可按提供商拆分，禁止多人同时编辑族入口。

## 6. 独立开发交付包

每个模块须有：导出入口、消费的公共版本、README、最小夹具、一个代表性验证、接入说明、已知限制。能够通过注入端口在没有其他业务模块的情况下运行；真实集成验证在依赖到位后另做。

任务认领模板：

```text
模块 ID / 子任务：
负责人：GitHub 用户名（`goo122` / `zemeng` / 已登记协作者）
评审者：另一位 GitHub 协作者，公共协议变更需 `goo122` 维护
独占目录：
消费的契约版本 / fake 场景：
输入 / 输出 / 验收：引用模块行并补充本次增量
不修改：根配置、他人目录（确有需要交 `goo122` 处理）
真实验证条件：账号、设备或指定测试环境
状态 / 分支 / PR / 证据：登记 ROADMAP
```

`zemeng` 的改动由 `goo122` 或 `Potatos498` 评审，`goo122` 的改动由 `zemeng` 或 `Potatos498` 评审；本人不能充当自己的独立评审。MOD-01/02/03 已完成评审集成；MOD-25 源码已通过 PR #4 合并，但因最终解析提交晚于原批准且根装配未完成，仍保持 review，具体状态以 ROADMAP 为准。

## 7. 开工门槛

1. `goo122` 先完成 MOD-01 和 MOD-02：可启动底座、契约版本、fake Runtime、消费者示例及兼容性检查。
2. `zemeng` 验证 fake 客户端；待认领的连接器负责人验证 fake 工具/连接器；最小契约形成冻结记录。
3. `zemeng` 从 MOD-11/12/13 开始；`goo122` 继续 MOD-03/04/05 和 MOD-08；`Potatos498` 从 MOD-25 开始，其余待认领模块负责人可从 MOD-22 开始。各自可以使用 fake 依赖，不需要等所有功能完成。
4. 第一次真实联调：悬浮面板 → 盘古 → Obsidian 查询 → 来源结果。只完成这一场景不代表首版全部需求通过。
