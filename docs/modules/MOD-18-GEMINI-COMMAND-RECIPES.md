# MOD-18-GEMINI-COMMAND-RECIPES：可信桌面命令工具配方构造与安全边界

- **目标 Profile**：`huawei_ict_agentarts`（比赛主路径，Local 保留为可选 baseline）。
- **需求与任务**：MOD-18 / PA-017；负责人 `zemeng`（Gemini 3.8 Flash High 实现），非作者评审 `goo122`。
- **基线提交**：`d9ecf2623c2aeff9deeb46bdca17c6e340087ab2`。
- **本工作包分支**：`codex/gemini-workspace-command-recipes`（独占新文件，不带入旧分支代码，不修改共享配置）。
- **独占新建文件范围**：
  1. `apps/desktop/electron/workspace-command-recipes.js`
  2. `apps/desktop/test/workspace-command-recipes.test.mjs`
  3. `docs/modules/MOD-18-GEMINI-COMMAND-RECIPES.md`
- **当前接口与能力状态**：内部组合辅助入口；产品端命令执行能力继续保持 `unavailable`。

---

## 1. 核心职责与安全模型

本模块为可信 Desktop Main 进程提供一个**可选工作区命令工具配方集合构造入口**（`buildWorkspaceCommandRecipes` 与 `createWorkspaceCommandRecipeTool`），基于 `@personal-agent/coding-tools` 公开的 `createWorkspaceCommandTool` 组装受限命令，严格遵循如下安全原则：

### 1.1 绝不新建进程执行器或第二套协议
- 严格消费 `@personal-agent/coding-tools` 的公开 `createWorkspaceCommandTool`，**绝不另写 `spawn`、`shell`、进程执行器、第二工具协议或 Runtime 执行循环**。
- 所有执行生命周期、超时期限（`deadline`）、取消信号（`context.signal`）、输出缓冲上限（`maxOutputBytes`）及 UTF-8 校验全部由底层公开命令工厂托管。
- `createWorkspaceCommandRecipeTool` 要求宿主**显式传入公开的 `createWorkspaceCommandTool` 工厂**；若未传入或非函数，立即 **Fail Closed**，绝不通过动态 import 掩盖破损依赖错误。

### 1.2 严格要求宿主显式注入 Node 可执行文件（禁止 PATH 自动探测）
- `nodeExecutable` **必须由受信 Desktop Main 显式传入固定的绝对路径**；
- **禁止使用 `where.exe`、PATH 环境变量搜索或默认回退至 `process.execPath`**（PATH 可能由用户或工作区篡改，不能作为可信安装证明）；
- 必须校验：为规范绝对路径、为普通文件（非符号链接）、文件名必须为 `node.exe`（非 Windows 平台为 `node`），且**必须严格位于所授权的工作区外**。

### 1.3 严格固定 argv 与参数枚举
- 所有命令参数（`args`）由宿主在配置时预先构造并固化为 `['--check', relPath]`。
- **禁止调用端提供可执行文件路径、任意脚本路径、或 shell 命令行字符串**。
- **证据边界澄清**：本 helper 的职责是生成固化的 `WorkspaceCommandRecipe` 结构；实际运行时针对模型调用的 `recipeId` 枚举校验与 `additionalProperties: false` 门禁，由既有公开的 `@personal-agent/coding-tools/src/command.ts` 契约负责。

### 1.4 路径合法性与跨界逃逸防御
- **工作区边界**：`workspaceRoot` 必须为本机绝对目录，禁止驱动器根目录（如 `C:\`），禁止 UNC 网络路径，禁止符号链接。若指定 `authorizedWorkspaceRoot`，必须严格与已授权目录身份一致。
- **待检查源文件**：`checkFiles` 必须是工作区内的规范相对路径。严格拒绝绝对路径、驱动器盘符、UNC 路径、`..` 目录逃逸、符号链接（`isSymbolicLink()`）以及指向工作区外的目标。

---

## 2. Windows 环境下 npm 脚本的真实约束与暂不暴露策略

针对 npm 项目脚本（如 `build` 与 `test`），本模块实施如下安全决策：

1. **公开工厂空环境变量（`env: {}`）约束**：
   `packages/coding-tools/src/command.ts` 在 `spawn` 时设置 `env: {}`。复杂的项目构建/测试脚本若依赖特定的全局环境或工具链路径，可能在空环境下执行失败。
2. **缺乏子进程树清理机制（Orphaned Process Tree Risk）**：
   底层 `command.ts` 在超时或取消时调用 `child.kill('SIGKILL')`。在 Windows 操作系统中，该调用仅终止直接父进程（`node.exe`），而 npm 脚本派生出的子进程（如 webpack、vite、jest、tsc 等编译器或测试进程）不会被连带终止，存在残留孤儿后台进程长期占用资源的严重隐患。
3. **暂不暴露 npm build/test 配方（Fail Closed）**：
   - 依据 `packages/coding-tools/README.md`，任意项目脚本均需另行验证的进程和文件系统隔离；现有契约无法满足此生产条件。
   - **无论 `allowProjectScripts` 开关为何值，本模块均不暴露 `npm-build` 与 `npm-test` 配方**。
   - 当 `allowProjectScripts === true` 时，在诊断信息 `diagnostics.reasons` 中准确记录阻碍原因（依赖公共 owner 后续引入 Windows Job Object 子进程树终止机制及环境隔离），绝不伪称可用。
4. **禁止不安全替代方案**：
   - 绝不使用 `npm.cmd` + `shell: true`（规避 cmd.exe 转义注入攻击）；
   - 绝不自动执行 `npm install`（规避依赖安装阶段的任意代码执行）；
   - 默认且当前唯一暴露的即为受信注入 Node 的 `node --check` 安全只读语法检查子集。

---

## 3. 接口与导出规范

模块导出位于 [`apps/desktop/electron/workspace-command-recipes.js`](file:///C:/Users/24035/.codex/worktrees/gemini-windows-execution/PersonalAgent/apps/desktop/electron/workspace-command-recipes.js)：

```javascript
/**
 * 校验路径与参数，构造固定的 WorkspaceCommandRecipe 列表与诊断信息
 */
export function buildWorkspaceCommandRecipes({
  workspaceRoot,             // 用户已授权的工作区绝对目录
  authorizedWorkspaceRoot,   // 可选：Desktop 已锁定的授权根（核对防漂移）
  nodeExecutable,            // 可信 node.exe 路径（必须显式提供，位于工作区外）
  checkFiles = [],           // 工作区内待检查的 JS 源文件相对路径（如 ['src/index.js']）
  allowProjectScripts = false,// 显式开启项目脚本请求（当前安全拦截并不暴露 npm）
});

/**
 * 构造可供 Desktop Main 使用的 RegisteredTool
 */
export function createWorkspaceCommandRecipeTool({
  workspaceRoot,
  authorizedWorkspaceRoot,
  nodeExecutable,
  checkFiles = [],
  allowProjectScripts = false,
  maxOutputBytes,
  maxDurationMs,
  createWorkspaceCommandTool,// 必须显式传入公开命令工具工厂
  now,
  required = true,
});
```

---

## 4. 验证证据与测试记录

### 4.1 定向轻量测试（`apps/desktop/test/workspace-command-recipes.test.mjs`）
测试通过 Node.js 内置 `node:test` 运行，无需外部网络、凭据或依赖包安装：

```powershell
node --test apps/desktop/test/workspace-command-recipes.test.mjs
```

测试覆盖并全部通过（**6 pass, 0 fail (耗时 ~100ms)**）：
1. `sanitizeRecipeId enforces lowercase alphanumeric pattern matching command.ts`：验证 recipeId 生成与正则约束；
2. `host-fixed recipes and factory delegation: helper generates bounded recipes and delegates to factory`：验证配方构建、缺少工厂时 fail closed 拦截、以及向底层工厂传递固定参数；
3. `nodeExecutable requires explicit injection, basename verification, and workspace separation`：验证缺失 nodeExecutable 拒绝（不回退 PATH/where.exe）、非 node.exe 名称拒绝、工作区内 node 拒绝；
4. `out-of-bounds, traversal, symlink, and invalid file rejection`：验证路径逃逸、绝对路径、符号链接及授权目录不一致的拦截；
5. `project scripts policy: npm build/test recipes are NOT exposed regardless of switch`：验证无论开关，均不暴露 npm 配方，并记录明确的孤儿进程/环境约束诊断；
6. `public command contract validation: recipe limits and properties`：验证配方完全符合底层 `WorkspaceCommandRecipe` 契约（数量上限 32，参数长度上限 4096，无 NUL 字符）。

### 4.2 语法校验
```powershell
node --check apps/desktop/electron/workspace-command-recipes.js
node --check apps/desktop/test/workspace-command-recipes.test.mjs
```
两者均为 Exit 0。

---

## 5. 架构边界与后续接线说明

1. **组合与接线边界**：
   本包仅交付 Desktop Main 侧的纯逻辑与构造 helper，**不自动在 UI 勾选、不直接修改 `main.js` 或 `workspace-config-host.js`**。
   Root 将在后续集成工作包中将 UI 复选框、Runtime 审批流及 Policy 授权消费与之串联。
2. **零凭据与零外部上传**：
   本 helper 不生成、不存储、不外发任何凭据；执行结果严格保留在本地，不自动上传云端。
3. **产品能力状态**：
   在产品端和公开接口目录中，命令执行能力严格维持 `unavailable`。
