# MOD-18-GEMINI-COMMAND-RECIPES：可信桌面命令工具配方构造与安全边界

- **目标 Profile**：`huawei_ict_agentarts`（比赛主路径，Local 保留为可选 baseline）。
- **需求与任务**：MOD-18 / PA-017；负责人 `zemeng`（Gemini 3.8 Flash High 实现），非作者评审 `goo122`。
- **基线提交**：`d9ecf2623c2aeff9deeb46bdca17c6e340087ab2`。
- **本工作包分支**：`codex/gemini-workspace-command-recipes`（独占编辑授权文件，不破坏其他协作者工作树）。
- **本轮改动文件范围**：
  1. `apps/desktop/electron/workspace-command-recipes.js`
  2. `apps/desktop/test/workspace-command-recipes.test.mjs`
  3. `docs/modules/MOD-18-GEMINI-COMMAND-RECIPES.md`
  4. `packages/coding-tools/src/command.ts`
  5. `packages/coding-tools/README.md`
  6. `packages/coding-tools/test/workspace-command.test.mjs`
  7. `packages/coding-tools/native/`（`WindowsJobProcessHost.csproj`、`Program.cs`、`.gitignore`）
- **当前接口与能力状态**：内部组合辅助入口；产品端命令执行能力继续保持 `unavailable`。

---

## 1. 核心职责与安全模型

本模块为可信 Desktop Main 进程提供**受限工作区命令工具配方构造入口**（`buildWorkspaceCommandRecipes` 与 `createWorkspaceCommandRecipeTool`），基于 `@personal-agent/coding-tools` 公开的 `createWorkspaceCommandTool` 组装受限命令，严格遵循如下安全原则：

### 1.1 绝不新建进程执行器或第二套协议
- 严格消费 `@personal-agent/coding-tools` 的公开 `createWorkspaceCommandTool`，**绝不另写 `spawn`、`shell`、进程执行器、第二工具协议或 Runtime 执行循环**。
- 所有执行生命周期、超时期限（`deadline`）、取消信号（`context.signal`）、输出缓冲上限（`maxOutputBytes`）及 UTF-8 校验全部由底层公开命令工厂托管。
- `createWorkspaceCommandRecipeTool` 要求宿主**显式传入公开的 `createWorkspaceCommandTool` 工厂**；若未传入或非函数，立即 **Fail Closed**，绝不通过动态 import 掩盖破损依赖错误。

### 1.2 严格要求宿主显式注入 Node 与助手可执行文件（禁止 PATH 自动探测）
- `nodeExecutable` **必须由受信 Desktop Main 显式传入固定的绝对路径**；
- **禁止使用 `where.exe`、PATH 环境变量搜索或默认回退至 `process.execPath`**（PATH 可能由用户或工作区篡改，不能作为可信安装证明）；
- 必须校验：为规范绝对路径、为普通文件（非符号链接）、文件名必须为 `node.exe`（非 Windows 平台为 `node`），且**必须严格位于所授权的工作区外**。
- 同理，`jobHelperExecutable`（WindowsJobProcessHost.exe）与 `npmCliPath`（npm-cli.js）亦必须由受信宿主显式注入，并验证为工作区外、规范化普通文件。

### 1.3 严格固定 argv 与参数枚举
- 所有命令参数（`args`）由宿主在配置时预先构造并固化（如 `['--check', relPath]` 或 `['--cwd', root, '--exe', node, '--', npmCli, 'run', 'build']`）。
- **禁止模型提供可执行文件路径、任意脚本路径、或 shell 命令行字符串**。
- 模型在执行时仅提供 `{recipeId}`，枚举值严格收紧至当前批准的配方集合。

### 1.4 路径合法性与跨界逃逸防御
- **工作区边界**：`workspaceRoot` 必须为本机绝对目录，禁止驱动器根目录（如 `C:\`），禁止 UNC 网络路径，禁止符号链接。若指定 `authorizedWorkspaceRoot`，必须严格与已授权目录身份一致。
- **待检查源文件**：`checkFiles` 必须是工作区内的规范相对路径。严格拒绝绝对路径、驱动器盘符、UNC 路径、`..` 目录逃逸、符号链接（`isSymbolicLink()`）以及指向工作区外的目标。

---

## 2. Windows 孤儿进程树治理：WindowsJobProcessHost 原生内核隔离

在 Windows 操作系统中，若直接通过 Node 内置 `spawn` 派生 `npm run build` 或 `npm test`，并在超时/取消时调用 `child.kill('SIGKILL')`，仅能杀死直接的父进程，而 npm 或 node 衍生出的底层编译工具（如 tsc、vite、webpack、jest 等）会成为不受控的**孤儿后台进程**，持续霸占系统资源。

为此，我们在 `packages/coding-tools/native/` 下实现了极简专用的原生宿主助手：`WindowsJobProcessHost`（基于 .NET 8 与 Win32 API）：

### 2.1 严格的 Win32 Job Object 不变量
1. **Kill On Job Close 保证**：使用 `CreateJobObjectW` 创建 Win32 作业对象，并配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000)`，同时坚决禁止 breakaway（严防进程从 Job Object 逃逸）。
2. **挂起创建与纳管前序**：使用 `CreateProcessW` 配合 `CREATE_SUSPENDED (0x4)` 与 `CREATE_NO_WINDOW (0x08000000)` 创建目标 Node/npm 进程。
3. **关键安全不变量（Assign Before Resume）**：
   - 在挂起进程的主线程被唤醒前，必须先调用 `AssignProcessToJobObject` 将其加入作业对象；
   - **若加入作业对象失败，立即调用 `TerminateProcess` 强制销毁该挂起进程**，绝不放任任何未纳管的进程开始运行；
   - 只有在成功加入作业对象后，才调用 `ResumeThread` 恢复进程执行。
4. **内核级原子灭活**：当父进程（Node 工具）发送 SIGKILL、被任务系统终止、或者 helper 进程由于任何原因退出时，操作系统内核会自动关闭 Job Object 句柄，从而瞬间、原子地强制终止整棵子进程树中的所有子进程、孙进程。
5. **管道与退出码安全转发**：通过匿名管道异步转发子进程的标准输出与标准错误流，并在子进程退出后如实返回退出码。

---

## 3. 受信环境变量注入与敏感词防御

在 `packages/coding-tools/src/command.ts` 中增强了环境变量配置与严格防御：
1. **向后兼容**：若未传入 `env`，保持现状使用默认 `{}`（不继承当前进程的 `process.env`，绝不泄漏外部私人凭据）。
2. **严格的键值模式门禁**：
   - 环境变量键必须匹配 `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u`，不能包含 `=` 或 `\0`；
   - 阻断含有敏感词的键：`/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i` 立即抛出 `INVALID_ARGUMENT`；
   - 环境变量值必须为 string，字符长度限制 <= 4096，且不含 `\0`；
   - 总条目数受限（<= 64 条）。
3. **白名单操作系统变量**：
   Desktop helper 在组装 npm 项目脚本配方时，仅从系统环境中提取最小化的安全操作系统变量（如 `APPDATA`, `LOCALAPPDATA`, `ComSpec`, `PATH`, `SystemRoot`, `TEMP`, `TMP`, `WINDIR` 等），保证 Node 和 npm 可以在受限隔离环境下正确定位 Windows 系统组件，同时杜绝任何用户私有 Token、API Key 的传入。

---

## 4. npm-build 与 npm-test 的 5 项严格门禁

在 `apps/desktop/electron/workspace-command-recipes.js` 中，只有当**下列 5 项安全门禁全部满足**时，才会生成并暴露 `npm-build` 与 `npm-test` 配方：
1. `allowProjectScripts === true`：宿主显式选择开启；
2. **受信 Job Helper 注入**：宿主显式提供 `jobHelperExecutable`（通过 `resolveJobHelperExecutable` 校验为工作区外、规范化普通文件、非 symlink，Windows 下为 `.exe`）；
3. **受信 npm-cli 路径注入**：宿主显式提供 `npmCliPath`（通过 `resolveNpmCliPath` 校验为工作区外、规范化普通文件、非 symlink，为 `npm-cli.js`）；
4. **package.json 声明脚本**：工作区根目录存在 `package.json`，且声明了 `build` 或 `test` 脚本（只核验脚本名称存在，绝不读取、存储或泄露脚本正文）；
5. **本地依赖存在性门禁**：工作区根目录必须已经存在 `node_modules/` 目录；若不存在，诊断记录 `dependencies_missing`，**坚决不自动执行 `npm install` 或联网下载包**。

若上述任一条件不满足，诊断信息记录明确原因，配方中仅包含合规的 `node --check`，绝不暴露未准备好的 npm 配方。

---

## 5. 验证证据与测试记录

### 5.1 coding-tools 单元测试与 Job Object 进程树终止合成验证
在 `packages/coding-tools/test/workspace-command.test.mjs` 中执行：
- 验证环境变量格式校验、敏感词（`GITHUB_TOKEN`, `API_KEY`, `USER_AUTH_DATA` 等）拦截；
- 验证环境变量合并与外部进程私有变量防泄漏隔离；
- **WindowsJobProcessHost 进程树终止合成验证**：启动由 Node 派生孙进程（长期循环）的进程树，通过 AbortController 取消执行后，断言 `WindowsJobProcessHost.exe` 终止，并通过 `process.kill(grandchildPid, 0)` 循环重试确认孙进程已被 Windows 内核通过 Job Object 彻底杀死（抛出 `ESRCH`）。

运行结果：
```powershell
npm test --workspace=@personal-agent/coding-tools
# 35 tests, 29 pass, 6 skip (PowerShell 7 helper unavailable), 0 fail.
```

### 5.2 Desktop 配方工具与门禁测试
在 `apps/desktop/test/workspace-command-recipes.test.mjs` 中执行：
- 验证缺省关闭（`allowProjectScripts: false`）时不暴露 npm 配方；
- 验证缺 helper、缺 npmCli、缺 package.json、缺 node_modules 各自的 Fail Closed 诊断记录；
- 验证 5 项条件全部满足时，正确生成并暴露 `npm-build` 与 `npm-test` 配方；
- 验证生成配方的参数结构（`--cwd`, `--exe`, `--`, `npm-cli.js`, `run`, `build`）；
- 验证安全环境变量白名单过滤与敏感 token 阻断；
- 验证 helper 与 npmCli 位于工作区内时的逃逸拦截报错。

运行结果：
```powershell
node --test apps/desktop/test/workspace-command-recipes.test.mjs
# 6 tests, 6 pass, 0 fail (耗时 ~90ms).
```

### 5.3 语法与类型校验
```powershell
node --check apps/desktop/electron/workspace-command-recipes.js
node --check apps/desktop/test/workspace-command-recipes.test.mjs
npm run build --workspace=@personal-agent/coding-tools
npm run typecheck --workspace=@personal-agent/coding-tools
git diff --check
```
全部通过，无报错，无空格违规。

---

## 6. 架构边界与后续接线说明

1. **组合与接线边界**：
   本包仅交付 Desktop Main 侧的纯逻辑与构造 helper，**不自动在 UI 勾选、不直接修改 `main.js` 或 `workspace-config-host.js`**。
   Root 将在后续集成工作包中将 UI 复选框、Runtime 审批流及 Policy 授权消费与之串联。
2. **零凭据与零外部上传**：
   本 helper 不生成、不存储、不外发任何凭据；执行结果严格保留在本地，不自动上传云端。
3. **产品能力状态**：
   在产品端和公开接口目录中，命令执行能力严格维持 `unavailable`。
