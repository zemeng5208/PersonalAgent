# MOD-18-WORKSPACE-PATCH-APPLY-01

- Profile：`huawei_ict_agentarts`；负责人 `zemeng`；非作者评审 `goo122`；状态 `review`。
- 基线：#133 stage-only head `c59534e`；工作树 `mod18-safe-apply`；仅 `packages/coding-tools/**` 和本记录。不改公共 Schema、Runtime/Policy、根 lock、Desktop 或业务连接器。

`workspace.apply_text_patch@1.0.0` 复用 preview 的精确编辑、UTF-8、相对路径、敏感项与 expected SHA 校验，使用独立 `workspace:apply` scope。真实源文件写入由 Windows 固定 helper 完成：可信宿主传入授权根、受控且与工作区分离的限权恢复根、PowerShell 路径；helper 脚本和可执行文件须位于授权根外。候选字节由本次 preview 生成并经 SHA 校验后通过 stdin 传递，不读取可被外部编辑的 stage 文件。工具不默认注册到产品，仍由既有 Policy/ToolGateway 对精确参数与一次性授权决定是否调用。

helper 用 .NET `FileStream(FileShare.None)` 独占打开源文件，校验已打开句柄的最终路径与单链接普通文件身份，同句柄读取并核对原 SHA。首写前排他创建备份、`Flush(true)` 并读回；随后仍在同句柄内写入、截断、`Flush(true)` 与目标 SHA 读回。锁前 hash 冲突或文件已占用不写；锁释放后的新编辑不属于这次读回时刻。写入开始后进程中断可能留下部分源文件与备份，结果必须记为未知并凭 task/run 派生备份前缀对账，不自动重试或盲目回滚。该路径防普通 Windows 编辑器在检查与写入之间覆盖，但不是崩溃原子替换、任意路径 OS 沙箱或恶意进程并发改写授权目录时的完整保证。

系统 Windows PowerShell 5.1 在本机为 `Restricted`，固定 `.ps1` 被策略拒绝；实现不使用 `ExecutionPolicy Bypass`。定向测试改用本机已有 PowerShell 7（`RemoteSigned`），因此受信宿主需要提供允许执行此本地脚本的 PowerShell 路径，正式安装/运行环境尚未验收。恢复目录访问控制由受信宿主创建和管理，备份可能包含源码，不是 Artifact，也不自动出机。

最小验证：coding-tools build 通过；在系统临时目录合成工作区、声明 Node 24.15.0 与 PowerShell 7 下 apply 定向测试 4/4 通过：成功应用/同锁读回且无残留备份、旧 SHA 与已占用源文件不覆盖、缺独立 scope/取消/硬链接拒绝、首写前备份创建失败时原文件不变。未运行全仓 check、真实用户工作区、AgentArts 或编程链联合验收。`ToolGateway` 当前把所有 `local_write` 异常保守映射 `RESULT_UNKNOWN`，包括 helper 首写前冲突；分阶段错误保留属于公共 owner 的后续接口工作。
