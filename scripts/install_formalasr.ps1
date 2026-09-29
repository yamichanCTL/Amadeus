param([switch]$CpuOnly)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$python = Join-Path $project '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    throw "Create the backend environment first: uv venv --python 3.12 .venv"
}

Push-Location $project
try {
    # CUDA 12.8 wheels support RTX 50-series GPUs. Keep the existing environment.
    $torchIndex = if ($CpuOnly) { 'https://download.pytorch.org/whl/cpu' } else { 'https://download.pytorch.org/whl/cu128' }
    & uv pip install --python $python torch torchaudio --index-url $torchIndex --upgrade-package torch --upgrade-package torchaudio
    if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
    & uv pip install --python $python -e '.[formalasr]'
    if ($LASTEXITCODE -ne 0) { throw 'FormalASR runtime installation failed.' }
    & $python (Join-Path $PSScriptRoot 'download_formalasr.py')
    if ($LASTEXITCODE -ne 0) { throw 'FormalASR model download failed; rerun to resume.' }
    Write-Output 'FormalASR-1.7B installed. Restart the backend, then load it in Model Management.'
    if ($CpuOnly) { Write-Output 'For CPU inference, select device=cpu and dtype=float32.' }
} finally {
    Pop-Location
}
