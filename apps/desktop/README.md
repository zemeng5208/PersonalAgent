# PersonalAgent Desktop

MOD-11 / MOD-12 / MOD-13，负责人 `zemeng`，待 `goo122` 评审与根装配。关联 PA-001、PA-002、PA-004。基于底座提交 `002e88a`，消费公共客户端和契约 `0.1.0-alpha.1`，没有修改根配置、锁文件或公共 Schema。

## 已落地的界面

2026-09-06 外观更新：ORB-02 所有粒子固定纯白、满不透明度，正反面及所有任务状态保持高亮，不再随状态变暗或闪烁。原稿的点数、位置和尺寸保留；此前逐像素一致记录对应调整亮度之前的版本。

原版 ORB-02 示例引擎移植到 `src/features/orb/orb.js`：170 个 Fibonacci 球壳点、matrix 渲染。原版比选卡片没有使用 lattice 纬度环分布；不能把同名“规则点阵”布局替换进去。待机绘制参数保持原样，只在产品代码修正状态切换的 shape 取值及减少动效时的重绘。

球体窗口 112px，画布按原版卡片保持 132px 并居中（球面约 70px），避免缩小画布后点距变密。无窗口阴影、无球体模糊，透明边缘用径向渐隐。以球心 90px 检测靠近，372px 面板按工作区左右避让；拖动抑制展开，输入/点击固定。独立后台关闭不销毁 Runtime。冷光青与标准毛玻璃令牌来自恢复后的原稿；后台表格共享父层玻璃材质。

任务提交、快照读取、事件订阅、能力目录、授权决定和取消调用公共 SDK。桌面主进程普通启动使用项目内持久化 `TaskRuntime`，显式 `--fake-runtime` 才使用测试 Runtime；两者都通过 `@personal-agent/client` 握手。没有 UI 计时器伪造任务进度，状态由 `event.subscribe` 后的 Runtime 事件回读驱动。取消受理显示“正在取消”，终态以 Runtime 快照为准。停止播报是独立的 `voice.stop` 操作，不调用 `task.cancel`；当前无语音提供者，因此按钮保持不可用并明确提示未连接。

后台“模型”页已提供盘古 V2 的真实 API 配置与连接测试：Endpoint、模型、部署和 API Key 通过受限 IPC 发送到主进程。ModelArts MaaS 可填 `https://api.modelarts-maas.com/openai/v1`，适配器会追加 `/chat/completions`；点击“测试真实连接”才会发起实际请求。保存配置时 API Key 使用 Electron/Windows 加密存储，绝不进入快照、日志或前端；重启后会自动恢复，无法使用系统加密存储时会拒绝落盘。面板思考滑块和快速模式可在连接失败时继续调整，用于桌面测试，但 Runtime 尚未公开对应参数，尚未把它伪装成任务参数。

模型页使用“模型列表 → 添加或编辑”结构，并支持真实启停；停用后的模型不会用于新任务。管理后台提供个人、集成、编码、任务四组共 25 个导航入口，配备统一线性图标和导航搜索。主题和降低动效会在桌面窗口间同步；新增页面中尚未接入的服务显示明确状态，页面数量不代表对应后端能力已经交付。

## 运行

先在仓库根执行已有的 `npm ci` 和 `npm run build`。桌面 workspace 的 `postinstall` 会安装锁定版本的 Electron 二进制；桌面依赖由根 workspace 解析。若只单独运行本模块可使用：

```powershell
npm install --prefix apps/desktop --package-lock=false --cache .cache/npm
$env:electron_config_cache = Join-Path $PWD '.cache/electron'
node apps/desktop/node_modules/electron/install.js
npm start --prefix apps/desktop
```

普通启动使用 `.cache/runtime.sqlite` 中的本地 Runtime；显式联调命令为 `npm run dev:fake --prefix apps/desktop`。fake 标识常驻面板和后台，任务状态由“推进联调一步”手动驱动，测试数据仅在内存，本机联调配置在模块 `.cache`。无真实盘古、语音、外部账号调用。

`electron/runtime.js` 提供 `register({transport, now?, readEvents?, attachClient?})`，生产路径传入 `@personal-agent/runtime/application` 的传输对象；生产路径不会自动加载 testkit。托盘菜单可打开面板、后台或退出应用，关闭后台不会销毁 Runtime。Electron 44.2.0 仍是模块开发依赖，根 workspace、锁文件和打包流程待 goo122 统一集成。当前应用不含分发安装包。

## 验证与限制

2026-09-05：Windows / Electron 44.2.0；公共底座 build 通过；关键测试 2/2；Electron smoke 通过原生热区、收起、拖动抑制、面板/后台和任务取消流程。`orb-fidelity.cjs <原版设计目录>` 在 132px 原稿尺寸验证产品待机球体逐像素一致（170 点）。已直接观察实际窗口截图。Node 26.3.0 与底座声明的 Node 24.15.x 不同，目标 Node 版本待集成环境验证。

`npm test --prefix apps/desktop` 检查跨屏工作区定位和公共客户端取消到终态的语义。`npm run test:smoke --workspace=@personal-agent/desktop` 使用项目锁定的 Playwright 启动真实 Electron 进行界面验收；截图保存在模块 `.cache/qa`。

后台未连接的业务页显示真实空状态，不把设计稿的手写业务数据带入产品。盘古 Provider 已接入，但真实 Endpoint/API Key 需要在“模型”页显式配置和测试；思考参数仍待 Runtime 公共契约与根装配接入。语音供应商、外部 Runtime 进程/Named Pipe、全局快捷键、安装卸载仍待对应模块接入。当前玻璃为 CSS 材质；原生 Windows 桌面背景模糊未验收。多屏位置算法已测，物理多显示器/DPI 切换未实机验收。此工作包处于 review，不代表 P0 全部完成。

## 文字交互垂直链路

普通启动时，提交文字任务会通过本地 Runtime Application 的 `task.submit` 入口，由 Runtime 自动执行 Agent、`ModelGateway` 和 Provider 编排。Desktop 主进程只负责安全配置、IPC、事件订阅和任务展示；没有 Provider 时任务会如实失败，不会静默生成假回答。

离线验收使用显式 Fake Model：

```powershell
npm run dev:text-fake --prefix apps/desktop
npm run test --workspace=@personal-agent/runtime
npm run test:text-smoke --workspace=@personal-agent/desktop
```

Fake Model 只验证 Runtime、Agent、持久化和桌面显示链路，不代表真实盘古连接已经验收。真实调用仍需在“模型”页配置并手动点击连接测试。

## 2026-09-06 桌面交互里程碑

本轮在 MOD-11 / MOD-12 / MOD-13 已有接入之上完成了可用的文字对话交互：Enter 发送、Shift+Enter 换行、重复发送、发送按钮状态、自动滚动和真实模型名称展示；任务回答改为用户气泡与助手正文的对话布局，任务 UUID、模型路径、验证等级和 token 统计不再混入面向用户的正文，但仍保留在 Runtime 快照中。助手回答下方提供复制、系统分享（不可用时仅复制分享文本）和本地点赞反馈。

执行中的任务由 Runtime 状态驱动“思考中 / 执行中 / 整理回答 / 等待中”，左侧使用 3×3 黑色底格与白色扫光动画。面板标题栏支持拖动面板与悬浮球，并根据工作区尝试左右换边和上下避让。剪贴板写入由主进程受控 IPC 完成，渲染器仍不能直接持有密钥或执行 Shell。现有 ORB-02 粒子动画未在本轮改动。

验证覆盖文字任务成功、Provider 不可用、取消中的模型请求、Enter 与按钮提交、自动滚动、复制与点赞、思考动画、面板和悬浮球拖动、工作区约束、后台关闭和任务取消；单元测试、类型检查及 Fake Electron 冒烟在本地通过。真实盘古配置可以由 Windows 加密存储恢复，但真实服务可用性仍以每次连接测试和任务结果为准。

### 已知问题：屏幕边缘拖动后的透明命中区域

在当前 Windows 分辨率 / DPI 环境中，把组合窗口拖向右侧的上角或下角后，仍可能在悬浮球右下方留下透明但会拦截鼠标的区域。代码已避免在拖动中主动重设悬浮球尺寸，并增加视口上限回归检查，但用户实机仍可复现，因此本问题保持未解决，不能把“无透明余块”列为本里程碑完成项。

后续需要按实际 DPI、显示器工作区和 Electron 原生命中测试继续采样，分别记录 BrowserWindow 外框、渲染视口和透明像素区域；验收标准是右上、右下、多显示器及不同缩放比例下，球体外透明区域均不拦截桌面点击，同时球体和标题栏拖动保持可用。
