# World-state contract fixtures

<!-- current-design-20261009 -->
> 当前目标与协作规则（2026-10-09）：[完整设计](../../../docs/design/resident-developer-agent-20261008/DESIGN.md) · [离线阅读/全部 SVG](../../../docs/design/resident-developer-agent-20261008/index.html) · [两人确认与本机阅读门槛](../../../docs/reviews/DESIGN_READING_GATE.md)。WSS 主通道、HTTPS 备用；Wiki 记忆由 goo122 接入。goo122 与 Potatos498 均确认后才可按授权合并，禁止强制合并/管理员绕过。设计不等于已实现；本文历史验收与作者记录保留，旧合并规则以当前门槛为准。

本目录只存放合成数据，用于 MOD-09A 契约讨论和未来验收。夹具不是公共 wire DTO、
数据库 Schema、生产迁移或冻结接口，不能导入生产代码，也不能替代消费者评审。

`queryProbes` 和 `changeFeedProbes` 只描述可观察行为。其中的字段名服务夹具测试，未来
端口可以采用不同传输形状，但必须保留空结果、水位、权限拒绝、游标确认、去重、缺口、
超时和取消语义。
