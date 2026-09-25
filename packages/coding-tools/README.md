# 编程工具：可信工作区能力（MOD-18）

## 当前增量：独占句柄内应用文本补丁

`createWorkspacePatchApplyTool(options)` / `registerWorkspacePatchApply(host, options)`
显式提供 `workspace.apply_text_patch@1.0.0`。它复用现有只读 preview 的严格
相对路径、原 SHA-256、唯一精确编辑和有界 UTF-8 候选字节；额外要求
`workspace:apply`，不能把 stage 的 `workspace:write` 授权升级为源文件应用。
可信宿主提供工作区根、工作区外且已限权的恢复目录、受信 PowerShell 可执行文件；
helper 脚本和可执行文件也必须位于授权工作区外，模型和工具输入都不能改变
这些位置。当前仅支持 Windows，默认不注册到产品。

固定的 `scripts/locked-apply.ps1` 不使用 `ExecutionPolicy Bypass`，通过 stdin
接收本次 preview 生成、SHA 绑定的候选字节，不信任可由其他进程修改的 stage
文件。它用 .NET `FileStream` 的 `FileShare.None` 在同一独占句柄内核对源 SHA、
最终路径和单硬链接身份；首写前在受信恢复目录排他创建备份并 `Flush(true)`、
读回备份，之后才原位写入、截断、`Flush(true)` 并在仍持锁时读回目标 SHA。
打开文件时已有其他句柄或原 SHA 不符时不写。成功结果只证明独占读回的那个
时刻，锁释放后的用户编辑仍可继续。写入开始后故障、超时或进程终止可能留下
部分文件与备份，必须以任务/运行标识查找备份并重新核对当前源文件及授权，
不自动重试或盲目回滚。恢复目录还按源文件保留 `.inflight` 标记及 helper PID：
候选字节发送前持久创建，只有进程 `close` 确认后才删除；2 秒停止等待超时
可以先向上层返回未知，但标记未消失前不得对账或再次 apply 同一源文件。
进程/宿主崩溃留下的标记只能由受信恢复流程确认 PID 已退出、核对备份和
当前源文件后处理。原位写入不是断电/崩溃时始终原子旧或新的替换。

此工具仍不构成任意路径的 OS 沙箱；Node 先拒绝链接、硬链接和越界路径，
helper 再对已打开句柄核对最终路径和链接数，无法证明时不写。恢复目录必须由
可信宿主预先创建并限制访问；本包不把备份当作 Artifact，也不允许其内容自动
送往云端。当前 factory 只确认恢复目录位于工作区外且存在，不能证明 Windows
ACL 已限权；正式组合在核验目录访问控制前不得注册 apply。合成临时目录测试
不构成该核验。现有 ToolGateway 对所有 `local_write` 异常保守映射
`RESULT_UNKNOWN`，包括可以证明首写前安全拒绝的冲突，需由公共 owner 后续
明确分阶段错误；本包不越界修改 Gateway。真实用户工作区验收须与命令工具
共用编程链的一次联合回执。

## 既有增量：授权后的文本补丁候选文件

`createWorkspacePatchStageTool(options)` 提供显式注册的
`workspace.stage_text_patch@1.0.0`。可信宿主提供工作区根，工具仅在现有
ToolGateway/Policy 以 task、工具、参数和 `workspace:read` + `workspace:write`
授权后使用；本包不签发授权。输入沿用预览的 `path`、`expectedSha256` 和
有界 `edits`。它复用只读预览与 reader 校验，拒绝链接、硬链接、目录逃逸、
敏感文件和过期哈希；在可信根下以排他创建生成 `.pa-stage-*.patch` 候选文件，
读回其摘要，并复核原文件状态。返回的 `stagedPath` 是候选文件的相对路径，
原文件始终不打开写入、不重命名、不覆盖。`registerWorkspacePatchStage(host, options)`
沿用现有 ToolHost 生命周期，默认不注册到产品。

候选文件创建属于 `local_write`，声明不支持自动幂等重试与恢复；失败时尝试
删除本次创建的候选，无法确认清理则返回 `RESULT_UNKNOWN`。外部编辑器即使
在最后一次原文件复核后修改原文件，也不会被此工具覆盖。候选文件并非已应用
补丁，不能把它呈现为源文件完成写入或最终 Artifact。上述 apply 是独立的
独占句柄原位应用路径，不把 stage 的哈希检查或 rename 冒充原子 CAS。

以下保留最初两个本地只读能力的边界：可信宿主绑定工作区根目录，并按需把 `workspace.read_text@1.0.0`、`workspace.list_entries@1.0.0` 注册到现有 `ToolHost`。只读工具不执行命令或修改 Git 状态，也不提供 Artifact/Evidence 服务。

## 公开入口

- `createWorkspaceReadTool(options)`：创建 `RegisteredTool`；`options.rootPath` 必须由可信宿主注入，不能来自 AgentArts、模型输出或工具参数。
- `register(host, options)`：使用现有 `ToolHost.register()` 注册并返回 dispose，不创建第二套 registry。
- 工具 scope：`workspace:read`。授权仍由 Runtime/Policy/ToolGateway 签发、绑定和消费；本包不创建授权引用，也不扩大 scope。
- 输入：`{path, maxBytes?}`。`path` 只接受规范的相对子路径，`maxBytes` 只能收紧宿主上限。文件必须完整落在上限内；不截断、不提供无限输出。
- 输出：`{path, encoding:'utf-8', byteLength, content}`。只返回相对路径，不披露宿主工作区绝对路径。
- 序列化边界：结果自身的 UTF-8 JSON 最多为 `MAX_SERIALIZED_WORKSPACE_READ_RESULT_BYTES`（当前为 960 KiB），为现有 `tool.invoke` / Response 包装预留 64 KiB；超限拒绝，不截断。

目录枚举使用独立入口与 scope：

- `createWorkspaceListTool(options)` 创建 `workspace.list_entries@1.0.0`；`registerWorkspaceList(host, options)` 注册并返回只释放该工具的 disposer。
- 工具 scope 为 `workspace:list`，不会把已有 `workspace:read` 授权扩大为枚举权限。
- 输入为 `{path, limit?}`；只有 `path:'.'` 表示受信根，其他路径必须是规范相对子目录。默认 limit 为 100；宿主 `maxEntries` 可降低请求上限，模块硬上限为 1000。
- 输出为 `{path, entries:[{name, kind:'file'|'directory'}], truncated}`。只返回直接子项名称与类别，不递归、不读取正文，也不返回绝对路径、权限、所有者、大小或时间；结果自身同样受 960 KiB 序列化门禁约束。

## 安全边界

工具拒绝绝对路径、`..`、Windows 盘符与 drive-relative 路径、UNC/设备路径、ADS、保留设备名和含尾随点/空格的歧义段。可信根使用 OS-native 同步 realpath，候选文件使用异步 realpath，避免 Windows CI 临时目录的 legacy/native 别名差异造成错误拒绝；随后通过 `path.relative` 的目录边界判断，不会用字符串前缀判断 containment。打开文件前后会再次核对 realpath 和文件标识，读取期间按块检查取消与 deadline，并在文件元数据变化时拒绝返回。

默认敏感文件策略同时检查请求路径与 realpath 目标，拒绝常见 `.env*`、凭据文件、私钥扩展、`.git`/`.ssh`/`.aws`/`.azure`/`.kube`/`.gnupg`/`.codex` 目录，并对文本内容中的私钥头再做一次拒绝。只接受完整、有效 UTF-8 且不含二进制控制字符的常规文件；默认原始文件上限为 256 KiB，宿主可调整，最高不能超过协议 1 MiB 边界。

原始字节数不等于 JSON 帧大小：Tab、换行、回车、引号和反斜杠会在 JSON 中转义。默认 256 KiB 即使全部由当前允许的最坏单字节转义字符组成，结果自身仍落在 960 KiB 预算内；NUL 等会产生更大 `\u00xx` 膨胀的控制字符会先被二进制策略拒绝。宿主提高原始文件上限时，工具会按实际序列化大小再次 fail-closed。该预算只约束 `WorkspaceReadResult`，不是对任意未来包装的保证：公共 Schema 没有限制所有 ID 与 `evidenceRefs` 的总长度，上层仍必须调用 `encodeFrame` 执行最终 1 MiB 帧校验。

这是一层应用内约束，不是 OS 沙箱。跨平台 Node API 没有提供对整条路径逐目录、不可替换的句柄遍历；实现用 canonical path、打开句柄身份和读取后元数据复核缩小符号链接/junction 与 TOCTOU 风险，但不能在攻击者可并发改写目录项的工作区内宣称消除了所有竞态。候选文件与后续真正的原文件写入仍需独立的文件系统隔离验收。

返回的源码只交给已经通过本地授权的调用路径。本包不会上传 AgentArts、写日志或持久化内容；调用方若要把内容发往云端，仍须单独执行最小化、脱敏和出机授权。

目录枚举在打开前确认请求目录位于 canonical root 内，拒绝把 symlink/junction 当作目标；遍历结束后再次核对路径和目录身份。枚举项只接受 `Dirent` 直接报告的普通文件/目录，symlink、junction、其他特殊项、不可由本包规范寻址的名称和默认敏感路径都会被省略，不跟随目标。敏感项不计入 `truncated`。

`workspace.list_entries` 使用 `opendir` 迭代，不先把整个目录读入数组；扫描期间仅保留至多 `limit` 个按 JavaScript 字符串码元升序排列的候选，因此输出与内存有界。为了得到全局稳定的前 N 项，仍会扫描到目录末尾，扫描过程逐项检查 deadline/cancel。真实文件系统枚举不是事务快照：读后 lstat/realpath/身份复核能拒绝可检测的目录路径替换，但 Node `fs.Dir` 没有公开可供本实现 fstat 的目录句柄，不能消除恶意并发替换竞态，也不能阻止扫描期间普通子项增删或改名；结果只能表示本次受限观察，不能当作完美快照。

## 当前状态与接线限制

本包消费 `@personal-agent/contracts@0.1.0-alpha.1` 的 provisional `RegisteredTool`、`ToolContext` 与 `ToolHost`，并按现有 Gateway/Policy scope 机制工作。它没有私设仍为 unavailable 的 `ToolExecutionPort`、ArtifactPort 或 EvidencePort。

这段只读工具的历史验收不证明上面的候选或 apply 工具已经进入 Runtime 或真实 AgentArts。根 `package.json` build 编排与 `package-lock.json` workspace 记录随 PR #83 直接从 `main@1e3b56b6` 重建；旧 Draft #63 已关闭。`workspace.list_entries`、候选文件和 apply 工具均不会自动进入生产 composition。

## 定向验证

测试只创建系统临时目录中的合成文件，不读取真实用户项目内容：

```powershell
npm.cmd run build --workspace=@personal-agent/contracts
npm.cmd run build --workspace=@personal-agent/coding-tools
npm.cmd run typecheck --workspace=@personal-agent/coding-tools
npm.cmd test --workspace=@personal-agent/coding-tools
node --test --test-isolation=none packages/coding-tools/test/workspace-read-wire-boundary.test.mjs
node --test --test-isolation=none packages/coding-tools/test/workspace-list.test.mjs
git diff --check
```

读取覆盖：允许的 UTF-8 文本；精确 Schema；绝对/父级/盘符/UNC/设备/ADS；兄弟前缀和 symlink/junction 逃逸；敏感文件；大文件与二进制；缺 scope；deadline/cancel；现有 Host 的 register/dispose；控制字符转义膨胀拒绝与正常 UTF-8 序列化边界。

枚举覆盖：根目录 `.`、稳定排序、limit/truncated、不递归、逃逸/敏感项/symlink-junction、独立 scope、扫描中 deadline、取消、严格 Schema、register/dispose。测试只使用系统临时目录中的合成文件；不读取真实用户工作区。
