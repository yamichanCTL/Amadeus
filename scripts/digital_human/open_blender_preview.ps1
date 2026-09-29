[CmdletBinding()]
param(
    [string]$Blender = 'D:\steam\steam\steamapps\common\Blender\blender.exe',
    [string]$Preview = (Join-Path $PSScriptRoot '../../assets/digital_human/aemeath/v03/Aemeath_DigitalHuman_v03.blend')
)

$ErrorActionPreference = 'Stop'
$previewFile = (Resolve-Path -LiteralPath $Preview).Path
if (-not (Test-Path -LiteralPath $Blender -PathType Leaf)) {
    throw 'Blender executable not found; provide its location with -Blender.'
}
# A visible Blender window is intentional: this command opens an editable review.
$previewProcess = Start-Process -FilePath $Blender -ArgumentList @('--disable-autoexec', ('"' + $previewFile + '"')) -WindowStyle Normal -PassThru
Write-Output "Opened Blender process $($previewProcess.Id): $previewFile"
