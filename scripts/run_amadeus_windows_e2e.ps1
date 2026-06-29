param(
    [string]$AppPath = "",
    [int]$TimeoutSeconds = 75
)

$ErrorActionPreference = "Stop"

if (-not $AppPath) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $AppPath = Join-Path $repoRoot "frontend\desktop\release\win-unpacked\Amadeus.exe"
}

if (-not (Test-Path $AppPath)) {
    throw "找不到 Amadeus.exe：$AppPath。请先在 frontend/desktop 运行 electron-builder --win dir。"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$testRoot = Join-Path $env:TEMP "amadeus-e2e-$stamp"
$appDir = Join-Path $testRoot "app"
$userData = Join-Path $testRoot "userData"
New-Item -ItemType Directory -Force -Path $testRoot, $userData | Out-Null
Copy-Item -Path (Split-Path -Parent $AppPath) -Destination $appDir -Recurse

$testExe = Join-Path $appDir "Amadeus.exe"
$arguments = @(
    "--amadeus-e2e",
    "--user-data-dir=$userData",
    "--amadeus-e2e-user-data=$userData",
    "--enable-logging=stderr"
)
$stdoutPath = Join-Path $testRoot "electron.stdout.log"
$stderrPath = Join-Path $testRoot "electron.stderr.log"

Write-Host "启动 Windows Amadeus E2E：$testExe"
$process = Start-Process -FilePath $testExe -ArgumentList $arguments -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Amadeus E2E 超过 $TimeoutSeconds 秒未退出。"
}

$resultPath = Join-Path $userData "e2e\result.json"
$fatalPath = Join-Path $userData "e2e\fatal.json"
if (Test-Path $fatalPath) {
    Get-Content $fatalPath -Raw -Encoding UTF8 | Write-Host
    throw "Amadeus E2E 主流程异常，详见 $fatalPath"
}
if (-not (Test-Path $resultPath)) {
    throw "Amadeus E2E 未生成结果：$resultPath"
}

$result = Get-Content $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
Get-Content $resultPath -Raw -Encoding UTF8 | Write-Host
Write-Host "截图与音频指标目录：$(Split-Path -Parent $resultPath)"
if (-not $result.passed) {
    if (Test-Path $stdoutPath) {
        Write-Host "Electron stdout："
        Get-Content $stdoutPath -Raw -Encoding UTF8 | Write-Host
    }
    if (Test-Path $stderrPath) {
        Write-Host "Electron stderr："
        Get-Content $stderrPath -Raw -Encoding UTF8 | Write-Host
    }
    exit 1
}
exit 0
