param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$destination = Join-Path $project '.runtime/windows-bootstrap'
$version = '0.10.4'
$expectedHash = '0f0e22d7507633bfb38d9b42fb6a0341f1f74b8e80b070a31231c354812432a3'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$archive = Join-Path $destination "uv-$version.zip"
if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    Write-Output "Downloading the pinned Windows runtime installer (uv $version)..."
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/astral-sh/uv/releases/download/$version/uv-x86_64-pc-windows-msvc.zip" -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'uv archive SHA256 verification failed. The runtime was not packaged.'
}
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $destination "extracted-$version") -Force
$executable = Get-ChildItem -LiteralPath (Join-Path $destination "extracted-$version") -Recurse -Filter uv.exe | Select-Object -First 1
if (!$executable) { throw 'uv.exe missing from the verified archive' }
Copy-Item -LiteralPath $executable.FullName -Destination (Join-Path $destination 'uv.exe') -Force
foreach ($license in @('LICENSE-APACHE', 'LICENSE-MIT')) {
    $licensePath = Join-Path $destination $license
    if (!(Test-Path -LiteralPath $licensePath)) {
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/astral-sh/uv/$version/$license" -OutFile $licensePath
    }
}
@{ version = $version; archiveSha256 = $expectedHash; source = "https://github.com/astral-sh/uv/releases/tag/$version" } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'manifest.json') -Encoding UTF8
Write-Output 'Windows runtime installer ready; no machine-wide Python or PATH changes.'
