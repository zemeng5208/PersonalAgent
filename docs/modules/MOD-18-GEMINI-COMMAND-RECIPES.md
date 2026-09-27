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
- 严格消费 `@personal-agent/coding-tools` 的 `createWorkspaceCommandTool`，**绝不另写 `spawn`、`shell`、进程执行器、第二工具协议或 Runtime 执行循环**。
- 所有执行生命周期、超时期限（`deadline`）、取消信号（`context.signal`）、输出缓冲上限（`maxOutputBytes`）及 UTF-8 校验全部由底层公开命令工厂托管。

### 1.2 严格固定 argv 与参数枚举（无任意代码注入）
- 所有命令参数（`args`）由宿主在配置时预先构造并固化，模型与工具输入端仅能传入严格枚举的 `recipeId`（符合 `/^[a-z][a-z0-9._-]{0,63}$/u` 规范）。
- **禁止调用端提供可执行文件路径、任意脚本路径、或 shell 命令行字符串**；输入模式设置 `additionalProperties: false`。

### 1.3 默认关闭项目脚本（Default Project Scripts OFF）
- `allowProjectScripts` **默认严格为 `false`**。在未显式开启时，即使工作区根目录下存在包含 `build` 或 `test` 的 `package.json`，也绝对不暴露任何 npm 脚本配方。
- 默认仅暴露经过严格路径校验的只读语法检查配方：`node --check <workspace-relative-file>`。

### 1.4 路径合法性与跨界逃逸防御
- **工作区边界**：`workspaceRoot` 必须为本机绝对目录，禁止驱动器根目录（如 `C:\`），禁止 UNC 网络路径，禁止符号链接。若指定 `authorizedWorkspaceRoot`，必须严格与已授权目录身份一致。
- **Node 可执行文件**：`nodeExecutable` 必须位于**工作区外**，必须是规范存在的普通文件，禁止符号链接，禁止使用放置在工作区内部的恶意可执行文件。
- **待检查源文件**：`checkFiles` 必须是工作区内的规范相对路径。严格拒绝绝对路径、UNC 路径、`..` 目录逃逸、符号链接（`isSymbolicLink()`）以及指向工作区外的目标。

---

## 2. Windows 环境下 npm 脚本的真实约束与阻碍分析

在 `allowProjectScripts === true` 时，本模块支持受控探测并生成 `npm-build` 与 `npm-test` 固定配方，但明确记录以下现实约束：

1. **公开工厂空环境变量（`env: {}`）约束**：
   `packages/coding-tools/src/command.ts` 在 `spawn` 时设置 `env: {}`。虽然 Windows 下底层 libuv 会保留部分核心系统变量（如 `SystemRoot`、`ComSpec`），但复杂的项目构建/测试脚本若依赖特定的全局环境或工具链路径，可能在空环境下执行失败。
2. **缺乏子进程树清理机制（Orphaned Process Risk）**：
   底层 `command.ts` 在超时或取消时调用 `child.kill('SIGKILL')`。在 Windows 操作系统中，该调用仅终止直接父进程（`node.exe`），而 npm 脚本派生出的子进程（如 webpack、vite、jest、tsc 等编译器或测试进程）不会被连带终止，存在残留孤儿后台进程的风险。
3. **明确不是沙箱（Not an OS Sandbox）**：
   项目脚本会以当前宿主 OS 用户的权限执行项目内部的任意代码，具备文件系统与网络副作用。
4. **禁止不安全替代方案**：
   - 绝不使用 `npm.cmd` + `shell: true`（规避 cmd.exe 转义注入攻击）；
   - 绝不自动执行 `npm install`（规避依赖安装阶段的任意生命周期脚本执行）；
   - 仅在定位到工作区外受信任的 `npm-cli.js` 且 `package.json` 为合规普通文件时，才以 `node.exe <npm-cli.js> run build` 和 `node.exe <npm-cli.js> test` 固定参数暴露。

---

## 3. 接口与导出规范

模块导出位于 [`apps/desktop/electron/workspace-command-recipes.js`](file:///C:/Users/24035/.codex/worktrees/gemini-windows-execution/PersonalAgent/apps/desktop/electron/workspace-command-recipes.js)：

```javascript
/**
 * 构造已校验的工作区命令配方数组及诊断信息
 */
export function buildWorkspaceCommandRecipes({
  workspaceRoot,
  authorizedWorkspaceRoot,
  nodeExecutable,
  checkFiles = [],
  allowProjectScripts = false,
  npmCliPath,
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
  npmCliPath,
  maxOutputBytes,
  maxDurationMs,
  createWorkspaceCommandTool, // 支持外部注入或动态加载
  now,
  required = true,
});
```

### 3.1 调用示例（Desktop Main / Composition）
```javascript
import {buildWorkspaceCommandRecipes, createWorkspaceCommandRecipeTool} from './workspace-command-recipes.js';

// 方式 A：在桌面组合入口生成配方并交由 product-tools-composition
const {recipes, diagnostics} = buildWorkspaceCommandRecipes({
  workspaceRoot: boundRoot,
  authorizedWorkspaceRoot: boundRoot,
  nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
  checkFiles: ['src/index.js'],
  allowProjectScripts: false, // 默认关闭
});
workspace.command = {recipes};

// 方式 B：直接创建受限命令 RegisteredTool
const {tool} = createWorkspaceCommandRecipeTool({
  workspaceRoot: boundRoot,
  checkFiles: ['src/index.js'],
  createWorkspaceCommandTool: coding.createWorkspaceCommandTool,
});
```

---

## 4. 验证证据与测试记录

### 4.1 定向轻量测试（`apps/desktop/test/workspace-command-recipes.test.mjs`）
测试通过 Node.js 内置 `node:test` 运行，无需外部网络、凭据或依赖包安装：

```powershell
node --test apps/desktop/test/workspace-command-recipes.test.mjs
```

测试覆盖并全部通过（**6 pass, 0 fail, 耗时 ~100ms**）：
1. `sanitizeRecipeId enforces lowercase alphanumeric pattern matching command.ts`：验证 recipeId 生成与正则约束；
2. `default project scripts OFF: only node --check recipes are produced even if package.json has scripts`：验证项目脚本默认严格关闭；
3. `fixed allowed input only: model/caller cannot supply arbitrary executables, shell strings, or unlisted recipeIds`：验证枚举 inputSchema 与固定参数；
4. `out-of-bounds, traversal, symlink, and invalid file rejection`：验证路径逃逸、绝对路径、符号链接、工作区内 node 恶意可执行文件及授权目录不一致的拦截；
5. `explicit project scripts switch semantics (allowProjectScripts: true)`：验证显式开启时 `package.json` 与 `npm-cli.js` 的严格条件判定与工作区外约束；
6. `public command contract validation: recipe limits and execution properties`：验证配方完全符合底层 `WorkspaceCommandRecipe` 契约（数量上限 32，参数长度上限 4096，无 NUL 字符）。

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
   Root 将在后续集成工作包中将 UI 复选框（如“允许 Node 检查”、“允许项目构建与测试”）、Runtime 审批流及 Policy 授权消费与之串联。
2. **零凭据与零外部上传**：
   本 helper 不生成、不存储、不外发任何凭据；执行结果严格保留在本地，不自动上传云端。
3. **产品能力状态**：
   在产品端和公开接口目录中，命令执行能力严格维持 `unavailable`。
