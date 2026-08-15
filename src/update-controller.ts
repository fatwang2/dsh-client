import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'downloading', version: string, percent?: number }
  | { status: 'downloaded', version: string }
  | { status: 'error', message: string }

export interface UpdateControllerOptions {
  readonly updater: Pick<AppUpdater, 'on' | 'checkForUpdates' | 'autoDownload' | 'autoInstallOnAppQuit'>
  readonly currentVersion: string
  readonly onStateChange: (state: UpdateState) => void
  readonly showUpToDate: (version: string) => Promise<void>
  readonly showError: (message: string) => Promise<void>
  readonly promptToRestart: (version: string) => Promise<boolean>
  readonly installUpdate: () => Promise<void>
  readonly log?: (message: string) => void
}

export interface UpdateController {
  readonly state: UpdateState
  check(manual?: boolean): Promise<void>
  installDownloaded(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Coordinate updater events with application-menu state and the asynchronous quit path. */
export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  let state: UpdateState = { status: 'idle' }
  let manualCheck = false
  let installing = false
  let promptedVersion: string | undefined

  const setState = (next: UpdateState): void => {
    state = next
    options.onStateChange(next)
  }

  const reportError = (error: unknown, showToUser: boolean): void => {
    const message = errorMessage(error)
    setState({ status: 'error', message })
    options.log?.(`update failed: ${message}`)
    if (showToUser) void options.showError(message)
  }

  const installDownloaded = async (): Promise<void> => {
    if (state.status !== 'downloaded' || installing) return
    installing = true
    try {
      await options.installUpdate()
    } catch (error) {
      installing = false
      reportError(error, true)
    }
  }

  options.updater.autoDownload = true
  options.updater.autoInstallOnAppQuit = true

  options.updater.on('checking-for-update', () => {
    setState({ status: 'checking' })
  })
  options.updater.on('update-available', (info: UpdateInfo) => {
    setState({ status: 'downloading', version: info.version })
  })
  options.updater.on('download-progress', (progress: ProgressInfo) => {
    const version = state.status === 'downloading' ? state.version : 'new version'
    setState({ status: 'downloading', version, percent: Math.round(progress.percent) })
  })
  options.updater.on('update-not-available', () => {
    const shouldNotify = manualCheck
    manualCheck = false
    setState({ status: 'idle' })
    if (shouldNotify) void options.showUpToDate(options.currentVersion)
  })
  options.updater.on('error', (error: Error) => {
    const shouldNotify = manualCheck
    manualCheck = false
    reportError(error, shouldNotify)
  })
  options.updater.on('update-downloaded', (info: UpdateInfo) => {
    manualCheck = false
    setState({ status: 'downloaded', version: info.version })
    if (promptedVersion === info.version) return
    promptedVersion = info.version
    void options.promptToRestart(info.version).then((restart) => {
      if (restart) void installDownloaded()
    }).catch((error: unknown) => {
      reportError(error, false)
    })
  })

  return {
    get state() { return state },
    async check(manual = false) {
      if (state.status === 'checking' || state.status === 'downloading') return
      manualCheck ||= manual
      setState({ status: 'checking' })
      try {
        await options.updater.checkForUpdates()
      } catch (error) {
        if (state.status !== 'error') {
          const shouldNotify = manualCheck
          manualCheck = false
          reportError(error, shouldNotify)
        }
      }
    },
    installDownloaded,
  }
}
