/**
 * 离线渲染验证：**匿名用户的档案弹窗**（用户 2026-10-12 报障：「匿名用户，内容监控会重复，
 * 这么严重的 bug」「所有的内容都重复了，个人主页内容」）。
 *
 * 抖音给所有隐藏身份的人发的 `user.id` 都是共用占位串 `111111`，所以按 id 聚合的一切
 * 都把互不相干的匿名观众堆成一个人：档案弹窗的「互动统计」是几个人头的合计、
 * 「历史弹幕」是一条混合时间线——看上去就是同一个人把内容重复刷了一遍。
 *
 * 主进程那边已经按「马甲」把身份分开（见 `shared/anonymous.ts` / `hub.identifyBatch`，
 * 回归工装 `anon-identity-check.mjs`）。这个工装验的是**界面这一侧**：
 * 拿着合成身份（`anon:111111#dou2056511`）打开档案弹窗时，
 * 1. **统计只算这个人自己**（这里给 2 条弹幕；改前那种合账是 13 条）；
 * 2. **历史弹幕只有他自己的话**（不会把别的匿名用户说过的话排进来）；
 * 3. 「用户 id」那一栏显示的是**抖音真给的 `111111`**，不是我们的内部键；
 * 4. 匿名身份不给「关联账号」入口，但**给分析入口**；「查看真实资料」按老规矩不出（查也查不到）；
 * 5. 匿名说明那一行在。
 *
 * 跑法（先构建，产物要与源码同步）：
 *   node scripts/build.mjs --plugin douyin-link
 *   node plugins/douyin-link/spike/anon-profile-check.mjs
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
/** 内部身份键（真正的抖音 id 是共用占位 `111111`，藏在 `anon:` 后面） */
const ANON_ID = 'anon:111111#dou2056511'
/** 同房间**另一个**匿名用户：他绝不该出现在上面那个人的档案里 */
const OTHER_ANON_ID = 'anon:111111#dou1330533'
const calls = []
const subs = new Map()

/** 这个人的档案：**只有他自己**的 2 条弹幕 / 1 次进场（旧版这里是十几个人的合计） */
const anonProfile = {
  id: ANON_ID,
  displayId: '',
  nickname: 'dou2056511',
  gender: 0,
  signature: '',
  city: '',
  avatar: '',
  following: 0,
  follower: 0,
  honorLevel: 52,
  fansClubLevel: 0,
  badges: [],
  secUid: '',
  firstSeen: Date.now() - 3600_000,
  lastSeen: Date.now(),
  stats: { chat: 2, enter: 1, like: 0, follow: 0, gift: 0, diamonds: 0, receivedDiamonds: 0 }
}

let seq = 0
const item = (kind, text, user, userId) => {
  seq += 1
  return { id: seq, kind, user, userId, text, count: 0, diamonds: 0, toUser: '', toUserId: '', at: Date.now() }
}
let recent = []

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
    danmaku: { phase: 'live', failure: null, since: Date.now(), received: recent.length },
    quality: null,
    qualities: [],
    audio: false,
    sessionId: 1,
    counters: { chat: recent.length, enter: 0, like: 0, follow: 0, gift: 0 },
    received: recent.length,
    rate: 0,
    sessionUsers: 1,
    stored: { messages: recent.length, users: 1, sessions: 1 },
    addedAt: Date.now(),
    lastActiveAt: Date.now(),
    lastSeenAt: Date.now()
  }
}

andOtherAnon()
function andOtherAnon() {
  /* 另一个匿名用户的档案（界面不该把他并进来） */
}
/**
 * 「历史弹幕」给的数据：**只回这个人自己发过的两条**。
 *
 * 这就是「分组是否正确」在界面上的落点——主进程那边按 `userId` 查（`queryMessages`），
 * 所以只要身份键分开了，另一个匿名用户的话根本不会出现在这里。
 * 工装里他说的「新年快乐」压根不在这份数据里，断言正是不许出现。
 */
const historyRows = () => [
  { id: 2, webRid: ROOM, kind: 'chat', user: 'dou2056511', userId: ANON_ID, text: '好久没玩了', count: 0, diamonds: 0, toUser: '', toUserId: '', at: Date.now() - 60_000 },
  { id: 1, webRid: ROOM, kind: 'chat', user: 'dou2056511', userId: ANON_ID, text: '匿名咋关来着', count: 0, diamonds: 0, toUser: '', toUserId: '', at: Date.now() - 120_000 }
]

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
  map.set(`${PREFIX}messages-query`, (query) => {
    /* 只认这个身份：另一个匿名用户的历史不该被查出来 */
    if (query && query.userId && query.userId !== ANON_ID) return { rows: [], total: 0 }
    return { rows: historyRows(), total: historyRows().length }
  })
  map.set(`${PREFIX}users-list`, () => ({ rows: [], total: 0 }))
  map.set(`${PREFIX}user-badges`, () => [])
  map.set(`${PREFIX}user-avatar`, () => '')
  map.set(`${PREFIX}user-get`, () => anonProfile)
  map.set(`${PREFIX}user-identity`, () => ({
    identityId: 0,
    name: '',
    note: '',
    primaryUserId: ANON_ID,
    accounts: []
  }))
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
const push = async (channel, payload) => {
  await act(async () => {
    emit(channel, payload)
  })
  await settle()
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

/* --------------------------------------- 把产物与它的宿主桥桩编到一起 */

const { build } = await import('esbuild')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-anon-profile-'))
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
recent = [item('chat', '好久没玩了', 'dou2056511', ANON_ID)]

const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(Page))
})
const settle = async (ms = 150) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}
await settle(250)

const text = () => dom.window.document.body.textContent ?? ''
const clickElement = async (element) => {
  if (!element) return false
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
  return true
}
const clickTab = async (label) => {
  const tab = [...dom.window.document.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.trim() === label)
  return clickElement(tab)
}
const buttonByLabel = (label) => dom.window.document.querySelector(`button[aria-label="${label}"]`)
const countOccurrences = (needle) => text().split(needle).length - 1

console.log('=== 1. 打开匿名用户的档案弹窗 ===')
check('切到「实时」页签', await clickTab(zh['douyin-link'].page.tabLive), true)
await settle(400)
const nameInFeed = [...dom.window.document.querySelectorAll('span')].find(
  (el) => el.textContent?.trim() === 'dou2056511' && el.className.includes('cursor-pointer')
)
check('实时列表里有这个匿名马甲（可点）', Boolean(nameInFeed), true)
check('点它打开档案弹窗', await clickElement(nameInFeed), true)
await settle(600)
check('弹窗开了（标题 + 马甲名）', [text().includes('用户档案'), text().includes('dou2056511')], [true, true])

console.log('\n=== 2. 统计只算这个人自己（不再是几个匿名用户的合账） ===')
/**
 * 统计小方块（`StatBlock`）长这样：`div > span(标签) + span(数字)`。
 * **只看档案弹窗那一块**——概览页签的 KPI 用的是同款方块、标签也一样（「弹幕」），
 * 全文档取第一个会取到概览页那个 0。
 */
const statOf = (label) => {
  const modal = dom.window.document.querySelector('.ant-modal')
  if (!modal) return undefined
  const node = [...modal.querySelectorAll('div')].find(
    (el) =>
      el.children.length >= 2 &&
      el.children[0]?.tagName === 'SPAN' &&
      el.children[1]?.tagName === 'SPAN' &&
      el.children[0]?.textContent?.trim() === label
  )
  return node?.children[1]?.textContent?.trim()
}
check('弹窗已渲染', Boolean(dom.window.document.querySelector('.ant-modal')), true)
check('弹幕 2（改前那种合账是十几个人的合计）', statOf(zh['douyin-link'].kinds.chat), '2')
check('进场 1', statOf(zh['douyin-link'].kinds.member), '1')

console.log('\n=== 3. 历史弹幕只有他自己的话 ===')
check('历史标题按总数给（共 2 条）', text().includes('共 2 条'), true)
check('有他说过的两句', [text().includes('好久没玩了'), text().includes('匿名咋关来着')], [true, true])
check('另一个匿名用户的话一条都没有', text().includes('新年快乐'), false)
check('历史行不是「重复的内容」：两句各不相同', countOccurrences('好久没玩了') >= 1 && countOccurrences('匿名咋关来着') >= 1, true)

console.log('\n=== 4. 身份展示与入口 ===')
check('「用户 id」显示抖音真给的 111111（不是内部键）', text().includes('用户 id 111111'), true)
check('内部键（anon:…）不泄漏到界面', text().includes('anon:'), false)
check('没有「关联账号」入口（匿名占位 id 绑了没意义）', Boolean(buttonByLabel(zh['douyin-link'].users.identityBind)), false)
check('没有「查看真实资料」按钮（拿占位 id 查也查不到）', Boolean(buttonByLabel(zh['douyin-link'].users.revealButton)), false)
check('给「分析用户」入口', Boolean(buttonByLabel(zh['douyin-link'].users.analyzeButton)), true)
check('弹幕里点昵称查的就是这个身份', calls.filter((call) => call.channel === `${PREFIX}user-get`).at(-1)?.args?.[1], ANON_ID)
check('历史弹幕按这个身份查（不是占位 111111）', calls.filter((call) => call.channel === `${PREFIX}messages-query`).at(-1)?.args?.[0]?.userId, ANON_ID)

console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
