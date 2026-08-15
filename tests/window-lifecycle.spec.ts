import { describe, expect, it, vi } from 'vitest'
import { createDesktopLifecycle, type DesktopWindow } from '../src/window-lifecycle.ts'

interface FakeWindow extends DesktopWindow {
  shown: number
  focused: number
  hidden: number
  _destroy(): void
}

function fakeWindow(): FakeWindow {
  let destroyed = false
  let visible = false
  const window = {
    shown: 0,
    focused: 0,
    hidden: 0,
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    show() { visible = true; window.shown += 1 },
    focus() { window.focused += 1 },
    hide() { visible = false; window.hidden += 1 },
    _destroy() { destroyed = true; visible = false },
  }
  return window
}

describe('createDesktopLifecycle', () => {
  it('hides the window instead of closing while not quitting', () => {
    const window = fakeWindow()
    const lifecycle = createDesktopLifecycle({
      getWindow: () => window,
      createWindow: async () => window,
      disposeHost: async () => {},
      quit: () => {},
    })
    const event = { preventDefault: vi.fn() }
    lifecycle.onWindowClose(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.hidden).toBe(1)
  })

  it('lets the close proceed during explicit quit', () => {
    const window = fakeWindow()
    const lifecycle = createDesktopLifecycle({
      getWindow: () => window,
      createWindow: async () => window,
      disposeHost: async () => {},
      quit: () => {},
    })
    void lifecycle.requestQuit()
    const event = { preventDefault: vi.fn() }
    lifecycle.onWindowClose(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('requestQuit disposes the host exactly once, then releases quit', async () => {
    const disposeHost = vi.fn(async () => {})
    const quit = vi.fn()
    const lifecycle = createDesktopLifecycle({
      getWindow: () => undefined,
      createWindow: async () => fakeWindow(),
      disposeHost,
      quit,
    })
    const first = lifecycle.requestQuit()
    const second = lifecycle.requestQuit()
    expect(second).toBe(first)
    await first
    expect(disposeHost).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
    expect(lifecycle.isQuitting).toBe(true)
  })

  it('showWindow creates a replacement window after destruction', async () => {
    const window = fakeWindow()
    const replacement = fakeWindow()
    let current: DesktopWindow = window
    const createWindow = vi.fn(async () => {
      current = replacement
      return replacement
    })
    const lifecycle = createDesktopLifecycle({
      getWindow: () => current,
      createWindow,
      disposeHost: async () => {},
      quit: () => {},
    })
    await lifecycle.showWindow()
    expect(window.shown).toBe(1)
    ;(current as FakeWindow)._destroy()
    await lifecycle.showWindow()
    expect(createWindow).toHaveBeenCalledOnce()
    expect(replacement.shown).toBe(1)
  })
})
