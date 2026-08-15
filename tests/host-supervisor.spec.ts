import { describe, expect, it, vi } from 'vitest'
import { createHostSupervisor, type HostChild } from '../src/host-supervisor.ts'

/** In-memory Host child used to drive supervisor lifecycle in tests. */
function fakeChild(): HostChild & {
  emitData(chunk: string): void
  emitExit(code: number | null, signal: NodeJS.Signals | null): void
  emitError(error: Error): void
  signals: string[]
} {
  const stdoutListeners: Array<(chunk: string) => void> = []
  const stderrListeners: Array<(chunk: string) => void> = []
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const errorListeners: Array<(error: Error) => void> = []
  const signals: string[] = []
  return {
    pid: 4242,
    signals,
    stdout: {
      onData(listener) {
        stdoutListeners.push(listener)
        return () => { /* noop */ }
      },
    },
    stderr: {
      onData(listener) {
        stderrListeners.push(listener)
        return () => { /* noop */ }
      },
    },
    onExit(listener) {
      exitListeners.push(listener)
      return () => { /* noop */ }
    },
    onError(listener) {
      errorListeners.push(listener)
      return () => { /* noop */ }
    },
    kill(signal) {
      signals.push(signal)
    },
    emitData(chunk) { for (const l of stdoutListeners) l(chunk) },
    emitExit(code, signal) { for (const l of exitListeners) l(code, signal) },
    emitError(error) { for (const l of errorListeners) l(error) },
  }
}

describe('createHostSupervisor', () => {
  it('resolves the readiness origin from the child stdout', async () => {
    const child = fakeChild()
    const supervisor = createHostSupervisor({ spawnHost: () => child })
    const startPromise = supervisor.start()
    child.emitData('dsh web: http://127.0.0.1:59273\n')
    await expect(startPromise).resolves.toBe('http://127.0.0.1:59273')
  })

  it('joins concurrent start calls into one start', async () => {
    let spawns = 0
    const child = fakeChild()
    const supervisor = createHostSupervisor({
      spawnHost: () => {
        spawns += 1
        return child
      },
    })
    const first = supervisor.start()
    const second = supervisor.start()
    child.emitData('dsh web: http://127.0.0.1:59273\n')
    await expect(first).resolves.toBe('http://127.0.0.1:59273')
    await expect(second).resolves.toBe('http://127.0.0.1:59273')
    expect(spawns).toBe(1)
  })

  it('rejects when the child exits before readiness', async () => {
    const child = fakeChild()
    const supervisor = createHostSupervisor({ spawnHost: () => child })
    const startPromise = supervisor.start()
    child.emitExit(1, null)
    await expect(startPromise).rejects.toThrow(/exited before readiness/)
  })

  it('fails startup after the readiness timeout and sends SIGTERM', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const supervisor = createHostSupervisor({ spawnHost: () => child, readinessTimeoutMs: 1000 })
      const startPromise = supervisor.start()
      vi.advanceTimersByTime(1001)
      await expect(startPromise).rejects.toThrow(/timed out/)
      expect(child.signals).toContain('SIGTERM')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an unexpected exit after readiness', async () => {
    const child = fakeChild()
    const onUnexpectedExit = vi.fn()
    const supervisor = createHostSupervisor({ spawnHost: () => child, onUnexpectedExit })
    const startPromise = supervisor.start()
    child.emitData('dsh web: http://127.0.0.1:59273\n')
    await startPromise
    child.emitExit(null, 'SIGKILL')
    expect(onUnexpectedExit).toHaveBeenCalledWith({ code: null, signal: 'SIGKILL' })
  })

  it('shutdown sends SIGTERM and waits for exit', async () => {
    const child = fakeChild()
    const supervisor = createHostSupervisor({ spawnHost: () => child })
    const startPromise = supervisor.start()
    child.emitData('dsh web: http://127.0.0.1:59273\n')
    await startPromise
    const shutdownPromise = supervisor.shutdown()
    expect(child.signals).toContain('SIGTERM')
    child.emitExit(0, 'SIGTERM')
    await expect(shutdownPromise).resolves.toBeUndefined()
  })

  it('shutdown escalates to SIGKILL after the grace period', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      const supervisor = createHostSupervisor({ spawnHost: () => child, shutdownTimeoutMs: 500 })
      const startPromise = supervisor.start()
      child.emitData('dsh web: http://127.0.0.1:59273\n')
      await startPromise
      const shutdownPromise = supervisor.shutdown()
      await vi.advanceTimersByTimeAsync(501)
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
      child.emitExit(null, 'SIGKILL')
      await expect(shutdownPromise).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects start after a completed shutdown', async () => {
    const child = fakeChild()
    const supervisor = createHostSupervisor({ spawnHost: () => child })
    const startPromise = supervisor.start()
    child.emitData('dsh web: http://127.0.0.1:59273\n')
    await startPromise
    const shutdownPromise = supervisor.shutdown()
    child.emitExit(0, 'SIGTERM')
    await shutdownPromise
    await expect(supervisor.start()).rejects.toThrow(/cannot start after shutdown/)
  })
})
