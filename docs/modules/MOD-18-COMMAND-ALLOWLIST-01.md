# MOD-18-COMMAND-ALLOWLIST-01

- Profile：`huawei_ict_agentarts`；负责人 `zemeng`；非作者评审 `goo122`；状态 `review`。
- 基线：`origin/main@ec43a55`；拥有范围 `packages/coding-tools/**` 与本记录。PRD `PA-017` 要求指定工作区内可审查改动和必要验证，不授权改无关工作区或自动发布。

本包新增可显式注册的 provisional `workspace.run_allowed_command@1.0.0`。可信宿主注入授权工作区根，以及每条 recipe 的固定绝对可执行文件和完整参数；调用者只能选择 `recipeId`，不能自带 shell、命令、argv、环境或 cwd。工具通过现有 `RegisteredTool`、Policy、ToolGateway 做参数摘要绑定和 `workspace:execute` scope 校验，不创造第二套授权或进程调度。descriptor 标为 `local_write`，不可幂等、不可自动恢复。生产 Runtime/Desktop 不注册，也不公布为可用 capability。

Node 内置 `spawn({shell:false})` 足以避免此固定调用面的 shell 解析，省掉新依赖和自行实现参数转义。工具约束时间、输出字节，取消/截止/超限时终止直接子进程并等待退出；测试只在用户授权的临时合成工作区运行固定 Node recipe。它不提供 OS 文件系统沙箱，cwd 不限制进程的可访问文件，也不保证 Windows 子进程树清理。因此可信宿主只能配置已审查、无需派生不受控进程的固定命令；任意项目脚本/命令、强隔离构建与真实用户工作区验收另行处理。未引入 execa：它提供便利 API，但不能提供缺失的权限或沙箱边界，且会增加直接依赖；未用 jsdiff 模糊应用替换现有精确 patch 路径。

结果只返回 `recipeId`、直接进程 `exitCode` 和完整受限 UTF-8 stdout/stderr。非零退出码不能当验证通过；返回结果不是 Artifact 或目标文件读回。ToolGateway 对写工具异常统一映射 `RESULT_UNKNOWN`，调用方必须先对账再重试。`ArtifactPort`、可信 Evidence、AgentArts 真实 proposal/continuation、生产接线和原文件原子条件替换仍未交付，stage-only 也不冒充 apply。

验证：Windows Node 26.3.0 本地 coding-tools build 通过；声明版本 Node 24.15.0 上的合成测试 `workspace-command.test.mjs` 3/3 通过，覆盖宿主 recipe 固定、cwd、非法输入/缺 scope、Policy 单次参数绑定授权、dispose、输出超限、非零退出、取消后的直接子进程停止。默认沙箱执行遇 `spawn EPERM`，获准在本机执行同一组定向测试后通过；该结果不是 Windows 子进程树或真实项目验证。未运行全仓 check、Electron、真实云端或项目脚本。
