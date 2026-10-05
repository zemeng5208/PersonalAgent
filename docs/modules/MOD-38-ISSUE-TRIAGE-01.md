# MOD-38：Issue 分类与受控修复 PR

负责人 zemeng；目标为已授权的 `local` DEV-WORKFLOWS 增量；状态 `review`（待真实集中验收与非作者评审）。不计入 `huawei_ict_agentarts` 比赛验收。
初始基线 `3d4d917`、工作树 `.worktrees/dev-issue`、分支 `codex/dev-issue`；当前沿已有
PR #290续接，精确提交与验收入口见下方统一记录。

## 行为与依赖

`createIssueTriageWorkflow` 接收公开 `@personal-agent/models` 的 `ModelPort`、
`@personal-agent/agents` 的 `AgentToolPort` / `AgentWorkerContext`，不反向依赖 apps。
`listIssues` 经 MOD-33 `github.issue.list` 保留 page/nextPage/hasMore，
`triageIssue` 经 `github.issue.get` 读取完整快照，仅接受 bug/feature/docs/question，
confidence 必须为有限 0..1，证据为能在原始标题/正文中找到的精确摘录。
缺省低于 0.8 转人工；置信度标记 calibrated=false，不冒充校准概率。
中文/混合标签四类夹具通过仅证明该契约，不是未给评估集/阈值的真实分类准确率。

输入中的安全/漏洞/凭据线索和常见令牌先在本地筛查，直接人工，不向模型发送这些内容。
这是一道保守筛查而非完整 DLP；模型外发仍需宿主授权，宿主必须保证注入的模型与隐私策略一致。
Issue 是不可信数据，不能签发权限、切换 profile、构造工具提案或提供修复授权。

写标签默认关闭；启用时仍要求宿主 scope 与 Runtime Policy 审批。
模型分类后先重读比较完整 SHA-256 fingerprint（含正文/标题/标签/状态/时间/URL），
再通过 `github.issue.label` 追加标签，并传 `expectedUpdatedAt` 给提供者再次检查。
提供者前置读回不等于 GitHub 原子条件写；最后一次外部读取与写入间的竞态仍需真实验收。
不把 Model 摘录当执行证据，`evidenceRefs` 只消费工具/修复链可信返回值。

bug 修复使用宿主注入 `IssueRepairPort.repairIssue`，组合适配 MOD-34 既有修复链，
不创建另一个 Agent 执行循环、调度器或任务库。宿主须保证受限工作区、MOD-34 预算、
源码快照/补丁/测试/提交/PR 与审批的事实状态，并将请求的 pullRequestBody 合入真实 PR 正文。
正文采用 `Related issue: <url>` 回链，不使用关闭关键词；不自动 close / merge。
缺少 repair 端口或可信 repairGoal 明确转人工，不以 Fake 替代生产服务。

## 恢复、预算与端口

请求使用 `{repo,number,writeLabel?,repairBug?,repairGoal?}`；list 使用
`{repo,page?,perPage?,state?,labels?}`。options 包含 model/tools/repair?、
authorizationRefFor、maxSteps、maxTokens、minConfidence?、labels?。
返回分类、fingerprint、标签及工具证据；分类与执行状态分离。接口为 provisional。
公共index/依赖与Runtime装配沿既有单一集成槽维护，模块不私设wire或新的授权接口。
当前Runtime `issue_list`提供独立已审批发现页；宿主明确选项后提交独立issue_triage任务，
通过持久请求及原Gateway runId保留页/审批/确认缓存/幂等身份；list自身没有独立步骤预算
journal，不调用模型，不自动轮询、为整页建子任务或复用另一Issue修复checkpoint。

所有调用携 deadline / AbortSignal；使用已有 `withCognitionDeadline`，迟到结果不能触发下一写入。
步骤和输入估算/输出 token 预算在模型调用与副作用前检查，真实 usage 超预算转人工。
输入估算是字符估计，不能保证所有 tokenizer 的实际输入 token；真实硬限额仍由 ModelGateway 执行。

写入前把 intent 存在 Runtime checkpoint。结果 unknown、超时、取消或断连保留
waiting_reconciliation，重入不重发未知写入。pending 审批返回 waiting_approval，
仅通过相同参数与 runId 的 Gateway 调用恢复审批或读回缓存；Gateway 必须实施幂等。
读工具的pending/unknown同样保持Runtime暂停状态。标签confirmed后的repair及原repair
waiting_approval恢复，先以本模块持久generation按原累计steps读取当前Issue；pending读取
沿同runId继续。确认原正文/标题/state/URL未变且通过敏感筛查后，保留原repairSource/
fingerprint/PRbody输入委派原MOD34，消费其已有checkpoint，不复制执行循环或换原修复身份。
仅实际进入委派才推进下一次fresh read generation，普通审批重启不反复换读取ID。
确认写入不会因后续修复失败而抹去。Runtime 是任务状态与 checkpoint 的唯一事实来源。

未知标签保留原始参数及 runId；只有宿主 `confirmedReplayReady(runId,context)`
核验原运行已存在 durable confirmed receipt 和 Gateway 缓存时才允许同调用读回缓存。
未知修复保留原 Issue 绑定，只有 `confirmedRepairReplayReady(context,issue)`
确认 MOD-34 原 checkpoint 的未知 run 都已分别核验/缓存才重新进入其恢复入口。
这两个 callback 必须由可信 Runtime 组合提供；新的审批、通用任务状态或调用者布尔值
均不能替代精确原始 receipt。缺 callback 始终保留暂停，不发起新任务或新写入。

## 验证与限制

初稿按当时用户限制仅静态交付；后续已授权并执行必要构建/受控验证。
Fake行为测试位于 `packages/cognition/test/issue-triage.test.mjs`：
四类、置信度/字段/证据校验、凭据拦截、指纹变化、审批与未知结果、幂等恢复、
bug修复回链、预算、取消/deadline和分页；后续补齐原修复委派绑定与重读缓存代际恢复。
当前source `2eda73d` 固定Node24.15完整check exit0，cognition201、Runtime347、
根集成19通过，全部31workspace1990/0/50平台跳过。原内容/已confirmed标签与原修复预算
在后续暂停/重启时保留，未将同一Issue改写为新的模型任务。
这些为明确Fake/SQLite受控证据，非真实标签或修复PR验收；当前精确head门禁及交接见
[统一续接清单](DEV-WORKFLOWS-CONTINUATION-20261005.md)，状态仍review/provisional。

Potatos498 在集成公共导出/依赖与 MOD-33/34/Runtime 装配后集中执行：

```sh
npm run build --workspace=@personal-agent/cognition
node --test packages/cognition/test/issue-triage.test.mjs
npm run check
```

真实验收需单独授权：真实 issue.list/get → 受权模型分类 → 审批 label 追加/读回 →
真实 MOD-34 修复 PR 正文回链，验证原 issue 未关闭、PR 未自动合并；
审批拒绝/撤销、写入未知恢复、并发改 Issue、取消和预算分别留存可信 Evidence。
离线 Fake 与编译均不能证明 GitHub、AgentArts 或模型外发生产能力已可用/已冻结。
