param(
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$resources = Get-Content -LiteralPath $BackupPath | ForEach-Object { $_ | ConvertFrom-Json -Depth 100 }
$world = $resources | Where-Object { $_.resource_type -eq 'workflow' -and $_.resource_level -eq 1 -and $_.resource_name -eq 'PA-世界状态影响分析' }
$nodes = @($world.dsl.nodes | Where-Object type -eq 'Code')
if ($nodes.Count -ne 1) { throw 'Expected one deterministic routing node.' }
$code = $nodes[0].configs.code
$anchor = '        return {"route": "review", "text_result": ""}'
$replacement = @'
        if isinstance(result, dict) and set(result) == {"recipeId", "exitCode", "passed"}:
            recipes = {"node-check": "语法检查", "npm-build": "构建", "npm-test": "测试"}
            recipe = result["recipeId"]
            exit_code = result["exitCode"]
            passed = result["passed"]
            if (not isinstance(recipe, str) or recipe not in recipes
                    or not is_json_int(exit_code) or not isinstance(passed, bool)
                    or passed != (exit_code == 0)):
                return direct_text("已确认命令结果格式不一致，无法报告通过。")
            verdict = "通过" if passed else "未通过"
            return direct_text("本地宿主确认的" + recipes[recipe] + verdict + "，退出码 " + str(exit_code) + "。")
        return {"route": "review", "text_result": ""}
'@
if (($code.Split(@($anchor), [StringSplitOptions]::None)).Count -ne 3) {
  throw 'Expected continuation and initial-request review routes.'
}
# Only the continuation return is replaced; catalog validation and repair guards stay intact.
$position = $code.IndexOf($anchor, [StringComparison]::Ordinal)
$code = $code.Substring(0, $position) + $replacement + $code.Substring($position + $anchor.Length)
$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) { New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null }
$code | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output ([pscustomobject]@{ file = $OutputPath; length = $code.Length; modelCallsForRecipeContinuation = 0 })
