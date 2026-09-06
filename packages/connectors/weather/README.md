# 天气连接器（MOD-25）

负责人 Potatos498（C）；评审者 `goo122` 或 `zemeng`。包版本 0.1.0-alpha.1。关联需求 [PA-010](../../../docs/PRD.md)。所有演示内容均为 mock，无真实天气提供商调用。

## 导出入口

`@personal-agent/weather`（ESM，类型声明在 `dist/index.d.ts`）：

- `register(host, options?)`：向 ToolHost 注册 `weather.forecast` 工具（scope `weather:read`），返回 dispose。`options`：`provider`、`now`、`defaultLocation`、`cacheTtlMs`（默认 10 分钟）。
- `WeatherService`：领域服务。`getForecast(query, signal?)` 返回 `{record, forecast, cache}`。
- `WeatherConnector`：ConnectorPort 适配（manifest `id: 'weather'`，capabilities `['forecast']`，verification `mock`）。
- `FakeWeatherProvider` / `defaultWeatherFixtures`：最小夹具，见下。

## 消费的公共版本

`@personal-agent/contracts` 0.1.0-alpha.1（wire 1.0.0）；记录用 `validateContract('connectorItem')` 校验；工具输出 schema 以 `$ref` 引用协议 `$id` 下的 `ConnectorItem` 定义，不复制契约。fake 联调用 `@personal-agent/testkit` 0.1.0-alpha.1（FakeClock / FakeToolHost）。

## 行为规则

- **地点不静默猜测**：地点只能来自本次请求或已配置的 `defaultLocation`（用户设置），两者都缺时返回 `INVALID_ARGUMENT`。
- **三个时间分开**：`record.occurredAt` 是提供商发布/观测时间，`record.fetchedAt` 是获取时间，`record.validFor` 是预报覆盖区间（ISO 8601 UTC 区间字符串）。
- **缓存状态可见**：每次结果带 `cache.state`——`fresh`（TTL 内命中，未调用提供商）、`fetched`（本次实际调用提供商）、`stale`（提供商失败且返回已过期缓存，`cache.lastError` 附错误码与信息）。提供商失败且无缓存时错误向上传播；仅 `ProtocolError` 触发 stale 回退，程序性异常照常抛出。
- 无账号连接器：`record.accountRef` 固定为 `weather`，manifest `accountTypes` 为空。

## 最小夹具

`FakeWeatherProvider` 内置 4 条固定夹具（Beijing ×2 日、Shanghai、Hangzhou，均 2026-09-05/06），`setFailure(error)` 可模拟提供商失败。未知地点/日期返回 `NOT_FOUND`。imperial 单位由摄氏换算（°F，一位小数）。

## 验证方法

仓库根目录执行：

```sh
npm ci
npm run check
```

`npm run check` 覆盖本包 11 项测试：地点拒绝猜测与默认地点、三个时间与单位、记录通过契约校验、缓存命中/过期/stale、输入校验、工具 scope 与 dispose、manifest 与生命周期。

## 已知限制

- 日期按 UTC 解释（`date` 缺省取注入时钟的 UTC 当日）；用户本地时区语义待 MOD-13/MOD-20 时区配置确定后接入。
- 缓存为实例内存级，无持久化与跨进程共享；TTL 到期前不感知真实数据更新。
- `verification: 'mock'`——真实提供商（如 Open-Meteo）的接入与读回验证是独立工作包，未包含在本交付内；manifest 在真实验证前不得改为 `verified`。
- ConnectorPort 的 `fetchChanges` / `search` / `getItem` / `performAction` 均返回 `UNSUPPORTED_CAPABILITY`：天气为按需查询连接器，非增量同步连接器。
- 根 workspace 清单需要 `packages/connectors/*` 通配（本 PR 已包含，待 `goo122` 确认）。
