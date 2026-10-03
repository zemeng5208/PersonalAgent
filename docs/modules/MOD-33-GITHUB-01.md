# MOD-33-GITHUB-01：GitHub 连接器源码增量

- Profile：Local（DEV-WORKFLOWS-PLAN-20261002 #276 的明确范围）。
- 状态：review；源码交付，未构建、未测试、未真实验收，不能标 done/frozen。
- 负责人：zemeng；非作者评审：goo122。
- 独占：packages/connectors/github/** 与本文件；其他模块只消费公开 package exports。
- 基线：3d4d917；工作树 .worktrees/dev-github，分支 codex/dev-github。
- 依赖：contracts ToolHost/ToolDescriptor/ConnectorPort/ProtocolError；Runtime Policy、
  ToolGateway、Connector Host 凭据注入；不私设授权、任务库或模型入口。

提供 repo、Actions run/job 与失败日志、issue get/list/追加标签、PR get/diff/create、
普通评论与 inline review comment。公开 DTO 在包 src/provider.ts，由 index.ts 导出。
register(host,{provider}) 真正注册 13 个工具并返回幂等 dispose。
GhCliProvider 使用受限 token accessor、显式 repo 白名单及无 shell argv runner；
生产 SpawnGhCommandRunner 不继承环境，支持字节上限、deadline、取消和释放。
Fake 与 JSON/测试夹具覆盖分页、过滤 PR、404、限流、脱敏、job 归属、revision冲突、
unknown 写入、取消、工具注册和 scope 防误调用；这些测试尚未运行。

公共端口 GitHubPort.execute 是可信装配/测试边界，业务和模型只通过 ToolGateway。
工具名、输入输出、安全边界与集中验收命令见
[包 README](../../packages/connectors/github/README.md)。无根依赖/锁文件修改，整合者
需按仓库 workspace 规范准备依赖与执行集中验收。

限制：GitHub 预读不是原子条件写；时间戳不是 issue 完整指纹；列表不是稳定快照；
1 MiB 以上日志/diff 明确失败；inline COMMENT 不代替人工 approve；不提供 run comment、
commit/push、merge、自动关闭或模型归因。verified 等级与生产 host capability 公布仍需
非作者评审、集中门禁和真实服务闭环，不能仅凭源码提升状态。

用户要求禁止 npm install/build/unit/integration/真实服务，因此本次只做允许的静态
检查。后续统一验收需覆盖跨模块 MOD-34/36/38 Gateway 读写闭环、一次性审批、
参数绑定、取消/超时/unknown reconciliation 和有副作用请求禁止盲重试。
