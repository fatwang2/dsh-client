/**
 * CDP verification for the traffic-light inset: connects to a running
 * packaged app started with --remote-debugging-port and checks the computed
 * geometry of the sidebar against the macOS traffic-light strip.
 */

const DEBUG_PORT = process.env.DSH_MAC_DEBUG_PORT ?? '9333'
const log = (...args) => console.error('[verify-inset]', ...args)

async function targets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)
  return res.json()
}

function evaluate(ws, id, expression) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime.evaluate timed out')), 15000)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else if (message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails)))
      else resolve(message.result?.result?.value)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
}

const EXPRESSION = `(() => {
  const sidebar = document.querySelector('[class*="sidebarCol"]')
  if (!sidebar) return { error: 'sidebarCol not found' }
  const cs = getComputedStyle(sidebar)
  const dragRegion = getComputedStyle(document.body, '::before')
  const rect = sidebar.getBoundingClientRect()
  const logoRow = sidebar.querySelector('[class*="logoRow"]')
  const logoRect = logoRow?.getBoundingClientRect()
  const interactiveControl = document.querySelector('button, a, input, textarea, select, [role="button"], [contenteditable]')
  const interactiveControlStyle = interactiveControl === null ? undefined : getComputedStyle(interactiveControl)
  // The session header only exists while a conversation is open; in the hero
  // phase the frontend renders it empty and display:none.
  const header = document.querySelector('[data-slot="conversation.session.header"] > header')
  const titleRow = header?.querySelector('[class*="titleRow"]')
  const titleRect = titleRow?.getBoundingClientRect()
  const toggle = sidebar.querySelector('[class*="toggle"]')
  const toggleRect = toggle?.getBoundingClientRect()
  // The details panel keeps its subtree mounted at width 0 while closed, so
  // its header is measurable whether or not the panel is open.
  const detailsHeader = document.querySelector('[data-slot="details"] > * > [class*="_header"]')
  const detailsClose = detailsHeader?.querySelector('button')
  const detailsRect = detailsClose?.getBoundingClientRect()
  const centerOf = rect => rect === undefined ? undefined : Math.round(rect.top + rect.height / 2)
  return {
    detailsHeaderCenter: centerOf(detailsRect),
    headerPaddingTop: header === null || header === undefined ? undefined : getComputedStyle(header).paddingTop,
    titleRowTop: titleRect === undefined ? undefined : Math.round(titleRect.top),
    titleRowCenter: centerOf(titleRect),
    sidebarToggleCenter: centerOf(toggleRect),
    title: document.title,
    paddingTop: cs.paddingTop,
    sidebarWidth: Math.round(rect.width),
    dragRegion: dragRegion.getPropertyValue('-webkit-app-region') || dragRegion.getPropertyValue('app-region'),
    dragRegionPosition: dragRegion.position,
    dragRegionHeight: dragRegion.height,
    dragRegionWidth: Math.round(Number.parseFloat(dragRegion.width)),
    interactiveControlRegion: interactiveControlStyle?.getPropertyValue('-webkit-app-region') || interactiveControlStyle?.getPropertyValue('app-region'),
    sidebarTop: Math.round(rect.top),
    logoRowTop: logoRect === undefined ? undefined : Math.round(logoRect.top),
    logoRowHeight: logoRect === undefined ? undefined : Math.round(logoRect.height),
    windowInnerWidth: window.innerWidth,
    windowInnerHeight: window.innerHeight,
  }
})()`

const list = await targets()
log('targets:', list.map(target => `${target.type}:${target.url}`).join(' | '))
const page = list.find(target => target.type === 'page')
if (page === undefined) {
  console.error('no page target found')
  process.exit(1)
}
log('connecting to', page.webSocketDebuggerUrl)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
log('connected, evaluating')
const result = await evaluate(ws, 1, EXPRESSION)
console.log(JSON.stringify(result, null, 2))
ws.close()

const trafficLightBottom = 18 + 14
if (result?.error) {
  console.error('VERIFY FAILED:', result.error)
  process.exit(1)
}
if (result.paddingTop !== '40px') {
  console.error('VERIFY FAILED: padding-top is', result.paddingTop, 'expected 40px')
  process.exit(1)
}
if (result.dragRegion !== 'drag' || result.dragRegionHeight !== '40px') {
  console.error('VERIFY FAILED: drag region is', result.dragRegion, result.dragRegionHeight, 'expected drag 40px')
  process.exit(1)
}
if (result.dragRegionPosition !== 'fixed' || result.dragRegionWidth !== result.windowInnerWidth) {
  console.error('VERIFY FAILED: drag region is', result.dragRegionPosition, result.dragRegionWidth, 'expected fixed window width', result.windowInnerWidth)
  process.exit(1)
}
if (result.interactiveControlRegion !== undefined && result.interactiveControlRegion !== 'no-drag') {
  console.error('VERIFY FAILED: interactive control region is', result.interactiveControlRegion, 'expected no-drag')
  process.exit(1)
}
if (result.logoRowTop === undefined) {
  console.error('VERIFY FAILED: logoRow not found inside sidebar')
  process.exit(1)
}
if (result.logoRowTop < trafficLightBottom) {
  console.error(`VERIFY FAILED: logo row top ${result.logoRowTop} overlaps traffic lights (bottom ${trafficLightBottom})`)
  process.exit(1)
}
/**
 * Session-header alignment. The header is absent until a conversation is
 * open, so this is a conditional assertion rather than a required one: run
 * the verifier with a session open to exercise it.
 */
if (result.titleRowCenter === undefined) {
  console.error('NOTE: no session header on screen; open a conversation to verify title alignment')
} else {
  if (result.titleRowTop < 40) {
    console.error(`VERIFY FAILED: title row top ${result.titleRowTop} sits under the 40px drag region`)
    process.exit(1)
  }
  if (result.sidebarToggleCenter === undefined) {
    console.error('VERIFY FAILED: sidebar collapse toggle not found for the alignment reference')
    process.exit(1)
  }
  if (Math.abs(result.titleRowCenter - result.sidebarToggleCenter) > 1) {
    console.error(`VERIFY FAILED: title row centers on y=${result.titleRowCenter}, sidebar controls on y=${result.sidebarToggleCenter}`)
    process.exit(1)
  }
  console.log(`VERIFY PASSED: title row and sidebar controls both center on y=${result.titleRowCenter}`)
}
/** Details panel header, measurable even while the panel is closed. */
if (result.detailsHeaderCenter === undefined) {
  console.error('NOTE: details panel header not mounted; open a conversation to verify its alignment')
} else if (result.sidebarToggleCenter !== undefined && Math.abs(result.detailsHeaderCenter - result.sidebarToggleCenter) > 1) {
  console.error(`VERIFY FAILED: details header centers on y=${result.detailsHeaderCenter}, sidebar controls on y=${result.sidebarToggleCenter}`)
  process.exit(1)
} else {
  console.log(`VERIFY PASSED: details header centers on y=${result.detailsHeaderCenter}`)
}
console.log(`VERIFY PASSED: ${result.dragRegionWidth}x${result.dragRegionHeight} draggable inset, logo row starts at y=${result.logoRowTop} (traffic lights end at y=${trafficLightBottom})`)
