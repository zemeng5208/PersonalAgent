---
data_class: synthetic
fixture_version: 1
---
# 信息来源

<!-- current-design-20261009 -->
> 当前目标与协作规则（2026-10-09）：[完整设计](../../../../docs/design/resident-developer-agent-20261008/DESIGN.md) · [离线阅读/全部 SVG](../../../../docs/design/resident-developer-agent-20261008/index.html) · [两人确认与本机阅读门槛](../../../../docs/reviews/DESIGN_READING_GATE.md)。WSS 主通道、HTTPS 备用；Wiki 记忆由 goo122 接入。goo122 与 Potatos498 均确认后才可按授权合并，禁止强制合并/管理员绕过。设计不等于已实现；本文历史验收与作者记录保留，旧合并规则以当前门槛为准。

知识资料：本库内容均为项目自有合成文字。引用须包含相对路径、行号与来源版本。
修改依据：演示操作者明确要求把会议时长从 30 分钟改为 20 分钟，并更新整理状态。

天气：通过 weather.forecast 查询北京市当天预报；记录实际解析地点、日期、单位、来源和获取时间。
订阅：通过 feeds.subscriptions 查询真实已配置目录，再以返回的 id 调用 feeds.collect。
未配置订阅时应报告未配置，不把本页当作 RSS、订阅目录或已抓取的新闻。

自动整理：只有在当前来源、选定文件、基线版本及写权限都有效时才可执行；本页不构成授权。
结果未知时先核实原执行记录，不能再发一笔相同写入来冒充恢复。
