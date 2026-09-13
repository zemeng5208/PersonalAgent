# MOD-24：搜索与资料获取

## 基本信息

- 关联需求：PA-010（P0 联网研究——来源/发布时间/获取时间三披露，失败及过期明确）
- GitHub 负责人：`Potatos498`
- 评审者：`goo122`（非作者）
- 独占目录：`packages/connectors/research/`
- 当前状态：review（源码完成，待非作者评审；分支 `feat/mod-24-research`）

## 职责

检索学术/公开资料（OpenAlex）并规范化为带时间与来源的 `ConnectorItem` 材料；失败/过期区分（错误照实、缓存三态、材料过旧标 stale）；工具 `research.search` 只读。

## 非职责

研究规划与汇总（MOD-04）、通用 web 搜索（后续提供商：Bing 需 key；DDG/Wikipedia 本机连接层不通）、网页正文抓取。

## 输入、输出与公共入口

- 入口：`register`（工具 `research.search`，scope `research:read`）；ConnectorPort `search`。
- 输入：查询词＋limit；输出：材料列表（freshness/publishedAt/publishedTimeKind/ageMs 逐条披露）＋缓存三态。
- 提供商端口可插拔：Fake（夹具）与 OpenAlex（免 key，实测可达）。

## 依赖

- 前置模块：MOD-02（contracts）；MOD-04 消费本工具做规划（已在 main）。
- 允许依赖：`@personal-agent/contracts`（HTTP 经注入 fetch，无新外部依赖）。
- 禁止依赖：apps、其他内部包私有导出。

## 权限与数据

- Scope：`research:read`；无写动作（`performAction` 返回 `UNSUPPORTED_CAPABILITY`）。
- 敏感数据：无凭据（OpenAlex 免 key，mailto 可选）；材料 `sensitivity: 'public'`。

## 验收

- Fake/离线：8 项（契约、失败/过期区分、回退标注、缓存三态、规范化、能力边界、工具校验）。
- 真实条件：OpenAlex live 读回（`PA_RESEARCH_LIVE=1`，免 key）——已实测通过，证据见包 README。

## 排除项与已知限制

材料不含正文摘要；缓存实例内存级；仅学术源。详见包 README「已知限制」。
