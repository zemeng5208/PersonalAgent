# MOD-27/28 本地消费者集成交接

> 维护入口（2026-10-07）：项目主要负责人为 zemeng；当前分工以 [模块分工](../../docs/MODULE_ASSIGNMENTS.md) 为准，最新状态见 [ROADMAP](../../docs/ROADMAP.md)。历史日期、作者和验收结论按原记录保留。

日期：2026-09-10；profile：huawei_ict_agentarts；消费者负责人 zemeng。
状态：原离线图谱工作包已在 PR #37 评审合并为 `41ea79d`，含根构建接线；不代表 MOD-27/28 整体验收完成。
存储首片见 [COORDINATION-STORE-01](COORDINATION-STORE-01.md)，已在 PR #38 经消费方非作者评审并合并为 `87ee444`；接口仍待持久图消费者纵向验收后评估冻结。
以下原工作树/基线及交接需求保留为当时记录；MemoryQueryPort、FactChangeFeed 仍 unavailable。
工作树 `.worktrees/zemeng-mod27-goal-graph`；分支 `codex/zemeng/mod27-goal-graph`。
本轮 fetch 确认 origin/main 为 59440614a15623e6190e0df5542dc9ff8d019d0c。

## 已有能力与不可用边界

- `packages/goals`：纯内存版本图、严格历史校验、expectedRevision 校验和历史查询。
- `packages/cognition`：精确版本依赖影响、KEEP/RECHECK、显式 summary 候选的 REVISE 差异。
- 公开入口消费者示例：`packages/cognition/examples/meeting-replay.mjs`。
- 基线提交本身不包含上述实现；两包与此交接记录作为同一图谱影响工作包提供和评审。
- PR #36 的 CoordinationPort/CloudAgentPort 是 provisional 文字子集；结果只允许
  kind/text/verification，不可塞入 PlanPatch、授权、Evidence 或任务状态。
- 接口目录中的 MemoryQueryPort、FactChangeFeed 仍 unavailable；CoordinationStorePort
  的首片已集成为 provisional。本文原始段落只描述当时消费需求，不扩大 wire DTO。

## goo122 端口交付需要覆盖的消费者场景

| 边界 | 最少行为 | 必须拒绝或显式暴露的情况 |
| --- | --- | --- |
| 图谱存储 | 命名空间读回、版本追加、提交时原子 CAS、历史保留 | 两个调用者使用相同旧 revision 只能一个成功；不得先读后无条件写 |
| 隔离与访问 | 由可信宿主判定用户与命名空间、敏感数据范围 | 更换命名空间字符串不能获得另一个人的图；错误不回显私人正文 |
| 事实读取 | 稳定来源、精确 revision、有效期、修正和撤回语义 | 缺失版本、缺来源、越权或不可用不能伪装成空结果/有效事实 |
| 变化流 | 可恢复游标、去重、顺序及缺口处理、取消/deadline | 重复事件不追加重复事实；乱序/缺口需重同步，不能跳过后声称最新 |
| 保留与删除 | 区分撤回历史和隐私删除；定义删除后依赖处理 | 当前图谱会保留旧摘要，不能把撤回称为物理删除；删除策略未定前不导入真实私人数据 |
| 重启恢复 | Fake 和持久适配分别展示读回、游标与 CAS 语义 | 内存 Fake 跨调用成功不作为进程重启证据 |

端口类型、Fake、错误语义及冻结状态由负责人交付。zemeng 在公开入口上补消费者
测试，不读取 Memory 数据库或导入存储私有实现。纯 appendVersion 的检查不能代替
存储原子事务；当前示例中的顺序追加也不证明并发安全。

## 本地可复现验收入口

在此工作树运行 `npm run demo --workspace=@personal-agent/cognition`。
合成会议从 15:00 改为 17:00 后，3 个节点 RECHECK；只显式重绑 Goal 后仍有 2 个；
显式更新 Decision/Plan 依赖后为 0 个。无关计划逐字段不变，旧历史可恢复查询，
旧 revision 的修订候选被拒绝。所有时刻、文本和重绑选择均为固定夹具，非智能推理。

最近验证：goals 8/8、cognition 10/10；根 check 在核心依赖增量时通过；后续示例
通过模块测试、构建与 demo。Node 26.3.0 / npm 11.16.0；目标 24.15.x / 11.12.x 待验。

## 接线顺序与所有权

1. zemeng 提交可审查的图谱/影响增量并由非作者评审；Git 动作需要对应授权。
2. goo122 交付上述公共端口与 Fake，记录精确接口版本及迁移风险。
3. zemeng 使用 Fake 补重复/乱序/冲突/取消/隔离消费者测试，不接真实账号。
4. goo122 集成根锁、构建顺序（goals → cognition）、存储与 Runtime 注入。
5. 集成工作包运行根 check，并在项目要求 Node 版本验证；涉及真实状态时增加重启读回。
6. 云试用获批且用户授权后，另行验收 AgentArts 语义修复和真实执行；不以本地 demo 替代比赛 Golden Path。

PR #37 CI 后续修正：2026-09-10 的 run 34430658413 在 npm ci 因缺少两个 workspace
锁登记失败。本 PR 补充根锁的 4 个 package/link 记录（19 行），没有第三方升级；
此共享文件例外由 goo122 随 PR 评审。上文原定锁登记交接项由此次修正提前完成，
生产构建次序、公共端口与根装配仍待集成。未修改根 package、公共 contracts 或 Runtime。
只按用户授权提交、推送和请求 PR 评审，不合并或标记 MOD done。

## 当前源码能力与验收矩阵（2026-10-07）

以下依据 `main@4b5ec61` 的公开入口与实际调用点核对，区分已合并实现与尚未完成的
真实来源验收。上文 2026-09-10 的 unavailable、构建版本和验证数量保留历史含义，
不能作为当前源码缺项的结论；本次仅校正文档，没有新增实现或真实服务验收。

| 能力 / 现有消费入口 | 当前源码状态 | 仍需完成的边界 |
| --- | --- | --- |
| [Goal 图与命令](../../packages/goals/src/index.ts)、[受控工具](../../packages/goals/src/tool.ts)、[Desktop Goal host](../../apps/desktop/electron/goal-host-core.js) | 已有 Fact/Goal/Decision/Plan 精确版本依赖、历史查询与撤回、SQLite/Fake 原子 `appendBatch`；Goal 创建/修订通过既有 Runtime 工具及图/Goal revision 检查，不由 Renderer 直接写图。 | 版本恢复是追加图版本，不回滚外部副作用；真实个人数据授权、删除与恢复读回不能由离线图测试代替。 |
| [SQLite fact projection](../../apps/runtime/src/application/sqlite-fact-projection.ts)、[CompetitionFactHost](../../apps/runtime/src/application/competition-fact-host.ts) | 已消费公开 `MemoryQueryPort` / `FactChangeFeedPort`、持久投影与确认读回，保留 consume/drain、completed impact 和恢复入口；当前 feed/query 固定 `allowedSensitivities: ['public']`，宿主写入来源是公开 Vault。 | 已有公开来源链不代表所有业务来源可用；不能将私人 Calendar 当公开 Vault 输入。真实来源修正、撤回、删除、权限撤销及重启的现场验收仍分别记录。 |
| [Committed fact consumer](../../packages/cognition/src/committed-fact-consumer.ts)、[Goal cognition host](../../apps/desktop/electron/goal-cognition-host.js) | 已有 KEEP/RECHECK/REVISE 影响回放与精确 completed projection 消费；Goal host 对已确认的创建/修订调用 `reviewGoalCreated` / `reviewGoalRevision`。 | 只复核有依赖的节点；模型建议或投影完成不能单独证明修复已执行，无关依赖不得被改写。 |
| [Runtime local repair](../../apps/runtime/src/application/local-repair.ts)、[Reviewed repair 接线记录](MOD-28-REVIEWED-REPAIR-01.md#当前源码接线核对2026-10-07) | 已有最小差异预览、可信 Goal 来源绑定及原 Runtime/Policy/原子 CAS/历史读回路径；main 已装配 P8 reviewed source resolver。 | 真实 Laya/AgentArts 候选、云执行、confirmed Evidence 与实际目标读回未由本次核验；未知写入不重发，不能用候选受理或 Fake 成功替代执行结果。 |
| [默认 P5 Calendar 交接](MOD-28-REVIEWED-REPAIR-01.md#默认-p5-会议链与可信来源交接2026-10-07) | 核心 committed reader 与 Goal 会议 review/repair 端口已具备；main 的 P5 仅注入 `calendarReadPort`，缺可信 meeting binding，仍保存 `requires_review`。 | 沿 #212：Potato 提供可信 Calendar sourceRevision→精确 Fact ref 与旧/新 baseline 顺序，goo 核对原 Memory/projection 的敏感范围与 completed 读回，zemeng 随后复用既有 composition/Goal host 接线；不得新造 Fact 来源、空转发或把无 binding 改为 KEEP。 |

现场验收继续使用上述既有模块记录与 #212 的步骤及负责人，MOD-27 保持 `review`、
MOD-28 保持 `in_progress`。接口状态以[接口目录](../interfaces/CURRENT_INTERFACE_CATALOG.md)
公布的子集为准；本次源码核对不冻结新接口，也不把合成绑定、实际 SQLite 持久读回或
一轮根检查记为真实 Calendar、私人 Memory、云或 Evidence 整体通过。

## 固定九项整合批次完整检查（2026-10-08 续接）

固定68fb1563ef73457dab1747e6eb15c08e6c32010a/tree8d6fa5b8ac47ff8d095d8c8dca0bd2f001f14bb0，Node24.15/4CPU原npm run check，01:19:57.495576Z至01:28:21.974862Z，实际session34257/dccf1d→dac3e6/exit0。34组2523项2473通过、0失败0取消、50跳过；Desktop647/636通过11跳过、Runtime439/439、Cognition273/273、Calendar47/44通过3跳过、root integration22/22。raw249163字节SHA5af62dc48f62442cf5dd9a22da3c63f6736c7951e0a52b038de76a9cff56e286；A独立完整raw+固定source核实4dd26739620a9d2249593f49db071ca711b20b1b900bbcb8d4707ec81342a0b3。原1f548整仓Calendar失败和同head隔离8/8仍完整保留，后来此批通过不能解释旧失败原因。此完整结果不覆盖随后新增Laya reader取消、Live shortcut反馈或Mail cache排序；新源码固定后须另跑原完整检查。没有借用旧远端Windows CI结论。

## 最终十二项自有增量的完整检查与交付（2026-10-08）

最终固定0b3eef9fa57340d2e992551dbcac26cea7827763/tree8918053995597cab9659dd29b1e37f5117d350e6，原npm run check实际5856/48cf7c→dd7d8c/exit0，01:40:40.655086Z至01:48:22.341844Z，Node24.15/实际4CPU/原期限与断言。34组2545项2495通过、0失败0取消、50跳过；Cognition283/283、Desktop659/648通过11跳过、Runtime439/439、Calendar47/44通过3跳过、root integration22/22；build/type/generated/architecture/contracts全部实际执行。完整raw3314行/251009字节SHAa8ba69d2a9d2068d54f5b47f8a0d9f9255fa4630524dabd9d8ac926e196edc22，A独审9f478df34f9c75bf69b6b9e5966488b3c4f9cc0e963bf233886fb64c3cec3fd8核全部34组七字段、50skip、全文及15冻结source/test。

覆盖原九项加Laya取消、Live快捷键反馈和Mail配置稳定排序十二项；此前68fb与1f548批次各自结果不混用，1f Calendar失败仍不解释根因。随后仅本文记录已发生结果的DOC提交，不改任何source/test；发布时须核源码一致、实际PR head/tree/全文件名/body。真实云/邮箱/Electron/Windows/物理设备与用户项目仍按原现场交接，未通过，不批准或合并；停止前由root向指定QQ邮箱发送实际结果、剩余事项、阻塞和责任人。
