/**
 * 离线渲染验证：**概览「发言榜」的名字可以点开用户档案**（用户 2026-10-11：
 * 「所有发言榜需要增加点击名字查看个人档案」）。
 *
 * 断言打在**真产物**（`dist/douyin-link/renderer.mjs`）上，跟 `overview-range-check.mjs` 同一套桩：
 *
 * 1. 发言榜里每个人名都是一个可点的元素（`button` / `[role=button]`），带 `title` 说明点了会怎样，
 *    而且那个 title 就是「点击查看这个人的用户档案」（= 两张礼物榜点名字时的同一句话）；
 * 2. **点名字** → 用户档案弹窗打开，里面是这个人的昵称（弹窗标题来自 `user-get` 的回话）；
 * 3. **点这一行别处**（条形 / 数字）→ 弹窗**不开**（发言榜这一行没有第二个动作，
 *    整行不该跟着变成「打开档案」的点击面）；
 * 4. 两张礼物榜的既有口径没被带坏：点**名字**开档案，点**行本身**开的是礼物历史（两个弹窗互不干扰）。
 *
 * 跑法（先构建，产物要与源码同步）：
 *   node scripts/build.mjs --plugin douyin-link
 *   node plugins/douyin-link/spike/rank-profile-check.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const distDir = process.env.DY_DIST ? process.env.DY_DIST.replace(/^\/([A-Za-z]:)/, '$1') : join(ROOT, 'dist/douyin-link')
const bundlePath = join(distDir, 'renderer.mjs')
/** 插件自带的样式表（截图自检要用它，否则版式全塌） */
const pluginCssPath = join(distDir, 'plugin.css')
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
const { dayBucketOf } = await import(pathToFileURL(join(ROOT, 'plugins/douyin-link/shared/gift-calendar.ts')).href)

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

/** 概览页签会挂 ECharts（CanvasRenderer）：给个什么都不做的 2d 上下文 */
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
dom.window.Element.prototype.getBoundingClientRect = function () {
  return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 10, width: 1000, height: 10, toJSON() { return this } }
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
const CHAT_USERS = [
  { userId: '7001', nickname: '发言第一名', chat: 40 },
  { userId: '7002', nickname: '发言第二名', chat: 12 }
]
/** 礼物榜的行用的是 `GiftRankRow`（字段是 `name`，不是 `nickname`——第一版工装写错了） */
const GIFT_ROWS = [{ userId: '8001', name: '收礼的人', count: 3, diamonds: 300, lastAt: 1 }]

/**
 * 「某一天的礼物明细」的工装数据：**一条送出 + 一条收到**（用户报的就是只给送出那种）。
 *
 * 行形状是 `GiftHistoryRow`（`StoredMessage` + 主进程算好的 `direction` / `counterpart`）。
 */
const GIFT_HISTORY = [
  {
    id: 1,
    webRid: '880000000001',
    kind: 'gift',
    user: '发言第一名',
    userId: '7001',
    toUser: '收礼的人',
    toUserId: '8001',
    text: '跑车',
    count: 1,
    diamonds: 1200,
    at: new Date(2026, 9, 9, 20, 0).getTime(),
    direction: 'sent',
    counterpart: '收礼的人',
    counterpartId: '8001'
  },
  {
    id: 2,
    webRid: '880000000001',
    kind: 'gift',
    user: '送礼的人',
    userId: '8001',
    toUser: '发言第一名',
    toUserId: '7001',
    text: '大啤酒',
    count: 1,
    diamonds: 500,
    at: new Date(2026, 9, 9, 21, 0).getTime(),
    direction: 'received',
    counterpart: '送礼的人',
    counterpartId: '8001'
  }
]

/**
 * 日历数据里那几天的日桶号：**与插件同一份实现**算出来（`shared/gift-calendar.ts`），
 * 不用手写常量——桶号算错一天，界面就会把数据画到隔壁格子（工装 A 段就是在钉这件事）。
 */
const BUCKET_1008 = dayBucketOf(new Date(2026, 9, 8, 12).getTime())
const BUCKET_1009 = dayBucketOf(new Date(2026, 9, 9, 12).getTime())
const BUCKET_0920 = dayBucketOf(new Date(2026, 8, 20, 12).getTime())

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

/** 概览要用的聚合：发言榜两个人 + 收礼物榜一个人（礼物榜用来验「既有口径没被带坏」） */
const summary = () => ({
  webRid: ROOM,
  windowMinutes: 60,
  totals: { chat: 52, enter: 1, like: 2, follow: 3, gift: 3 },
  messages: 60,
  users: 3,
  firstAt: Date.now() - 3600_000,
  lastAt: Date.now(),
  series: [{ minute: Date.now() - 60000, chat: 52, member: 1, like: 2, social: 3, gift: 3 }],
  kinds: [{ kind: 'chat', count: 52 }],
  diamonds: 300,
  gifts: [],
  received: GIFT_ROWS,
  sent: GIFT_ROWS,
  topChat: CHAT_USERS.map((row) => ({
    userId: row.userId,
    nickname: row.nickname,
    stats: { chat: row.chat, enter: 0, like: 0, follow: 0, gift: 0, diamonds: 0 }
  }))
})

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
  map.set(`${PREFIX}room-summary`, () => summary())
  map.set(`${PREFIX}messages-query`, () => ({ rows: [], total: 0 }))
  map.set(`${PREFIX}users-list`, () => ({ rows: [], total: 0 }))
  map.set(`${PREFIX}user-get`, (webRid, userId) => {
    const hit = [...CHAT_USERS, ...GIFT_ROWS].find((row) => row.userId === userId)
    return hit
      ? {
          userId,
          nickname: hit.nickname ?? hit.name ?? '',
          /** 跨全部直播间的互动合计：**送礼 / 收礼各一个**抖币数（工装数据，好认） */
          stats: {
            userId,
            chat: 8,
            enter: 3,
            like: 2,
            follow: 1,
            gift: 1,
            diamonds: 1200,
            receivedDiamonds: 1300
          }
        }
      : null
  })
  /*
   * 「每日收益」日历：2026-10 有记录的是 8 号（送 1200 / 收 100）与 9 号（只收 500）；
   * 有记录的月份清单给两个月，用来验「上月/下月」能翻。
   */
  map.set(`${PREFIX}user-gift-calendar`, (_userId, month) => {
    const target = month || '2026-10'
    const days =
      target === '2026-10'
        ? [
            { day: '2026-10-08', bucket: BUCKET_1008, sent: 1200, received: 100, sentGifts: 1, receivedGifts: 2 },
            { day: '2026-10-09', bucket: BUCKET_1009, sent: 0, received: 500, sentGifts: 0, receivedGifts: 1 }
          ]
        : [{ day: '2026-09-20', bucket: BUCKET_0920, sent: 0, received: 700, sentGifts: 0, receivedGifts: 1 }]
    return { month: target, months: ['2026-10', '2026-09'], days }
  })
  map.set(`${PREFIX}user-identity`, () => null)
  /*
   * 礼物历史：**按方向给不同的数据**——`both` 时两条都给（一条送的、一条收的），
   * 单一方向时只给对应的那条。这样界面如果偷偷把 `both` 当成 `sent`，断言就会缺一条。
   */
  map.set(`${PREFIX}gift-history`, (_webRid, _userId, direction) => {
    const rows =
      direction === 'both'
        ? GIFT_HISTORY
        : GIFT_HISTORY.filter((row) => row.direction === (direction === 'received' ? 'received' : 'sent'))
    return { rows, total: rows.length }
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

/** 主进程回话里记录了哪些查询（断言「点名字真的去查了这个人」） */
const calls = []
dom.window.api = {
  plugin: {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args })
      const handler = handlers().get(channel)
      return handler ? handler(...args) : null
    },
    on: () => () => {},
    off: () => {},
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

/* --------------------------------------- 把产物与它的宿主桥桩编到一起（同 overview 工装） */

const { build } = await import('esbuild')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-rank-'))
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

/**
 * 把**真产物渲染出来的 DOM**（不是手写的仿制品）连同**插件自带的 plugin.css** 落成一个 HTML 文件，
 * 用来给人/截图看版式：jsdom 量不到像素（`getBoundingClientRect` 全是 0），所以「有没有撑高、
 * 两列分不分得开」这类事只能靠眼睛。默认写到临时目录，用完删。
 */
const snap = (name, node) => {
  if (!node) return ''
  const css = existsSync(pluginCssPath) ? readFileSync(pluginCssPath, 'utf8') : ''
  const file = join(tmpdir(), `douyin-snap-${name}.html`)
  writeFileSync(
    file,
    `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${css}</style>` +
      `<style>body{margin:0;background:#141414;padding:16px;font-family:"Microsoft YaHei",sans-serif}.ant-modal{position:static!important;width:auto!important;margin:0!important}.ant-modal-content{background:#1f1f1f}.ant-modal-body{padding:12px!important}</style>` +
      `</head><body>${node.outerHTML}</body></html>`,
    'utf8'
  )
  return file
}

const Page = (await route.load()).default
const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(Page))
})
const settle = async (ms = 200) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}
await settle(600)

const doc = dom.window.document
const click = async (element) => {
  if (!element) return false
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle(450)
  return true
}

/** 按卡片标题找面板（标题文案唯一） */
const cardByTitle = (title) =>
  [...doc.querySelectorAll('.ant-card')].find(
    (card) => card.querySelector('.ant-card-head-title')?.textContent?.trim() === title
  )
const rankRows = (title) => {
  const card = cardByTitle(title)
  if (!card) return []
  const scroller = card.querySelector('[data-rb-scroll]') ?? card.querySelector('.ant-card-body')
  return [...(scroller?.children ?? [])]
}
/**
 * 弹窗（antd Modal）里显示的字：**只看最后那一个**。
 * antd 关掉的弹窗会留在 DOM 里（`display:none`），拼所有弹窗会把上一次的内容也读进来
 * （第一版工装就踩了这个：读到的其实是已经关掉的那个）。
 */
const modalText = () => {
  const modals = [...doc.querySelectorAll('.ant-modal')]
  return modals.length > 0 ? (modals[modals.length - 1].textContent ?? '') : ''
}
/** 行里的可点元素：**行自己**可能就是按钮（礼物榜），也可能名字才是（发言榜） */
const clickableIn = (row) =>
  row?.matches?.('button, [role="button"]')
    ? row
    : (row?.querySelector('button') ?? row?.querySelector('[role="button"]') ?? row?.querySelector('[tabindex]'))

console.log('=== 1. 发言榜的人名是可点的 ===')
const chatRows = rankRows(zh['douyin-link'].page.topChat)
check('发言榜有两行（工装数据）', chatRows.length, 2)
check('第一行的名字在可点元素里', (clickableIn(chatRows[0])?.textContent ?? '').trim(), CHAT_USERS[0].nickname)
check(
  '可点元素的提示就是「点击查看这个人的用户档案」',
  clickableIn(chatRows[0])?.getAttribute('title'),
  zh['douyin-link'].page.rankNameHint
)
check(
  '第二行同理',
  [clickableIn(chatRows[1])?.textContent?.trim(), clickableIn(chatRows[1])?.getAttribute('title')],
  [CHAT_USERS[1].nickname, zh['douyin-link'].page.rankNameHint]
)

console.log('\n=== 2. 点名字 → 打开用户档案 ===')
await click(clickableIn(chatRows[1]))
const afterName = modalText()
check('弹窗打开了', afterName.length > 0, true)
check('弹窗里是这个名字', afterName.includes(CHAT_USERS[1].nickname), true)
check(
  '确实按这个人的 id 查了档案',
  calls.some((entry) => entry.channel === `${PREFIX}user-get` && entry.args[1] === CHAT_USERS[1].userId),
  true
)
check('标题是「用户档案」那块', afterName.includes(zh['douyin-link'].users.profileTitle ?? '用户档案'), true)

/* 关掉当前弹窗（返回「确实点到了关闭」） */
const closeModal = async () => {
  const closer = doc.querySelector('.ant-modal-close')
  if (!closer) return false
  await click(closer)
  return true
}
/* 关掉弹窗，回到榜单 */
await closeModal()

console.log('\n=== 3. 点这一行别处（条形 / 数字）→ 不打开档案 ===')
calls.length = 0
const barOfChat = chatRows[0].querySelectorAll('span')
await click(barOfChat[barOfChat.length - 1])
check('点数字没弹档案', modalText().includes(CHAT_USERS[0].nickname), false)
check(
  '也没去查档案',
  calls.some((entry) => entry.channel === `${PREFIX}user-get`),
  false
)

console.log('\n=== 4. 礼物榜的既有口径没被带坏 ===')
/*
 * 两张礼物榜的一行本身就是按钮（整行 = 看这个人的礼物历史），**名字是嵌在里面的 span**
 * （点名字 = 开档案，`stopPropagation` 把两件事分开，见 `GiftRankBoard` 的注释）。
 * 所以这里要显式区分「行按钮」与「里面的名字」，别像发言榜那样一律取第一个可点元素。
 */
const giftRows = rankRows(zh['douyin-link'].page.giftReceivedBoard)
const sentRows = rankRows(zh['douyin-link'].page.giftSentBoard)
check('收礼物榜有一行（工装数据）', giftRows.length, 1)
check('送礼物榜有一行（工装数据）', sentRows.length, 1)
const giftRowButton = clickableIn(sentRows[0])
const giftNameSpan = [...(giftRowButton?.querySelectorAll('span') ?? [])].find(
  (node) => (node.textContent ?? '').trim() === GIFT_ROWS[0].name
)
check('礼物榜那一行里能找到嵌着的名字', Boolean(giftNameSpan), true)
await click(giftNameSpan)
/* 弹窗挂载后的 effect 才会去查档案：先抄下来再清空 `calls`（清在前面会把这次查询也抹掉） */
const giftNameCalls = calls.slice()
calls.length = 0
check(
  '礼物榜点名字 → 还是开档案（按收礼人的 id 去查档案）',
  giftNameCalls.some((entry) => entry.channel === `${PREFIX}user-get` && entry.args[1] === GIFT_ROWS[0].userId),
  true
)
check(
  '而且没有顺带开礼物历史（两个动作分得清）',
  giftNameCalls.some((entry) => entry.channel === `${PREFIX}gift-history`),
  false
)

await closeModal()
calls.length = 0
check('点礼物榜整行', await click(giftRowButton), true)
check(
  '礼物榜点整行 → 开的是礼物历史（不是档案）',
  calls.some((entry) => entry.channel === `${PREFIX}gift-history`),
  true
)
check('而且这一下没有顺手去查这个人的档案', calls.some((entry) => entry.channel === `${PREFIX}user-get`), false)

/* ---------------------------------------------------------- 5. 互动统计 / 每日收益 */
/*
 * 用户 2026-10-11：「这个互动统计（本房间累计）需要所有直播间统计，并且礼物价值要改成送礼和
 * 收礼两个统计，点击后可以查看每一个月的每一天送礼和收礼的抖币」。
 */
console.log('\n=== 5. 互动统计：跨直播间 + 礼物价值拆成送礼 / 收礼 ===')
await closeModal()
await click(doc.querySelector('.ant-modal-close'))
calls.length = 0
await click(clickableIn(chatRows[0]))
await settle(300)

/** 2026-10-01 是周四（表头周一起 → 前面该有 3 个空位） */
const octoberFirstWeekdayOffset = () => (new Date(2026, 9, 1).getDay() + 6) % 7

/** 档案弹窗里那一块统计（找含「互动统计」的那张卡） */
const profileModal = () => [...doc.querySelectorAll('.ant-modal')].pop()
const bodyText = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ')
const profileText = bodyText(profileModal())
check(
  '标题写着「全部直播间」而不是「本房间」',
  profileText.includes(zh['douyin-link'].users.statsTitle),
  true
)
check('标题里不再出现「本房间累计」', profileText.includes('本房间累计'), false)
const giftBlock = [...(profileModal()?.querySelectorAll('button') ?? [])].find((node) =>
  bodyText(node).includes(zh['douyin-link'].page.kpiDiamonds)
)
check('礼物价值那一块是个按钮（可点）', Boolean(giftBlock), true)
/*
 * 用户 2026-10-11 第二轮：「超出了高度了…不需要文字了送礼和收礼这两个文字了，我只要数字即可」。
 * 所以这一格里**只有两个数字**，两个都是**定死在块内两半、居中**的（`data-rb-gift-*` 是标记锚点），
 * 并且**不再出现「送礼 / 收礼」这两个词的可见文本**（含义改由悬浮提示承载）。
 */
const sentNode = giftBlock?.querySelector('[data-rb-gift-sent]')
const receivedNode = giftBlock?.querySelector('[data-rb-gift-received]')
check('两个数字都在（各有自己的锚点）', [Boolean(sentNode), Boolean(receivedNode)], [true, true])
check('左边那个是送礼 1,200', (sentNode?.textContent ?? '').trim(), '1,200')
check('右边那个是收礼 1,300', (receivedNode?.textContent ?? '').trim(), '1,300')
check(
  '格子里没有「送礼 / 收礼」这两个词（只剩数字）',
  [bodyText(giftBlock).includes(zh['douyin-link'].users.statsGiftSent), bodyText(giftBlock).includes(zh['douyin-link'].users.statsGiftReceived)],
  [false, false]
)
/*
 * 「横排」在 jsdom 里**量不到**（工装的 `getBoundingClientRect` 对所有元素给同一个矩形），
 * 所以这里只钉结构：两个数字是**同一个 flex 行**里的兄弟，各占一半（`flex-1`）——
 * 真正的像素版式看 `snap()` 落出来的那张快照（同目录的截图自检）。
 */
check(
  '两个数字是同一个 flex 行里的兄弟、各占一半（横排结构）',
  [
    Boolean(sentNode?.parentElement) && sentNode?.parentElement === receivedNode?.parentElement,
    (sentNode?.parentElement?.className ?? '').includes('flex'),
    [sentNode?.className.includes('flex-1'), receivedNode?.className.includes('flex-1')]
  ],
  [true, true, [true, true]]
)
/*
 * 高度对齐：旁边四个块都是「一行标签 + 一行数字」，礼物那格也必须是**两行**的高度
 * （标签 + 一行数字），不能再多出第三行——工装能数的是子元素层数，像素高度在 jsdom 里都是 0。
 */
check(
  '礼物格结构 = 标签行 + 数字行（没有多出来的第三行）',
  [...(giftBlock?.children ?? [])].map((node) => node.querySelectorAll('span').length),
  [0, 2]
)
check(
  '悬浮提示写清了两个数字是什么（含义不靠格子里的文字）',
  giftBlock?.getAttribute('title'),
  zh['douyin-link'].users.giftCalendarHint.replace('{{sent}}', zh['douyin-link'].users.statsGiftSent).replace('{{received}}', zh['douyin-link'].users.statsGiftReceived)
)
/* 留一张「真 DOM + 真 plugin.css」的快照给眼睛看（暗色主题，与用户截图一致） */
console.log(`  版式快照：${snap('profile-stats', profileModal())}`)

console.log('\n=== 6. 点礼物价值 → 「每日收益」日历弹窗 ===')
calls.length = 0
await click(giftBlock)
const calendarCalls = calls.slice()
const calendarModal = () => {
  const hit = [...doc.querySelectorAll('.ant-modal')].find((node) =>
    bodyText(node).includes(zh['douyin-link'].users.giftCalendarMonthTotal.split('{{')[0])
  )
  return hit ?? null
}
check('确实去查了这个人的日历', calendarCalls.some((entry) => entry.channel === `${PREFIX}user-gift-calendar`), true)
check('日历弹窗打开了', Boolean(calendarModal()), true)
const calendarText = bodyText(calendarModal())
check('标题是「每日收益」', calendarText.includes('每日收益'), true)
check('回的是 2026-10', calendarText.includes('2026-10'), true)
check('给了星期表头', zh['douyin-link'].users.weekdayMon.length > 0 && calendarText.includes(zh['douyin-link'].users.weekdayTue), true)
check('本月合计写在月份条右边（送 1,200 / 收 600）', calendarText.includes('1,200') && calendarText.includes('600'), true)

/**
 * 日历格子：只认**日期格子**——它们带 `data-rb-row`（月份清单那几颗按钮没有），
 * 光看「文字以数字开头」会把 `2026-09` 那颗也算进来（第一版就是这么错了一位）。
 */
const dayCells = [...(calendarModal()?.querySelectorAll('button[data-rb-row]') ?? [])]
check('日历里有 31 个格子（10 月）', dayCells.length, 31)
const cellOf = (day) => dayCells.find((node) => (node.textContent ?? '').trim().startsWith(String(day)))
check('8 号格子：送礼 1.2k、收礼 100', [bodyText(cellOf(8)).includes('1.2k'), bodyText(cellOf(8)).includes('100')], [true, true])
/*
 * 9 号只收过礼：送礼那一行必须是**空点**（`·`），不是「0」——
 * 格子里的三个 span 依次是「几号 / 送礼 / 收礼」，直接看后两个。
 */
const amountsOf = (cell) => [...(cell?.querySelectorAll('span') ?? [])].slice(1).map((node) => (node.textContent ?? '').trim())
check('9 号格子：送礼那行是空点、收礼是 500', amountsOf(cellOf(9)), ['·', '500'])
check('8 号格子：两行都有数', amountsOf(cellOf(8)), ['1.2k', '100'])

/*
 * 「股票每日收益」那种日历最容易错的是**排位**：7 列、周一起、1 号要落在正确的星期那一列。
 * jsdom 量不到像素，但数格子能数清——格子总数 = 前面的空位 + 当月天数，而且第一个格子
 * 紧跟在空位之后（也就是它落在「星期几」那一列）。
 */
const calendarGrid = [...(calendarModal()?.querySelectorAll('.grid') ?? [])].find(
  (node) => node.querySelectorAll('button[data-rb-row]').length > 0
)
const cellCount = calendarGrid?.children.length ?? -1
/* 2026-10-01 是周四 → 周一起的表头前面该有 3 个空位；总格子 = 3 + 31 = 34（不必是 7 的整数倍） */
check('格子数 = 补位 + 当天天数（31）', cellCount - 31, octoberFirstWeekdayOffset())
check('1 号落在它该在的那一列', dayCells[0]?.textContent?.trim().startsWith('1'), true)
check('最后一格是 31 号', (dayCells[30]?.textContent ?? '').trim().startsWith('31'), true)
check('表头 7 列（周一起）', calendarGrid?.className.includes('grid-cols-7'), true)

console.log('\n=== 7. 点某一天 → 那一天的礼物明细 ===')
calls.length = 0
await click(cellOf(9))
const dayCalls = calls.slice()
check(
  '点 9 号 → 查的是那一天的礼物历史',
  dayCalls.some((entry) => entry.channel === `${PREFIX}gift-history`),
  true
)
const historyCall = dayCalls.find((entry) => entry.channel === `${PREFIX}gift-history`)
check('而且范围就是本地 10-09 那一整天', Boolean(historyCall), true)
if (historyCall) {
  const [from, to] = [historyCall.args[5], historyCall.args[6]]
  const start = new Date(from)
  const end = new Date(to)
  check(
    '起止是同一天的 00:00:00 → 23:59:59',
    [
      start.toDateString(),
      start.getHours(),
      start.getMinutes(),
      end.getDate() === start.getDate() && end.getHours() === 23 && end.getMinutes() === 59
    ],
    [new Date(2026, 9, 9).toDateString(), 0, 0, true]
  )
}
check(
  '日历还开着（明细叠在上面，不是把它顶掉）',
  Boolean(calendarModal()),
  true
)
check('而且明细弹窗也开了', dayCalls.filter((entry) => entry.channel === `${PREFIX}gift-history`).length, 1)
/*
 * 用户 2026-10-11：「礼物历史只能看见送的，没有收的」——日历那格同时写着送礼与收礼两个数，
 * 点开明细就必须**两个方向都给**（`direction='both'`），并且逐行标出方向。
 */
check('明细问的是「两个方向都要」（不是只要送的）', historyCall?.args[2], 'both')
const historyModal = [...doc.querySelectorAll('.ant-modal')].find((node) =>
  bodyText(node).includes(zh['douyin-link'].page.giftHistoryBoth)
)
check('明细弹窗标题行写着「送出与收到」', Boolean(historyModal), true)
const historyText = bodyText(historyModal)
check('送出的那条在（带 → 指向对方）', historyText.includes(`→ ${GIFT_HISTORY[0].toUser}`), true)
check('收到的那条也在（带 ← 指向对方）', historyText.includes(`← ${GIFT_HISTORY[1].user}`), true)
check(
  '两条的抖币都画出来了',
  [historyText.includes('1,200'), historyText.includes('500')],
  [true, true]
)

console.log('\n=== 8. 日历能翻到上一个月 ===')
calls.length = 0
const prevButton = [...(calendarModal()?.querySelectorAll('button') ?? [])].find(
  (node) => node.getAttribute('title') === zh['douyin-link'].users.giftCalendarPrev
)
check('有「上一个月」按钮', Boolean(prevButton), true)
check('它在有更早的月份时是可点的', prevButton?.disabled, false)
/*
 * 明细弹窗还叠在上面，先把两层都关掉再翻月（关两次：明细 → 日历）。
 * 翻月走月份清单里的那颗按钮（比箭头更好找，也是同一套逻辑）。
 */
await closeModal()
await closeModal()
calls.length = 0
const septButton = [...(calendarModal()?.querySelectorAll('button') ?? [])].find(
  (node) => (node.textContent ?? '').trim() === '2026-09'
)
check('月份清单里有 2026-09', Boolean(septButton), true)
await click(septButton)
check(
  '翻月查的是 2026-09',
  calls.some((entry) => entry.channel === `${PREFIX}user-gift-calendar` && entry.args[1] === '2026-09'),
  true
)
check('翻过去之后回的是 9 月', bodyText(calendarModal()).includes('2026-09'), true)

console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
