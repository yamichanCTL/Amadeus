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

# Visual proof for the two Windows-shell-specific requirements that renderer
# screenshots cannot cover: the initial work-area bounds and taskbar/exe icon.
$visualUserData = Join-Path $testRoot "visual-userData"
$visualEvidenceDir = Join-Path $testRoot "visual-evidence"
$taskbarScreenshot = Join-Path $visualEvidenceDir "windows-taskbar.png"
$taskbarCropPath = Join-Path $visualEvidenceDir "windows-taskbar-crop.png"
$associatedIconPath = Join-Path $visualEvidenceDir "amadeus-associated-icon.png"
$visualReportPath = Join-Path $visualEvidenceDir "visual-evidence.json"
New-Item -ItemType Directory -Force -Path $visualUserData, $visualEvidenceDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$associatedIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($testExe)
if (-not $associatedIcon) {
    throw "无法从最终 Amadeus.exe 提取关联图标"
}
$associatedBitmap = $associatedIcon.ToBitmap()
try {
    $associatedBitmap.Save($associatedIconPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $associatedBitmap.Dispose()
    $associatedIcon.Dispose()
}

$visualProcess = $null
try {
    $visualProcess = Start-Process -FilePath $testExe -ArgumentList @(
        "--user-data-dir=$visualUserData",
        "--enable-logging=stderr"
    ) -PassThru
    Start-Sleep -Seconds 4

    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point ([Math]::Floor($bounds.Width / 2)), ($bounds.Bottom - 1)
    [System.Windows.Forms.SendKeys]::SendWait("^{ESC}")
    Start-Sleep -Seconds 2
    $screenBitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($screenBitmap)
    try {
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $screenBitmap.Save($taskbarScreenshot, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $screenBitmap.Dispose()
    }

    $taskbarHeight = [Math]::Min(120, $bounds.Height)
    $taskbarBitmap = New-Object System.Drawing.Bitmap $bounds.Width, $taskbarHeight
    $taskbarGraphics = [System.Drawing.Graphics]::FromImage($taskbarBitmap)
    try {
        $taskbarGraphics.CopyFromScreen(
            (New-Object System.Drawing.Point $bounds.Left, ($bounds.Bottom - $taskbarHeight)),
            [System.Drawing.Point]::Empty,
            (New-Object System.Drawing.Size $bounds.Width, $taskbarHeight)
        )
        $taskbarBitmap.Save($taskbarCropPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $taskbarGraphics.Dispose()
        $taskbarBitmap.Dispose()
    }

    @{
        exe = $testExe
        processId = $visualProcess.Id
        screen = @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
        workArea = @{ x = $workArea.X; y = $workArea.Y; width = $workArea.Width; height = $workArea.Height }
        taskbarScreenshot = $taskbarScreenshot
        taskbarCrop = $taskbarCropPath
        associatedIcon = $associatedIconPath
    } | ConvertTo-Json -Depth 4 | Set-Content -Path $visualReportPath -Encoding UTF8
} finally {
    if ($visualProcess -and -not $visualProcess.HasExited) {
        Stop-Process -Id $visualProcess.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Windows 任务栏截图：$taskbarScreenshot"
Write-Host "Windows 任务栏原始裁剪：$taskbarCropPath"
Write-Host "Amadeus EXE 关联图标：$associatedIconPath"
exit 0
