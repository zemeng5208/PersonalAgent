# PersonalAgent Desktop

MOD-11 / MOD-12 / MOD-13，负责人 `zemeng`，待 `goo122` 评审与根装配。关联 PA-001、PA-002、PA-004。基于底座提交 `002e88a`，消费公共客户端和契约 `0.1.0-alpha.1`，没有修改根配置、锁文件或公共 Schema。

## 已落地的界面

2026-09-06 外观更新：ORB-02 所有粒子固定纯白、满不透明度，正反面及所有任务状态保持高亮，不再随状态变暗或闪烁。原稿的点数、位置和尺寸保留；此前逐像素一致记录对应调整亮度之前的版本。

原版 ORB-02 示例引擎移植到 `src/features/orb/orb.js`：170 个 Fibonacci 球壳点、matrix 渲染。原版比选卡片没有使用 lattice 纬度环分布；不能把同名“规则点阵”布局替换进去。待机绘制参数保持原样，只在产品代码修正状态切换的 shape 取值及减少动效时的重绘。

球体窗口 112px，画布按原版卡片保持 132px 并居中（球面约 70px），避免缩小画布后点距变密。无窗口阴影、无球体模糊，透明边缘用径向渐隐。以球心 90px 检测靠近，372px 面板按工作区左右避让；拖动抑制展开，输入/点击固定。独立后台关闭不销毁 Runtime。冷光青与标准毛玻璃令牌来自恢复后的原稿；后台表格共享父层玻璃材质。

任务提交、快照读取、事件订阅、能力目录、授权决定和取消调用公共 SDK。桌面主进程普通启动使用项目内持久化 `TaskRuntime`，显式 `--fake-runtime` 才使用测试 Runtime；两者都通过 `@personal-agent/client` 握手。没有 UI 计时器伪造任务进度，状态由 `event.subscribe` 后的 Runtime 事件回读驱动。取消受理显示“正在取消”，终态以 Runtime 快照为准。停止播报是独立的 `voice.stop` 操作，不调用 `task.cancel`；当前无语音提供者，因此按钮保持不可用并明确提示未连接。

设置页已提供盘古 V2 的真实 API 配置与连接测试：Endpoint、模型、部署和 API Key 通过受限 IPC 发送到主进程。ModelArts MaaS 可填 `https://api.modelarts-maas.com/openai/v1`，适配器会追加 `/chat/completions`；点击“测试真实连接”才会发起实际请求。保存配置时 API Key 使用 Electron/Windows 加密存储，绝不进入快照、日志或前端；重启后会自动恢复，无法使用系统加密存储时会拒绝落盘。面板思考滑块和快速模式可在连接失败时继续调整，用于桌面测试，但 Runtime 尚未公开对应参数，尚未把它伪装成任务参数。

## 运行

先在仓库根执行已有的 `npm ci` 和 `npm run build`。桌面依赖由根 workspace 解析，若只单独运行本模块可使用：

```powershell
npm install --prefix apps/desktop --package-lock=false --cache .cache/npm
$env:electron_config_cache = Join-Path $PWD '.cache/electron'
node apps/desktop/node_modules/electron/install.js
npm start --prefix apps/desktop
```

普通启动使用 `.cache/runtime.sqlite` 中的本地 Runtime；显式联调命令为 `npm run dev:fake --prefix apps/desktop`。fake 标识常驻面板和后台，任务状态由“推进联调一步”手动驱动，测试数据仅在内存，本机联调配置在模块 `.cache`。无真实盘古、语音、外部账号调用。

`electron/runtime.js` 提供 `register({transport, now?, readEvents?, attachClient?})`，供 goo122 根装配传入真实传输；生产路径不会自动加载 testkit。托盘菜单可打开面板、后台或退出应用，关闭后台不会销毁 Runtime。Electron 44.2.0 仍是模块开发依赖，根 workspace、锁文件和打包流程待 goo122 统一集成。当前应用不含分发安装包。

## 验证与限制

2026-09-05：Windows / Electron 44.2.0；公共底座 build 通过；关键测试 2/2；Electron smoke 通过原生热区、收起、拖动抑制、面板/后台和任务取消流程。`orb-fidelity.cjs <原版设计目录>` 在 132px 原稿尺寸验证产品待机球体逐像素一致（170 点）。已直接观察实际窗口截图。Node 26.3.0 与底座声明的 Node 24.15.x 不同，目标 Node 版本待集成环境验证。

`npm test --prefix apps/desktop` 检查跨屏工作区定位和公共客户端取消到终态的语义。`node apps/desktop/test/electron-smoke.cjs` 使用本机已有 Playwright 启动真实 Electron 进行界面验收；截图保存在模块 `.cache/qa`。

后台未连接的业务页显示真实空状态，不把设计稿的手写业务数据带入产品。盘古 Provider 已接入，但真实 Endpoint/API Key 需要在设置页显式配置和测试；思考参数仍待 Runtime 公共契约与根装配接入。语音供应商、外部 Runtime 进程/Named Pipe、全局快捷键、安装卸载仍待对应模块接入。当前玻璃为 CSS 材质；原生 Windows 桌面背景模糊未验收。多屏位置算法已测，物理多显示器/DPI 切换未实机验收。此工作包处于 review，不代表 P0 全部完成。
