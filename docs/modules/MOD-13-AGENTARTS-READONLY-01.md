# MOD-13-AGENTARTS-READONLY-01：Competition 后台只读配置状态

- Profile：huawei_ict_agentarts；MOD-13 / PA-002、PA-026；负责人 zemeng，评审者 goo122。
- 状态 review，待非作者评审与集成；基线 main `72cc76b`。
- 工作树 `.worktrees/zemeng-desktop-agentarts-readonly`；分支 `codex/zemeng/desktop-agentarts-readonly`。

后台原先在 AgentArts 模式也展示盘古编辑、测试及启停按钮，但可信主进程明确拒绝这些操作。
本项以现有可信快照中的 `model.provider === 'agentarts'` 选择只读状态页，展示 Runtime 名称与原因，
明确区分已配置和已验收。不新增配置入口、权限、公共字段或任何云调用。

主进程在初始化前即按已选择的 Competition Profile 设置 AgentArts 的不可用状态，
避免缺配置或初始化失败时继续显示盘古配置入口。只有既有初始化成功路径才标为已配置；
失败不会提升能力或改成 Local。未初始化时不沿用盘古 Endpoint、部署名或密钥配置标记。

Local/Fake 原有页面不变；主进程权限检查仍保留，隐藏控件不构成授权边界。
部署名及状态原因继续 HTML 转义；不展示密钥、凭据或未公开的 trace/version 字段。

验收：定向纯函数测试及 AgentArts 后台页面渲染/导航检查；不运行全套 Electron 或真实云验收。

## 验证结果

- `node --test --test-isolation=none apps/desktop/test/agentarts-model.test.mjs`：1/1 通过，
  覆盖已配置/未配置文案、两种状态均不生成编辑控件，以及外部字段转义与凭据 canary 不展示。
- `node --check`（main.js、view.js、agentarts-model.js、定向测试）及 `git diff --check` 通过。
- 一次独立合成渲染：Playwright 1.63 / Electron 44.2，实际产品 CSS，
  只读复用已安装第三方依赖，无内部包构建、Runtime 启动或 HTTP(S) 请求。
- 页面标题与非空内容正确，无错误 overlay，pageerror/console error 均为 0；
  已配置 AgentArts 状态无编辑/测试/启停控件，外部 HTML 仅显示为文字，密钥 canary 未出现。
- 合成切回 Local 后可打开完整原有编辑器；父代理查看两张截图，未发现阻断性的裁切或重叠。
- 未配置状态有纯函数覆盖，未单独运行 GUI；主进程初始化失败分支仅静态复核，
  不把独立渲染夹具宣称为真实 Runtime 失败或 AgentArts 云端验收。
- 测试 Electron 已退出；无公共协议、依赖、迁移或权限变化，可回滚单一提交。
