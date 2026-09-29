# MOD-11-CANCEL-ACCEPTANCE-01：取消受理与终态分离

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
