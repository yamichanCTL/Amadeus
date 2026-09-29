const path = require('node:path')
const { execFileSync } = require('node:child_process')

module.exports = async (context) => {
  if (context.electronPlatformName !== 'win32') return
  if (process.platform !== 'win32') throw new Error('Build the managed Windows runtime package on Windows.')
  const script = path.resolve(__dirname, '../../../scripts/windows/prepare_runtime.ps1')
  const windows = process.env.SystemRoot || 'C:\\Windows'
  // Node can inherit PowerShell 7's module path; Windows PowerShell needs its own modules.
  const env = { ...process.env, PSModulePath: [
    path.join(windows, 'System32/WindowsPowerShell/v1.0/Modules'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsPowerShell/Modules'),
  ].join(path.delimiter) }
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true, stdio: 'inherit', timeout: 300000, env,
  })
}
