[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appFile = Join-Path $projectRoot 'frontend/desktop/release-digital-human/win-unpacked/Amadeus.exe'
$profilePath = Join-Path $projectRoot '.runtime/digital-human-profile'
if (-not (Test-Path -LiteralPath $appFile)) { throw "Digital human build missing: $appFile" }
& (Join-Path $PSScriptRoot 'start_amadeus_backend.ps1')
$nodeMode = $env:ELECTRON_RUN_AS_NODE
try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    # The previous installed build may still live in the tray. Use this
    # persistent profile for the integrated build so it opens the correct code.
    $runningPreview = Get-CimInstance Win32_Process -Filter "Name='Amadeus.exe'" |
        Where-Object { $_.ExecutablePath -eq $appFile -and $_.CommandLine -like ('*' + $profilePath + '*') } |
        Select-Object -First 1
    if ($runningPreview) {
        $windowShell = New-Object -ComObject WScript.Shell
        $null = $windowShell.AppActivate([int]$runningPreview.ProcessId)
        Write-Output "Digital human application already running (PID $($runningPreview.ProcessId))."
        return
    }
    $argsForApp = @('--amadeus-realtime', ('"--amadeus-preview-user-data=' + $profilePath + '"'))
    $process = Start-Process -FilePath $appFile -ArgumentList $argsForApp `
        -WorkingDirectory (Split-Path $appFile -Parent) -WindowStyle Normal -PassThru
    Write-Output "Amadeus digital human started (PID $($process.Id))."
} finally {
    if ($null -ne $nodeMode) { $env:ELECTRON_RUN_AS_NODE = $nodeMode }
}
