/**
 * Supervise the loopback `dsh web` host process.
 *
 * The host is spawned on an OS-assigned loopback port (`--port 0`) and
 * announces its readiness on stdout with the canonical line
 * `dsh web: http://127.0.0.1:<port>`. The supervisor owns the whole child
 * lifecycle: startup (with a bounded readiness timeout), graceful shutdown
 * (SIGTERM, then SIGKILL after a bounded grace period matching the harness'
 * 5s drain), and unexpected-exit reporting.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

const READINESS_PREFIX = 'dsh web: '
const DEFAULT_READINESS_TIMEOUT_MS = 90_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const MAX_STARTUP_OUTPUT_CHARS = 32_768

/** Incremental parser for the Web Host's canonical readiness line. */
export interface ReadinessParser {
  /**
   * Consume one stdout chunk.
   * @param chunk - Text emitted by the Host.
   * @returns The loopback origin once a complete readiness line is observed.
   */
  push(chunk: string): string | undefined
  /**
   * Finish the stream and require a readiness line.
   * @returns The parsed loopback origin.
   */
  finalize(): string
}

/**
 * Assert and normalize one readiness line.
 *
 * The webview will be pointed at whatever this returns, so the accepted
 * shape is deliberately strict: loopback HTTP only, root path, explicit
 * numeric port, no query or hash.
 */
function parseReadinessLine(line: string): string | undefined {
  if (!line.startsWith(READINESS_PREFIX)) return undefined
  const token = line.slice(READINESS_PREFIX.length).split(/\s/u, 1)[0]
  if (token === undefined) throw new Error(`host readiness line has no URL: ${line}`)

  let url: URL
  try {
    url = new URL(token)
  } catch {
    throw new Error(`host readiness URL is invalid: ${token}`)
  }
  const port = Number(url.port)
  if (url.protocol !== 'http:'
    || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535) {
    throw new Error(`host readiness URL must be loopback HTTP with an explicit port: ${token}`)
  }
  return url.origin
}

/**
 * Create a line parser whose result is stable after readiness.
 * @returns A fresh incremental parser.
 */
export function createReadinessParser(): ReadinessParser {
  let pending = ''
  let readyUrl: string | undefined

  const accept = (line: string): string | undefined => {
    const parsed = parseReadinessLine(line.replace(/\r$/u, ''))
    if (parsed === undefined) return undefined
    if (readyUrl !== undefined && parsed !== readyUrl) {
      throw new Error(`host emitted conflicting readiness URLs: ${readyUrl} and ${parsed}`)
    }
    readyUrl = parsed
    return readyUrl
  }

  return {
    push(chunk) {
      pending += chunk
      for (;;) {
        const newline = pending.indexOf('\n')
        if (newline === -1) return readyUrl
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        const parsed = accept(line)
        if (parsed !== undefined) return parsed
      }
    },
    finalize() {
      if (pending !== '') accept(pending)
      if (readyUrl === undefined) throw new Error('host exited before emitting its readiness URL')
      return readyUrl
    },
  }
}

/** Child process operations the supervisor owns. */
export interface HostChild {
  readonly pid?: number
  readonly stdout: { onData(listener: (chunk: string) => void): () => void }
  readonly stderr: { onData(listener: (chunk: string) => void): () => void }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void
  onError(listener: (error: Error) => void): () => void
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
}

/** Configuration and platform operations for one Host supervisor. */
export interface HostSupervisorOptions {
  /** Spawn one Host process. */
  readonly spawnHost: () => HostChild
  /** Maximum startup time before the Host is terminated. */
  readonly readinessTimeoutMs?: number
  /** Grace after SIGTERM before SIGKILL. */
  readonly shutdownTimeoutMs?: number
  /** Receives bounded Host output for desktop diagnostics. */
  readonly log?: (line: string) => void
  /** Called when a ready Host exits outside an application-owned shutdown. */
  readonly onUnexpectedExit?: (detail: { code: number | null, signal: NodeJS.Signals | null }) => void
}

/** Handle for the desktop-owned Host process. */
export interface HostSupervisor {
  /** Start once, or join the in-flight start. */
  start(): Promise<string>
  /** Gracefully stop once, escalating after the configured timeout. */
  shutdown(): Promise<void>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

/**
 * Create a single-owner Host supervisor.
 *
 * Concurrent `start()` calls join the same in-flight start; concurrent
 * `shutdown()` calls join the same in-flight shutdown. A process that exits
 * on its own after readiness is reported through `onUnexpectedExit`, because
 * the shell must never keep showing a window to a dead host.
 */
export function createHostSupervisor(options: HostSupervisorOptions): HostSupervisor {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  let child: HostChild | undefined
  let startPromise: Promise<string> | undefined
  let shutdownPromise: Promise<void> | undefined
  let exited: Promise<void> | undefined
  let exitResult: Deferred<void> | undefined
  let ready = false
  let shuttingDown = false
  let output = ''

  const appendOutput = (chunk: string): void => {
    output = `${output}${chunk}`.slice(-MAX_STARTUP_OUTPUT_CHARS)
    options.log?.(chunk)
  }

  const start = (): Promise<string> => {
    if (shutdownPromise !== undefined) return Promise.reject(new Error('host cannot start after shutdown'))
    if (startPromise !== undefined) return startPromise

    startPromise = new Promise<string>((resolve, reject) => {
      const parser = createReadinessParser()
      const spawned = options.spawnHost()
      child = spawned
      exitResult = deferred<void>()
      exited = exitResult.promise
      let settled = false
      const startupCleanups: Array<() => void> = []

      const cleanupStartup = (): void => {
        clearTimeout(timer)
        for (const dispose of startupCleanups.splice(0)) dispose()
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanupStartup()
        const diagnostic = output === '' ? '' : `\nHost output:\n${output}`
        reject(new Error(`${error instanceof Error ? error.message : String(error)}${diagnostic}`))
      }
      const acceptChunk = (chunk: string): void => {
        appendOutput(chunk)
        try {
          const url = parser.push(chunk)
          if (url === undefined || settled) return
          settled = true
          ready = true
          cleanupStartup()
          resolve(url)
        } catch (error) {
          fail(error)
          spawned.kill('SIGTERM')
        }
      }

      const timer = setTimeout(() => {
        fail(new Error(`host readiness timed out after ${String(readinessTimeoutMs)}ms`))
        spawned.kill('SIGTERM')
      }, readinessTimeoutMs)
      startupCleanups.push(spawned.stdout.onData(acceptChunk))
      startupCleanups.push(spawned.stderr.onData(appendOutput))
      spawned.onError((error) => {
        fail(new Error(`host failed to spawn: ${error.message}`))
        exitResult?.resolve()
      })
      spawned.onExit((code, signal) => {
        exitResult?.resolve()
        if (ready) {
          if (!shuttingDown) options.onUnexpectedExit?.({ code, signal })
          return
        }
        fail(new Error(`host exited before readiness (code ${String(code)}, signal ${String(signal)})`))
      })
    })
    return startPromise
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      const spawned = child
      if (spawned === undefined) return
      shuttingDown = true
      spawned.kill('SIGTERM')
      const closed = exited ?? Promise.resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        closed.then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout')
          }, shutdownTimeoutMs)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      if (outcome === 'timeout') {
        spawned.kill('SIGKILL')
        await closed
      }
    })()
    return shutdownPromise
  }

  return { start, shutdown }
}

/** Options for the real `dsh web` child. */
export interface SpawnDshWebOptions {
  /** Node-compatible executable selected by the desktop app. */
  readonly nodeExecutable: string
  /** Built dsh CLI entry. */
  readonly cliEntry: string
  /** Working directory inherited by user-created sessions and tools. */
  readonly cwd: string
  /** Frozen environment for the Host process. */
  readonly env: NodeJS.ProcessEnv
  /** Run the Electron executable as its bundled Node runtime. */
  readonly electronRunAsNode?: boolean
}

function streamAdapter(stream: NodeJS.ReadableStream): HostChild['stdout'] {
  return {
    onData(listener) {
      const accept = (chunk: string | Buffer): void => { listener(chunk.toString()) }
      stream.on('data', accept)
      return () => { stream.off('data', accept) }
    },
  }
}

/**
 * Spawn the production Web Host on an OS-assigned loopback port.
 *
 * The `--expose-internals` flag matches the harness' own deployment guidance
 * for Electron-carried Node runtimes; it is harmless for a real Node binary.
 */
export function spawnDshWeb(options: SpawnDshWebOptions): HostChild {
  const env = options.electronRunAsNode
    ? { ...options.env, ELECTRON_RUN_AS_NODE: '1' }
    : options.env
  const child = spawn(options.nodeExecutable, ['--expose-internals', options.cliEntry, 'web', '--host', '127.0.0.1', '--port', '0'], {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return nodeChildAdapter(child)
}

/** Adapt Node's event overloads to the supervisor's explicit ownership API. */
function nodeChildAdapter(child: ChildProcessByStdio<null, Readable, Readable>): HostChild {
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    stdout: streamAdapter(child.stdout),
    stderr: streamAdapter(child.stderr),
    onExit(listener) {
      child.on('exit', listener)
      return () => { child.off('exit', listener) }
    },
    onError(listener) {
      child.on('error', listener)
      return () => { child.off('error', listener) }
    },
    kill(signal) {
      child.kill(signal)
    },
  }
}
