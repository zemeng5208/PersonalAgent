# World-state contract fixtures

本目录只存放合成数据，用于 MOD-09A 契约讨论和未来验收。夹具不是公共 wire DTO、
数据库 Schema、生产迁移或冻结接口，不能导入生产代码，也不能替代消费者评审。

`queryProbes` 和 `changeFeedProbes` 只描述可观察行为。其中的字段名服务夹具测试，未来
端口可以采用不同传输形状，但必须保留空结果、水位、权限拒绝、游标确认、去重、缺口、
超时和取消语义。
