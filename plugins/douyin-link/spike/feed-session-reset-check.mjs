/**
 * 离线渲染验证：**重连之后实时列表顶上还钉着「直播已结束」**（用户 2026-10-11 反馈：
 * 「重连的时候，还显示直播已结束的文案，但是确实重新连接了，弹幕都是正常的」）。
 *
 * 现场是怎么来的：下播时服务端推一条 `WebcastControlMessage` → 界面在实时列表**上方**
 * 钉一行「直播已结束」（`DanmakuFeed` 的 notices：状态类提示固定显示，不当流水）。主播重开播后，
 * 主进程开了**新会话**（`recorder.begin()` 把自己那份最近消息清空），弹幕也恢复正常；
 * 但渲染层这份列表是**一路累加**下来的，那条提示没人清 → 于是「弹幕都正常了，顶上还说已结束」。
 *
 * 这个工装把**真产物** `dist/douyin-link/renderer.mjs` 挂进 jsdom，用假宿主桥按真实顺序推事件：
 *   1. 挂载（快照里带的最近消息含一条「直播已结束」）→ 切到「实时」页签 → 它必须可见（复现现场）；
 *   2. 推一条「新会话（sessionId 变了）+ 新弹幕」→ 提示必须消失，弹幕一条不少（这就是修的那条）；
 *   3. 反向用例 A：**同一个会话**里再推一条「直播已结束」→ 不许清（别把当前状态也清了）；
 *   4. 反向用例 B：下播那一刻（sessionId 归 0）→ 不许清（那会儿正该留着给用户看）。
 *
 * 跑法（先构建，产物要与源码同步）：
 *   node scripts/build.mjs --plugin douyin-link
 *   node plugins/douyin-link/spike/feed-session-reset-check.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const bundlePath = join(ROOT, 'dist/douyin-link/renderer.mjs')
const distDir = join(ROOT, 'dist/douyin-link')
if (!existsSync(bundlePath)) {
  console.error('先跑 node scripts/build.mjs --plugin douyin-link（找不到 dist/douyin-link/renderer.mjs）')
  process.exit(2)
}

/** jsdom 是宿主仓库的依赖（本仓库不装它）：没有就联一条过去，与 settings-render-check 同款 */
const jsdomLink = join(ROOT, 'node_modules/jsdom')
const hostJsdom = 'E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\jsdom'
if (!existsSync(jsdomLink) && existsSync(hostJsdom)) {
  try {
    mkdirSync(join(ROOT, 'node_modules'), { recursive: true })
    symlinkSync(hostJsdom, jsdomLink, 'junction')
  } catch (error) {
    console.error(`建 jsdom 联接失败（${error.message}）`)
    process.exit(2)
  }
}
const { JSDOM } = await import('jsdom')

/** 真实词条：断言里要看到中文文案，所以从源码里取 */
const zh = (await import(pathToFileURL(join(ROOT, 'plugins/douyin-link/locales/zh-CN.ts')).href)).default

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
})
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === 'undefined' || key === 'window' || key === 'self' || key === 'globalThis') continue
  if (key in globalThis && !['document', 'location', 'history', 'navigator'].includes(key)) continue
  try {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true })
  } catch {
    /* 有些内置全局只读，跳过 */
  }
}
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.matchMedia = () => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {}
})
const observerStub = class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
globalThis.ResizeObserver ??= observerStub
globalThis.IntersectionObserver ??= observerStub

/**
 * canvas 垫片：默认页签是「概览」，它会挂 ECharts（CanvasRenderer）。
 * 这个工装验的是弹幕列表，图表崩不崩不该影响结论——给个什么都不做的 2d 上下文即可。
 */
const ctxStub = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === 'canvas') return { width: 800, height: 200 }
      if (key === 'measureText') return () => ({ width: 8, actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 2 })
      if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern') {
        return () => ({ addColorStop() {} })
      }
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
      if (key === 'isPointInPath') return () => false
      return () => undefined
    }
  }
)
dom.window.HTMLCanvasElement.prototype.getContext = () => ctxStub
dom.window.HTMLCanvasElement.prototype.toDataURL = () => ''

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRequire } = await import('node:module')
const require_ = createRequire(pathToFileURL(join(ROOT, 'package.json')).href)
const React = require_('react')
const { createRoot } = require_('react-dom/client')
globalThis.__JSDOM_REACT__ = React
globalThis.__JSDOM_REACT_DOM_CLIENT__ = { createRoot, hydrateRoot: require_('react-dom/client').hydrateRoot }
globalThis.__JSX_RUNTIME__ = require_('react/jsx-runtime')
const { act } = React

/* ------------------------------------------------------- 假宿主桥（真产物照用） */

const PREFIX = 'plugin:douyin-link:'
const ROOM = '880000000001'
const calls = []
/** 事件订阅登记表：工装自己按通道推事件（真产物里那些 `api.onXxx` 都落在这里） */
const subs = new Map()
const handlers = () => {
  const map = new Map()
  map.set(`${PREFIX}snapshot`, () => ({
    rooms: [roomRuntime()],
    activeRoom: ROOM,
    audioRoom: '',
    settings: {},
    recent: [...recent],
    db: {},
    updatedAt: Date.now()
  }))
  map.set(`${PREFIX}day-records`, () => [])
  map.set(`${PREFIX}room-summary`, () => ({}))
  map.set(`${PREFIX}messages-query`, () => ({ rows: [], total: 0 }))
  map.set(`${PREFIX}users-list`, () => ({ rows: [], total: 0 }))
  map.set(`${PREFIX}presence-list`, () => ({
    webRid: ROOM,
    rows: [],
    micCount: 0,
    listedCount: 0,
    activeCount: 0,
    voice: false,
    hasInfo: false,
    updatedAt: Date.now()
  }))
  return map
}

let sessionId = 1
let roomStatus = 'live'
let danmakuPhase = 'live'
let recent = []

function roomRuntime() {
  return {
    webRid: ROOM,
    title: '工装直播间',
    anchor: '工装主播',
    cover: '',
    onlineText: '12',
    status: roomStatus,
    note: '',
    monitor: true,
    phase: roomStatus === 'ended' ? 'ended' : 'live',
    failure: null,
    danmaku: { phase: danmakuPhase, failure: null, since: Date.now(), received: recent.length },
    quality: null,
    qualities: [],
    audio: false,
    sessionId,
    counters: { chat: 3, enter: 0, like: 0, follow: 0, gift: 0 },
    received: 3,
    rate: 0,
    sessionUsers: 2,
    stored: { messages: 3, users: 2, sessions: 1 },
    addedAt: Date.now(),
    lastActiveAt: Date.now(),
    lastSeenAt: Date.now()
  }
}

let seq = 0
const item = (kind, text, user = '') => {
  seq += 1
  return {
    id: seq,
    kind,
    user,
    userId: user ? `7000000000${seq}` : '',
    text,
    count: 0,
    diamonds: 0,
    toUser: '',
    toUserId: '',
    at: Date.now()
  }
}

dom.window.api = {
  plugin: {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args })
      const handler = handlers().get(channel)
      return handler ? handler(...args) : null
    },
    on: (channel, callback) => {
      if (!subs.has(channel)) subs.set(channel, new Set())
      subs.get(channel).add(callback)
      return () => subs.get(channel)?.delete(callback)
    },
    off: (channel, callback) => subs.get(channel)?.delete(callback),
    send: () => {}
  }
}
const emit = (channel, payload) => {
  for (const callback of subs.get(channel) ?? []) callback(payload)
}
/** 推一个事件（**包在 act 里**：不这样做 React 会报「update not wrapped in act」） */
const push = async (channel, payload) => {
  await act(async () => {
    emit(channel, payload)
  })
  await settle()
}

/** `plugin://host/ui.js?m=…` 的返回：i18n + useTheme（插件自己的 ui.tsx 要用后者判明暗） */
dom.window.__RB_HOST_UI_RESOLVE__ = () => ({
  default: {},
  useTranslation: () => ({
    t: (key, options) => {
      const tree = zh['douyin-link'] ?? {}
      const path = key.replace(/^douyin-link\./, '').split('.')
      let node = tree
      for (const part of path) node = node?.[part]
      if (typeof node !== 'string') return key
      return options ? node.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options[name] ?? '')) : node
    },
    i18n: { language: 'zh-CN' }
  }),
  useTheme: () => ({ effectiveTheme: 'light' }),
  useHostEvent: () => () => {}
})

/* --------------------------------------- 把产物与它的宿主桥桩编到一起（同 settings 工装） */

const { build } = await import('esbuild')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-feed-reset-'))
writeFileSync(join(workDir, 'package.json'), '{ "type": "module" }\n', 'utf8')
try {
  symlinkSync(join(ROOT, 'node_modules'), join(workDir, 'node_modules'), 'junction')
} catch {
  /* 挂不上就靠 Node 自己解析 */
}
const REACT_NAMED = [
  'useState',
  'useEffect',
  'useCallback',
  'useMemo',
  'useRef',
  'useReducer',
  'useContext',
  'useLayoutEffect',
  'useId',
  'useSyncExternalStore',
  'useTransition',
  'useDeferredValue',
  'createContext',
  'createElement',
  'forwardRef',
  'memo',
  'Children',
  'cloneElement',
  'isValidElement',
  'StrictMode',
  'version'
]
const reactCjs = `const react = globalThis.__JSDOM_REACT__\nconst require_ = (await import('node:module')).createRequire(${JSON.stringify(pathToFileURL(join(ROOT, 'package.json')).href)})\n`
const stubPath = join(workDir, 'host-ui-stub.mjs')
writeFileSync(
  stubPath,
  reactCjs +
    REACT_NAMED.map((name) => `export const ${name} = react.${name}\n`).join('') +
    [
      'const ui = () => globalThis.window.__RB_HOST_UI_RESOLVE__()',
      'const jsxRuntime = globalThis.__JSX_RUNTIME__',
      'const antd = await import("antd")',
      'export const jsx = jsxRuntime.jsx',
      'export const jsxs = jsxRuntime.jsxs',
      'export const Fragment = react.Fragment',
      ...['Button', 'Input', 'InputNumber', 'Select', 'Switch', 'Typography', 'Tooltip', 'Empty', 'Spin', 'Segmented', 'Tabs', 'Tag', 'Progress', 'Table', 'Card', 'Space', 'Divider', 'Alert', 'Popconfirm', 'Dropdown', 'Badge', 'Drawer', 'Modal', 'Checkbox', 'Radio', 'DatePicker', 'Statistic', 'Descriptions', 'List', 'Avatar', 'Slider', 'Collapse', 'Form', 'Tree', 'Pagination', 'ConfigProvider', 'App', 'theme', 'message', 'notification'].map(
        (name) => `export const ${name} = antd.${name}`
      ),
      'export const useTranslation = (...a) => ui().useTranslation(...a)',
      'export const useHostEvent = (...a) => ui().useHostEvent(...a)',
      'export const useTheme = (...a) => ui().useTheme(...a)',
      'export const I18nextProvider = ({ children }) => children',
      'export const HostEventProvider = ({ children }) => children',
      /**
       * 默认导出必须是**可调用的 dayjs**：产物里 vendor 模块（`@host/vendor/dayjs`）走的就是
       * 这一个桥的 `default`（`dayjs().startOf('day')` 直接调它）。把 antd / react 的成员也挂上，
       * 免得别处取 default 上的东西时落空。
       */
      'const dayjsModule = require_("dayjs")',
      /**
       * 图标也走同一个宿主的 vendor 桥（`m=@host/vendor/@remixicon/react`），
       * 所以桩要把**真图标**整个转出去（不然 `<RiRadarLine />` 是 undefined → 渲染期炸）。
       */
      'export * from "@remixicon/react"',
      'export default Object.assign((...args) => dayjsModule(...args), dayjsModule, antd, react)'
    ].join('\n') +
    '\n',
  'utf8'
)
const reactStub = join(workDir, 'react-stub.mjs')
writeFileSync(
  reactStub,
  `const { createRequire } = await import('node:module')\n` +
    `const require_ = createRequire(${JSON.stringify(pathToFileURL(join(ROOT, 'package.json')).href)})\n` +
    `const react = require_('react')\n` +
    REACT_NAMED.map((name) => `export const ${name} = react.${name}\n`).join('') +
    `export default react\n`,
  'utf8'
)
const reactDomStub = join(workDir, 'react-dom-stub.mjs')
writeFileSync(
  reactDomStub,
  `const client = globalThis.__JSDOM_REACT_DOM_CLIENT__\n` +
    `export const createRoot = client.createRoot\n` +
    `export const hydrateRoot = client.hydrateRoot\n` +
    `export default client\n`,
  'utf8'
)

const outfile = join(workDir, 'renderer.mjs')
await build({
  entryPoints: [bundlePath],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'silent',
  /**
   * `dayjs` **必须打进来**（不 external）：产物里是 `import dayjs from 'dayjs'`，
   * 在 Node ESM 里 external 会变成命名空间对象 → `dayjs()` 直接 “is not a function”。
   * 图标留 external 即可（它是真包，具名导出在 ESM 下没问题）。
   */
  external: ['@remixicon/react', 'node:module'],
  plugins: [
    {
      name: 'stub-host-ui',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^plugin:\/\/host\/ui\.js/ }, () => ({ path: stubPath }))
        buildApi.onResolve({ filter: /^react$/ }, () => ({ path: reactStub }))
        buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: reactDomStub }))
        buildApi.onResolve({ filter: /^[^./\\]/ }, (args_) => {
          // dayjs 例外：它必须是**真函数**（external 到 Node ESM 会变成命名空间对象）
          if (args_.path === 'dayjs' || args_.path.startsWith('dayjs/')) return null
          if (args_.path.includes('\\') || args_.path.includes('/')) return null
          if (args_.path.startsWith('@') && args_.path.split('/').length > 2) return null
          return { path: args_.path, external: true }
        })
        buildApi.onResolve({ filter: /^plugin:\/\/douyin-link\// }, (args_) => {
          const name = args_.path.replace(/^plugin:\/\/douyin-link\//, '').split('?')[0]
          return { path: join(distDir, name) }
        })
      }
    }
  ]
})

/* ------------------------------------------------------------------ 挂载真产物 */

const plugin = (await import(pathToFileURL(outfile).href)).default
let route = null
plugin.install({
  use: (kind) => ({
    register: (entry) => {
      if (kind === 'route') route = entry
    },
    addResources: () => {}
  })
})

const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`)
}
let failures = 0

const Page = (await route.load()).default
/** 快照里带的最近一段：**按主进程的契约是「新 → 旧」**（`hub.snapshot()` 做过 reverse） */
recent = [item('control', 'ended'), item('chat', '最新一条', '阿甲'), item('chat', '倒数第二条', '阿乙')]

const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(Page))
})
const settle = async (ms = 80) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}
await settle(150)

const text = () => dom.window.document.body.textContent ?? ''
const endedCopy = zh['douyin-link'].lines.controlEnded
const clickTab = async (label) => {
  const tab = [...dom.window.document.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.trim() === label)
  if (!tab) return false
  await act(async () => {
    tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
  return true
}

console.log('=== 1. 挂载 + 切到「实时」页签（复现现场）===')
check('页面挂载了（左栏房间行在）', text().includes('工装主播'), true)
check('切到「实时」页签', await clickTab(zh['douyin-link'].page.tabLive), true)
check(`实时列表里有「${endedCopy}」这条状态提示`, text().includes(endedCopy), true)
check('弹幕也在（最新一条 / 倒数第二条）', [text().includes('最新一条'), text().includes('倒数第二条')], [true, true])
/**
 * 列表顺序：主进程给的最近消息是**「新 → 旧」**（`hub.snapshot()` 做过 reverse），
 * 而实时列表是**从旧到新往下排**、新消息追加在末尾（`DanmakuFeed` 会滚到底）。
 * 所以界面上「倒数第二条」必须在「最新一条」**上面**——不转一次顺序，开页面看到的就是反的。
 */
const chatOrder = ['最新一条', '倒数第二条'].map((needle) => text().indexOf(needle))
check('最近消息按「旧 → 新」排（后收到的在下面）', chatOrder[0] > chatOrder[1], true)

console.log('\n=== 2. 重连：新会话 + 新弹幕（sessionId 变化）===')
sessionId = 2
danmakuPhase = 'live'
await push(`${PREFIX}rooms`, { rooms: [roomRuntime()], activeRoom: ROOM })
await push(`${PREFIX}messages`, { webRid: ROOM, items: [item('chat', '重连后的弹幕', '阿丙')] })
await settle(120)
check(`重连后「${endedCopy}」必须消失`, text().includes(endedCopy), false)
check(
  '重连后的弹幕在，重连前的弹幕也一条没少',
  [text().includes('重连后的弹幕'), text().includes('最新一条'), text().includes('倒数第二条')],
  [true, true, true]
)

console.log('\n=== 3. 反向用例 A：同一个会话里又来一条「直播已结束」→ 不许清 ===')
await push(`${PREFIX}messages`, { webRid: ROOM, items: [item('control', 'ended')] })
await settle(120)
check(`同一会话里的「${endedCopy}」要留着（它是当前状态）`, text().includes(endedCopy), true)

console.log('\n=== 4. 反向用例 B：下播（sessionId 归 0）→ 也不许清 ===')
sessionId = 0
roomStatus = 'ended'
danmakuPhase = 'idle'
await push(`${PREFIX}rooms`, { rooms: [roomRuntime()], activeRoom: ROOM })
await settle(120)
check(`下播那一刻「${endedCopy}」要留着（正在等开播）`, text().includes(endedCopy), true)

console.log('\n=== 5. 等开播期间同会话（sessionId 一直是 0）→ 仍然不许清 ===')
await push(`${PREFIX}rooms`, { rooms: [roomRuntime()], activeRoom: ROOM })
await settle(120)
check(`等待期间「${endedCopy}」还在`, text().includes(endedCopy), true)

console.log('\n=== 6. 再开播：新会话（0 → 3）→ 清掉 ===')
sessionId = 3
roomStatus = 'live'
danmakuPhase = 'live'
await push(`${PREFIX}rooms`, { rooms: [roomRuntime()], activeRoom: ROOM })
await push(`${PREFIX}messages`, { webRid: ROOM, items: [item('chat', '又开播了', '阿甲')] })
await settle(120)
check(`再开播后「${endedCopy}」消失`, text().includes(endedCopy), false)
check('两次重连的弹幕都在', [text().includes('重连后的弹幕'), text().includes('又开播了')], [true, true])

console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
