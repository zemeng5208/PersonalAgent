# MOD-34 受控 Git 工具

生产入口 `packages/coding-tools/src/dev-workflows/git-tools.ts` 提供 `createGitTools`、`registerGitTools`、`readGitWorkspaceFingerprint`。组合入口负责公开导出和注入可信 Runtime receipt 查询。

| 工具 | 输入 | 输出 | 授权 |
| --- | --- | --- | --- |
| workspace.git.head | repository | headSha, clean, workspaceClean, fingerprint | workspace:git:read |
| workspace.git.commit | repository, expectedHeadSha, paths, message, verificationRunId | headSha, parentSha, branch | workspace:git:commit + Presence |
| workspace.git.push | repository, expectedHeadSha | headSha, pushed | workspace:git:push + Presence |

`workspaceClean` 要求整个工作区和用户 index 干净，用于修复开始前检查；`clean` 允许 host allowlist 内未暂存修改，但禁止其他修改。两个字段不代表构建成功。

Host 固定 canonical root、repository、sourceBranch、remoteName、无凭据 HTTPS remote URL、路径 allowlist 与作者身份。模型无法传命令、shell、remote、branch、凭据或验证结果。进程使用 Node spawn 与固定 argv，限制输出和 deadline，清理 Git 环境注入变量，不返回 stderr。命令失败不声称写入未发生；取消、超时及输出溢出标记结果未知，必须外部核实后再决定操作。

Commit 查询原 task/run 的 Runtime 已确认 `workspace.run_allowed_command` receipt，要求真实 exitCode=0、同 HEAD、全部 host allowlist 文件 SHA256 一致。Runtime 组合入口必须在验证命令执行前后读取相同快照，仅在两者一致且命令结果确认时记录 receipt。不能将模型 arguments 转成 receipt。快照 helper 只读，不签发授权。

Commit 用临时独立 index 从旧 HEAD 建树，精确验证字节经 hash-object stdin 写入 blob，不执行 clean filter、不暂存全仓。入口拒绝已有 staged 变动；按 `git rev-parse --git-path index` 取得实际 worktree index 路径，取得 exclusive index.lock 后核实原 index 字节 SHA256、HEAD 和文件快照，写入新 index，锁期间以 update-ref old SHA CAS 更新固定分支，再原子 rename 安装新 index。不覆盖并发 Git index 写入；ref 已尝试更新后异常使用 RESULT_UNKNOWN，需读回 HEAD/index 核实。仅支持 bounded canonical 普通文件；不支持删除、symlink、submodule。只读 Git 子进程中断也保守返回 RESULT_UNKNOWN。

Push 固定 SHA 到固定 remote 分支；读取远程 SHA 并确认其是新 HEAD 的祖先，再使用 expected-SHA lease 消除远程竞争，拒绝覆盖分叉历史。读到不可达远程对象时 fail closed，不做隐式 fetch。Push 独立外部写审批；无副作用盲目重试。

Push 在 context 授权检查后调用 host `getCredentials(context)`，接收 `{token}`。host 可与 GitHub 工具复用同一个可信 secret adapter；不读取 ambient token，不调用全局 credential helper。缺凭据明确 UNAUTHORIZED。仅为固定 HTTPS URL 的 Git 子进程设置 http extraheader 环境配置；token 不进入 argv、模型参数、返回值或日志，并禁止 HTTP redirect。注册任一工具失败时回滚已取得的注册。

本工作包遵照用户限制，未执行 build、测试、安装或真实服务。准备的集中验收命令：`npm run build -w @personal-agent/coding-tools`，随后 `node --test packages/coding-tools/test/git-tools.test.mjs`。另外需要真实临时 Git 仓库验收 index 字节保持、HEAD CAS 竞争、receipt 伪造/文件变动、远程 lease 竞争和写结果未知恢复；这些尚未验证。
