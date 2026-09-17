# MOD-18-COMPETITION-WORKSPACE-01：Competition 工作区只读纵向接线

## 基本信息

- Profile：`huawei_ict_agentarts`。
- 负责人 / 非作者评审：`zemeng` / `goo122`。
- 分支：`codex/zemeng/workspace-competition`；状态：`review`（实现与定向测试已完成，
  尚未提交、推送或完成非作者评审）。
- 堆叠基线：PR #49 `03f9ab4`、PR #60 `d012a7d`，以及 MOD-18 coding-tools
  提交 `ada40a5`、`1fe234d` 与 PR #63 修复 `f8ee77c`（本分支 cherry-pick
  `fc694d8`、`8828227`、`e8aa1e0`）。这些依赖未合并不代表不存在；本工作包不复制其实现。
- 本片新增范围：`tests/integration/workspace-read-competition.test.mjs` 与本文档。

## 目标与边界

本片使用公开 `@personal-agent/coding-tools`、`@personal-agent/coordination/testing` 和
`@personal-agent/runtime/application` API，把真实 `workspace.read_text@1.0.0` provider
装入现有 Competition Fake 工具环。它验证的是本地可信组合、Policy/Approval、
ToolGateway、执行记录和 confirmed continuation，不新增第二套端口、registry、wire
operation、生产迁移或授权方式。

测试只在系统临时目录创建合成 UTF-8 源码；不读取真实用户工作区、凭据或私人数据，
不连接 AgentArts、模型、桌面或其他云服务。`rootPath` 由测试宿主直接绑定，绝不来自
proposal。测试结束删除临时目录。

## 纵向行为

主路径固定为：

1. Competition Runtime 的 `capability.list` 精确公布一个 `workspace.read_text` descriptor；
2. `FakeCoordinationPort` 提出只含相对路径和更小字节上限的 `mock` proposal；
3. Runtime 校验后进入 `waiting_approval`，公开审批查询不回显工具参数；
4. `allow_once` 绑定 task、tool、scope、参数摘要和期限；
5. 现有 RuntimeToolInvoker → ToolGateway → `createWorkspaceReadTool` 只执行一次；
6. 读取结果以 confirmed continuation 返回 Fake coordination，最终文本由 Runtime 提交；
7. task、tool execution record 和 conditional Evidence metadata 使用同一 run/evidence ID；
8. 同一个审批响应的幂等重放不触发第二次读取或第二条执行记录。

失败路径只覆盖跨层接线所需的两个增量，不重复 coding-tools 的九项 provider 单测：

- `../outside.txt` 在 provider 的同步路径规范化阶段被拒绝，不产生工具结果 checkpoint，
  不进入 continuation；执行记录为 `failed/INVALID_ARGUMENT`；
- 未注入工具时不公布 `capability.list`，proposal 以 `UNSUPPORTED_CAPABILITY` 失败，
  不产生 Evidence。

## 证据状态与剩余边界

本片通过后，只能证明 actual MOD-18 provider 的离线 Competition 纵向接线为
`provisional/mock`：

- PR #49 已提供 proposal、审批恢复、Policy/ToolGateway、Evidence 引用和 continuation；
- PR #60 保证提案参数和 continuation 结果中的合法 JSON 特殊键不会在隔离复制时丢失；
- PR #63 让可信根的同步与异步规范化使用原生 realpath 语义，并在返回前拒绝超过
  descriptor 输出 Schema 上限的序列化 JSON；
- MOD-18 provider 保持可信根、路径 containment、敏感文件、UTF-8、大小、deadline 和
  cancellation 边界；本片不重测所有细节。

真实 `AgentArtsCloudAgentPort` 仍只发送 query、接收文本；没有真实 tool proposal、
continuation、deployment/version/trace/usage 或数据出机读回。本片不把 Fake proposal
当作真实 AgentArts 能力，也不把 generic `verification: conditional` Evidence metadata
当作云端最终回答已核实。

Desktop 尚未提供用户显式选择、展示和撤销可信 workspace root 的生产组合，也未注册
`@personal-agent/coding-tools`。环境变量或本机已有路径不自动构成读取或出机授权；
Desktop 接线应在独立工作包中完成，未配置时继续不注册、不公布。

## 最少验证

在只构建本测试所需 workspace 闭包后运行：

```powershell
node --test --test-isolation=none tests/integration/workspace-read-competition.test.mjs
git diff --check
```

实际复核复用原 coding-tools 工作树缓存中的 Node `v24.15.0`：
`C:\Users\24035\.codex\worktrees\a9c8\PersonalAgent\.cache\npm\_npx\1c56de6e9acc34f8\node_modules\node\bin\node.exe`，
没有下载第二份 Node。用该精确目标版本只重建 coding-tools 后，本文件登记的 3 项集成
测试全部通过，0 failed。本次直接调用 Node/TypeScript，没有借此宣称 npm `11.12.x`
已复核；本片也没有为适配执行器复制或修改 provider。
