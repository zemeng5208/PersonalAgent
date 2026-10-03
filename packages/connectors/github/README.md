# GitHub 连接器（MOD-33）

`@personal-agent/github` 是 DEV-WORKFLOWS 的 Local Profile 增量。接口为
provisional，真实 GitHub、Windows CLI 和消费者闭环尚未验收；不纳入 Competition
Profile 的完成证据。生产 provider 不自动回退 Fake。

公开入口导出 `GitHubInputs`、`GitHubOutputs`、`GitHubOperation`、`GitHubPort`、
`GitHubProvider`、`GitHubReadContext`、`GitHubService`、`GitHubConnector`、
`GhCliProvider`、`SpawnGhCommandRunner`、`FakeGitHubProvider`、`register`。

可信组合注入：

```ts
const provider = new GhCliProvider({
  runner: new SpawnGhCommandRunner('/trusted/path/gh', trustedEnvironment),
  readToken: context => restrictedSecretReader(context),
  repositories: ['owner/repository'],
});
const dispose = register(toolHost, {provider});
```

`readToken` 由 Connector Host 的受限凭据适配提供，模型、Renderer 和工具输入不能
提供 token、CLI 路径、环境或 runner。runner 只接收 argv，不执行 shell；不继承进程
环境。宿主显式提供所需 PATH/SystemRoot/TEMP 等可信值。仅支持 github.com。
凭据通过 GH_TOKEN 环境传给 gh，命令参数、返回值和错误不含凭据。

工具版本为 `0.1.0-alpha.1`。全部输入拒绝未知字段；`repo` 必须在宿主白名单。
所有操作需 `ToolContext.signal/deadline/authorizationRef/scopes`；读工具 scope 为
`github:read`，写工具为 `github:write`，写工具声明 `external_write`、
`requiresPresence: true`、`idempotencySupport/recoverySupport: false`。
**审批由 Runtime Policy → ToolGateway 校验及消费**。连接器的 context guard 只是
防误调用，不能替代授权验证；不要给模型或认知模块直接 provider 引用。

| 工具名（均有 github. 前缀） | 输入（公共 DTO 为准） | 输出 |
| --- | --- | --- |
| repo.get | repo | fullName/defaultBranch/private/url |
| actions.run.list | repo/page?/perPage?/status?/branch? | GitHubPage&lt;GitHubRun&gt; |
| actions.job.list | repo/runId/page?/perPage? | GitHubPage&lt;GitHubJob&gt; |
| actions.log.read | repo/runId/jobId/offset?/maxChars? | TextPage |
| issue.get | repo/number | GitHubIssue |
| issue.list | repo/page?/perPage?/state?/labels? | GitHubPage&lt;GitHubIssue&gt; |
| issue.label | repo/number/labels/expectedUpdatedAt | GitHubWriteResult |
| issue.comment | repo/number/body | GitHubWriteResult |
| pr.get | repo/number | GitHubPullRequest（含 headSha/baseSha） |
| pr.diff | repo/number/expectedHeadSha/expectedBaseSha/offset?/maxChars? | TextPage |
| pr.create | repo/title/body/head/base/expectedHeadSha/draft? | GitHubWriteResult |
| pr.comment | repo/number/body | GitHubWriteResult |
| pr.review.comment | repo/number/body/commitId/path/line/side? | GitHubWriteResult |

分页默认 page=1、perPage=30，上限分别 10000、100。满页保守返回 nextPage，最后可能
需要读一页空结果；issue.list 过滤 PR，但游标以 GitHub 原始页推进，不因过滤跳页。
REST 分页不是快照，变化期间可能重复/遗漏，消费者按编号去重并重读目标。
文本默认每页 16384 字符、上限 65536；offset 以**脱敏后的 UTF-16 字符偏移**计量。
CLI stdout+stderr 总上限 1 MiB；超过明确失败，不将部分 diff/log 冒充完整内容。
失败日志先验证 job.run_id，再通过 `gh run view --job --log-failed` 读文本。
不把临时签名下载 URL 或 zip 日志作为输出。

pr.diff 每页读前及读后核对两端 SHA；review.comment 写前核对 commitId；pr.create
写前核对 head branch SHA。issue.label 为追加标签，写前核对 expectedUpdatedAt，
消费者仍应对完整 issue 做指纹比较。GitHub 写接口没有这里所需的原子 SHA/时间戳
条件更新，预读与写入之间仍有竞态；消费者必须保守处理、必要时读回人工核实。
review.comment 只创建 inline comment，不提交 APPROVE/REQUEST_CHANGES。
不支持 workspace 操作、commit/push、自动 merge、关闭 issue 或向 Actions run 写评论。

provider 写入 dispatch 后断连、超时、取消、响应损坏返回 `{state:'unknown',evidenceRefs:[]}`，
registered tool 将该结果转为 `ProtocolError('RESULT_UNKNOWN')`，使 Gateway/Runtime
持久化 unknown 并进入 reconciliation，避免把正常返回的内层 unknown 当成外层 confirmed。
不重试、不伪造成功；已确认响应返回 confirmed，此处不宣称人工/外部验收 verified。
消费者 unknown 后进入 reconciliation，不能以新 run 重发。未派发的过期/取消明确
抛 TIMEOUT/CANCELLED。所有错误只返回标准错误码与固定摘要，原始 stderr 不回显。
脱敏覆盖受限注入 token、常见 GitHub token、Authorization、密码/密钥键值；不是
DLP 保证，issue/log/diff 仍是不可信内容，不能作为权限或模型指令来源。

`GitHubConnector` 复用 ConnectorPort/manifest，通用 ConnectorPort 没有 ToolContext，
其读写/sync 方法明确 UNSUPPORTED_CAPABILITY，工具是实际执行入口。
connect 只登记宿主配置 session，不访问账号或声称 ready；health 保持 unavailable。
disconnect/dispose 释放 provider 与进程，register 初始化部分失败回滚已注册工具。

Fake 必须显式注入 operation fixture；缺项拒绝，不伪造成功。测试夹具不含真实 token。
当前用户明确要求不运行构建/测试/安装/真实服务；只做静态阅读、语法检查与 diff 检查。
集中验收时在整合后的 workspace 依赖准备完成后运行：

```sh
npm run build --workspace=@personal-agent/github
npm run typecheck --workspace=@personal-agent/github
npm run test --workspace=@personal-agent/github
npm run check
```

真实验收另行授权：白名单仓库 run/job 列表、失败日志、两端 SHA diff；写验收通过
Runtime 审批对测试 issue/PR 操作并读回，覆盖 unknown/reconciliation，不自动 merge。
