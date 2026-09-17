# AgentArts 控制台单次合成只读验收

日期：2026-09-17；执行身份：zemeng；profile：huawei_ict_agentarts。

## 本轮明确授权与范围

用户直接授权使用当前已登录 AgentArts 控制台进行一次最小合成只读验收，费用确认，
失败停止且不重试。仅用浏览器 UI；不取 API key、不上传私有数据、不改配置、不部署资源。

## 目标与唯一请求

- 既有应用：PersonalAgent持续认知协调器。
- 应用 ID：`32d4d44c-eade-4f3f-8f76-209c74609e79`。
- 区域：cn-southwest-2；界面显示已提交，保存于 2026-09-17 16:09:27。
- 入口：应用编辑页的“试运行”，不是本地 Desktop 或部署 API。
- 请求标记：`PA-20260917-ONE`。

输入全文：

> 合成只读验收 PA-20260917-ONE：虚构任务T1是在15:00开会前完成材料准备，现唯一事实变化为会议改到17:00；虚构任务T2是独立的晚间阅读，与会议无依赖。请通过已有的事实变化/计划修复子工作流，说明T1和T2各应保留还是重新检查，并给简短理由。只分析本段合成数据，不访问文件、账号、网络工具，不写入或执行任何现实动作；没有工具执行证据就明确写“未执行现实工具”。

已且仅已发送一次。提交后页面显示“正在识别您要做什么”，输入框禁用、可停止回答。
这是受理/运行中证据，不是成功证据；本文件下方将记录本次唯一运行的终态。

## 证据边界

本例只验证云端只读分析/路由，不请求实际 MCP 或本地工具执行，因此即使回答正确也
不能证明 Runtime→Policy→ToolGateway→Evidence 的生产闭环，不能证明 Desktop 或语音可用。

## 本次终态与读回

页面最终显示“执行完成”，不再显示“停止回答”，输入框恢复可用；只有一条用户请求。
控制台已完成本次云端分析响应，不是 HTTP 状态码或本地 Fake 推断。

可见中间事实分析摘要：

```json
{"revision":null,"recommended_disposition":"RECHECK","affected_items":[{"kind":"goal","id":"T1","impact":"direct","reason":"会议时间变化直接影响T1的截止时间，需检查是否调整计划"}],"summary":"会议推迟仅影响T1的截止时间，建议重新检查T1计划；T2无依赖，可保留。"}
```

可见计划结果全文：

```json
{"base_revision":null,"disposition":"REVISE","preserved_steps":[{"id":"T2","reason":"晚间阅读任务与会议时间变化无依赖，原步骤继续有效"}],"rechecked_steps":[],"revised_steps":[{"id":"T1","replacement":"在17:00开会前完成材料准备","reason":"会议时间从15:00改为17:00，原步骤中的截止时间不再适用，需更新为17:00"}],"removed_steps":[],"dependency_updates":[],"evidence_required":[],"missing_information":[],"local_next_actions":[]}
```

另一个可见结果对象显示 overall_status=ACCEPT，但其 claims 均标注
`basis: unsupported`、`verification: not_verified`；它明确声明“未执行任何现实工具”，
且将执行计划修复子工作流标为 `out_of_scope/hold`。这些是模型输出，不是宿主授权或
工具执行证据，不因 ACCEPT 字样提升验证等级。

## 判定：部分链路成立，完整验收未通过

- 控制台登录态、提交的既有应用、唯一合成请求、云端响应及终止状态已直接读回。
- 输出存在语义偏差：事实分析为 RECHECK，后续计划输出升级 REVISE，并在没有
  current_plan/base_revision 的情况下提供替换项；不能采纳为可提交的计划修复。
- 当前界面只有“起始工作流”等可见结果，未取得具备唯一 ID 的完整控制器/子工作流
  调用链、deployment version 或 API trace ID，不能推断具体执行了哪些节点。
- 没有 MCP 工具结果、本地 Policy/Approval/ToolGateway 执行或可信 Evidence。
- 此次请求没有要求真实工具执行；它的成功响应也不能替代比赛工具 Golden Path。

已停止后续云调用，不重试、不修改/重新提交配置、不发布新版本。
一次验收授权已使用。页面保留本次结果；可见截图已在任务工具记录呈现。
恢复入口是上述既有应用的试运行面板。后续若修复云端提示/计划契约或另做 API/MCP
验收，需要新的明确调用授权；本文件不授予重试权限。
