/** Electron application shell for the loopback DeepSeek Harness Web Host. */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  session,
  shell,
  type Event,
  type MenuItemConstructorOptions,
} from 'electron'
import updaterPackage from 'electron-updater'
import { createHostSupervisor, spawnDshWeb, type HostSupervisor } from './host-supervisor.ts'
import { createUpdateController, type UpdateController, type UpdateState } from './update-controller.ts'
import { createDesktopLifecycle, type DesktopLifecycle } from './window-lifecycle.ts'

const { autoUpdater } = updaterPackage

const APP_NAME = 'DeepSeek Harness'
const LEGACY_USER_DATA_DIRECTORY = 'dsh-mac'
const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 920
const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(DESKTOP_DIR, '..')

// The npm project is now dsh-client, but existing installs already store
// sessions and settings under dsh-mac. Keep that location stable across the
// repository rename instead of presenting users with an empty profile.
app.setPath('userData', join(app.getPath('appData'), LEGACY_USER_DATA_DIRECTORY))

let mainWindow: BrowserWindow | undefined
let host: HostSupervisor | undefined
let lifecycle: DesktopLifecycle | undefined
let hostOrigin: string | undefined
let bootQuitPromise: Promise<void> | undefined
let quitReleased = false
let installUpdateOnQuit = false
let updateController: UpdateController | undefined

/** Resolve artifacts from the checkout in development and resourcesPath when packaged. */
function hostPaths(): { nodeExecutable: string, cliEntry: string, cwd: string, electronRunAsNode: boolean } {
  if (!app.isPackaged) {
    return {
      nodeExecutable: process.env.DSH_MAC_NODE_EXECUTABLE ?? 'node',
      cliEntry: join(REPOSITORY_ROOT, 'runtime-host/node_modules/@deepseek-ai/dsh/lib/bin.js'),
      cwd: process.cwd(),
      electronRunAsNode: false,
    }
  }
  return {
    nodeExecutable: process.execPath,
    cliEntry: join(process.resourcesPath, 'host/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    cwd: app.getPath('home'),
    electronRunAsNode: true,
  }
}

function assertHostArtifacts(paths: ReturnType<typeof hostPaths>): void {
  if (paths.nodeExecutable.includes('/') && !existsSync(paths.nodeExecutable)) {
    throw new Error(`host Node runtime is missing: ${paths.nodeExecutable}`)
  }
  if (!existsSync(paths.cliEntry)) {
    throw new Error(`host CLI entry is missing: ${paths.cliEntry}; run \`npm run stage\` first`)
  }
}

/**
 * Host environment: pass the user environment through, tag the process, and
 * optionally confine the harness state to an app-owned directory instead of
 * the shared `~/.dsh`.
 */
function hostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_MAC: '1' }
  if (process.env.DSH_MAC_OWN_HOME === '1') {
    env.DSH_HOME = join(app.getPath('userData'), 'dsh-home')
  }
  return env
}

function isExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function hasOrigin(raw: string, expected: string): boolean {
  try {
    return new URL(raw).origin === expected
  } catch {
    return false
  }
}

/** Install navigation and permission policy before the first renderer loads. */
function hardenSession(): void {
  const desktopSession = session.defaultSession
  desktopSession.setPermissionCheckHandler(() => false)
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })
}

/**
 * Reserve the macOS traffic-light strip inside the sidebar and restore the
 * native window drag affordance removed by the frameless `hiddenInset` shell.
 * The shipped harness frontend is unaware of the desktop chrome, so its logo
 * row would otherwise sit under the close/minimize/zoom buttons and the empty
 * top edge would not move the window. The layout column uses a css-module hash;
 * the substring attribute selector keeps working across hash changes.
 */
const TRAFFIC_LIGHT_INSET_CSS = `
[class*="sidebarCol"] {
  padding-top: 40px !important;
}

body::before {
  content: "";
  position: fixed;
  inset: 0 0 auto;
  height: 40px;
  -webkit-app-region: drag;
}

a,
button,
input,
textarea,
select,
[role="button"],
[contenteditable]:not([contenteditable="false"]) {
  -webkit-app-region: no-drag;
}
`

async function createMainWindow(): Promise<BrowserWindow> {
  const origin = hostOrigin
  if (origin === undefined) throw new Error('host is not ready')
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    frame: process.platform === 'win32',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7f858f',
        height: 44,
      },
    }),
    ...(process.platform === 'darwin' ? {
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      visualEffectState: 'followWindow' as const,
    } : {}),
    ...(process.platform === 'win32' ? {
      backgroundMaterial: 'acrylic' as const,
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    } : {
      transparent: true,
      backgroundColor: '#00000000',
    }),
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  mainWindow = window
  window.on('close', (event) => { lifecycle?.onWindowClose(event) })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (hasOrigin(url, origin)) return
    event.preventDefault()
    if (isExternalUrl(url)) void shell.openExternal(url)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const rendererUrl = new URL(origin)
  rendererUrl.searchParams.set('dsh-mac-platform', process.platform)
  if (process.platform === 'darwin') {
    // Queue the inset for the first document without awaiting: awaiting
    // insertCSS before the renderer has committed a document can leave the
    // promise pending forever and stall the boot sequence. dom-ready
    // re-injection makes the inset survive document reloads; duplicate
    // style rules are idempotent.
    const injectInset = (): void => {
      window.webContents.insertCSS(TRAFFIC_LIGHT_INSET_CSS).catch((error: unknown) => {
        console.error('traffic-light inset CSS failed:', error)
      })
    }
    injectInset()
    window.webContents.on('dom-ready', injectInset)
  }
  await window.loadURL(rendererUrl.href)
  if (!lifecycle?.isQuitting) window.show()
  return window
}

function updateMenuItem(state: UpdateState): MenuItemConstructorOptions {
  switch (state.status) {
    case 'checking':
      return { label: '正在检查更新…', enabled: false }
    case 'downloading': {
      const progress = state.percent === undefined ? '' : ` ${state.percent}%`
      return { label: `正在下载 ${APP_NAME} ${state.version}${progress}…`, enabled: false }
    }
    case 'downloaded':
      return {
        label: `重启并安装 ${APP_NAME} ${state.version}`,
        click: () => { void updateController?.installDownloaded() },
      }
    case 'idle':
    case 'error':
      return { label: '检查更新…', click: () => { void updateController?.check(true) } }
  }
}

function unavailableUpdateMenuItem(): MenuItemConstructorOptions {
  return {
    label: '检查更新…',
    click: () => {
      void dialog.showMessageBox({
        type: 'info',
        title: '无法检查更新',
        message: '开发模式不检查应用更新。',
        detail: '请使用打包后的 DeepSeek Harness 从 GitHub Releases 检查更新。',
      })
    },
  }
}

function rebuildApplicationMenu(): void {
  const updateItem = updateController === undefined
    ? unavailableUpdateMenuItem()
    : updateMenuItem(updateController.state)
  const updateItems: MenuItemConstructorOptions[] = [updateItem, { type: 'separator' }]
  const template: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
        {
          label: APP_NAME,
          submenu: [
            { label: `关于 ${APP_NAME}`, role: 'about' },
            { type: 'separator' },
            ...updateItems,
            { role: 'services' },
            { type: 'separator' },
            { label: `隐藏 ${APP_NAME}`, role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { label: `退出 ${APP_NAME}`, role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]
    : [
        {
          label: 'File',
          submenu: [
            ...updateItems,
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function initializeUpdates(): void {
  if (!app.isPackaged || process.platform !== 'darwin') return

  autoUpdater.logger = console
  updateController = createUpdateController({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    onStateChange: rebuildApplicationMenu,
    showUpToDate: async (version) => {
      await dialog.showMessageBox({
        type: 'info',
        title: `${APP_NAME} 更新`,
        message: `${APP_NAME} ${version} 已是最新版本。`,
      })
    },
    showError: async (message) => {
      const noPublishedRelease = message.includes('No published versions on GitHub')
      await dialog.showMessageBox({
        type: noPublishedRelease ? 'info' : 'error',
        title: noPublishedRelease ? '暂无正式版本' : '无法检查更新',
        message: noPublishedRelease ? '当前还没有可用的正式发布版本。' : message,
        ...(noPublishedRelease ? {
          detail: '发布首个 GitHub Release 后，此处会自动比较并下载新版本。',
        } : {}),
      })
    },
    promptToRestart: async (version) => {
      const result = await dialog.showMessageBox({
        type: 'info',
        title: `${APP_NAME} 更新已就绪`,
        message: `${APP_NAME} ${version} 已下载完成。`,
        detail: `立即重启以安装更新，或稍后在退出 ${APP_NAME} 时安装。`,
        buttons: ['重启并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      return result.response === 0
    },
    installUpdate: async () => {
      installUpdateOnQuit = true
      await requestAppQuit()
    },
    log: message => { console.error(message) },
  })

  const timer = setTimeout(() => { void updateController?.check() }, 10_000)
  timer.unref()
  const interval = setInterval(() => { void updateController?.check() }, 6 * 60 * 60 * 1000)
  interval.unref()
}

function releaseAppQuit(): void {
  quitReleased = true
  if (installUpdateOnQuit) {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (error) {
      console.error('update installation failed:', error)
      app.quit()
    }
  } else {
    app.quit()
  }
}

/** Join explicit quit requests even while the Host or window is still starting. */
function requestAppQuit(): Promise<void> {
  if (lifecycle !== undefined) return lifecycle.requestQuit()
  bootQuitPromise ??= (host?.shutdown() ?? Promise.resolve()).catch((error: unknown) => {
    console.error('shutdown failed:', error)
  }).then(() => {
    releaseAppQuit()
  })
  return bootQuitPromise
}

async function boot(): Promise<void> {
  if (bootQuitPromise !== undefined) return
  const paths = hostPaths()
  assertHostArtifacts(paths)
  host = createHostSupervisor({
    spawnHost: () => spawnDshWeb({
      ...paths,
      env: hostEnvironment(),
    }),
    log: chunk => process.stderr.write(chunk),
    onUnexpectedExit: ({ code, signal }) => {
      console.error(`host exited unexpectedly (code ${String(code)}, signal ${String(signal)})`)
      void requestAppQuit()
    },
  })
  hostOrigin = await host.start()
  hardenSession()
  lifecycle = createDesktopLifecycle({
    getWindow: () => mainWindow,
    createWindow: createMainWindow,
    disposeHost: async () => { await host?.shutdown() },
    quit: releaseAppQuit,
    reportError: (error) => { console.error('shutdown failed:', error) },
  })
  initializeUpdates()
  rebuildApplicationMenu()
  await lifecycle.showWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { void lifecycle?.showWindow() })
  app.on('activate', () => { void lifecycle?.showWindow() })
  app.on('window-all-closed', () => {
    // The Host owns application lifetime; Dock activation restores the window.
  })
  app.on('before-quit', (event: Event) => {
    if (quitReleased) return
    event.preventDefault()
    void requestAppQuit()
  })
  app.whenReady().then(boot).catch(async (error: unknown) => {
    console.error('startup failed:', error)
    if (bootQuitPromise === undefined) {
      await dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME} failed to start`,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    await requestAppQuit()
  })
}
