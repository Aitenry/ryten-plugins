/**
 * 离线渲染验证：**房间清单不再藏直播间，超出就在清单自己身上出细滚动条**
 * （用户 2026-10-13：「这个内容不能隐藏其他直播间，出现滚动条即可，滚动条要用优化后的滚动条」）。
 *
 * 复现的正是用户那张截图里的场景：左栏「直播间（N）」有 3 个以上房间、容器只放得下两行。
 * 改动前用的是 `FitList`（贪心塞行 + 「还有 N 个」），多出来的房间**一行都不画**——
 * 连「当前选中的那个房间」都可能看不见。改动后清单是一个 `data-rb-scroll` + `overflow-y-auto`
 * 的滚动容器，**每个房间都渲染**，放不下就自己滚。
 *
 * jsdom 里所有元素都是零尺寸，`useSize()` 读到的可用高度是 0，那样旧代码一行都不画、
 * 断言会「因为环境」而通过。所以这里把 `clientHeight/clientWidth` 钉成 200×300
 * （`useSize()` 就是读 `clientHeight`），让旧代码走**真实的**降级路径：200px 只塞得下 2 行
 * （行高 62 + 间距 6），剩下的变成「还有 3 个直播间」。
 *
 * 跑法（先构建，产物要与源码同步）：
 *   node scripts/build.mjs --plugin douyin-link
 *   node plugins/douyin-link/spike/room-rail-scroll-check.mjs
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
    /* 只读的内置全局，跳过 */
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

/** 默认页签是「概览」，会挂 ECharts（CanvasRenderer）：给个什么都不做的 2d 上下文 */
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

/**
 * 容器可用高度：`useSize()` 读的 `clientHeight`。钉成 200px —— 房间行高 62 + 间距 6，
 * 200px 只塞得下两行（旧代码就是在这里开始藏房间的）。宽度只影响布局断言，给 300。
 */
const CONTAINER_HEIGHT = 200
const CONTAINER_WIDTH = 300
Object.defineProperty(dom.window.Element.prototype, 'clientHeight', {
  configurable: true,
  get: () => CONTAINER_HEIGHT
})
Object.defineProperty(dom.window.Element.prototype, 'clientWidth', {
  configurable: true,
  get: () => CONTAINER_WIDTH
})

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
const subs = new Map()

/** 5 个直播间：第 5 个最新加（排在清单最上面），第 1 个最早加 = **当前选中的那个** */
const ROOMS = [
  { webRid: '108011161837', anchor: '少爷', addedAt: 1_000 },
  { webRid: '89580589016', anchor: '少女', addedAt: 2_000 },
  { webRid: '75512340099', anchor: '老张', addedAt: 3_000 },
  { webRid: '65122334455', anchor: '阿伟', addedAt: 4_000 },
  { webRid: '51234567890', anchor: '大力', addedAt: 5_000 }
]
/** 选中的是**最早加**的那个：它在清单最下面（也就是旧代码最先藏掉的那一行） */
const ACTIVE = ROOMS[0].webRid

function roomRuntime(room) {
  return {
    webRid: room.webRid,
    title: '今天人多',
    anchor: room.anchor,
    cover: '',
    onlineText: '12',
    status: 'live',
    note: '',
    monitor: true,
    phase: 'live',
    failure: null,
    danmaku: { phase: 'live', failure: null, since: Date.now(), received: 0 },
    quality: null,
    qualities: [],
    audio: false,
    sessionId: 1,
    counters: { chat: 0, enter: 0, like: 0, follow: 0, gift: 0 },
    received: 0,
    rate: 0,
    sessionUsers: 0,
    stored: { messages: 100, users: 0, sessions: 1 },
    addedAt: room.addedAt,
    lastActiveAt: Date.now(),
    lastSeenAt: Date.now()
  }
}

const handlers = () => {
  const map = new Map()
  map.set(`${PREFIX}snapshot`, () => ({
    rooms: ROOMS.map(roomRuntime),
    activeRoom: ACTIVE,
    audioRoom: '',
    settings: {},
    recent: [],
    db: {},
    updatedAt: Date.now()
  }))
  map.set(`${PREFIX}day-records`, () => [])
  map.set(`${PREFIX}room-summary`, () => ({}))
  map.set(`${PREFIX}messages-query`, () => ({ rows: [], total: 0 }))
  map.set(`${PREFIX}users-list`, () => ({ rows: [], total: 0 }))
  map.set(`${PREFIX}presence-list`, () => ({
    webRid: ACTIVE,
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

dom.window.api = {
  plugin: {
    invoke: async (channel, ...args) => {
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
const workDir = mkdtempSync(join(tmpdir(), 'douyin-rail-'))
writeFileSync(join(workDir, 'package.json'), '{ "type": "module" }\n', 'utf8')
try {
  symlinkSync(join(ROOT, 'node_modules'), join(workDir, 'node_modules'), 'junction')
} catch {
  /* 挂不上就靠 Node 自己解析 */
}
const REACT_NAMED = [
  'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useReducer', 'useContext',
  'useLayoutEffect', 'useId', 'useSyncExternalStore', 'useTransition', 'useDeferredValue',
  'createContext', 'createElement', 'forwardRef', 'memo', 'Children', 'cloneElement',
  'isValidElement', 'StrictMode', 'version'
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
      'const dayjsModule = require_("dayjs")',
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
  external: ['@remixicon/react', 'node:module'],
  plugins: [
    {
      name: 'stub-host-ui',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^plugin:\/\/host\/ui\.js/ }, () => ({ path: stubPath }))
        buildApi.onResolve({ filter: /^react$/ }, () => ({ path: reactStub }))
        buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: reactDomStub }))
        buildApi.onResolve({ filter: /^[^./\\]/ }, (args_) => {
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

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`
  )
}

const Page = (await route.load()).default
const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(Page))
})
const settle = async (ms = 150) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}
await settle(500)

/* ---------------------------------------------------------------- 工具 */

const doc = dom.window.document
const text = () => doc.body.textContent ?? ''

const railPanel = () =>
  [...doc.querySelectorAll('.ant-card')].find((card) =>
    card.querySelector('.ant-card-head-title')?.textContent?.trim().startsWith('直播间（')
  ) ?? null
const railBody = () => railPanel()?.querySelector('.ant-card-body') ?? null
/** 房间行：`RoomRow` 带 `data-rb-row`（只用于真人可点的行；这里就是房间行） */
const rows = () => [...(railPanel()?.querySelectorAll('[data-rb-row]') ?? [])]
const scrollers = () => [...(railPanel()?.querySelectorAll('[data-rb-scroll]') ?? [])]
const clickElement = async (element) => {
  if (!element) return false
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle(200)
  return true
}
const rowOf = (anchor) => rows().find((row) => row.textContent?.includes(anchor)) ?? null
const isActiveRow = (row) => (row?.style.borderLeft ?? '').includes('solid') && !(row?.style.borderLeft ?? '').includes('transparent')

console.log('=== 1. 五个直播间全部画出来（改前只画得下两行） ===')
console.log(`  容器可用高度：${CONTAINER_HEIGHT}px，行高 62 + 间距 6 → 旧代码只塞得下 2 行`)
check('标题是「直播间（5）」', railPanel()?.querySelector('.ant-card-head-title')?.textContent?.trim(), '直播间（5）')
check('清单里画出了 5 行', rows().length, 5)
check(
  '五个主播名都在',
  ROOMS.map((room) => rows().some((row) => row.textContent?.includes(`${room.anchor} · ${room.webRid}`))),
  [true, true, true, true, true]
)
check('不再有「还有 N 个直播间」这种收尾行', /还有 \d+ 个直播间/.test(text()), false)
check(
  '当前选中的房间（最早加的那个）也在清单里',
  Boolean(rowOf('少爷')),
  true
)
check('而且它标着选中（左侧强调条）', isActiveRow(rowOf('少爷')), true)

console.log('\n=== 2. 放不下就出滚动条，用的是插件那套细滚动条 ===')
const scroller = scrollers()[0]
check('清单里正好一个可滚容器', scrollers().length, 1)
check('容器带 data-rb-scroll（细滚动条的挂载点）', scroller?.getAttribute('data-rb-scroll'), '')
check('容器自己是纵向滚动（overflow-y-auto）', Boolean(scroller?.className.includes('overflow-y-auto')), true)
check('5 行都在这个滚动容器里', scroller?.querySelectorAll('[data-rb-row]').length ?? -1, 5)
const scrollCss = [...doc.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n')
check(
  '文档里注入了优化过的滚动条样式（细、圆角、半透明）',
  [scrollCss.includes('[data-rb-scroll]::-webkit-scrollbar-thumb'), scrollCss.includes('scrollbar-width:thin')],
  [true, true]
)
check(
  '它是「卡片正文里 flex-1 / 自己滚」的那条链（卡片高度不会被内容顶开）',
  Boolean(
    scroller &&
      scroller.parentElement?.className.includes('flex-1') &&
      railBody() &&
      railBody().contains(scroller)
  ),
  true
)
check(
  '卡片正文本身是 overflow: hidden（超出只能靠里面的滚动条）',
  (railBody()?.getAttribute('style') ?? '').includes('overflow: hidden'),
  true
)
check('输入行在滚动容器**外面**（加房间的入口固定在上方）', Boolean(railBody()?.querySelector('input')) && !scroller?.contains(railBody()?.querySelector('input')), true)

console.log('\n=== 3. 原来被藏掉的那几行现在点得到 ===')
check('点最下面那一行（最早加的房间：大力）', await clickElement(rowOf('大力')), true)
check('它变成选中', isActiveRow(rowOf('大力')), true)
check('原来选中的那一行已经取消选中', isActiveRow(rowOf('少爷')), false)
check('清单顺序没变（加入时间倒序：新加的在上）', rows()[0]?.textContent?.includes('大力'), true)

console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
