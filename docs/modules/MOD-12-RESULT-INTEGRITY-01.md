# MOD-12-RESULT-INTEGRITY-01：回答正文完整性

- Profile：huawei_ict_agentarts；MOD-11/12，PA-001/004。
- 负责人 zemeng；非作者评审者 goo122；状态 review，待评审及集成。
- 基线 main `72cc76b`；工作树 `.worktrees/zemeng-desktop-result-integrity`。
- 分支 `codex/zemeng/desktop-result-integrity`。

## 问题与范围

面板、工作区和桌面历史辅助代码使用正则删除 `resultSummary` 末尾形如
`[model=...; verification=...; tokens=...]` 的内容。该内容可能是合法回答，
不能只凭文本外形认定为可信元数据。Core Runtime Profile 1 未提供对应结构化字段，
接口目录明确禁止从摘要尾缀形成新协议。

该工作移除猜测性删除，使展示、复制/分享及历史辅助结果保留字面正文，
继续在 HTML 展示处转义不可信文本。不改变 Runtime 结果、模型生产者、任务终态、
公共 Schema 或授权，也不添加替代元数据协议。

既有 Local 生产者主动附带的尾缀将作为普通文本可见；这不是新增 Local 功能，
也不承诺该历史格式成为公共协议。后续结构化元数据需由公共接口负责人发布。

## 验收边界

- 使用合成字面正文验证完整尾缀、仅尾缀、普通正文与空值。
- 保留历史任务状态及会话过滤，保留 HTML 转义。
- 仅做受影响定向测试、语法和差异检查，不新增云调用或真实数据读取。
- 不声称整个 Desktop 或 AgentArts Golden Path 已验收完成。

## 实际验证

- `node --test --test-isolation=none apps/desktop/test/result-text.test.mjs apps/desktop/test/conversations.test.mjs`：2/2 通过。
- 相关七个 JavaScript 文件 `node --check`、`git diff --check` 通过。
- 面板、工作区及历史复用同一无 DOM、无 Node 依赖的文本函数；HTML 转义保持在原有渲染位置。
- 现有 `text-chat-smoke.cjs` 的旧“不得出现元数据文本”断言已同步为完整正文及剪贴板值断言，
  仅静态检查，未运行该 GUI 检查；未声明面板/工作区的动态渲染验收通过。
- 无公共接口、依赖、数据迁移或真实调用变化，可通过回滚单一提交恢复。
