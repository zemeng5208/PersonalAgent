# MOD-11/13/18：Desktop 工作区授权与撤销

## 范围与状态

- Profile：`huawei_ict_agentarts`。
- 负责人 / 非作者评审：`zemeng` / `goo122`。
- 分支：`codex/zemeng/desktop-workspace-access`；状态：`review`。
- 前置：PR #49（Competition 工具环）、PR #60（JSON fidelity）、PR #63（有界工作区读取）和 PR #68（离线纵向集成）。本片只消费其公开装配面，不复制 Runtime、ToolGateway 或 provider。
- 交付边界：可信 Desktop 主进程中的会话级工作区根选择、撤销、现有审批页展示与 `workspace.read_text@1.0.0` 生产装配。

这不是 AgentArts 真实工具调用或云端数据出机验收。实际 HTTP Adapter 当前仍是 text-only；本片测试使用 `FakeCoordinationPort`，不调用云服务、不读取或恢复 AgentArts 凭据。

## 用户与信任边界

1. 默认没有工作区根，因此 Desktop 不向 Runtime 注册或公布 `workspace.read_text`。
2. 只有管理后台的受信窗口可以请求原生 `dialog.showOpenDialog`；Renderer 不能提交任意绝对路径。取消选择不改变现有权限。
3. 拒绝磁盘根、用户主目录/用户容器根，以及 Windows、Program Files、ProgramData 等系统保护树。实际文件仍由 MOD-18 provider 执行 realpath、敏感路径、UTF-8、大小、deadline 和 cancellation 校验。
4. 根仅保存在当前主进程内存中。Renderer 只收到目录 basename、是否已授权和重组状态，不收到绝对路径；重启后恢复为未授权。
5. 选择根只限定本机可读范围。每次读取仍由现有 Runtime/Policy/ToolGateway 请求 `allow_once`，审批快照继续脱敏参数；它不构成把文件内容发给 AgentArts、模型或日志的授权。

## 装配与撤销语义

Runtime 当前只支持构造时注入 `tools`，本片没有访问私有 gateway，也没有新增动态注册接口。

- 选择或更换根前，Desktop 同时检查 Runtime 活动执行和任务快照；存在 `running`、`waiting_approval`、`waiting_reconciliation` 等未结束任务时，明确拒绝切换。
- 每次原生选择都有独立 generation；撤销或较新的选择会立即使旧对话框结果过期。对话框返回后再次检查任务状态，迟到结果和“选择期间任务开始”都不能修改 root、revision 或 tool。
- 允许切换时，旧 epoch 先失效，再构造新的 guarded `workspace.read_text`，随后关闭并用同一 SQLite 路径重建 Runtime Application，重新同步 Client、能力和任务/审批快照。
- 已确认的新根若校验或重建失败，保持未授权并尝试以空工具集恢复 Runtime；不会静默复活旧根。
- 撤销先同步 abort 当前 epoch。旧 wrapper、正在读取或迟到结果均不能返回内容；若 Runtime 仍有活动执行，主进程在其结束后重建空工具集。能力目录在重建完成前可能短暂处于“正在更新”，但文件读取已经 fail-closed。
- 重建复用原数据库，不删除任务、审批或会话数据。

## 界面

管理后台 `Worktrees` 页显示：未授权 / 已授权的 basename / Runtime 更新状态，并提供“选择目录”“更换目录”“撤销”。页面明确提示逐次审批和云端边界。现有“安全”页继续显示 Runtime 返回的 `workspace.read_text` 待处理审批及 `allow_once` / 拒绝操作，不生成新的授权引用。

## 最少验收

目标 Node `24.15.0` 下运行：

```powershell
node --check apps/desktop/electron/workspace-access.js
node --check apps/desktop/electron/main.js
node --check apps/desktop/src/features/admin/view.js
node --test --test-isolation=none apps/desktop/test/workspace-access.test.mjs
node apps/desktop/test/workspace-access-smoke.cjs
git diff --check
```

单元/集成测试 6/6 通过，覆盖：默认无 capability；取消和忙时拒绝；Renderer 路径注入拒绝；迟到 picker 在撤销/第二选择后不可复活授权；对话框期间任务变忙会保留旧 grant；过宽/保护目录拒绝；A→B、撤销和迟到输出 fail-closed；真实 provider 仍经过现有 `allow_once`；同一 SQLite 重开后任务保留且工具不再公布。

Desktop workspace `typecheck` 与架构门禁 1/1 通过。Electron smoke 只使用占位 authorization 创建 Competition 组合但不提交任务，因此不会发起 HTTP；最终物理 Electron 路径运行通过，验证管理后台真实渲染、默认未授权/无 capability，以及 Renderer 不能注入绝对路径。此前两次 harness 启动把不存在的 worktree junction 当作 Electron 路径，应用未启动、没有形成验收结果；改为 `require.resolve('electron/package.json')` 后的真实应用结果才计为通过。以上证据仍为本地 `provisional/mock`，不提升 AgentArts 云端状态。
