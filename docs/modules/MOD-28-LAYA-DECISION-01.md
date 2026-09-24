# MOD-28-LAYA-DECISION-01：本地主动介入判断首片

- Profile：`huawei_ict_agentarts`；关联 MOD-04B、MOD-28 / PA-025。
- 负责人：zemeng 委派的 Laya 执行者；Git 身份 `zemeng5208`；状态：`review`，待非作者评审与集成。
- 分支：`codex/zemeng/laya-decision-mvp`；基线 `main@c5c4ada`。
- 文件所有权：仅 `packages/cognition/src/proactive-decision.ts`、`laya-decision.ts`、对应定向测试和本文。`packages/cognition` 既有公开入口、README、package.json，以及 `packages/goals`、contracts、Runtime 和根装配均由整合者协调。

## 目的与边界

PR #92 的[设计文档](https://github.com/zemeng5208/PersonalAgent/pull/92)标记为 Proposed；PR 当前状态未通过 GitHub API 读回。本片建立模块内部 provisional `DecisionPort`、有界事件决策服务、Laya typed-choice 适配和受限回环 HTTP transport。公开 package export 与生产 Runtime 接线尚未发生，因此不能通过握手公布能力，也不能把本片称作已运行的主动服务。

确定性规则先在一次最多四项的事件批次中合并相同 source、eventId、FactRef、Goal/Plan 版本和授权状态；同一事件身份出现不同版本或正文时拒绝。模型只收到不超过 200 字的观测摘要、不超过 100 字的目标摘要、引用 ID 与版本、Plan 版本；授权状态只在可信服务内参与去重，不进入模型请求。一次 Laya 请求给每项事件一个 `choice` 问题，答案严格限于 `IGNORE/MERGE/DEFER/REMIND/REQUEST_DECISION/EXECUTE/ESCALATE_AGENTARTS`。结果保留 source 与 eventId，并只使用本地已验证的引用；模型不能发明引用。

本片的低置信度、未知或故障结果升级为 `ESCALATE_AGENTARTS`。Laya 官方模型卡明确指出基础 checkpoint 的目标式零样本准确度接近随机且概率偏过度自信；在缺少本任务独立校准集之前，即使模型高置信度给出 `IGNORE/MERGE/DEFER/EXECUTE`，也统一升级，不做静默压制或自动动作。`REMIND` 和 `REQUEST_DECISION` 也仅是建议；本片不触发提醒、不创建审批、不调用工具、不改变 TaskRuntime 或图谱终态。真正执行仍由 Runtime/Policy/ToolGateway 和目标读回决定，复杂计划修复仍交 AgentArts。

## Laya 身份与部署准备

官方 [模型卡](https://huggingface.co/convaiinnovations/laya)说明 Laya 是 Convai Innovations 的 Apache-2.0 非自回归 typed-decision 模型。中文优先建议只加载 `convaiinnovations/laya` 的 `multilingual` 子目录（mmBERT-base，322M 参数，权重约 647 MB）；其 Python SDK 和 `laya[serve]` 提供 `POST /v1/systemone`。官方给出的约 32.8ms 单问题延迟来自 Tesla T4，不能当成本机指标。项目与 `D:\MODELS` 当前均未发现 Laya 权重或运行入口；本片尚未安装、加载或测量真实模型。

用户要求安装在 `D:\PersonalAgent` 项目内。待主控安排资源窗口后，计划把虚拟环境、Hugging Face 权重和 pip 缓存放在被 Git 忽略的 `D:\PersonalAgent\.cache\laya\` 下，先用 CPU 兼容的最小依赖方案核对 wheel 和磁盘成本。当前 D 盘读回可用约 83 GB；仅权重约 647 MB，Python/PyTorch/Transformers 与下载缓存因 wheel 而异，预估稳态 3–6 GB、安装峰值预留 8–10 GB，需以 dry-run 和实测修正。服务必须配置 `LAYA_HOST=127.0.0.1`、`LAYA_MODELS=multilingual` 和受信宿主提供的 `LAYA_API_KEY`；官方默认 `0.0.0.0` 且无鉴权，不直接采用。HTTP 客户端拒绝重定向，避免 307/308 把摘要和引用转发到其他主机。密钥不写入仓库、提示、日志或测试夹具。

服务常驻时只预加载这一 checkpoint，避免逐事件冷启动；请求最多四项，保留 deadline/取消。未来分别记录首次加载、首调用、热调用延迟与内存，不借用官方 GPU 基准作为本机验收。正式启用前需要合成标注集测准确度、漏报、误提醒、校准和延迟；小样本接口测试不能证明质量。

## 接线与验收

整合者可在明确的可信 composition 中注入 `ProactiveDecisionService(new LayaDecisionModel(new LocalLayaHttpTransport(port, getApiKey)))`，通过共享文件所有权协调导出模块内部端口。FactChangeFeed/Goal 的实际输入仍取已公布的 provisional 端口，并由可信宿主裁剪；不得从连接器、Renderer 或模型直接签发授权。服务不可用时保留明确升级结果，AgentArts 不可用时不能用 Laya/Fake 冒充比赛云端成功。

当前定向验证使用合成数据：通过本机现有 TypeScript 编译器单独编译两个新增源文件；`node --test --test-isolation=none packages/cognition/test/laya-decision.test.mjs` 通过 8/8，覆盖重复合并、不同 source 同名事件归因、版本冲突、未校准标签升级、模型失败脱敏、deadline/取消、typed-choice 形状与回环鉴权，以及两个本地服务器模拟的 307 转发目标零命中。普通 `node --test` 在当前 Windows 沙箱因测试隔离子进程 `spawn EPERM` 失败，不能计作测试失败或通过。未运行真实 Laya、真实 AgentArts、Python 安装、全仓检查或桌面验收；没有公共接口冻结或迁移。
