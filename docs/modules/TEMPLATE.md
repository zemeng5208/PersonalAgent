# MOD-XX：模块名称

## 基本信息

- 关联需求：PA-XXX
- 目标 Profile：`huawei_ict_agentarts`（当前默认）/ `local`（可选，需说明进入当前范围的理由）
- GitHub 负责人：
- 评审者：
- 独占目录：
- 当前状态：todo
- 消费的冻结基线 / 精确提交：

## 职责

该模块负责什么。

## 非职责

该模块明确不负责什么。

## 输入、输出与公共入口

列出公共端口、Schema、事件和 package exports。

| 接口 | 提供方 | 状态（frozen / provisional / unavailable） | 兼容或迁移要求 |
| --- | --- | --- | --- |
|  |  |  |  |

## 依赖

- 前置模块：
- 允许依赖：
- 禁止依赖：

## 权限与数据

列出 Scope、副作用、敏感数据、凭据注入和保留边界。

## 验收

- Fake/离线测试：
- 跨模块集成：
- 真实条件验收：
- 能力发现与不可用路径：
- AgentArts deployment/API/trace 与防静默回退（Competition 模块）：

## 排除项与已知限制

明确本工作包不实现和仍未验证的事项。

Competition 模块必须区分 AgentArts、Local 和 Fake 证据；Local 模块不能被计入比赛主路径完成度。
