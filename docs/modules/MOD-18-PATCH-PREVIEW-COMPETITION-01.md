# MOD-18-PATCH-PREVIEW-COMPETITION-01：Competition 文本 Patch 预览纵向接线

## 基本信息

- Profile：`huawei_ict_agentarts`。
- 负责人 / 非作者评审：`zemeng` / `goo122`。
- 分支：`codex/zemeng/patch-preview-competition`；状态：`review`（本地组合与定向测试完成后，仍待非作者评审与集成）。
- 依赖：工作区补丁预览 `9ca55a4`；Competition 本地工具循环与 JSON 保真修复 PR #49 / PR #60 汇总提交 `a54b408171a8d174e8c32fd56e47912343376f5f`。
- 本片新增范围：`tests/integration/workspace-patch-preview-competition.test.mjs` 与本文档；不修改 Runtime、contracts、coding-tools provider 或生产装配。

## 目标与边界

本片通过公开 `@personal-agent/coding-tools`、`@personal-agent/coordination/testing`、`@personal-agent/runtime/application` 和 `@personal-agent/tool-gateway` API，把真实本地 `workspace.preview_text_patch@1.0.0` provider 装入 Competition Fake 工具环。它只验证本地可信组合中的 proposal、审批、参数摘要绑定、ToolGateway、执行记录、confirmed continuation 和 Runtime 终态，不新增端口、registry、wire operation、授权方式或数据库迁移。

测试只在系统临时目录创建合成 UTF-8 源码和 Runtime 数据库；不读取真实用户工作区、凭据或私人数据，不连接 AgentArts、模型、桌面或其他云服务。可信 `rootPath` 由测试宿主直接绑定，绝不来自 proposal，测试结束删除临时目录。

## 唯一组合路径

新增的一条集成测试固定验证：

1. `capability.list` 精确公布一个已就绪的补丁预览工具；
2. `FakeCoordinationPort` 提出含相对路径、精确 before hash 和单条替换的 `mock` proposal；
3. Runtime 校验后进入 `waiting_approval`，审批查询只公开 action，不回显参数，provider 尚未执行；
4. `allow_once` 把 task、tool、`workspace:read` scope、期限和完整参数摘要绑定；
5. RuntimeToolInvoker → ToolGateway → 真实 `createWorkspacePatchPreviewTool` 只执行一次；
6. 本地 provider 返回精确 before/after SHA-256 与候选文本，结果以 `confirmed` continuation 交回 Fake coordination，Runtime 进入 `succeeded`；
7. 脱敏审批的 `argumentsDigest` 等于 proposal 参数的公开 `toolArgumentsDigest`，工具执行记录、Evidence 与审批保持对应 ID；
8. 原文件字节和目录项在审批前、执行后及审批幂等重放后均完全不变；同一个审批响应重放不产生第二次预览、第二条执行记录或第三次 coordination 请求。

本片不重复 provider 的路径、编码、编辑歧义、大小、deadline/cancel 等单测，也不重复 Policy 集成的未授权、参数替换与撤销分组。

## 证据状态与剩余边界

测试中的 provider 是真实本地实现，Policy/ToolGateway/Runtime 路径也是真实本地组合；`FakeCoordinationPort` 的 proposal 和最终文本仍明确标记 `verification: 'mock'`。因此本片只能证明 provisional 的离线 Competition 组合，不是 AgentArts 云端工具调用、部署或真实文件写入成功：

- 工具只生成预览，不写文件、不授予后续写权限，也没有 OS 原子 compare-and-swap；
- 未调用真实 AgentArts project、Agent/Workflow、deployment/version、API、trace 或 usage；
- 未验证真实云端 tool proposal / continuation 协议，也未发送本地源码到云端；
- 未接入 Desktop 的可信工作区选择、撤销或生产工具注册；
- conditional Evidence 只描述本地可信执行，不能提升为云端 `verified`。

## 最少验证

只构建本测试所需 workspace 闭包后运行：

```powershell
node --test --test-isolation=none tests/integration/workspace-patch-preview-competition.test.mjs
git diff --check
```

实际使用 Node `v24.15.0` 直接构建本测试所需 workspace 闭包；新增测试 `1/1` 通过，`0 failed`，`git diff --check` 通过。依赖安装由宿主 npm `11.16.0` 完成并因宿主 Node `v26.3.0` 与仓库 engine 不同产生警告，但构建与测试均明确使用目标 Node `v24.15.0`。未运行全仓 `npm run check`、云端验收或真实用户文件测试。
