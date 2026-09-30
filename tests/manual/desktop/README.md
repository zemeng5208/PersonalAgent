# P8 已批准版本的 Runtime 消费验收

Profile：`huawei_ict_agentarts`。负责人：zemeng/P8；集成评审：goo122 或 Potatos498。
此处只验收隔离本地总装，不操作用户 Desktop、记事本或真实账号。

## 集成基线

- 独立分支：`codex/zemeng/p8-approved-runtime-consumption`，从 #243 `85b16831633126d157bc56791ea3bdbac7d42a1c` 建立。
- 正常 merge #237 `542a2cd592b06c53597ea2821ca1c02e8bba02e0` → `b60a302c01258abec092cda361973c77eb41cf70`。
- 正常 merge #234 `b4d09b7e28d19d20ba57f32abf5c3baf8abffa38` → `c902db6abfec3d5f754a7fba14d8f2d082d31c44`。
- 两个源包已由非作者 Potatos498 批准，CI 各双绿；源包文件与批准版本零差异。
  本地 merge 不表示两个源 PR 远端已合并，也不批准继承的 #236/#243 配置/消费内容。
- #236/#240/#243 原分支 head 保留；此分支不包含 #240 尚待评审的分类器身份增量。

## 最小执行

在 Windows、已安装工作区依赖及 PowerShell 7 的仓库根目录执行：

```powershell
npm run build --workspace=@personal-agent/coding-tools
node tests/manual/desktop/p8-approved-runtime-consumption.mjs
```

仅构建变动包，不重复其单元测试或全仓 check。脚本在 `.cache/p8-approved-consumption-*` 新建
工作区、独立配置、Runtime/Memory SQLite 与 receipt.json，保留可继续的证据，不删除用户文件。

## 当前已取得的证据

- 真实 Desktop `createWorkspaceConfigHost` 构造公开工具，经正式 AgentArts Runtime Application、Client、Policy 和 ToolGateway。
- 四个本地任务：read、preview、apply、read-back；各有真实 Runtime `allow_once` 审批，审批前未发生补丁写入。
  使用第一次 read 的 path/sha256 构造同一补丁；预览不写，应用后独立文件字节与再次工具读回相符，BOM/CRLF 保留。
- 四个执行记录为 confirmed，四条 Runtime Evidence 的 verification 均为 `conditional`，未人工升格。
  文件系统独立读回证明这次隔离文件确已改变；不代表正式窗口、云提案或用户工作区验收。
- Goal 源回执、Laya 与 HTTP 都为显式夹具；Runtime/SQLite/cognition host 和 P8 状态消费函数真实。
  未授权出云拒绝，同 review 两次接管只创建同一 task，Fake 编排 succeeded 后仍显示
  “编排任务已完成，目标更新尚未核实”，executionVerified/graphUpdateVerified=false；Goal 写入 0，图版本维持 5。
- 产物 `.cache/p8-approved-consumption-n3POGY/receipt.json`：整体 conditional；realLocalExecution=true、
  filesystemReadbackVerified=true；desktopUiVerified/cloudVerified/safeStorageVerified/formalF9Verified=false。
- 最初脚本漏传显式 initialRequestMode 被 Runtime 拒绝，未启动任务；修正为正式总装同款
  goal-with-tools-json/tool-proposal-json 后上述关键链通过。未改生产检查、作者源码或断言。

尚未验证：正式 Electron 新版本加载/完整 UI，真实 AgentArts 编排、真实 Goal 更新及 revision/Evidence，
F9/记事本、麦克风、真实凭据加密、崩溃恢复。本片没有远端合并、应用重启或真实云发送。
