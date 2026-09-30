# 辅助子任务模型配置与真实 child 绑定

工作包：SUBAGENT-MODEL-CONFIG；负责人 zemeng；非作者评审 goo122 / Potatos498。
Profile：`huawei_ict_agentarts`。隔离工作树登记：`.worktrees/subagent-model-config`，
分支 `codex/zemeng/subagent-model-config`，基线 main `4249ace1`（含批准的 #244/#246）。
状态：review；本包不承担共享 main/preload/Admin/Runtime Application 挂载。

## 受信挂载接口（P8 唯一写入）

```js
import {createModelApiConfig} from './model-api-config.js';
const modelApiHost = createModelApiConfig({userData, safeStorage});
const subagentTool = createDesktopSubagentDispatchTool({
  getRuntime: () => runtimeApplication.runtime,
  getTools: () => runtimeApplication.tools,
  getModelGateway: modelApiHost.getModelGateway,
  getModelReasoningEfforts: modelApiHost.getModelReasoningEfforts,
});
// 主进程退出时调用；不得向 Renderer 暴露 host 或 gateway。
modelApiHost.dispose();
```

共享 IPC 使用既有可信窗口/发送者校验与模型设置权限，限定以下分派：

| 控件调用 | 主进程处理 | 返回 |
| --- | --- | --- |
| `modelApi.state` | `modelApiHost.snapshot()` | 脱敏 snapshot |
| `modelApi.configure` | `modelApiHost.configure(payload)` | 脱敏 snapshot |
| `modelApi.remove` | `modelApiHost.remove({id})` | 脱敏 snapshot |

`configure` 只接受 `id? / provider / baseUrl / model / displayName / apiKey? /
enabled? / makeDefault?`，provider 为 `pangu` 或 `openai-compatible`。
不导入环境密钥，不发起连接测试。空密钥仅在同一记录、供应商和规范化 Endpoint
不变时保留；改变目的地须新密钥。整个配置使用 Electron safeStorage 加密，原子写入
用户数据目录。解密或安全存储失败明确不可用，不回退明文。

Renderer 导入独立的 `src/app/model-api-controls.js`：

```js
const controls = mountModelApiControls(root, restrictedInvoke);
controls.render(await restrictedInvoke('modelApi.state'));
// 页面切换/窗口释放
controls.close();
```

控件只向 IPC 短暂提交新密码，提交前清空输入，完成后清空 payload；快照没有密钥。
模型选择使用 snapshot.models 的稳定 `id`；无选型时只取 `defaultId`，未知/停用模型
返回 unavailable，不回退旧盘古配置。P8 应把稳定 ID 绑定到原有子任务选型控件及可用
模型目录，不将本地配置表直接导出到云端。保留 AgentArts/Live/SIS 的现有配置。

模型均经已有 ModelGateway 和 StructuredToolProvider；后者是文字 JSON 提案协议，
能力等级 conditional，不是原生工具调用。当前配置宿主返回空 reasoningEfforts；
只有可信宿主独立确认某个端点支持时，才可向子任务宿主注入支持列表。
thinkingDepth 仍控制既有执行步骤预算，不构成原生模型 reasoning 的验证。

## Runtime 行为

- runAgent 使用 childWorker.taskId；模型循环的 runId 与授权引用采用 #244 的已有规则，
  工具调用经 Runtime Application → Policy → ToolGateway，Evidence 绑定真实 child。
- 无网关行为保留 main #232 的 UNSUPPORTED_CAPABILITY 回归；生产不生成角色完成文本。
- 父级进度写入已有 TaskRuntime；父/child checkpoint、取消、deadline 与去重沿既有路径。
- 更改、停用、删除、释放配置会中止该记录正在运行的请求，旧 gateway 引用随后拒绝调用。
- 子任务 waiting_approval / waiting_reconciliation 不汇总为成功。现有 SubtaskExecutionSummary
  只有 succeeded/failed/cancelled，本包把未完成汇总为 failed 并保留 child 的真实等待状态。
  独立 child 的审批恢复与重新汇总仍需要 P8 在现有 Runtime Application 恢复入口接线，
  不能用本包离线自动授权用例证明该恢复用户旅程已经完成。

## 验证与限制

本树只编译 Runtime 的必要依赖与 Runtime，运行专属子任务及模型配置测试；无全仓 check、
全套 smoke、真实端点或新付费调用。覆盖无网关、未知选型、真实 child/task authorization
绑定、Policy 单次消费、Evidence、两模型选择、去重、取消、等待审批不成功、密钥边界及撤销。
设置控件独立预览的渲染不代表共享 Desktop 的 IPC/挂载已验收。
本地 PATH 为 Node 26.3 / npm 11.16，与锁定 Node 24.15 / npm 11.12 不同；
CI 与 P8 在约定环境的整体验收独立记录。
真实云、原生工具与 reasoning、本机 safeStorage、Desktop 完整用户旅程仍未验证。
不改变公共 wire Schema、迁移、依赖或锁文件，也不新增 Local Profile 路径。

局部测试命令：

```powershell
node --test apps/desktop/test/model-api-config.test.mjs apps/runtime/test/subagent-host.test.mjs apps/runtime/test/subagent-end-to-end.test.mjs apps/runtime/test/subagent-task-binding.test.mjs
node --check apps/desktop/electron/model-api-config.js
node --check apps/desktop/src/app/model-api-controls.js
git diff --check
```

上述 12 个用例通过；默认选择取消的小修改后仅重跑配置的 3 个用例，通过。
独立浏览器预览检查保存后模型选中、默认选中和密码清空，截图位于本树忽略目录
`.cache/model-api-controls-preview.png`；该预览只使用合成值与 Fake IPC。
