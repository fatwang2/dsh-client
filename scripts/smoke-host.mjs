/**
 * Smoke-test the staged Host CLI before signing and publishing: spawn the
 * exact staged `dsh web` entry with the same flags the packaged shell uses,
 * wait for its canonical readiness line, validate the line under the same
 * contract the renderer's readiness parser enforces, then terminate the
 * server gracefully.
 *
 * This is the release gate for harness changes that `npm test` cannot see:
 * the tests parse fixed fixture strings, while this script exercises the real
 * staged tree. If an upstream release ever prints a readiness line the shell
 * would reject (or stops printing one), the release fails here instead of
 * shipping a client that cannot boot.
 *
 * Run from the repository root after `node scripts/stage-runtime.mjs`:
 *
 *   node scripts/smoke-host.mjs
 *
 * The Host runs in an isolated temporary HOME and is terminated before the
 * script exits, so it never touches the user's real `~/.dsh`.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const cliEntry = join(root, 'runtime-host/node_modules/@deepseek-ai/dsh/lib/bin.js')
const READINESS_PREFIX = 'dsh web: '
/** Overall budget for the Host to print its readiness line. */
const READINESS_TIMEOUT_MS = 30_000
/** Grace period after SIGTERM before the Host is force-killed. */
const DRAIN_MS = 8_000

/**
 * The window is pointed at whatever the parser accepts, so the accepted shape
 * is deliberately strict: loopback HTTP only, root path, explicit numeric
 * port, no hash, and at most one query parameter — the Host's per-process
 * access `token`. This mirrors src/host-supervisor.ts; keep the two in sync.
 */
function parseReadinessLine(line) {
  if (!line.startsWith(READINESS_PREFIX)) return undefined
  const raw = line.slice(READINESS_PREFIX.length).trim()
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`host readiness URL is invalid: ${raw}`)
  }
  const port = Number(url.port)
  const params = [...url.searchParams.keys()]
  const accessToken = url.searchParams.get('token')
  const queryAccepted = params.length === 0
    || (params.length === 1 && params[0] === 'token' && accessToken !== null && accessToken !== '')
  if (url.protocol !== 'http:'
    || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    || url.pathname !== '/'
    || !queryAccepted
    || url.hash !== ''
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535) {
    throw new Error(`host readiness URL must be loopback HTTP with an explicit port and at most a token query: ${raw}`)
  }
  return url
}

if (!readFileSync(cliEntry, 'utf8')) {
  throw new Error('staged Host CLI not found; run `node scripts/stage-runtime.mjs` first')
}

const workspace = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
const child = spawn(process.execPath, ['--expose-internals', cliEntry, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  cwd: workspace,
  env: { ...process.env, HOME: workspace, DSH_MAC: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let readiness = undefined
let stdoutTail = ''
let stderrTail = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => {
  stdoutTail = (stdoutTail + chunk).slice(-2000)
})
child.stderr.on('data', chunk => {
  stderrTail = (stderrTail + chunk).slice(-2000)
})

/** Resolves with the validated readiness line; rejects on parse failure, early exit, or timeout. */
const readinessPromise = new Promise((resolve, reject) => {
  let buffer = ''
  let settled = false
  const fail = (message) => {
    if (settled) return
    settled = true
    reject(new Error(`${message}\nstdout tail:\n${stdoutTail}\nstderr tail:\n${stderrTail}`))
  }
  child.stdout.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/u, '')
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith(READINESS_PREFIX) || readiness !== undefined) continue
      try {
        readiness = { raw: line, url: parseReadinessLine(line) }
        settled = true
        resolve(readiness)
      } catch (error) {
        settled = true
        reject(error)
      }
    }
  })
  child.once('exit', (code, signal) => {
    fail(`host exited before announcing readiness (code ${String(code)}, signal ${String(signal)})`)
  })
  child.once('error', error => {
    if (!settled) {
      settled = true
      reject(error)
    }
  })
  setTimeout(() => fail(`host did not announce readiness within ${READINESS_TIMEOUT_MS}ms`), READINESS_TIMEOUT_MS).unref()
})

try {
  const ready = await readinessPromise
  console.log(`host readiness verified: ${ready.raw}`)

  child.kill('SIGTERM')
  await new Promise((resolve, reject) => {
    const grace = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('host ignored SIGTERM and was force-killed after the drain period'))
    }, DRAIN_MS)
    grace.unref()
    child.once('exit', (code, signal) => {
      clearTimeout(grace)
      if (code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL') resolve()
      else reject(new Error(`host did not shut down cleanly after readiness (code ${String(code)}, signal ${String(signal)})\nstderr tail:\n${stderrTail}`))
    })
  })
  console.log('smoke test passed: staged host spawned, announced readiness, and shut down cleanly')
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
