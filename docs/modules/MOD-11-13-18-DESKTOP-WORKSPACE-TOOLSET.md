# MOD-11/13/18：Desktop 可信工作区只读工具集

## 范围与状态

- Profile：`huawei_ict_agentarts`。
- 负责人 / 非作者评审：`zemeng` / `goo122`。
- 分支：`codex/zemeng/desktop-workspace-toolset`；状态：`review`（本地组合完成后仍待非作者评审与依赖集成）。
- 基线：本地组合 `5773149`（工作区 read/list/patch-preview、Competition 本地工具环及 preview 纵向测试）与 Desktop 工作区授权最新树 `ffee84b`；Desktop 内容经核对与其授权提交一致，依赖组合提交不手工修改根配置。
- 本片拥有：`apps/desktop/electron/workspace-access.js`、`apps/desktop/test/workspace-access.test.mjs` 与本文档。

本片把已经存在的三个只读 provider 消费进 Desktop 的可信工作区授权，不新增 provider、工具协议、Runtime 特例、写文件、command 或 Artifact 能力，也不修改 `main.js`、Runtime、contracts、根配置或管理后台视图。

## 实际组合

用户仍只能从管理后台触发原生目录选择器。`WorkspaceAccess` 对同一个经过校验的 `rootPath` 构造并返回：

- `workspace.read_text@1.0.0`，scope 为 `workspace:read`；
- `workspace.list_entries@1.0.0`，scope 为独立的 `workspace:list`；
- `workspace.preview_text_patch@1.0.0`，scope 为 `workspace:read`，只返回候选文本及前后 SHA-256。

现有 Desktop `main.js` 已将 `workspaceAccess.tools()` 原样注入 Competition Runtime，因此不需要修改 Runtime composition。每次工具调用仍由 Runtime/Policy/ToolGateway 单独进入 `waiting_approval` 并消费 `allow_once`；选择目录本身不授予工具执行或数据出机权限。

三个工具共享同一 grant epoch。更换根或撤销时先 abort 旧 epoch，所有旧 wrapper 都 fail-closed；迟到读取或预览结果不能返回。新根的任一工具构造失败时保持未授权，不复活旧根。既有单工具工厂注入只保留为合成迟到结果测试 seam，生产默认固定注册上述三个公开 provider。

## 最小验收

现有 `workspace-access.test.mjs` 在系统临时目录的合成文件上覆盖：

1. 默认不公布工具；原生选择后精确公布 read/list/preview 及各自 scope；
2. A→B 与 revoke 使旧工具集失效，单工厂测试 seam 仍可验证迟到结果被丢弃；
3. Desktop 选择的根进入现有 Competition Fake 链，只执行一次真实本地 patch preview：`waiting_approval` → 脱敏 `allow_once` → 精确 before/after hash → `confirmed` → Runtime `succeeded`；
4. 合成源码保持原字节不变，撤销后以同一 SQLite 数据库重开 Runtime 不再公布任何工具，既有任务仍保留。

定向命令：

```powershell
node --check apps/desktop/electron/workspace-access.js
node --test --test-isolation=none apps/desktop/test/workspace-access.test.mjs
git diff --check
```

不运行云端、真实用户文件、重复 Electron smoke 或全仓检查。`FakeCoordinationPort` 的 proposal/最终文字仍是 `mock`；本片不证明 AgentArts 真实 tool proposal/continuation、数据出机、生产部署或补丁写入。

实际使用 Node `v24.15.0` 构建本测试所需 workspace 闭包；`workspace-access.test.mjs` 的现有 6 项测试全部通过，`0 failed`，代码语法检查与 `git diff --check` 通过。依赖安装由宿主 npm `11.16.0` 完成并因宿主 Node `v26.3.0` 与仓库 engine 不同产生警告，但构建与测试均明确使用目标 Node `v24.15.0`。未运行 Electron smoke、全仓检查、云端或真实用户文件测试。

## 协作提示

`apps/desktop/src/features/admin/view.js` 由另一 Desktop 工作包并行编辑，本片不触碰。建议该负责人把现有文案“每次 `workspace.read_text` 仍需 Runtime `allow_once` 审批”改为“读取、目录枚举和补丁预览每次仍需 Runtime `allow_once` 审批”，不改变按钮或 IPC。
