/**
 * 离线渲染验证：**实时列表行首那截人物信息**（用户 2026-10-11：「弹幕 tab 的用户和进场的用户
 * tab 前面的人物要显示等级，消费评分，入场次数，今天消费」）。
 *
 * 这一截有四个数，来源分三层（见 `shared/types.ts` 的 `UserBadge`）：
 * - 等级：本房间档案行的荣誉等级（主进程给）；
 * - 消费评分：本房间累计抖币 + 送礼次数 → `shared/score.ts`（与画像「消费力」同一算法）；
 * - 入场次数 / 今日消费：**跨全部直播间**（渲染层手上没有，只能主进程算 → `api.userBadges`）。
 *
 * 界面这边要验四件事（把**真产物**挂进 jsdom 跑）：
 * 1. 弹幕行与进场行都显示这四个数，格式对（`Lv12 · 消费 87 · 进场 5 · 今日 1.2万`，万以上折「万」）；
 * 2. **批量**：当前可见行一次问回来，不是每行一个请求；
 * 3. **只有弹幕/进场两类行**显示（关注/点赞/礼物不显示；今日 0 照实显示 0）；
 * 4. 新来的弹幕（新人）会被补问一次，数字到了那截就出现。
 *
 * 跑法（先构建，产物要与源码同步）：
 *   node scripts/build.mjs --plugin douyin-link
 *   node plugins/douyin-link/spike/feed-user-stats-check.mjs
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

/** jsdom 是宿主仓库的依赖（本仓库不装它）：没有就联一条过去 */
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
const CHAT = '500000000012'
const JOIN = '500000000011'
const LATER = '500000000013'
const SOCIAL = '500000000014'
const THROTTLE = '500000000015'
const calls = []
const subs = new Map()

/** 主进程会回的那个人物信息（等级 / 消费评分 / 入场次数 / 今日消费） */
const BADGES = {
  [CHAT]: { honorLevel: 12, fansClubLevel: 0, spendScore: 87, diamonds: 100, giftCount: 1, enterTotal: 5, todayDiamonds: 12345, fromStore: true },
  [JOIN]: { honorLevel: 30, fansClubLevel: 0, spendScore: 100, diamonds: 250000, giftCount: 40, enterTotal: 42, todayDiamonds: 0, fromStore: true },
  [LATER]: { honorLevel: 7, fansClubLevel: 0, spendScore: 22, diamonds: 20, giftCount: 1, enterTotal: 3, todayDiamonds: 6, fromStore: true },
  [SOCIAL]: { honorLevel: 99, fansClubLevel: 0, spendScore: 99, diamonds: 9, giftCount: 1, enterTotal: 9, todayDiamonds: 9, fromStore: true },
  [THROTTLE]: { honorLevel: 3, fansClubLevel: 0, spendScore: 33, diamonds: 30, giftCount: 1, enterTotal: 2, todayDiamonds: 30, fromStore: true }
}

let sessionId = 1
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
    sessionId,
    counters: { chat: 2, enter: 1, like: 0, follow: 0, gift: 0 },
    received: 3,
    rate: 0,
    sessionUsers: 3,
    stored: { messages: 3, users: 3, sessions: 1 },
    addedAt: Date.now(),
    lastActiveAt: Date.now(),
    lastSeenAt: Date.now()
  }
}

let seq = 0
const item = (kind, text, user, userId) => {
  seq += 1
  return { id: seq, kind, user, userId, text, count: 0, diamonds: 0, toUser: '', toUserId: '', at: Date.now() }
}

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
  map.set(`${PREFIX}user-badges`, (_webRid, ids) => {
    // 主进程回的每条都带 `userId`（渲染层按它建表），所以这里也补上
    const rows = (Array.isArray(ids) ? ids : [])
      .filter((id) => BADGES[id])
      .map((id) => ({ userId: id, ...BADGES[id] }))
    console.log(`  [stub] user-badges(${JSON.stringify(ids)}) → ${JSON.stringify(rows.map((row) => row.userId))}`)
    return rows
  })
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

/* --------------------------------------- 把产物与它的宿主桥桩编到一起（同 settings 工装） */

const { build } = await import('esbuild')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-feed-stats-'))
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
/** 快照里的最近消息：**新 → 旧**（主进程契约）；两条都是要显示那截信息的类型 */
recent = [item('member', '', '阿进场', JOIN), item('chat', '今天人真多', '阿弹幕', CHAT)]

const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(Page))
})
const settle = async (ms = 120) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}
await settle(250)

const text = () => dom.window.document.body.textContent ?? ''
const clickTab = async (label) => {
  const tab = [...dom.window.document.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.trim() === label)
  if (!tab) return false
  await act(async () => {
    tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
  return true
}
/** 实时列表内部那排分类（弹幕/进场/关注/点赞/礼物）是 antd Segmented，按文字点它 */
const clickView = async (label) => {
  const seg = [...dom.window.document.querySelectorAll('.ant-segmented-item')].find(
    (el) => el.textContent?.trim() === label
  )
  if (!seg) return false
  await act(async () => {
    seg.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    const input = seg.querySelector('input')
    if (input) {
      input.checked = true
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    }
  })
  await settle(200)
  return true
}
const badgeCalls = () => calls.filter((call) => call.channel === `${PREFIX}user-badges`)
const countOf = (needle) => text().split(needle).length - 1
/** 断言失败时把页面文字打一截出来（省得靠猜） */
const dump = () => console.log(`  [调试] 页面文字：${text().replace(/\s+/g, ' ').slice(-500)}`)

console.log('=== 1. 实时页签 →「弹幕」分类：那一行带上四个数 ===')
check('切到「实时」页签', await clickTab(zh['douyin-link'].page.tabLive), true)
await settle(1800)
if (!text().includes('Lv12')) dump()
check('弹幕行的等级', text().includes('Lv12'), true)
check('弹幕行的消费评分', text().includes('消费 87'), true)
check('弹幕行的入场次数', text().includes('进场 5'), true)
check('弹幕行的今日消费（12345 → 1.2万）', text().includes('今日 1.2万'), true)
check('这一屏只问了可见的那个人（1 次、1 个 id）', badgeCalls().length, 1)
check('问的就是弹幕行那个人', badgeCalls()[0]?.args?.[1], [CHAT])

console.log('\n=== 2. 切到「进场」分类：进场行也有这四个数（今日 0 照实显示）===')
check('切到「进场」分类', await clickView(zh['douyin-link'].kinds.member), true)
await settle(1200)
if (!text().includes('Lv30')) dump()
check('进场行的等级', text().includes('Lv30'), true)
check('进场行的消费评分', text().includes('消费 100'), true)
check('进场行的入场次数', text().includes('进场 42'), true)
check('今日 0 照实显示（不是藏起来）', text().includes('今日 0'), true)
check('进场行的 id 被补问了', badgeCalls().at(-1)?.args?.[1] ?? [], [JOIN])

console.log('\n=== 3. 「关注」行不显示这一截（它有自己的重点）===')
await push(`${PREFIX}messages`, { webRid: ROOM, items: [item('social', '', '阿关注', SOCIAL)] })
await settle(600)
check('切到「关注」分类', await clickView(zh['douyin-link'].kinds.social), true)
await settle(1200)
if (!text().includes('阿关注')) dump()
check('关注行渲染出来了', text().includes('阿关注'), true)
check('关注行不带这截（虽然主进程也给了他的数字）', text().includes('Lv99'), false)
check('「消费 」这一屏一次都不出现', countOf('消费 '), 0)

console.log('\n=== 4. 新来的弹幕（新人）会被补问一次，数字到了就显示 ===')
check('切回「弹幕」分类', await clickView(zh['douyin-link'].kinds.chat), true)
const beforeNew = badgeCalls().length
await push(`${PREFIX}messages`, { webRid: ROOM, items: [item('chat', '刚来', '阿后来', LATER)] })
await settle(900)
const afterNew = badgeCalls()
console.log(
  `  user-badges：新增 ${afterNew.length - beforeNew} 次，最后一次带的 id：${JSON.stringify(afterNew.at(-1)?.args?.[1] ?? [])}`
)
check('新人被补进请求', (afterNew.at(-1)?.args?.[1] ?? []).includes(LATER), true)
check('新人的那截显示出来了（Lv7 / 进场 3）', [text().includes('Lv7'), text().includes('进场 3')], [true, true])
check('这一屏两行都带这截信息', countOf('消费 '), 2)

console.log('\n=== 5. 节流：刚问过的人短时间内不重复问（别把主进程的查询排满）===')
const beforeThrottle = badgeCalls().length
await push(`${PREFIX}messages`, { webRid: ROOM, items: [item('chat', '第一句', '阿节流', THROTTLE)] })
await settle(900)
const afterFirstAsk = badgeCalls().length
check('新人第一次被问了一次', afterFirstAsk - beforeThrottle, 1)
await push(`${PREFIX}messages`, { webRid: ROOM, items: [item('chat', '第二句', '阿节流', THROTTLE)] })
await settle(900)
check('同一人 5 秒内再说话：没有再发请求', badgeCalls().length, afterFirstAsk)
check('那一行照旧带着之前问到的数字', text().includes('Lv3') || text().includes('消费 33'), true)

console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
