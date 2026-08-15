import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createUpdateController, type UpdateControllerOptions, type UpdateState } from '../src/update-controller.ts'

class FakeUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async () => null)
}

function setup(overrides: Partial<UpdateControllerOptions> = {}) {
  const updater = new FakeUpdater()
  const states: UpdateState[] = []
  const showUpToDate = vi.fn(async () => {})
  const showError = vi.fn(async () => {})
  const promptToRestart = vi.fn(async () => false)
  const installUpdate = vi.fn(async () => {})
  const controller = createUpdateController({
    updater: updater as unknown as UpdateControllerOptions['updater'],
    currentVersion: '0.1.0',
    onStateChange: state => { states.push(state) },
    showUpToDate,
    showError,
    promptToRestart,
    installUpdate,
    ...overrides,
  })
  return { controller, updater, states, showUpToDate, showError, promptToRestart, installUpdate }
}

describe('createUpdateController', () => {
  it('configures background download and install-on-quit', () => {
    const { updater } = setup()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
  })

  it('reports an up-to-date result only for a manual check', async () => {
    const { controller, updater, showUpToDate } = setup()
    await controller.check()
    updater.emit('update-not-available', { version: '0.1.0' })
    expect(showUpToDate).not.toHaveBeenCalled()

    await controller.check(true)
    updater.emit('update-not-available', { version: '0.1.0' })
    expect(showUpToDate).toHaveBeenCalledOnce()
    expect(showUpToDate).toHaveBeenCalledWith('0.1.0')
  })

  it('tracks download progress and installs a downloaded update on request', async () => {
    const { controller, updater, states, installUpdate } = setup()
    updater.emit('update-available', { version: '0.2.0' })
    updater.emit('download-progress', { percent: 42.4 })
    updater.emit('update-downloaded', { version: '0.2.0' })

    expect(states).toContainEqual({ status: 'downloading', version: '0.2.0', percent: 42 })
    expect(controller.state).toEqual({ status: 'downloaded', version: '0.2.0' })
    await controller.installDownloaded()
    expect(installUpdate).toHaveBeenCalledOnce()
  })

  it('prompts once per downloaded version and can restart immediately', async () => {
    const promptToRestart = vi.fn(async () => true)
    const { updater, installUpdate } = setup({ promptToRestart })
    updater.emit('update-downloaded', { version: '0.2.0' })
    updater.emit('update-downloaded', { version: '0.2.0' })

    await vi.waitFor(() => {
      expect(installUpdate).toHaveBeenCalledOnce()
    })
    expect(promptToRestart).toHaveBeenCalledOnce()
  })

  it('shows automatic check failures in menu state without interrupting the user', async () => {
    const { controller, updater, showError } = setup()
    await controller.check()
    updater.emit('error', new Error('offline'))
    expect(controller.state).toEqual({ status: 'error', message: 'offline' })
    expect(showError).not.toHaveBeenCalled()
  })
})
