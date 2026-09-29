param([int]$Port = 8000)

$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$backend = Join-Path $project 'backend'
$python = Join-Path $project '.venv\Scripts\python.exe'
$runtime = Join-Path $project '.runtime'
$health = "http://127.0.0.1:$Port/v1/health"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Python environment missing: $python. Run 'uv sync --locked --no-dev' in the project first."
}
try {
    $existing = Invoke-RestMethod -Uri $health -TimeoutSec 2
    if ($existing.status -eq 'ok') {
        Write-Output "Amadeus backend is already running at http://127.0.0.1:$Port"
        return
    }
} catch { }

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$env:CODEX_RUNTIME_DIR = Join-Path $runtime 'codex-local'
$process = Start-Process -FilePath $python `
    -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$Port", '--log-level', 'warning') `
    -WorkingDirectory $backend -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime 'backend.stdout.log') `
    -RedirectStandardError (Join-Path $runtime 'backend.stderr.log') -PassThru

$process.Id | Set-Content -LiteralPath (Join-Path $runtime 'backend.pid')
for ($attempt = 0; $attempt -lt 25; $attempt++) {
    Start-Sleep -Milliseconds 400
    try {
        $result = Invoke-RestMethod -Uri $health -TimeoutSec 2
        if ($result.status -eq 'ok') {
            Write-Output "Amadeus backend ready at http://127.0.0.1:$Port (PID $($process.Id))"
            return
        }
    } catch { }
    if ($process.HasExited) { break }
}
throw "Backend failed to become ready. See $runtime\backend.stderr.log"
