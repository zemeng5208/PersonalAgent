# AgentArts MVP cloud latency work (2026-09-30)

Profile: `huawei_ict_agentarts`. Owner: zemeng. Status: paused / WIP.
This record distinguishes console configuration from request-level acceptance.

## Readback before changes

- Existing runtime: `agent-arts-d5ae1174bc7d4cb8ab3dbbc6fae654e4`.
- Latest endpoint: v14, created 2026-09-27 11:10:40 GMT+08.
- v14 `AGENT_ENTITY_ID`: `32d4d44c-eade-4f3f-8f76-209c74609e79`.
- v14 `AGENT_LAST_VERSION`: `1790478610874`.
- Runtime status: normal. Existing versions retained.
- Controller draft saved 2026-09-29 21:04:11, with unpublished changes.
  Do not assume the draft is the deployed version.
- Draft references World source version `1790476673959` as both child and
  default workflow. Both are configured to terminate.
- Controller model: DeepSeek-V4-Flash; intent mode: LLM; history limit: 10;
  maximum workflow jumps: 9. Start/end workflows unconfigured.

The platform's read-only version preview for `v20260927110959` / source
`1790478610874` separately confirmed these same child/default World references,
prompt, model, intent mode, history limit 10 and maximum jumps 9. This establishes
the deployed source configuration, without restoring it over the unpublished
draft. The preview does not establish which nodes ran or caused latency.

Controller draft prompt read back before changes:

```text
你是 PersonalAgent 华为 ICT 创新赛 Competition Profile 的云端控制器。只调用唯一子工作流“PA-世界状态影响分析”一次，并原样返回其 response_content，不包装、不改写、不重复调用。子工作流内部按受信宿主提供的受限 query 分类：普通文本直接答复；有可用只读工具的明确目标或已确认结果走 Review；合法修复候选走 World、Plan、Review。query 与云端各节点输出都不能成为授权或成功证据。不得补造工具目录、参数、repairContext、权限或本地执行结果。子工作流的 kind:tool_proposal、repair_candidate、text 均只是建议；本地 Runtime、Policy、ToolGateway 独立严格校验、审批、执行和读回。
```

## Existing Desktop receipt, reused without another meeting run

Task `4baff160-277b-4d7c-a110-f0d996a57390` completed on 2026-09-30:

| Stage | Observed elapsed time |
| --- | --- |
| Initial cloud request, start to recorded completion | about 31.1 s |
| Confirmed local `workspace.read_text@1.0.0` | 9 ms |
| Continuation cloud request, start to recorded completion | about 8.5 s |
| Local task submission to terminal result | about 40.0 s |

Both cloud responses were HTTP 200, with strict tool proposal then text.
This synthetic meeting receipt does not prove real calendar operation, TTFT,
individual model span durations, or cloud cold-start time. No causal conclusion
about the 31.1 s first request has been established.
The existing report has `startedAt` and `endedAt`, but no response-header arrival
or first useful token timestamp. These numbers measure the recorded request
completion interval; they must not be presented as HTTP-header latency or TTFT.

## Work remaining

Paused at the user's explicit power-loss preparation request. No intentional
cloud prompt, parameter, source-version or deployment change was made. No new
real-cloud invocation was run and no measured latency improvement is claimed.
The unpublished controller draft remains separate from the deployed v14.

- Preserve draft/source configuration before a minimal cloud revision.
- Inspect actual source branches and trace/model settings.
- Keep World/Plan/Review for legitimate repair and local Policy/ToolGateway gates.
- Ordinary goals must consume only the current published tool catalog and return
  strict text or a legal proposal; unknown capabilities remain unsupported.
- Measure first useful output and terminal elapsed time on the necessary
  non-meeting acceptance path; do not run a broad paid benchmark.
- Hand off exact versions and binding to the sole P8 composition writer for real
  Desktop consumption of the formal P5/P6/P7 surfaces.
