const { spawn } = require('node:child_process')
const http = require('node:http')

const url = 'http://localhost:5173'

function waitForVite() {
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => setTimeout(attempt, 500))
      req.setTimeout(1000, () => {
        req.destroy()
        setTimeout(attempt, 500)
      })
    }
    attempt()
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code}`))
    })
  })
}

async function main() {
  await waitForVite()
  await run('npx', ['tsc', '-b', 'tsconfig.node.json', '--force'])

  const electronBin = require('electron')
  const env = { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = spawn(electronBin, ['.'], {
    stdio: 'inherit',
    shell: false,
    env
  })

  electron.on('exit', (code) => process.exit(code ?? 0))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
