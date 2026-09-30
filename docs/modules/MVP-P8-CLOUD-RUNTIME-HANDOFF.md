# P8 公共 Runtime 接续交接

Profile：`huawei_ict_agentarts`。公共 Runtime 后续源码交 Work 云端唯一作者，本机 P8 保留 Desktop/native/configuration 装配。所有既有未知结果、数据库和用户配置保留。

## 当前源码

- 默认子任务使用与主任务相同的 `runCoordinationWorker`；SubagentHost 仍只负责一次原 `runTask` 生命周期。主 AgentArts 默认可用性不再依赖独立模型 API；显式选择独立模型仍走原受信模型工厂。
- SubagentHost 来源 `2b07e34`：独立任务并行、原父子身份/工具目录冻结、原审批和取消恢复。Runtime 接收第三参数限定 ToolPort，为子任务建立同源受限目录；发送前从原子任务工具绑定重查目录。思考步骤预算保留，未支持的原生 reasoning 不宣称已执行。
- 同一 TaskRuntime SQLite 有序增加 migration 10 `trusted_host_state`。可信宿主得到绑定 namespace 的同步 get/set/delete，未注册 wire/Renderer/模型操作，不创建额外任务或数据库。只保存公开宿主元数据，私有正文及凭据保持原存储。
- 知识写入恢复从原 HostTool intent、ToolRecord、完整输入 matcher 和真实只读结果构造接受记录；独立 observation Evidence 绑定原任务/run/digest/operation/current SHA。先持久读回证据，再由原锁定 finalizer 清匹配 metadata，仅 finalized 后恢复原终态；unknown/in_progress/still_unknown 保持待核实，不重发工具、不提前钉死未知分类。
- 公开逐项 Feed 原结果 mapper 来源 `1ffe991`，新函数已由 application exports 发布。原生产来源 Evidence/TrackingGrant 消费尚未补齐。

## 本地必要检查

Runtime TypeScript 编译最终通过（此前缺 knowledge 新 dist/类型声明的问题已修复）。新增知识恢复 2 case、原 Runtime migration 9→10/namespace/reopen/旧 checksum 不变 1 case，共 3/3；新增默认 Coordination 子任务 case 与 P5 最终 KV 2 case，共 3/3。默认子任务检查复用 FakeCoordinationPort，证明原循环/审批/同 run/Evidence/父汇总，无独立 API 调用；不是真实 AgentArts 云调用。Node 26.3.0，不是目标 Node 24.15.0。

Goal 本地常规授权修复 `1bf0dca` 的实际 SQLite case 1/1 通过。原真实验收任务 `dfe3b24e-deb1-4e3e-91de-f9cbba8e146b` 仍 waiting_reconciliation，图 revision 3/Goal 1 未写，cloudCalls 0，Laya stopped。原未知写不得重发。

知识模块 sidecar 来源 `610dd9a` 的作者必要检查已通过，本机未重复。已消费 PA020 `e3a0d94`、设备 `ab08ded`、Live `e23b4cd`、MCP/Skill `d94e9f6`、P5 KV `e11ac12` 与邮件夹具/manual；本机尚未统一启动验收这些装配。

## 仍需云 Runtime 实现

1. 原 Cloud 请求和部署版本/trace 的真实绑定；P4 v17 发布与独立角色预览不是本地 Goal/Laya/CAS 证据。窗口释放及准确 pins 后，用新的隔离夹具执行真实主链。
2. 私有记忆的可信临时 goal 投影 hook：公开原 user goal 持久化，native task consent 后仅内存引用摘要；最终发送复验许可，重启无 lease 拒绝。原 Runtime/子任务/历史的本地派生副本登记、withheld 与终态精确清除，并真实读回，未知写 proof 不提前清除。
3. P7 原 Feed execution/result/Evidence→完整 v2 mapper 绑定、真实公开 transport proof/native TrackingGrant、主文字同源 answer 消费。
4. 同一原 Skill worker 的可发现云选择/续接，不能在工具锁内嵌套 invoke；MCP 公共 export 必须明确原生许可/task/proposal/path/config/SHA，workspace read 不自动成为出机许可。
5. Calendar 初始真实 Fact/Goal dependency link、Meeting execution 通过原 Runtime/Policy/Gateway，不能用旧 allowed 回调直接 appendBatch 冒充授权。
6. Windows 原未知运行 recover 的 HostResult 严格校验、只读接受到原 Runtime record/终态；不得重发 execute/not_found 伪完成。

Desktop/main 原生选择、安全配置、IPC、持久任务列表的恢复操作及最终统一验收由 P8 串行接线。现有 UI/源码/测试/模块合并不代表全部 MVP 完成。
