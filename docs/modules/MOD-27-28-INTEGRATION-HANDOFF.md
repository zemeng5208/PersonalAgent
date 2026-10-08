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

## 12:30续接的公开消费契约与前端恢复（2026-10-08）

用户将本轮截止延至北京时间12:30；先行清单邮件已实际发送并核实后，三个原GPT-6.1 Sol执行线在独立工作树继续自有工作。以下八个工作包已精确整合至本地交付分支；它们需要新的固定源码完整检查，不能借用前述0b3eef9检查或24a1290的两条Windows CI成功元数据。仍沿原#302交付，不自行批准或合并，整体MVP与真实现场验收未完成。

- Mail缓存身份绑定原分类criteriaDigest的精确标签顺序。同序跨locale重开infer0，改序重新分类并通过原公开Dispatch；旧收据仍按原校验拒绝。新增摘要字段会让所有旧配置的checkpoint首次可能miss，含默认标签；旧记录保留，无迁移或改写收据。原三个affected文件33/33，独立Node/disk公开消费者9进程，冻结清单72e2016a。
- Mail在分块之间取消或到达期限时，用原Laya/Dispatch定义的criteriaDigest生成剩余收据ID。真实AbortController和注入的合成期限时钟分记；剩余项不推理、不存瞬态checkpoint，重开复用已完成项。原三个affected文件38/38、独立Node/disk消费者6进程，de48fe11；没有额外缓存身份变化。
- 当前可信highImpact提示撤去时，之前仅因该提示产生的高影响缓存会重新分类，不伪造语义降级；模型高影响和meeting缓存继续保留。空输入缓存保留insufficient_input原因，只按当前提示选择deferred路线、infer0。无key或收据迁移。原duplicate测试的batch内OR断言保留，后续false的旧缓存预期改为有依据的新分类及公开Dispatch验收；首轮49/50失败日志保留，最终原affected50/50、独立Node/disk14进程，28457636。三项都是原基线已有公开组合缺口；未发现当前生产Pipeline→Dispatch调用，不能声称修复了真实邮件、Task或通知失败。
- Desktop有活动任务时，在永久关闭Wake/Voice前拒绝退出；活动任务完成不会自动续退，用户下一次显式退出才开始清理。原末尾任务守卫及未知Live/SIS释放阻塞保留。原五个affected文件39/39，原完整main quit/IPC和实际Voice/Wake公开消费者验证，863001fc；Runtime计数、app和设备端口为Fake，不算Windows退出验收。
- SIS无效参数、过期Token、加密不可用或文件写入失败不再提前永久移除旧Wake宿主。原初次disable和IAM前后活跃校验保留；旧宿主保持disabled，可由用户显式重新启用。配置成功才继续原永久替换；保存后若资源释放未知，保留已保存副作用且不初始化，不宣称原子回滚。原八个affected文件66/66，原main IPC与实际ConfigHost文件/Voice/Wake消费者，1a76abb9；加密和设备替身明确，无真实IAM/网络验收。
- Goal完整投影24338字符超出原AgentArts16000上限时，prepare/dispatch先阻塞提交，保留全部101项复查和原图。控件显示实数/上限；用户可通过原proactive.configure的严格两个Goal布尔字段撤销目标云端许可，保原本地分析、独立CPU租约/云开关及未保存草稿。当前无授权或图版本已失效时不伪造可用投影，旧已受理/未知/失败任务的锁和完整journal不变。原三个affected文件58/58和Desktop typecheck通过；原HTTP/CSP完整renderer、实际Proactive/Goal/SQLite新消费者与原失败DB独立字节副本读回通过，eea1e521。Fake IPC、Laya及工具授权上下文明示，不算物理Electron、云或修复审批通过。
- 超过320字符的触发原因使用原生details/summary，保留完整转义文本、101项范围和原状态/动作。原6367字符原因在520×900页面使状态和本地恢复按钮初始落在3474/3525处；折叠后为574/625，用户展开仍可滚动。原Tab可到达按钮，故这是首屏可读性改善，不记为旧键盘不可用缺陷。按reviewID保留用户实际open状态并清理缺席记录；仅原summary当前有焦点且同ID仍存在时，以preventScroll恢复焦点，不抢输入框或其他控制的焦点、不复活移除项。原2正式失败后23/23、补充原焦点失败后完整24/24；原HTTP/CSP页面连续Enter跨刷新无需重新focus可开/关，0376cb89链保留原58685fe0和before。IPC为冻结的原真实Host投影的Fake回放，本次未新增Host/DB/任务/许可操作，也不是物理Electron验收。

- Device检查点先在局部Map中验证并克隆全部来源，成功后才发布到当前状态。坏行使公开readFeedback或evaluate首次读取拒绝时，不遗留已验证前缀；可信宿主随后修为空或替换来源，同实例不会显示幽灵反馈或误判replayed，后续合法采样仍持久化并在重开后防重放。原四恢复子例及父聚合失败、另一个非JSON克隆失败均保留；修复后原五个完整affected文件56/56，四个独立Node/真实SQLite公开HostState/P5消费者读回精确，e228ef33。无shape/key/configDigest/schema/阈值/通知意图或迁移变化，旧测试字节相同。坏行与可信修复是合成输入，仅原migration10表，不算完整TaskRuntime或真实OS；unused Fake推理/通知均0，nonJSON克隆例保留原DataCloneError，实际JSON端口会提前拒绝该数据。

原before/final源码、完整raw、实际启动回执和独立消费者均冻结；C/A/D交叉只读核验全部证据字节与摘要，未为同行审核重复生产绿色测试。工具命令固定Node24.15；formal未打印内部版本的情况按实际pinned启动回执记录，公开helper的内嵌版本另记。夹具故障和原正式失败均独立保留。必要整仓检查和精确发布头读回结果在实际发生后追加。
