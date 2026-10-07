# MOD-11-CANCEL-ACCEPTANCE-01：取消受理与终态分离

> 维护入口（2026-10-07）：项目主要负责人为 zemeng；当前分工以 [模块分工](../../docs/MODULE_ASSIGNMENTS.md) 为准，最新状态见 [ROADMAP](../../docs/ROADMAP.md)。历史日期、作者和验收结论按原记录保留。

- Profile：huawei_ict_agentarts；MOD-11/12，PA-004；负责人 zemeng，待非作者评审 goo122。
- 状态：review；基线 main `72cc76b`。等待非作者评审与集成，不代表模块整体完成。
- 工作树：`.worktrees/zemeng-desktop-cancel-acceptance`。
- 分支：`codex/zemeng/desktop-cancel-acceptance`。
- 所有权：Desktop 主进程取消接线及对应定向检查；不修改 Runtime 或公共协议。

## 问题与行为

公开 `task.cancel` 的 `cancelAccepted` 表示取消请求受理，不保证任务立即进入终态。
Runtime 可以保持 cancelling，或者在外部结果不确定时保持 waiting_reconciliation。
旧桌面 IPC 在取消受理后仍强制等待五秒终态，导致合法的待核实状态被误报为超时失败。

取消请求仍经原有发送者及任务归属校验，再调用公开 Client。受理后只回读一次真实快照，
返回受理结果与该状态；后续变化由已有事件订阅驱动，不重复请求，不伪造 cancelled。
拒绝与快照读取失败保持失败，不吞掉错误。该工作不声称可以强制终止云端执行。

## 交付与验证边界

- 不新增 capability、DTO、任务库或 Runtime 执行循环。
- 保留已有 UI 对 cancelling / waiting_reconciliation 的状态映射。
- 只验证受理、非终态与失败透传；桥接检查复用现有本地模拟入口。
- 不读取凭据，不连接云端，不进行真实外部副作用。
- 非作者评审和集成仍是完成条件，但不阻塞其他独立工作包。

## 当前验证

- `node --test --test-isolation=none apps/desktop/test/cancel.test.mjs`：5/5 通过，
  覆盖 cancelling、waiting_reconciliation、已取消以及快照读取失败透传。
- 修改的主进程、辅助函数与两个测试文件通过 `node --check`，`git diff --check` 通过。
- 默认测试进程隔离受本机 `spawn EPERM` 限制；使用同一测试的单进程模式通过，未更改断言。
- `node apps/desktop/test/runtime-application-smoke.cjs`：通过，7 次本地模拟请求、2 次取消；
  验证 IPC 到 Runtime 的受理与事件推进终态，未调用真实云服务。
- 该次运行后补充退出提示清除的显式等待断言，仅做语法与差异检查，未再次启动 Electron；
  不把新增断言记为已动态通过。
- 独立工作树通过被忽略的逐包 junction 只读复用已安装第三方依赖；内部包指向本工作树，
  仅生成本树 dist，无依赖安装、锁文件修改或共享数据库。验证环境 Node 26.3.0，
  仓库目标 Node 24.15.x 的验证以 CI 为准。
- 未进行真实 AgentArts 或外部工具调用；不能据此声称云端取消成功。

## 取消后的迟到状态读回（2026-10-07 续接）

现有 PR #302 的 Desktop 消费增量保留同一 Task 的较新 revision。原 `task.get`
已捕获 running/revision3、回执被显式延后时，原停止按钮通过公开 Runtime 接受取消，
新读回及实际取消事件推进至 cancelled/revision5。此前释放旧 get 会把界面画回运行中，
即使 SQLite 仍为 cancelled；现在 `refresh` 返回已有较新 Task，不重复发布旧投影。
初次、新版及相同 revision 的读回继续沿原 set、退出提示清理和发布路径处理。
没有修改 TaskRuntime、取消受理、审批、公共协议或 `applyEvent`。

新回归与原取消测试共 7/7、Desktop typecheck、原完整 panel/CSP AFTER 均实际 exit0。
原面板保持已取消、停止按钮消失、发送可用，等待期间新草稿保留；真实本地公开
get/cancel/get 共三次调用、取消一次，console/pageerror 为零。
源码固定 main blob `66127a66d2d1b0d7dc1eca3589133a3398588c76`，
新测试 blob `b53ab4426ad0a86c432d519136d79d9c7719e9cd`。
证据在 `.worktrees/mod15-host-20261007/.cache/review-evidence/20261007/`
的 `panel-task-refresh-order-*`；环境恢复前未保留退出码的产物与各错误调用日志继续保留，
续接仅使用有实际退出码的新证据。

该验证使用实际 RuntimeApplication/Client/SQLite、合成可取消只读 worker 与原 panel；
回执延后、IPC 和窗口宿主为显式 Fake。此处没有验证 EventCursor/pump 传输、
真实 Electron/Windows 或云端取消，也不把定向检查称为根完整检查。

随后独立核对原 `pumpEvents`、公开 EventCursor 与实际 Runtime 事件流：
在较新 cancelled/revision5 的 get 已读回后，合法历史事件1–3仍可能包含 running/revision3。
同 Task 更低 revision 现在仅跳过快照替换及退出提示清理，未提前退出整个 event；
原 task.created 分派、通知、审批与取消审批清理继续执行。游标正常从0到3再到6，
完整重复事件被原 EventCursor 拒绝，不重放或重新发布。

新增实际 pump 测试与上一包 refresh/取消测试共10/10、typecheck均实际 exit0，
覆盖低 revision、正常前进、相同 revision、重复事件及真实只读审批取消后的清理。
原完整 panel/CSP AFTER 实际 exit0，仍已取消、stopfalse、发送可用、草稿保留，
console/pageerror 为零；没有手工伪造 cancelled 快照或运行工具/签发 grant。
固定 main blob `059d73be5e72acb78ea50c76a21f978c4b1f4db2`，
新测试 blob `8ca985d39e69a23ae7ba06a9faac582463feebc0`，
证据在同 Desktop 私有目录的 `panel-event-readback-order-*`。

生产组合当前提供同步 `RuntimeApplication.readEvents`；证据通过显式 Fake
runtimeConnection 延后已捕获的合法批次，证明原消费者可保护快照合流，
没有声称在真实进程内 Electron 或物理传输复现长时间延迟。
