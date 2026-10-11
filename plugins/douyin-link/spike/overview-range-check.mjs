/**
 * 离线渲染验证：**时间范围面板砍掉「这一天全部」按钮，时长的位置搬到标题右边**
 * （用户 2026-10-13：「移除这一天的全部的按钮，时长 15h39m 放在标题的右边」）。
 *
 * 断言分三段，全部打在**真产物**（`dist/douyin-link/renderer.mjs`）上：
 *
 * 1. 标题右边就是时长：`时间范围` 那张卡片的**头部**（`.ant-card-head`）里有且只有一个
 *    `时长 …`，位置在标题**之后**（DOM 顺序），数值等于卡片正文里那两个端点印章算出来的跨度；
 * 2. 「这一天全部」整页消失：页面文案里找不到这四个字，`时间范围` 正文里一个 `button` 都没有，
 *    正文只剩「进度条 + 两端印章」两行（时长不再占正文的一行）——
 *    页面传下来的 `range` 一直是**生效区间**（没拖过就是这一天 00:00 → 现在），
 *    旧代码里那个按钮是**一直挂着**的，所以这一段在改动前就会炸；
 * 3. 拖动进度条之后：中间那行变成 `起 → 止`，标题右边跟着换成**这一段的时长**，
 *    且和正文里印出来的起止时刻算出来的时长一致；按钮依然不在。
 *
 * 跑法（先构建，产物要与源码同步）：
 *   node scripts/build.mjs --plugin douyin-link
 *   node plugins/douyin-link/spike/overview-range-check.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
/**
 * 被测产物目录：默认是本地构建的 `dist/douyin-link`。
 * `DY_DIST=<解压出来的目录>` 可以指到**已发布的 zip**（把 Release 资产解开跑同一套断言，
 * 验的就是「发出去的那份字节」而不只是「我本地编出来的那份」）。
 */
const distDir = process.env.DY_DIST ? process.env.DY_DIST.replace(/^\/([A-Za-z]:)/, '$1') : join(ROOT, 'dist/douyin-link')
const bundlePath = join(distDir, 'renderer.mjs')
if (!existsSync(bundlePath)) {
  console.error(`找不到渲染层产物：${bundlePath}（先跑 node scripts/build.mjs --plugin douyin-link）`)
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
 * jsdom 里所有元素都是零尺寸矩形，而 rc-slider 拖拽靠
 * `containerRef.current.getBoundingClientRect()` 的宽度换算百分比（`offsetX / width`）。
 * 给一个固定宽度 1000，拖动就是可预期的：`Δvalue = (max - min) * ΔX / 1000`。
 */
const RECT_WIDTH = 1000
dom.window.Element.prototype.getBoundingClientRect = function () {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: RECT_WIDTH,
    bottom: 10,
    width: RECT_WIDTH,
    height: 10,
    toJSON() {
      return this
    }
  }
}

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
const subs = new Map()

function roomRuntime() {
  return {
    webRid: ROOM,
    title: '工装直播间',
    anchor: '工装主播',
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
    stored: { messages: 0, users: 0, sessions: 1 },
    addedAt: Date.now(),
    lastActiveAt: Date.now(),
    lastSeenAt: Date.now()
  }
}

const handlers = () => {
  const map = new Map()
  map.set(`${PREFIX}snapshot`, () => ({
    rooms: [roomRuntime()],
    activeRoom: ROOM,
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
const workDir = mkdtempSync(join(tmpdir(), 'douyin-range-'))
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

/** 和 `OverviewPanel.duration()` 同一份实现（断言就是拿它算出来的数去比界面上的字） */
function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

/** 「时间范围」那张卡片：标题文案唯一 */
const rangeCard = () =>
  [...doc.querySelectorAll('.ant-card')].find(
    (card) => card.querySelector('.ant-card-head-title')?.textContent?.trim() === zh['douyin-link'].page.range
  )
const rangeTitle = () => rangeCard()?.querySelector('.ant-card-head-title') ?? null
const rangeExtra = () => rangeCard()?.querySelector('.ant-card-extra') ?? null
const rangeBody = () => rangeCard()?.querySelector('.ant-card-body') ?? null
/** 正文 = 「进度条 + 两端印章」两行；按**位置**取，不看类名（所以改动前也能读出来） */
const rangeWrapper = () => rangeBody()?.firstElementChild ?? null
const rangeRow = (index) => rangeWrapper()?.children[index] ?? null

/** 「MM-DD HH:mm」/「HH:mm」→ 毫秒时间戳（按界面同一天的口径拼） */
function parseStamp(value, fallbackAt = Date.now()) {
  const full = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value.trim())
  const clockOnly = /^(\d{2}):(\d{2})$/.exec(value.trim())
  const base = new Date(fallbackAt)
  if (full) {
    return new Date(
      base.getFullYear(),
      Number(full[1]) - 1,
      Number(full[2]),
      Number(full[3]),
      Number(full[4])
    ).getTime()
  }
  if (clockOnly) {
    return new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      Number(clockOnly[1]),
      Number(clockOnly[2])
    ).getTime()
  }
  return NaN
}

/** 正文第二行那三个 `span`（左端点 / 这一段 / 右端点） */
const rangeEnds = () => {
  const spans = rangeRow(1)?.querySelectorAll('span')
  if (!spans || spans.length < 3) return null
  return {
    first: parseStamp(spans[0].textContent ?? ''),
    last: parseStamp(spans[spans.length - 1].textContent ?? ''),
    middle: (spans[1].textContent ?? '').trim(),
    count: spans.length
  }
}

const mouse = (type, x) =>
  new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 5, button: 0 })
const handles = () => [...(rangeCard()?.querySelectorAll('.ant-slider-handle') ?? [])]
/** 拖动某个把手：rc-slider 只看 `ΔX / 容器宽`，所以「按住在 x 处、移到 x+Δ」就是一段确定的比例 */
const dragHandle = async (index, fromX, toX) => {
  const handle = handles()[index]
  if (!handle) return false
  await act(async () => {
    handle.dispatchEvent(mouse('mousedown', fromX))
  })
  await act(async () => {
    doc.dispatchEvent(mouse('mousemove', toX))
  })
  await act(async () => {
    doc.dispatchEvent(mouse('mouseup', toX))
  })
  await settle(300)
  return true
}

console.log('=== 1. 时长搬到了标题右边 ===')
check('找到「时间范围」面板', Boolean(rangeCard()), true)
const titleEl = rangeTitle()
const extraEl = rangeExtra()
check('标题右边有一个元素（Card 的 extra）', Boolean(extraEl), true)
console.log(`  标题右边：${JSON.stringify(extraEl?.textContent?.trim() ?? '')}`)
check('它是「时长 …」', (extraEl?.textContent ?? '').startsWith(zh['douyin-link'].page.rangeSpan.split('{{')[0]), true)
check(
  '和标题在同一个卡片头部里',
  Boolean(titleEl) && extraEl?.closest('.ant-card-head') === titleEl?.closest('.ant-card-head'),
  true
)
check(
  '位置在标题之后（也就是右边）',
  Boolean(
    titleEl &&
      extraEl &&
      titleEl.compareDocumentPosition(extraEl) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING
  ),
  true
)

const ends = rangeEnds() ?? { first: 0, last: 0, middle: '', count: 0 }
console.log(`  正文两端：${new Date(ends?.first ?? 0).toLocaleString()} → ${new Date(ends?.last ?? 0).toLocaleString()}`)
console.log(`  中间那行：${ends?.middle ?? ''}`)
check('正文第二行还是三个印章（左端点 / 这一段 / 右端点）', ends?.count, 3)
check('正文两端印章读得到', Boolean(ends && ends.first > 0 && ends.last > ends.first), true)
const wholeDayText = zh['douyin-link'].page.rangeSpan.replace('{{duration}}', duration(ends.last - ends.first))
/** 整段那一天的跨度（ms）：拖动后的断言用它比**数值**，不比文案（见第 3 段那条注释） */
const wholeDaySpan = ends.last - ends.first
check('没拖过进度条时时长 = 这一天整段', (extraEl?.textContent ?? '').trim(), wholeDayText)

console.log('\n=== 2. 「这一天全部」按钮被移除 ===')
check('整页文案里没有「这一天全部」', text().includes('这一天全部'), false)
check('也没留下任何「这一天全部」按钮', [...doc.querySelectorAll('button')].some((b) => b.textContent?.includes('这一天全部')), false)
check('正文里一个按钮都没有（原来那个就长在这里）', rangeBody()?.querySelectorAll('button').length ?? -1, 0)
check('「时长」不再出现在正文里', (rangeBody()?.textContent ?? '').includes('时长'), false)
check('整页「时长」只出现一次（就是标题右边那一处）', (text().match(/时长/g) ?? []).length, 1)
check('正文只剩两行（进度条 + 两端印章）', rangeWrapper()?.children.length ?? -1, 2)
const firstRow = rangeRow(0)
check(
  '第一行还是进度条（内容全在）',
  Boolean(firstRow?.classList.contains('ant-slider') || firstRow?.querySelector('.ant-slider')),
  true
)

console.log('\n=== 3. 拖动进度条：时长跟着换，按钮依然不在 ===')
check('两个把手都在', handles().length, 2)
/** 滑块自己的值（rc-slider 写在把手上的 `aria-valuenow`，秒级；文案只到分钟，见下面那段注释） */
const handleValue = (index) => Number(handles()[index]?.getAttribute('aria-valuenow') ?? NaN)
const rightBefore = handleValue(1)
check('右把手拖之前有值（rc-slider 的 aria-valuenow）', Number.isFinite(rightBefore), true)
/*
 * 页面传下来的 `range` 一直是**生效区间**（不是 null）——没拖过就是这一天 00:00 → 现在，
 * 所以旧代码里那个「这一天全部」按钮**一直挂着**（第 2 段那几条断言在改动前必炸）。
 *
 * 拖动量取**整段的 40%**（右把手 x=1000 → 600）：早先固定拖 2%，在**刚过午夜**那个窗口里
 * 整段本身只有几分钟，2% 只有几秒，取整到分钟后文案与整段一模一样（2026-10-13 复核发布字节时
 * 正好踩在 00:04），于是「时长变了」这条断言会误报。拖 40% 之后，任何真实跨度都会跨过一分钟。
 */
check('拖右把手', await dragHandle(1, 1000, 600), true)
const after = rangeEnds() ?? { first: 0, last: 0, middle: '' }
console.log(`  拖动后中间那行：${after?.middle ?? ''}`)
check('中间那行变成「起 → 止」（选了具体一段）', (after?.middle ?? '').includes('→'), true)
const [fromText, toText] = (after?.middle ?? '').split('→').map((part) => part.trim())
const fromAt = parseStamp(fromText ?? '')
const toAt = parseStamp(toText ?? '')
const spanText = zh['douyin-link'].page.rangeSpan.replace('{{duration}}', duration(toAt - fromAt))
console.log(`  换算：${new Date(fromAt).toLocaleString()} → ${new Date(toAt).toLocaleString()} = ${spanText}`)
check('标题右边换成了这一段的时长（和正文印的起止时刻一致）', (rangeExtra()?.textContent ?? '').trim(), spanText)
/*
 * 「时长变了没有」比**滑块自己的值**（秒级），不比文案：`duration()` 与正文印章都只到分钟，
 * 而刚过午夜时整段本身就只有几分钟——那时任何小于一分钟的位移在文案上看不出来（第一版就是这么误报的）。
 * 选中区间是不是整段的**真子集**，与跑在一天中的什么时刻无关。
 */
const rightAfter = handleValue(1)
console.log(`  右把手：拖前 ${rightBefore} → 拖后 ${rightAfter}（秒级，文案只到分钟）`)
check(
  '右把手确实变小了（选中区间成为整段的真子集）',
  Number.isFinite(rightAfter) && rightAfter < rightBefore,
  true
)
check('时长确实变了（不再是整段那一天）', toAt - fromAt < wholeDaySpan, true)
check('拖完还是没有「这一天全部」', text().includes('这一天全部'), false)
check('拖完正文还是一个按钮都没有', rangeBody()?.querySelectorAll('button').length ?? -1, 0)
check('拖完「时长」仍然只在标题右边', (text().match(/时长/g) ?? []).length, 1)

console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
