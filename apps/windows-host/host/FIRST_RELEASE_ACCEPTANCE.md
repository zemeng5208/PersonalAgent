# P6 首版消费与现场验收

Profile：`huawei_ict_agentarts`。范围为 Windows Host/Client、coding-tools 与可信工作区绑定。
本文件是已实现端口和消费检查的说明，不新增协议、授权、调度器或任务状态来源。

## 版本与实际产物

- 命令 Job 生命周期修正：[#223](https://github.com/zemeng5208/PersonalAgent/pull/223)，源 `2bb4243f80308573d3f418bea4e8f7cf3c92e40f`。
- 工作区原始字节 SHA/BOM/CRLF：[#234](https://github.com/zemeng5208/PersonalAgent/pull/234)，合入 `2732ff98ad654fee21e32f70f99ec800d19167c6`。
- Host 目标有效期与同 SafeHandle 映像/包身份：[#249](https://github.com/zemeng5208/PersonalAgent/pull/249)，源 `b6c40e6c6121c6a38c8f0b003d47af71601b89e5`，合入 `723f2518aa9e73c5cea870f5afcb26caa2f6fb87`。
- 工作区可信绑定：[#260](https://github.com/zemeng5208/PersonalAgent/pull/260)，源 `afc38d16e7527a56496ec281f1b652ffa4dc7d4d`，合入 `f95f7aa84312c996f94c5ff6ae8eec7a3113e926`。

2026-09-30 核对装配基线 `b34af799d27a2f4cc0d108d5c6dbc831f53edfce`：上述 P6 生产源码和可信绑定与交付源一致。
但该工作树当时的 Host.exe、Host.dll、WindowsHost.dll 仍匹配旧批次，其余配置和 Schema 一致。
装配方随后确认本次自有 Host 没有在途操作，备份旧批次后整组复制六件。P6 再次只读核对六件 SHA，
全部与 #249 同批 manifest 一致。这里只完成开发产物准备；没有启动 Native/F9 或关闭用户应用，不能记录实机操作通过。

复用已构建产物时，先确认本次自有 Bridge/Host 没有在途操作，再整批拷贝以下文件，并按同批本地 manifest 核对每个 SHA：
`WindowsHost.Host.exe`、`WindowsHost.Host.dll`、`WindowsHost.dll`、`WindowsHost.Host.deps.json`、
`WindowsHost.Host.runtimeconfig.json`、`windows-host.json`。Bridge 使用其独立已验证产物与完整 companions。
Job helper 同样保留 exe/dll/deps/runtimeconfig 整批来源；不要混用旧 manifest 或为此重复重建。
这些是未签名的开发产物，不构成安装发行验收。缺产物保持不可用，不自动安装依赖或重启用户应用。

## 桥契约与诊断

单一帧来源是 `@personal-agent/contracts/windows-host` / `schema/windows-host.json`，内部版本 `0.1.0`。
公开可信宿主工厂是 Runtime/Application 的 `createWindowsHostBridgeTransport`、
`createWindowsHostNotepadAdapter`、`createRuntimeWindowsHostAttemptStore`；没有通用 DesktopActionPort。

| 表面 | 准确含义 | 不能推导的结论 |
| --- | --- | --- |
| Bridge stderr 的 `VERIFIED\n` | 核对真实 Pipe 服务端 PID、启动身份和 session 后放行 JSONL | 不是 hello/bind、目标捕获、授权或 UIA 成功 |
| `REFUSED\n` / 启动前退出 | 拒绝本次启动或身份核验；不提供目标私密诊断 | 不能改选其他进程或绕过身份检查 |
| `hello_ack`、`bind` | 经双向 SID/PID/session 检查后的当前连接绑定 | 不授权写入；窗口基线在 hello_ack 前建立 |
| `observation_refused` | 原 request/session 关联的明确拒绝；保留 Schema errorCode | 断连不能冒充写前拒绝 |
| `target_ready_result` | 原 targetRef 当前就绪与原 expiresAt；不读正文、不续期 | 不保证稍后的前台状态或执行成功 |
| `result.state=verified` | 原 Host run 的同目标 UIA 写后读回匹配 | 不是文件保存，也不是 Runtime 任务终态 |
| 新会话 `status` | 仅查询原 durable run 身份；`in_progress`/`not_found` 均仍未知 | 不能重发 execute、改变原参数或认为未发生写入 |

本地目标身份绑定的是 `(HWND, PID, ProcessStartUtc)`，映像与包身份通过同一个 Process.SafeHandle 查询，
还复核窗口 owner、当前 session、前台、唯一标签/可写控件和短期有效期。
SID、HWND/PID、路径、标题、正文和 targetRef 保留在可信宿主，不新增 Renderer/云端诊断字段。
消费者可记录现有固定阶段、errorCode、任务状态和 Evidence 引用；不能打印原始帧或异常里的私人内容。
Bridge 启动错误的公开异常由 Runtime adapter 脱敏为既有 `TIMEOUT`、`UNAUTHORIZED`、`EXTERNAL_FAILURE` 等；
以实际关联帧和 Runtime 记录区分失败阶段，不能仅凭错误名判断副作用。

Desktop 原生圆角/窗口区域的 OS 合成验收由共享装配方负责，与 Notepad targetRef/Pipe 协议没有关联。
现有 `getBounds()` → `setShape()` 调用不证明最终 OS 区域或桌面像素正确；应核对当前自有窗口的真实
窗口身份、bounds、显示缩放和最终合成效果，不能将浏览器 DOM 截图或另造 Host DTO 作为该项证据。

## 可立即执行的物理现场

1. 使用完成产物核对的正式 Desktop，保留现有用户窗口。设置页填写公开合成短文本，点击“新建并准备写入”。
2. 等待桥握手完成后出现的新独立空白单标签记事本；旧 HWND 中新增标签不符合条件。
   用户亲眼确认本次文本和目标，将新窗口保持前台，物理按 F9。没有人在场时保留此项未验，不代按。
3. 用户确认后检查 Runtime 一次性授权、同目标就绪复核、UIA 写后读回、任务 `succeeded`、confirmed 结果与 Evidence 引用。
   最后在窗口亲眼核对文本；成功说明控件文本匹配，未保存文件。
4. 接管验收使用另一项明确的新操作，在写前切换前台或输入；应停止自动动作并拒绝原目标。
   若已开始写入，则保留 `RESULT_UNKNOWN`，不能自动撤销、继续输入或重新写入。
5. 取消/过期/断连后保留原 task/run。只用原 durable identity 查询 Host 状态；不另建任务冒充恢复。
   原 `host_result` 即使为 verified 也须由 Runtime 校验并持久投影后才能恢复终态；不存在该投影入口时仍列装配缺项。

不关闭或保存用户记事本。已取消的旧任务和没有 Evidence 的“finish”回复不算物理确认或成功。
当前物理 F9、真实 UIA、接管和跨重启 Runtime 恢复仍未验；不能把本文件当作这些项的通过记录。

## 工作区与恢复消费

公开工厂沿 `@personal-agent/coding-tools`。根路径、可信 exe、固定 argv、恢复目录都由可信宿主注入；模型只选择既有有界参数。
`read_text` 返回原字节 SHA，`preview_text_patch` 使用它形成可审查候选，`apply_text_patch` 经 Policy 消费一次授权，
独占 helper 先持久备份/marker，再校验原字节并写后读回。旧 SHA、撤销、链接或身份变化不得覆盖用户修改。
列表使用独立 `workspace:list` scope，只枚举直接子项。

固定命令的 cwd 不是 OS 沙箱。项目脚本只能在单独 `projectCodeAllowed` 许可、可信 Node/npm/Job helper、
固定 recipe 与依赖已存在时启用；没有自动 install 或发布。Job 必须 assign-before-resume，正常根退出先关闭 Job 再排空输出；
取消和超时的进程树验证复用 #223 的真实 Windows 检查，不以直接进程退出代替整树停止。

写工具异常在现有 ToolGateway 中统一为 `RESULT_UNKNOWN`。补丁恢复使用公开
`reconcileWorkspacePatchApply` 与 Runtime 的 `reconcileWorkspacePatchTask(taskId)`，按原 run/参数摘要/marker/进程起始 token 对账。
Runtime 持久保存结果后才 acknowledge marker；无 marker、PID 身份不确定、哈希变为第三值都不能重做写入。
命令没有自动重放恢复：保留原输出/未知状态，先核实实际产物与进程，再由用户决定独立新任务。

可信 `readWorkspaceBinding()` / `isWorkspaceBindingCurrent()` 只给 Main 使用，绑定 root、Node 和当前许可 generation。
选择/撤销/重新许可/close 使旧绑定失效；Main 停止对应服务并拒绝过时结果。PRIVATE 源码和绝对路径不进入云端。

## 证据复用与剩余项

已有真实本地 Runtime/Policy/ToolGateway 编码收据证明 read→preview→apply→command→read、取消无写、旧 SHA 拒绝和重启不重放；
BOM/CRLF 的独立 CAS 收据与装配方四个真实补丁任务也已读回。Evidence 仍为 `conditional`，不是最终 UI 或云端验收。
HostFixture 已验证目标/任务期限 CTS 和同句柄进程映像；Job 的取消/超时/根退出实测已通过，不重复全 .NET 或 full smoke。
本轮复用既有 Job helper，真实 npm 对自有合成项目执行 `build` 与 `test`，退出码均为 0；
再经两个真实 Runtime 任务读取产物原字节 SHA 和列举直接子项。四项 task 均成功、工具执行 confirmed，
Evidence 为 `conditional`。没有安装依赖、执行用户项目或调用云端；复用既有编译 Runtime，不能证明最新共享装配或 Electron。
首轮因合成项目将同一个空 npm 配置文件同时设为 user/global，npm 拒绝 double-loading、命令退出 1；
原 Runtime 正确保留非零退出码，任务与失败现场未重放。修正为两个独立空配置文件后，新合成工作区通过。
这不是产品 Policy 或 Job 错误，也不隐藏首轮失败。

已有可信 Node、Job helper 与 npm CLI 的普通 Windows 会话可运行一次以下显式手工入口：

```powershell
node tests/manual/coding/p6-project-command-acceptance.mjs "<trusted absolute Job helper.exe>" "<trusted absolute npm-cli.js>"
```

它仅在仓库 `.cache/p6-project-command-*` 新建合成项目与 SQLite，使用当前启动 Node，
通过 Client 的原审批与 Runtime 执行固定命令/读/列表任务，原文件、输出、数据库和收据保留供核实。
输出记录 helper/npm/runtime 的实际 artifact SHA；工具 stdout/stderr 不进入云端或公开摘要。
现有进程树取消/超时证据不重复运行；此新 npm 消费收据补充未验项，不代表复杂用户项目已支持。

2026-09-30 独立真实 `node:os` provider 采样与 Schema 校验通过，未经过持续会话、通知或 AgentArts；对应语义见
[windows-client README](../../../packages/windows-client/README.md)。

最终装配方仍须读回当前 Native 产物、项目脚本真实消费、持续指标/通知、物理目标和恢复状态。
新失败仅补验受影响路径；源码合并、CI 或单条链路不能完成整个 P6/MVP。
