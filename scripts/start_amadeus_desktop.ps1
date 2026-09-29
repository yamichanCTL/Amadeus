param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$desktop = Join-Path $project 'frontend\desktop'
$runtime = Join-Path $project '.runtime'
$node = (Get-Command node -ErrorAction Stop).Source
$packagedApp = Join-Path $desktop 'release-integrated\win-unpacked\Amadeus.exe'

if (-not $SkipBuild) {
    Push-Location $desktop
    try {
        & $node node_modules/typescript/bin/tsc --noEmit
        if ($LASTEXITCODE -ne 0) { throw 'Desktop type check failed' }
        & $node node_modules/vite/bin/vite.js build
        if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
        & $node node_modules/typescript/bin/tsc -p tsconfig.node.json
        if ($LASTEXITCODE -ne 0) { throw 'Electron build failed' }
        # Reuse the installed Electron runtime. Preserve earlier release folders.
        $electronDist = Join-Path $desktop 'node_modules\electron\dist'
        $branding = 'electron'
        if (-not (Test-Path -LiteralPath (Join-Path $electronDist 'electron.exe'))) {
            $electronDist = Join-Path $desktop 'release-ready\win-unpacked'
            if (Test-Path -LiteralPath (Join-Path $electronDist 'Amadeus.exe')) {
                # Use a clean runtime, without the previous application bundle.
                $runtimeCopy = Join-Path $runtime 'electron-runtime'
                & $node -e "const fs=require('node:fs'),p=require('node:path');fs.cpSync(process.argv[1],process.argv[2],{recursive:true,filter:s=>p.basename(s)!=='app.asar'});" $electronDist $runtimeCopy
                if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare existing Electron runtime' }
                # electron-builder 24 treats non-electron framework branding as
                # a non-Electron app and puts the bundle in the wrong directory.
                Move-Item -LiteralPath (Join-Path $runtimeCopy 'Amadeus.exe') -Destination (Join-Path $runtimeCopy 'electron.exe') -Force
                $electronDist = $runtimeCopy
            }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $electronDist "$branding.exe"))) {
            throw 'No installed Electron runtime. Run npm ci in frontend/desktop first.'
        }
        $outputPath = [IO.Path]::GetFullPath((Join-Path $desktop 'release-integrated'))
        if (-not $outputPath.StartsWith($desktop + '\')) { throw 'Unexpected build output path' }
        & $node node_modules/electron-builder/cli.js --dir --win `
            "--config.electronDist=$electronDist" "--config.electronBranding.projectName=$branding" `
            --config.directories.output=release-integrated --config.npmRebuild=false
        if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed' }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $packagedApp)) {
    throw 'No built desktop app was found; run again without -SkipBuild.'
}

& (Join-Path $PSScriptRoot 'start_amadeus_backend.ps1')
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$nodeMode = $env:ELECTRON_RUN_AS_NODE
$devUrl = $env:VITE_DEV_SERVER_URL
try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item Env:VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $packagedApp `
        -WorkingDirectory (Split-Path $packagedApp -Parent) -WindowStyle Normal `
        -RedirectStandardOutput (Join-Path $runtime 'desktop.stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'desktop.stderr.log') -PassThru
    Write-Output "Amadeus desktop started (PID $($process.Id)); backend http://127.0.0.1:8000"
} finally {
    if ($null -ne $nodeMode) { $env:ELECTRON_RUN_AS_NODE = $nodeMode }
    if ($null -ne $devUrl) { $env:VITE_DEV_SERVER_URL = $devUrl }
}
