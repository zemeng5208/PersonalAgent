# MOD-27/28 本地消费者集成交接

日期：2026-09-10；profile：huawei_ict_agentarts；消费者负责人 zemeng。
状态：原离线图谱工作包已在 PR #37 评审合并为 `41ea79d`，含根构建接线；不代表 MOD-27/28 整体验收完成。
存储首片见 [COORDINATION-STORE-01](COORDINATION-STORE-01.md)，当前分支实现中、待消费评审。
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
- 接口目录中的 MemoryQueryPort、FactChangeFeed、CoordinationStorePort 仍 unavailable。
  本文只描述消费需求，不定义方法签名、wire DTO 或数据库结构。

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
