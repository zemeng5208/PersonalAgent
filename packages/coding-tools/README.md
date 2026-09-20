# 编程工具：可信工作区只读能力（MOD-18）

`@personal-agent/coding-tools` 当前交付 `huawei_ict_agentarts` Competition Profile 的两个本地只读能力：由可信宿主绑定一个工作区根目录，并按需把 `workspace.read_text@1.0.0`、`workspace.list_entries@1.0.0` 注册到现有 `ToolHost`。它不执行命令、不生成或应用 patch、不修改 Git 状态，也不提供 Artifact/Evidence 服务。

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

这是一层应用内约束，不是 OS 沙箱。跨平台 Node API 没有提供对整条路径逐目录、不可替换的句柄遍历；实现用 canonical path、打开句柄身份和读取后元数据复核缩小符号链接/junction 与 TOCTOU 风险，但不能在攻击者可并发改写目录项的工作区内宣称消除了所有竞态。后续 command/patch 执行必须使用独立、经验证的进程/文件系统隔离方案，不能把本工具的检查当作写入沙箱。

返回的源码只交给已经通过本地授权的调用路径。本包不会上传 AgentArts、写日志或持久化内容；调用方若要把内容发往云端，仍须单独执行最小化、脱敏和出机授权。

目录枚举在打开前确认请求目录位于 canonical root 内，拒绝把 symlink/junction 当作目标；遍历结束后再次核对路径和目录身份。枚举项只接受 `Dirent` 直接报告的普通文件/目录，symlink、junction、其他特殊项、不可由本包规范寻址的名称和默认敏感路径都会被省略，不跟随目标。敏感项不计入 `truncated`。

`workspace.list_entries` 使用 `opendir` 迭代，不先把整个目录读入数组；扫描期间仅保留至多 `limit` 个按 JavaScript 字符串码元升序排列的候选，因此输出与内存有界。为了得到全局稳定的前 N 项，仍会扫描到目录末尾，扫描过程逐项检查 deadline/cancel。真实文件系统枚举不是事务快照：读后 lstat/realpath/身份复核能拒绝可检测的目录路径替换，但 Node `fs.Dir` 没有公开可供本实现 fstat 的目录句柄，不能消除恶意并发替换竞态，也不能阻止扫描期间普通子项增删或改名；结果只能表示本次受限观察，不能当作完美快照。

## 当前状态与接线限制

本包消费 `@personal-agent/contracts@0.1.0-alpha.1` 的 provisional `RegisteredTool`、`ToolContext` 与 `ToolHost`，并按现有 Gateway/Policy scope 机制工作。它没有私设仍为 unavailable 的 `ToolExecutionPort`、ArtifactPort 或 EvidencePort。

AgentArts 工具提案、Runtime composition、目标系统读回、Evidence 和最终回答尚未接通；因此这些只是离线可验证的本地只读工具，不是完整编程执行能力，也不是 Competition Golden Path 已完成或真实 AgentArts 可用的证据。根 `package.json` build 编排与 `package-lock.json` workspace 记录随 PR #83 直接从 `main@1e3b56b6` 重建；旧 Draft #63 已关闭且不作为本 PR 的堆叠依赖。`workspace.list_entries` 不会自动进入生产 composition。

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
