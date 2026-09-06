# 天气连接器（MOD-25）

负责人 Potatos498（C）；评审者 `goo122` 或 `zemeng`。包版本 0.1.0-alpha.1。关联需求 [PA-010](../../../docs/PRD.md)。

接 **Open-Meteo** 真实提供商（免密钥、无账号），manifest `verification` 为 `conditional`——结果依赖出站网络可达。`register` 不默认任何提供商，装配方必须显式传入（通常为 `new OpenMeteoProvider()`），缺失时抛 `INVALID_ARGUMENT`，避免静默启用测试用 Fake。`FakeWeatherProvider` 夹具仅用于离线测试，`verification` 为 `mock`。

## 导出入口

`@personal-agent/weather`（ESM，类型声明在 `dist/index.d.ts`）：

- `register(host, options)`：向 ToolHost 注册 `weather.forecast` 工具（scope `weather:read`），返回 dispose。`options.provider` 必须显式提供；`now`、`defaultLocation`、`cacheTtlMs`（默认 10 分钟）可选。
- `OpenMeteoProvider`：真实提供商。`options`：`fetchImpl`（注入以便离线测试）、`language`（默认 `zh`）、`locationResolution`（默认 `ranked`）、`forecastBaseUrl`、`geocodingBaseUrl`、`geocodeCacheLimit`（默认 500）。
- `WeatherService`：领域服务。`getForecast(query, signal?)` 返回 `{record, forecast, cache}`；`providerVerification` 反映注入的提供商。
- `WeatherConnector`：ConnectorPort 适配（manifest `id: 'weather'`，capabilities `['forecast']`，`verification` 取自 service）。
- `FakeWeatherProvider` / `defaultWeatherFixtures`：离线夹具，见下。

## 消费的公共版本

`@personal-agent/contracts` 0.1.0-alpha.1（wire 1.0.0）；记录用 `validateContract('connectorItem')` 校验；工具输出 schema 以 `$ref` 引用协议 `$id` 下的 `ConnectorItem` 定义，不复制契约。fake 联调用 `@personal-agent/testkit` 0.1.0-alpha.1（FakeClock / FakeToolHost）。无新增外部依赖：HTTP 用 Node 内置 `fetch`，时区换算用内置 `Intl`。

## 行为规则

- **地点不静默猜测**：地点只能来自本次请求或已配置的 `defaultLocation`（用户设置），两者都缺时返回 `INVALID_ARGUMENT`。
- **地点解析必须披露**：真实地理编码天然有同名歧义（"北京" 返回北京市／重庆市／四川三个同名地点，"朝阳" 返回五个）。`ranked`（默认）取提供商相关性首位，但在 `forecast.resolved` 中披露解析到的具体地点（名称、行政区、国家、经纬度、时区）、`ambiguous` 标记与最多 4 条 `alternatives`；`strict` 直接返回 `INVALID_ARGUMENT` 并列出全部候选，拒绝任何猜测。
- **三个时间分开**：`record.occurredAt` 是来源时间，`record.fetchedAt` 是获取时间，`record.validFor` 是预报覆盖区间（ISO 8601 UTC 区间）。
- **时间来源必须标注**：Open-Meteo **不返回预报发布时间**（只有 `generationtime_ms`，那是响应生成耗时）。因此 `forecast.publishedTimeKind` 显式区分 `provider_published`（提供商给出真实发布时刻，如夹具）与 `coverage_start`（Open-Meteo：取覆盖日本地零点的 UTC 时刻）。不用抓取时间冒充发布时间。
- **覆盖区间按地点时区**：真实提供商给出时区时，`validFor` 是该地本地日对应的真实 UTC 区间（北京 2026-09-06 → `2026-09-05T16:00:00.000Z/2026-09-06T16:00:00.000Z`）。按 UTC 日界推算会偏 8 小时。日界用 `Intl` 计算，跨夏令时正确（纽约 7 月 → `T04:00Z`，1 月 → `T05:00Z`）。
- **缓存状态可见**：每次结果带 `cache.state`——`fresh`（TTL 内命中，未调用提供商）、`fetched`（本次实际调用提供商）、`stale`（提供商失败且返回已过期缓存，`cache.lastError` 附错误码、信息与可选 `retryAfterMs`）。仅 `RATE_LIMITED` / `TIMEOUT` / `EXTERNAL_FAILURE` 这三类可重试的外部失败才回退到 stale；`NOT_FOUND`、`INVALID_ARGUMENT` 等确定性错误照常向上抛出，不用旧数据掩盖。提供商失败且无缓存时错误同样传播；仅 `ProtocolError` 触发 stale 回退，程序性异常照常抛出。
- **取消不是失败**：信号已取消时返回 `CANCELLED`，既不回退到 stale 缓存，也不返回提供商在取消后才到达的结果——抓取前后各检查一次，避免把取消后的数据当成成功结果交出去。
- **不编造数据**：提供商未给降水概率时 `precipitationProbability` 为 `null`，不填 0；未知 WMO 天气代码返回 `未知天气代码 N`，不编造天气描述。
- 无账号连接器：`record.accountRef` 固定为 `weather`，manifest `accountTypes` 为空，`authentication` 为 `none`，不持有任何凭据。

## 真实提供商：Open-Meteo

调用两个免密钥端点：地理编码 `geocoding-api.open-meteo.com/v1/search`（结果按 `location|language` 缓存，上限 500 条，超出淘汰最早项）与预报 `api.open-meteo.com/v1/forecast`（`daily=temperature_2m_min,temperature_2m_max,precipitation_probability_max,weather_code`，`timezone` 取解析地点的 IANA 时区）。

错误映射：

| 情况 | 协议错误码 | 可重试 |
| --- | --- | --- |
| 地名无匹配 | `NOT_FOUND` | 否 |
| 日期超出模式范围（400 且 reason 含 out of allowed range） | `NOT_FOUND`，附提供商给出的允许日期区间 | 否 |
| 其他 400 / 参数被拒 | `INVALID_ARGUMENT`，附 reason | 否 |
| 429 | `RATE_LIMITED` | 是（`retryAfterMs` 60s） |
| 5xx、网络失败、JSON 畸形 | `EXTERNAL_FAILURE` | 5xx 与网络问题为是 |
| 信号已取消 | `CANCELLED` | 否 |
| 该日无温度数据 / 响应缺 daily 块 | `NOT_FOUND` / `EXTERNAL_FAILURE` | 否 / 是 |

单位：`imperial` 走 `temperature_unit=fahrenheit`（由提供商换算），`metric` 走 `celsius`。天气摘要由 WMO `weather_code` 映射为中文或英文文本。

## 最小夹具

`FakeWeatherProvider` 内置 4 条固定夹具（Beijing ×2 日、Shanghai、Hangzhou，均 2026-09-05/06），`setFailure(error)` 可模拟提供商失败。未知地点/日期返回 `NOT_FOUND`。imperial 单位由摄氏换算（°F，一位小数）。夹具带真实发布时刻，`publishedTimeKind` 为 `provider_published`；不含时区，故 `validFor` 退回 UTC 日界。

## 验证方法

仓库根目录执行：

```sh
npm ci
npm run build
npm run typecheck --workspaces
npm run test --workspaces
```

本轮结果：6 个工作区类型检查全部通过；根 `npm run check` **整体通过**（退出码 0）——此前卡住的 `check:generated` 漂移误报是 Windows CRLF 造成的，已由 PR #5 修复。

全仓 62 项测试，61 通过、1 跳过（weather 29：28 通过 + 1 项真实读回默认跳过；runtime 7、testkit 13、client 5、contracts 4、storage 4）。

本包 29 项测试中，`test/weather.test.mjs` 13 项覆盖：地点拒绝猜测与默认地点、三个时间与单位、记录通过契约校验、缓存命中/过期/stale（含 `retryAfterMs`）、取消不返回缓存或成功结果、拒绝静默启用 Fake、输入校验、工具 scope 与 dispose、manifest 与生命周期。

`test/open-meteo.test.mjs` 16 项覆盖真实提供商，其中 15 项为离线测试（默认运行，无网络），用注入的 `fetchImpl` 覆盖时间来源标注、夏令时日界、歧义披露、`strict` 拒绝、地理编码缓存、单位参数、降水缺失、未知天气代码、错误码映射、网络失败与取消、畸形响应、空地点拒绝、manifest `conditional`，以及经 `FakeToolHost` 的 ajv 实际校验工具输出 schema（含 `resolved` 与可空降水概率）。

第 16 项是真实读回，**与模拟测试分开**，需显式开启：

```sh
PA_WEATHER_LIVE=1 node --test packages/connectors/weather/test/open-meteo.test.mjs
```

未设 `PA_WEATHER_LIVE=1` 时该测试跳过，保证 CI 与离线环境确定性。本轮实际执行结果：16 项全部通过，证据见下。

## 真实读回证据

2026-09-06 于 Windows 本机对生产端点实际执行（`PA_WEATHER_LIVE=1`），合并评审修复后重跑，查询「北京」当日：

```json
{
  "occurredAt": "2026-09-05T16:00:00.000Z",
  "fetchedAt": "2026-09-06T03:59:28.796Z",
  "validFor": "2026-09-05T16:00:00.000Z/2026-09-06T16:00:00.000Z",
  "summary": "阴",
  "min": 22.3,
  "max": 31.4,
  "precip": 0,
  "resolved": {
    "name": "北京", "admin1": "北京市", "country": "中国",
    "latitude": 39.9075, "longitude": 116.39723,
    "timezone": "Asia/Shanghai", "ambiguous": true,
    "alternatives": ["北京, 重庆市, 中国", "北京, 四川, 中国"]
  }
}
```

同一次查询另经 `curl` 直接核对原始响应（`temperature_2m_min` 22.3、`temperature_2m_max` 31.4、`weather_code` 3 → 阴），与连接器输出一致。`record` 通过 `validateContract('connectorItem')`。

## 已知限制

- **Open-Meteo 不提供预报发布时间**，`occurredAt` 是覆盖日起点而非真实发布时刻，已由 `publishedTimeKind: 'coverage_start'` 显式标注。需要真实发布时间的提供商（如和风天气返回 `forecastStartTime`）可作为第二个 `WeatherProvider` 实现接入，届时标注为 `provider_published`。
- `verification` 为 `conditional` 而非 `verified`：真实读回依赖出站网络可达，且本轮仅验证了北京、上海、纽约等少量地点与当日/近日日期，未做长期或多地点覆盖。
- 预报范围受提供商模式限制（本轮实测允许区间约当日前 3 个月至后 15 天）；超出返回 `NOT_FOUND` 并附提供商给出的允许范围。历史气候查询不属本模块。
- 摘要文本仅提供中英两套；`language` 设为其他值时地名按该语言本地化，但摘要回退英文。
- 地理编码歧义在 `ranked` 模式下仍会选一个结果（已披露但未拒绝）；对准确性要求高的调用方应使用 `strict` 或由上层让用户从 `alternatives` 中选择。
- 日期按地点时区解释，但请求中的 `date` 仍是无时区的日历日字符串；用户本地时区语义待 MOD-13/MOD-20 时区配置确定后接入。
- 缓存为实例内存级，无持久化与跨进程共享；TTL 到期前不感知真实数据更新。地理编码缓存无 TTL，地名变更不会自动刷新。
- 无凭据、无密钥，因此不涉及凭据存储；但真实调用会产生出站请求，Open-Meteo 免费额度（约 600 次/分、10000 次/日）耗尽时返回 `RATE_LIMITED`。
- ConnectorPort 的 `fetchChanges` / `search` / `getItem` / `performAction` 均返回 `UNSUPPORTED_CAPABILITY`：天气为按需查询连接器，非增量同步连接器。
- 未实现 MOD-05 权限隔离，scope 校验目前由 testkit 的 `FakeToolHost` 承担；本包尚未接入 `apps/runtime`（MOD-03）的根装配，装配时需显式传入 `new OpenMeteoProvider()`（归 `goo122`）。
