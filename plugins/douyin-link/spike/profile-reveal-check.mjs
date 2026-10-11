/**
 * 离线渲染验证：**「查看真实资料」按钮改成和「分析用户」并排的纯图标，点了回填上面的内容**
 * （用户 2026-10-11：「查看真实资料的按钮，要和分析用户按钮一样，放在其旁边，只要图标，
 * 点击后更新用户的信息，回填页面上面的内容，不要独立开个内容」）。
 *
 * 这个工装把**真产物**挂进 jsdom，走一遍真实操作：
 * 点实时列表里的昵称 → 弹窗打开 → 断言
 * 1. 名字行右边是**两枚相邻的纯图标按钮**（`aria-label` 分别是「查看真实资料」「分析用户」，
 *    按钮里一个字都没有）；
 * 2. 原来那块独立的「真实资料」内容不再出现（那句 `revealSecret` 文案已删）；
 * 3. 点图标 → 调 `reveal-mystery` 且把 `(userId, webRid)` 一起传过去（主进程据此回填档案）；
 * 4. 查到之后**上面的内容被回填**：昵称/抖音号/地区/粉丝数换成真实资料（档案重拉了一次），
 *    并多出一行事实（作品 / 获赞 / 认证）；
 * 5. 失败时只给一行失败文案，档案内容**不动**（不写成半截真实资料）。
 *
 * 跑法（先构建，产物要与源码同步）：
 *   node scripts/build.mjs --plugin douyin-link
 *   node plugins/douyin-link/spike/profile-reveal-check.mjs
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
const USER = '500000000012'
const calls = []
const subs = new Map()

/** 我们库里那份档案（回填前）：房间里观察到的昵称/抖音号，粉丝数还是 0 */
const beforeProfile = {
  id: USER,
  displayId: 'room_dy',
  nickname: '房间里的昵称',
  gender: 0,
  signature: '',
  city: '',
  avatar: '',
  following: 0,
  follower: 0,
  honorLevel: 12,
  fansClubLevel: 0,
  badges: [],
  secUid: '',
  firstSeen: Date.now() - 3600_000,
  lastSeen: Date.now(),
  stats: { chat: 3, enter: 1, like: 0, follow: 0, gift: 0, diamonds: 0 }
}

/** 回填之后那份档案：昵称/抖音号/地区/粉丝/关注换成真实资料（工装里由 `revealed` 切换） */
const afterProfile = {
  ...beforeProfile,
  displayId: 'real_dy',
  nickname: '真实昵称',
  gender: 2,
  city: '上海',
  following: 321,
  follower: 12345
}

/** 抖音那边按 id 查回来的真实资料 */
const revealedProfile = {
  userId: USER,
  nickname: '真实昵称',
  displayId: 'real_dy',
  secUid: 'sec-real',
  signature: '真实签名',
  gender: 2,
  region: '上海',
  follower: 12345,
  following: 321,
  awemeCount: 42,
  totalFavorited: 9999,
  verified: '某某认证',
  avatar: 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
}

let sessionId = 1
let revealed = false
/** 让「查看真实资料」返回失败（测失败分支） */
let revealFails = false
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
    counters: { chat: 1, enter: 0, like: 0, follow: 0, gift: 0 },
    received: 1,
    rate: 0,
    sessionUsers: 1,
    stored: { messages: 1, users: 1, sessions: 1 },
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
  map.set(`${PREFIX}user-badges`, () => [])
  map.set(`${PREFIX}user-avatar`, () => '')
  map.set(`${PREFIX}user-get`, () => (revealed ? afterProfile : beforeProfile))
  map.set(`${PREFIX}user-identity`, () => ({
    identityId: 0,
    name: '',
    note: '',
    primaryUserId: USER,
    accounts: [{ userId: USER, nickname: (revealed ? afterProfile : beforeProfile).nickname, displayId: '', avatar: '', identityId: 0, chat: 3, enter: 1, likes: 0, follows: 0, gift: 0, diamonds: 0, firstSeen: 0, lastSeen: 0, rooms: 1 }]
  }))
  map.set(`${PREFIX}reveal-mystery`, () => {
    if (revealFails) return { ok: false, code: 'notFound' }
    revealed = true
    return { ok: true, profile: revealedProfile }
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
const workDir = mkdtempSync(join(tmpdir(), 'douyin-reveal-'))
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
recent = [item('chat', '今天人真多', '房间里的昵称', USER)]

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
const callsOf = (channel) => calls.filter((call) => call.channel === channel)

console.log('=== 1. 打开某个人的档案弹窗 ===')
check('切到「实时」页签', await clickTab(zh['douyin-link'].page.tabLive), true)
await settle(500)
const nameInFeed = [...dom.window.document.querySelectorAll('span')].find(
  (el) => el.textContent?.trim() === '房间里的昵称' && el.className.includes('cursor-pointer')
)
check('实时列表里有这个人的昵称（可点）', Boolean(nameInFeed), true)
check('点昵称打开档案弹窗', await clickElement(nameInFeed), true)
await settle(600)
check('弹窗打开了（标题 + 档案内容）', [text().includes('用户档案'), text().includes('房间里的昵称')], [true, true])

console.log('\n=== 2. 名字行右边：两枚相邻的纯图标按钮 ===')
const revealButton = buttonByLabel(zh['douyin-link'].users.revealButton)
const analyzeButton = buttonByLabel(zh['douyin-link'].users.analyzeButton)
check('有「查看真实资料」按钮', Boolean(revealButton), true)
check('有「分析用户」按钮', Boolean(analyzeButton), true)
check('两枚按钮在同一个容器里（并排）', revealButton?.parentElement === analyzeButton?.parentElement, true)
check(
  '两枚都只要图标（按钮里没有文字）',
  [revealButton?.textContent?.trim() ?? 'x', analyzeButton?.textContent?.trim() ?? 'x'],
  ['', '']
)
check('两枚都有 title（鼠标悬停可见文案）', [revealButton?.getAttribute('title'), analyzeButton?.getAttribute('title')], [zh['douyin-link'].users.revealButton, zh['douyin-link'].users.analyzeButton])

console.log('\n=== 3. 不再有独立的「真实资料」内容块 ===')
check('那句独立的引导文案不在了', text().includes('按用户 id 查一下'), false)
check('也没有「抖音真实资料」那张卡片', text().includes('抖音真实资料'), false)

console.log('\n=== 4. 点图标 → 查资料 + 回填上面的内容 ===')
const beforeGets = callsOf(`${PREFIX}user-get`).length
check('点击图标', await clickElement(revealButton), true)
await settle(800)
const revealCall = callsOf(`${PREFIX}reveal-mystery`).at(-1)
console.log(`  reveal-mystery 参数：${JSON.stringify(revealCall?.args ?? [])}`)
check('用的是 reveal-mystery 通道', Boolean(revealCall), true)
check('把 userId 与 webRid 一起传过去（主进程据此回填档案）', revealCall?.args, [USER, ROOM])
check('档案重拉了一次（回填后界面看的就是真实资料）', callsOf(`${PREFIX}user-get`).length > beforeGets, true)
check('昵称被回填成真实昵称', text().includes('真实昵称'), true)
check('抖音号被回填', text().includes('real_dy'), true)
check('地区被回填', text().includes('上海'), true)
check('粉丝数被回填（12,345）', text().includes('12,345'), true)
check('多出一行事实：作品 / 获赞 / 认证', [text().includes('作品 42'), text().includes('获赞 9,999'), text().includes('认证 某某认证')], [true, true, true])
check('没有另开一块内容（旧的引导文案仍不出现）', text().includes('按用户 id 查一下'), false)

console.log('\n=== 5. 查不到时：一行失败文案，档案内容不动 ===')
// 先关掉弹窗再重开，回到「回填前」的样子（工装里用 revealed 标志控制 user-get 的返回）
revealed = false
revealFails = true
const closeButton = dom.window.document.querySelector('.ant-modal-close')
check('关掉弹窗', await clickElement(closeButton), true)
await settle(600)
const nameAgain = [...dom.window.document.querySelectorAll('span')].find(
  (el) => el.textContent?.trim() === '房间里的昵称' && el.className.includes('cursor-pointer')
)
check('重新打开档案', await clickElement(nameAgain), true)
await settle(600)
check('点「查看真实资料」', await clickElement(buttonByLabel(zh['douyin-link'].users.revealButton)), true)
await settle(800)
check(
  '给出一行失败文案（notFound → 「抖音那边没有这个账号的资料」）',
  text().includes('抖音那边没有这个账号的资料'),
  true
)
check('档案还是原来那份（昵称没被改成半截真实资料）', text().includes('房间里的昵称'), true)
check('也没有冒出一行作品/获赞（失败不留半截结果）', text().includes('作品 42'), false)

console.log(`\n=== 小结 ===\n${failures === 0 ? '✓ 全部断言通过' : `✗ ${failures} 项断言失败`}`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
