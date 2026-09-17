# MOD-18-WORKSPACE-READ-01：可信工作区只读源码首片

目标 Profile：`huawei_ict_agentarts`

模块 / 需求：MOD-18 / PA-017、PA-023、PA-026

负责人 / 评审者：`zemeng` / `goo122`

状态：`review`（模块实现与根 workspace/build/lock 已进入 Draft PR；生产 composition 未接）

拥有范围：`packages/coding-tools/**`、本文档

## 目标与交付

本工作包先建立 patch/command 之前的工作区读取安全边界。可信宿主在构造 `workspace.read_text@1.0.0` 时注入并 canonicalize 唯一根目录；模型和 AgentArts 只能提交相对文件路径与更严格的整文件字节上限。工具复用当前 provisional `RegisteredTool` / `ToolContext` / `ToolHost`，descriptor 要求 `workspace:read`，通过现有 Runtime/Policy/ToolGateway 取得 scope；本包不签发授权、不创建第二套 registry。

交付范围：

- 只读、完整 UTF-8 文本读取，默认 256 KiB、最高 1 MiB；文件超限或二进制直接拒绝，不截断成可能误导的源码；
- 精确 input/output Schema，拒绝未知字段；
- 拒绝绝对路径、`..`、Windows 盘符/drive-relative、UNC/设备路径、ADS、保留设备名和歧义路径段；
- 根与目标按平台 `realpath`，用 `path.relative` 目录边界抵御兄弟前缀、符号链接与 junction 逃逸；打开前后核对 canonical path 和文件标识；
- 默认同时检查请求路径与 realpath 目标，拒绝常见环境文件、凭据、私钥及敏感配置目录；文本内容出现私钥头也拒绝；
- scope、deadline 与取消信号在打开、分块读取和返回前持续检查；读取过程中变化的文件不返回；
- `register(host, options): dispose` 使用现有 Host 生命周期；用户文件始终只读。

不在范围：命令执行、patch 生成/应用、Git 状态修改、真实用户项目读取、Artifact/Evidence DTO、Runtime/根 composition、AgentArts 云调用、Local Profile 扩展、发布。

## 信任与隐私边界

`rootPath` 是受信 composition 配置，不得来自工具输入、模型内容或 AgentArts proposal。返回内容只属于本地已授权工具调用结果；它不会由本包写日志、持久化或发云。后续 Competition 链将内容传给 AgentArts 前，必须另行做最小化、脱敏和出机授权，且不得传 `authorizationRef` 或本地绝对路径。

当前措施不构成 OS 沙箱。跨平台 Node 文件 API 无法保证攻击者并发替换每一级目录项时的完全无竞态遍历；本包通过 realpath、目录边界、打开句柄身份与读取后元数据复核降低风险并明确拒绝检测到的变化。后续写入和 command 必须另设进程/文件系统隔离、资源限制和结果读回，不能复用“只读检查通过”作为写权限。

## 接口状态与集成交接

- 消费：`@personal-agent/contracts@0.1.0-alpha.1` 的 `RegisteredTool`、`ToolContext`、`ToolHost`，当前均为 `provisional`；固定本分支提交供评审，准备随接口迁移。
- 不新增公共 contracts，不定义 unavailable 的 `ToolExecutionPort`、ArtifactPort 或 EvidencePort。
- 根 workspace 发现、build 顺序和 lockfile link 已接入；Policy/ToolGateway 黑盒集成测试覆盖未授权不执行、精确授权读取、撤销拒绝和 dispose 后 `UNSUPPORTED_CAPABILITY`。
- 新 capability 尚未进入生产 Runtime/capability list；未装配时继续表现为未注册/`UNSUPPORTED_CAPABILITY`，不能启用 Fake 冒充。
- AgentArts proposal → 本地 Runtime/Policy/ToolGateway → 本工具 → 读回/Evidence → AgentArts 最终回答仍未接通；没有真实 deployment/API/trace，也没有 Local 回退。

本工作包已完成：

1. 根 `package.json` 在 contracts 后构建 `@personal-agent/coding-tools`；`package-lock.json` 只增加该 workspace 的 metadata/link，无新外部依赖。
2. 合成临时工作区通过 `InMemoryAuthorizationPolicy` + `ToolGateway` 黑盒验证：授权前 provider 调用计数为零；grant 绑定 task/tool/scope/参数摘要后读取精确文本；revoke 后不执行；dispose 后返回 `UNSUPPORTED_CAPABILITY`。

仍需由 goo122 在后续独立生产 composition 工作包完成：

1. 从用户明确授权的工作区配置注入 `rootPath`，通过现有 ToolGateway 注册/释放；不得从 proposal 参数构造根目录。
2. capability 公布前补 Runtime 任务生命周期消费与发现测试；未装配时保持 `UNSUPPORTED_CAPABILITY`。
3. 等 ToolExecutionPort、ArtifactPort、EvidencePort 由接口负责人提供后，再接工具提案、内容最小化、读回证据与可访问 Artifact；本包不猜 DTO。

## 验收与证据

定向测试只使用系统临时目录中的合成文件，不读取真实用户项目：允许文本；非法字段与路径；兄弟前缀；symlink/junction（平台不支持时记录明确 skip 原因）；敏感文件；大文件；二进制；缺 scope；调用前和读取中的 deadline/cancel；register/dispose。

本集成增量命令：

```powershell
npm.cmd run build --workspace=@personal-agent/contracts
npm.cmd run build --workspace=@personal-agent/policy
npm.cmd run build --workspace=@personal-agent/tool-gateway
npm.cmd run build --workspace=@personal-agent/coding-tools
npm.cmd run check:architecture
node --test --test-isolation=none tests/integration/workspace-read-policy.test.mjs
git diff --check
```

不运行全仓 build/check，不重跑本包已有 9 项单元测试，不启动 Electron 或长驻服务。本文不把本地模拟测试表述成 AgentArts、Artifact、command/patch、完整 MOD-18 或完整 PA-017 验收。
