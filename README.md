# PersonalAgent

面向 Windows 的私人 Agent 助理：以动态悬浮球为入口，由盘古主导推理，结合个人知识、平台连接器与受控电脑操作，提供主动提示和有限自动执行。

项目面向华为 ICT 创新赛准备。具体届次、报名通知与技术使用要求尚待核实；不能将调用盘古 API 直接视为满足全部参赛条件。

## 当前状态

截至 2026-09-05，MOD-01 工程与存储底座、MOD-02 公共协议与 Fake 联调 SDK 已本地实现并通过 26 项联合测试，待交叉评审与集成。SDK 为 0.1.0-alpha.1，协议未冻结；尚无桌面应用或真实模型能力。完整进度见 ROADMAP。

## 文档入口

- [产品需求 PRD](docs/PRD.md)：产品范围、需求编号、优先级和验收条件。
- [架构设计](docs/ARCHITECTURE.md)：模块、进程、协议、数据与技术验证项。
- [模块分工](docs/MODULE_ASSIGNMENTS.md)：26 个独立模块、GitHub 负责人和文件所有权；`goo122` 为 A，`zemeng` 为 B。
- [公共开发协议](docs/DEVELOPMENT_PROTOCOL.md)：`goo122` 维护的任务、事件、工具、连接器契约与联调交付要求。
- [协作开发规范](CONTRIBUTING.md)：任务分配、分支、PR、评审和完成标准。
- [开发计划与进度](docs/ROADMAP.md)：阶段门槛、首批工作包和当前状态。
- [Agent 协作规则](AGENTS.md)：在本仓库工作的自动化开发者必须遵循的约束。

阅读顺序：PRD → 模块分工 → 公共开发协议 → 架构 → 协作规范 → 开发计划。`goo122` 先交付底座与公共协议，再按模块并行开发；Obsidian 归 `goo122`。实现变更必须关联需求编号和验收证据。

## 开发入口

默认通过分支与 Pull Request 协作，不直接向主分支提交实现。当前基线为 Node.js 24.15.0、npm 11.12.1；开发依赖由 package-lock.json 锁定。

在仓库根目录运行（PowerShell 中如脚本策略阻止 npm，可使用 npm.cmd）：

```sh
npm ci
npm run check
npm run dev
npm run demo:protocol
```

check 校验生成类型一致性，按依赖顺序构建并执行严格类型检查与两个模块的联合测试。dev 是一次性存储示例，结束后退出；重复启动时 persistedRuns 递增，数据位于 data/local/foundation-demo.sqlite。demo:protocol 展示 mock 消费者取消往返和连接器注册调用。这些不是桌面或真实 Runtime 启动命令。

MOD-02 接入入口：[contracts](packages/contracts/README.md)、[client](packages/client/README.md)、[testkit 六场景与验证](packages/testkit/README.md)。

当前源码入口为 packages/storage/src，保留的 src/.gitkeep 不承载另一套实现。模块测试和夹具位于 packages/storage/test；开发缓存与验证产物位于项目内 .cache，并已忽略。详见 [存储包说明](packages/storage/README.md)。

文档相对链接以仓库内位置为准；不在可公开内容中记录个人绝对路径、账号或密钥。
