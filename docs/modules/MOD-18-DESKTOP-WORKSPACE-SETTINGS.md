# MOD-18 Desktop 编程工作区设置

- Profile：`huawei_ict_agentarts`；负责人：zemeng；待非作者评审，尚未真实联合验收。
- 工作树：`mvp-assembly`，分支：`codex/mvp-assembly`。
- 范围：Desktop 可信组合与设置。复用 coding-tools，不修改公共 Schema 或业务连接器。

设置中的 Worktrees / 环境页面提供系统目录选择器，并分别声明工具结果发送 AgentArts、写入和受限命令许可。目录使用 Electron safeStorage 加密保存；许可仅在本次应用进程有效。新目录需重启装配，重启后重新授权。Renderer 只收到目录简称和能力状态。

可信宿主注册读取、枚举、预览、候选、条件应用补丁，以及固定的 Git 差异检查命令。应用补丁复用独占句柄、恢复目录 ACL 和原 SHA 校验；不可用时准确显示。命令不是通用终端或 OS 沙箱。移除早期 4 KB 限制，复用 coding-tools 默认 256 KiB 读取和既有预览限额；补丁只修改已有文件，命令运行固定 `git diff --check` 参数。工具执行继续经过 Runtime、Policy、ToolGateway。

普通产品启动不再自动公布固定会议夹具为编程能力。历史夹具验收需显式设置 `PA_DESKTOP_SYNTHETIC_FACT_SOURCE=1`。云端续答取消额外的 8 KiB 演示上限，统一使用既有 CoordinationContinuation 的 1 MiB JSON 边界；这不是外部模型上下文容量保证。Desktop 采用已有文字工具流程的八轮预算并在任务创建时持久绑定；审批恢复不会重置预算，历史任务保持四轮。

工作区许可绑定任务 checkpoint 和本次许可代次。撤销会取消本宿主在途调用并禁止后续执行、结果发送；重新授权不复活旧任务。已经发生的文件写入不会因撤销自动回滚，结果未知应通过既有恢复证据核实。

必要验证：专属宿主测试 1/1 通过，覆盖目录配置、进程重建后不继承许可、绑定读取、撤销及旧任务不能使用新许可；相关 JS 语法和差异检查通过。用实际设置组件及合成状态检查了浏览器布局。本轮未执行真实项目补丁、命令、Electron 或 AgentArts 联合验收，不据此宣布 MOD-18 或 MVP 完成。
