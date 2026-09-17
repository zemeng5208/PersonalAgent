# MOD-32：Competition 文字与本地工具组合

- 负责人：zemeng；非作者评审：goo122；profile：`huawei_ict_agentarts`。
- 工作树：`.worktrees/zemeng-competition-assembled`；分支：`codex/zemeng/competition-assembled`。
- 本地整合提交：`a496f0d04cab86b95c44c99dfbffc8733b7afb41`。
- 状态：`in_progress`，生产 Golden Path 仍 `unavailable`；没有合并 main、推送或发布。

## 已组合的实际代码

以 Desktop 三只读工具注册 `cb49b518` 为基础合并文字适配栈 `98769b2`。
保留 PR51 的 Competition 提交期限、workflow_end 回答解析、多 workflow index 重置，
以及 PR72 的可信 Workflow 输入映射与不支持 continuation 时提前拒绝。
保留原生目录选择、grant epoch 撤销、read/list/preview 三工具及本地 Runtime 审批执行路径。
唯一手工冲突在 coordination README；同时保留本地工具协议说明和 HTTP 文字边界。
没有删除 mock 限制、伪造 verification 或增加新的云 DTO。

## 本次必要验证

- 构建 contracts、storage、coding-tools、client、policy、tool-gateway、connector-host、
  weather、models、agents、coordination、goals、runtime 成功。TypeScript 编译器来自已有
  根依赖，执行构建的宿主 Node 为 26.3.0；没有据此声称精确 Node24 构建验证。
- 用已有 Node24.15.0 执行
  `node --test --test-isolation=none apps/desktop/test/workspace-access.test.mjs`：6/6 通过。
  包括授权前无工具、选择/撤销/迟到结果、真实 preview 的一次审批与执行、
  文件不变及相同 SQLite 重开后的任务保留。编排上游明确为 FakeCoordination。
- 合并差异检查报告继承的 SSE 夹具末尾空行；它是事件分隔格式，本次没有为了
  消除 whitespace 提示改写夹具。没有新增代码冲突标记。
- 未访问凭据、未调用云、未启动真实 Desktop/麦克风/扬声器。

## 可复现的生产阻塞

1. `packages/coordination/src/agentarts.ts:720` 只返回文字结果，未实现云工具提案映射。
2. 同文件 `validateRequest` 明确拒绝非 undefined continuation，不能回传本地工具结果。
3. `apps/runtime/src/application/coordination.ts:86` 只接受 mock 工具提案；真实提案明确返回
   `UNSUPPORTED_CAPABILITY`。不能把该判断删除或把真实提案标 mock 来取得成功。
4. 本地工具审批不等于工具结果出机许可；还缺已确认的云提案/续接映射及受限结果出口。
5. 本轮没有新的 deployment/version/API/trace 与本地 Evidence 配对读回，因此
   HTTP 200、历史 trace 或本地测试都不能证明真实 Golden Path 完成。

Desktop Workflow 启动增量 `0541a835` 已随后合入，main.js 的 Node24.15.0
语法检查通过；选择 query 或明确配置的 inputs，不猜测生产 Workflow 变量名。
PR51 页面虽显示 APPROVED，goo122 的批准实际绑定旧提交 `de9c400`，不是当前
`82c7c0e`，因此本组合仍需登记非作者复审，不能据页面汇总状态合并 main。

下一步在合法明确的云协议与数据出口下
实施生产提案/续接；若平台仍阻止真实诊断，保留上述阻塞，不换工具规避。
