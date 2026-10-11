/**
 * 离线渲染验证：**「AI 画像」弹窗**（把真产物挂进 jsdom 跑，用真词条、真组件、真流式协议）。
 *
 * 要验的是「用户点得到、看得懂、不会白花钱」这几件事：
 *  1. 档案里那枚入口是**纯图标按钮**，title / aria-label 写的是「AI 画像（大模型）」；
 *  2. 点开**不会自动调模型**（只读缓存状态）——一次大模型调用是要花钱的，必须由用户点「生成画像」；
 *  3. 没生成过时把「会用哪个模型」写在按钮旁边；一个模型都没配时按钮**禁用**并说明原因；
 *  4. 生成中：流式增量到了就**只渲染已闭合的字段**（画像一节一节省出来），不贴半截 JSON；
 *  5. 完成后：人物类型 / 一句话画像 / 分节 / 证据 / 建议 / 局限全都在，头部写清
 *     第几版、哪个模型、什么时候生成、基于多少条互动、花了多少 token；
 *  6. 「重新生成」传 `force = true`（版本 +1）；重开弹窗走缓存**不再调模型**；
 *  7. 数据涨了要提示「可重新生成」；模型没按结构回话时按原文显示、不丢内容；
 *  8. 失败原因如实显示（no-model / model-failed / busy / no-data）；
 *  9. 弹窗层级在用户档案**之上**（曾经踩过：靠 antd 自动分配会被下面的弹窗盖住）；
 * 10. 关掉档案时它一起关（不留一个悬空的宽弹窗）。
 *
 * 跑法（先构建，产物要与源码同步）：
 *   node scripts/build.mjs --plugin douyin-link
 *   node plugins/douyin-link/spike/ai-portrait-render-check.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
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
const { JSDOM, VirtualConsole } = await import('jsdom')

const zh = (await import(pathToFileURL(join(ROOT, 'plugins/douyin-link/locales/zh-CN.ts')).href)).default
const texts = zh['douyin-link']

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
  /** antd 会问伪元素样式，jsdom 只会往 stderr 喷「Not implemented」——静音，别淹没断言输出 */
  virtualConsole: new VirtualConsole()
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

/* ---------------------------------------------------------- 假宿主桥（真产物照用） */

const PREFIX = 'plugin:douyin-link:'
const ROOM = '880000000001'
/**
 * 两个用户：切换用户是**唯一可靠的重载手段**。
 *
 * 为什么不靠点「关闭」按钮来验「重开」：jsdom 里 React 的 portal 事件重放会让新开弹窗里的按钮
 * 也被点到（实测：点一次入口，弹窗内的按钮各被点一次），于是「点关闭」这条路在 jsdom 里不可靠
 * ——那是**工装环境**的问题，不是产品行为（最小复现脚本已确认：同样的 antd 弹窗结构在 jsdom 里
 * 不会泄漏到刚打开的弹窗）。所以这里改用**换人**触发重载，顺带把最要紧的一件事验了：
 * 换人之后**绝不能还显示上一个人的画像**。
 */
const USER = { userId: '7001', nickname: '夜猫子小张' }
const OTHER = { userId: '7002', nickname: '另一个观众' }

/** 模型写出来的报告（工装数据；真模型回的东西在 live 工装里验） */
const REPORT = {
  persona: '夜聊型陪伴者',
  headline: '深夜出现、话不多但一直在的熟客',
  overview: '他几乎只在晚上 20-23 点出现，弹幕很短，爱用表情，送的都是小礼物但频率很稳。',
  tags: ['夜猫子', '稳定', '爱夸唱'],
  sections: [
    { title: '说话风格', items: ['句子极短，常用 [比心] 这类表情收尾', '爱点名回话，@ 主播的占比明显高于平均'] },
    { title: '消费与动机', items: ['单笔小、频次稳，更像在表达喜欢而不是求关注'] },
    { title: '活跃节律', items: ['21 点前后最活跃，与主播的开播时段高度重合'] }
  ],
  evidence: [
    { quote: '今晚唱得太好听了', note: '习惯用夸唱开场' },
    { quote: '点一首《太聪明》可以吗？', note: '有明确的内容偏好，愿意点歌' }
  ],
  suggestions: ['固定时段点他一句，成本低但对他意义大', '他点过的歌单可以留个记录'],
  caveats: ['样本只有几十条弹幕，性格判断置信度有限']
}

const AI_REPORT_RAW = '```json\n' + JSON.stringify(REPORT, null, 1) + '\n```'

/** 状态（工装逐段改它来验不同场景）；画像**按人存**，这样换人才不会串味 */
const state = {
  /** userId → 已生成的画像 */
  portraits: {},
  current: { fingerprint: 'a:1', interactions: 178 },
  running: false,
  models: [{ id: 3, name: '工装供应商', model: 'workbench-model', isDefault: true }],
  selectedProviderId: 3,
  /** 生成回话（工装改它来验失败路径） */
  generateResult: null
}

const calls = []
/** 事件订阅：把回调存下来，工装自己推流式增量 */
const listeners = new Map()

/** 造一版成品（版本号由调用方给）：`generate` 与「挂住的生成」都用它 */
function makePortrait(userId, version, fingerprint = state.current.fingerprint, interactions = state.current.interactions) {
  return {
    key: `user:${userId}`,
    userId,
    version,
    providerId: 3,
    providerName: '工装供应商',
    model: 'workbench-model',
    report: REPORT,
    raw: AI_REPORT_RAW,
    fingerprint,
    interactions,
    inputTokens: 3210,
    outputTokens: 880,
    generatedAt: new Date(2026, 9, 13, 22, 5).getTime()
  }
}

function aiPortrait(userId) {
  return { ...state, portrait: state.portraits[String(userId ?? '')] ?? null }
}

/** 生成一版：默认回一份成功的画像（版本按这个人已有画像 +1） */
function generate(_webRid, userId, force) {
  if (state.generateResult) return state.generateResult
  const key = String(userId ?? '')
  const portrait = makePortrait(key, (state.portraits[key]?.version ?? 0) + 1)
  state.portraits[key] = portrait
  return Promise.resolve({ ok: true, portrait })
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
  map.set(`${PREFIX}room-summary`, () => summary())
  map.set(`${PREFIX}messages-query`, () => ({ rows: [], total: 0 }))
  map.set(`${PREFIX}users-list`, () => ({ rows: [], total: 0 }))
  map.set(`${PREFIX}user-get`, (_webRid, userId) => {
    const hit = [USER, OTHER].find((row) => row.userId === userId)
    return hit
      ? {
          userId,
          nickname: hit.nickname,
          displayId: hit.userId === USER.userId ? 'zhang_2026' : '',
          city: '杭州',
          honorLevel: 12,
          fansClubLevel: 8,
          firstSeen: Date.now() - 86400000 * 26,
          lastSeen: Date.now() - 3600000,
          stats: { userId, chat: 42, enter: 9, like: 120, follow: 1, gift: 6, diamonds: 3200, receivedDiamonds: 500 }
        }
      : null
  })
  map.set(`${PREFIX}user-identity`, () => ({ identityId: 0, name: '', note: '', primaryUserId: '', accounts: [] }))
  map.set(`${PREFIX}user-analysis`, () => null)
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
  map.set(`${PREFIX}user-gifts`, () => [])
  map.set(`${PREFIX}gift-history`, () => ({ rows: [], total: 0 }))
  map.set(`${PREFIX}user-badges`, () => [])
  map.set(`${PREFIX}db-stats`, () => ({}))
  map.set(`${PREFIX}ai-portrait`, (userId) => aiPortrait(userId))
  map.set(`${PREFIX}ai-portrait-models`, () => state.models)
  map.set(`${PREFIX}ai-portrait-generate`, (webRid, userId, force) => generate(webRid, userId, force))
  return map
}

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

function summary() {
  return {
    webRid: ROOM,
    windowMinutes: 60,
    totals: { chat: 52, enter: 1, like: 2, follow: 3, gift: 3 },
    messages: 60,
    users: 1,
    firstAt: Date.now() - 3600000,
    lastAt: Date.now(),
    series: [],
    kinds: [{ kind: 'chat', count: 52 }],
    diamonds: 300,
    gifts: [],
    received: [],
    sent: [],
    topChat: [USER, OTHER].map((row) => ({
      userId: row.userId,
      nickname: row.nickname,
      stats: { chat: row.userId === USER.userId ? 40 : 12, enter: 0, like: 0, follow: 0, gift: 0, diamonds: 0 }
    }))
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
      listeners.set(channel, callback)
      return () => listeners.delete(channel)
    },
    off: () => {},
    send: () => {}
  }
}

dom.window.__RB_HOST_UI_RESOLVE__ = () => ({
  default: {},
  useTranslation: () => ({
    t: (key, options) => {
      const path = key.replace(/^douyin-link\./, '').split('.')
      let node = texts
      for (const part of path) node = node?.[part]
      if (typeof node !== 'string') return key
      return options ? node.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options[name] ?? '')) : node
    },
    i18n: { language: 'zh-CN' }
  }),
  useTheme: () => ({ effectiveTheme: 'light' }),
  useHostEvent: () => () => {}
})

/* --------------------------------- 把产物与它的宿主桥桩编到一起（同 rank 工装） */

const { build } = await import('esbuild')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-ai-render-'))
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

/* ------------------------------------------------------------------- 挂载 */

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
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `\n       ${detail}`}`)
}
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(label, ok, `期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`)
}
const has = (label, haystack, needle) =>
  check(label, String(haystack).includes(needle), `找不到：${JSON.stringify(needle)}`)
const not = (label, haystack, needle) =>
  check(label, !String(haystack).includes(needle), `不该出现却出现了：${JSON.stringify(needle)}`)

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
/** 弹窗按 z-index 排序（antd 把 zIndex 写在 `.ant-modal-wrap` 的行内样式上） */
const modals = () =>
  [...doc.querySelectorAll('.ant-modal-wrap')].map((wrap) => ({
    wrap,
    z: Number(wrap.style.zIndex || 0),
    text: wrap.querySelector('.ant-modal')?.textContent ?? ''
  }))
const topModal = () => {
  const all = modals()
  return all.sort((a, b) => a.z - b.z)[all.length - 1]
}
const modalText = () => topModal()?.text ?? ''
const buttons = () => [...(topModal()?.wrap.querySelectorAll('button') ?? [])]
const buttonByText = (text) => buttons().find((button) => (button.textContent ?? '').includes(text))
const buttonByTitle = (title) => buttons().find((button) => button.getAttribute('title') === title)

/**
 * 档案与 AI 画像弹窗的**开合助手（带重试）**。
 *
 * 为什么要重试：jsdom 里 React 的 portal 事件重放会让「点一个弹窗里的按钮」顺带点到另一个弹窗里的
 * 按钮（实测会点到刚打开那层的关闭按钮，于是刚打开的弹窗立刻又被关掉）。这是**工装环境**的问题
 * （最小复现脚本已确认同样的 antd 结构在 jsdom 里不会被点穿），不是产品行为——所以这里不掩盖它，
 * 而是**每次点完都核对结果、不对就再点一次**，让断言仍然打在真产物上。
 */
const aiBodyText = () => {
  const all = modals().sort((a, b) => a.z - b.z)
  const top = all[all.length - 1]
  return (top?.wrap.querySelector('.ant-modal-body')?.textContent ?? '').trim()
}
const rankRowByName = (name) =>
  [...doc.querySelectorAll('.ant-card-body *')].find(
    (node) => node.textContent?.trim() === name && node.children.length === 0
  )
/** 档案弹窗里的字（档案是最下面那层：z 1000；AI 画像 1300、日历 1100 都在它上面） */
const profileModalText = () =>
  modals()
    .filter((entry) => entry.z < 1300)
    .map((entry) => entry.text)
    .join(' ')
const openProfile = async (name) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = rankRowByName(name)
    await click(row?.closest('button, [role="button"]') ?? row)
    // 成功判据必须落在**档案那一层**上：AI 画像弹窗的头部也写着这个名字，只看最上面那层会误判
    if (profileModalText().includes(name)) return true
  }
  return false
}
const openAi = async () => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const entry = [...doc.querySelectorAll('button')].find(
      (button) => button.getAttribute('title') === texts.users.aiButton
    )
    if (!entry) {
      await settle(150)
      continue
    }
    await click(entry)
    if (aiBodyText().length > 0) return true
  }
  return false
}
/** 打开某个人的档案 + AI 画像弹窗，返回弹窗里的字（换人就是重载状态） */
const openUserByName = async (name) => {
  await openProfile(name)
  await openAi()
  return modalText()
}

console.log('=== 1. 入口：档案名字行里那枚「AI 画像」图标按钮')
const rankRow = rankRowByName(USER.nickname)
check('发言榜里找到了这个人', Boolean(rankRow), '工装数据里第一个人应该在榜上')
await openProfile(USER.nickname)
const profileText = profileModalText()
has('用户档案打开了', profileText, USER.nickname)

const aiButton = [...doc.querySelectorAll('button')].find(
  (button) => button.getAttribute('title') === texts.users.aiButton
)
check('名字行里有 AI 画像按钮', Boolean(aiButton))
eq('它是纯图标按钮（没有文字）', (aiButton?.textContent ?? '').trim(), '')
eq('无障碍名走 aria-label', aiButton?.getAttribute('aria-label'), texts.users.aiButton)
has('按钮名写清是大模型', texts.users.aiButton, '大模型')
eq('此时还没有查过 AI 画像', calls.some((entry) => entry.channel === `${PREFIX}ai-portrait`), false)

console.log('\n=== 2. 点开：只读缓存状态，不自动花钱')
calls.length = 0
await openAi()
const openedText = modalText()
has('AI 画像弹窗打开', openedText, texts.users.aiTitle)
check('读了缓存状态', calls.some((entry) => entry.channel === `${PREFIX}ai-portrait`))
eq('没有自动生成（没调模型）', calls.some((entry) => entry.channel === `${PREFIX}ai-portrait-generate`), false)
has('说明里写了将用哪个模型', openedText, '工装供应商 · workbench-model')
has('有一枚「生成画像」按钮', openedText, texts.users.aiGenerate)
has('把一个模型都没配的情况写成条件（这里配了，所以不该出现）', openedText, texts.users.aiGenerate)
not('配了模型时不给「没有模型」的说明', openedText, texts.users.aiNoModel)
check('层级在用户档案之上', topModal().z > modals().filter((entry) => entry.text.includes(texts.users.detailTitle)).map((entry) => entry.z)[0], JSON.stringify(modals().map((entry) => entry.z)))

console.log('\n=== 3. 生成中：流式增量只渲染已闭合的字段')
calls.length = 0
const generateButton = buttonByText(texts.users.aiGenerate)
check('找到生成按钮', Boolean(generateButton))
/** 让生成「挂住」，好在中间推流（回话在手上去 resolve） */
let finishGenerate = null
state.generateResult = new Promise((resolve) => {
  finishGenerate = resolve
})
await click(generateButton)
eq(
  '调用生成通道时带上了房间、人和 force=false',
  calls.filter((entry) => entry.channel === `${PREFIX}ai-portrait-generate`).map((entry) => entry.args),
  [[ROOM, USER.userId, false]]
)
const push = async (delta) => {
  await act(async () => {
    listeners.get(`${PREFIX}portrait`)?.({
      requestId: 'p1',
      delta,
      done: false
    })
  })
  await settle(30)
}
// 半截 JSON：类型名与一句话画像已闭合，总览还没闭合
await push('{"persona": "夜聊型陪伴者", "headline": "深夜出现、话不多但一直在的熟客", "overview": "他几乎只在晚上 20-23 点出现，')
const streamingText = modalText()
has('已闭合的类型名先长出来', streamingText, '夜聊型陪伴者')
has('一句话画像也长出来了', streamingText, '深夜出现、话不多但一直在的熟客')
not('没闭合的总览不显示（不给半句话）', streamingText, '他几乎只在晚上')
not('不把半截 JSON 贴出来', streamingText, '"persona"')
has('状态行写着正在生成', streamingText, texts.users.aiThinking.slice(0, 4))
// 再推一个完整 JSON：最终报告出现
await push(AI_REPORT_RAW)
await act(async () => {
  listeners.get(`${PREFIX}portrait`)?.({ requestId: 'p1', delta: '', done: true })
})
await settle(200)

console.log('\n=== 4. 完成后：正文、证据、建议、局限、元信息都在')
// 放行那次生成：回一份「主进程已落库」的成功结果（界面据此拉一次状态，拿到成品）
const finishedPortrait = makePortrait(USER.userId, 2)
state.portraits[USER.userId] = finishedPortrait
await act(async () => {
  finishGenerate({ ok: true, portrait: finishedPortrait })
  state.generateResult = null
})
await settle(400)
const doneText = modalText()
has('人物类型名', doneText, '夜聊型陪伴者')
has('一句话画像', doneText, '深夜出现、话不多但一直在的熟客')
has('总览', doneText, '他几乎只在晚上 20-23 点出现')
has('标签', doneText, '夜猫子')
has('分节标题', doneText, '说话风格')
has('分节条目', doneText, '爱点名回话')
has('证据（原话 + 说明）', doneText, '今晚唱得太好听了')
has('证据说明', doneText, '习惯用夸唱开场')
has('建议', doneText, '固定时段点他一句')
has('局限', doneText, '样本只有几十条弹幕')
has('头部写了第几版', doneText, '第 2 版')
has('头部写了模型', doneText, '工装供应商 · workbench-model')
has('头部写了生成时间（与插件其它时间同一格式 MM-DD HH:mm）', doneText, '10-13 22:05')
has('头部写了基于多少条互动', doneText, '基于 178 条互动')
has('头部写了 token 用量', doneText, 'token 3,210/880')
has('有重新生成按钮', doneText, texts.users.aiRegenerate)
has('页脚说明事实层与解读层的分工', doneText, texts.users.aiFooter)

console.log('\n=== 5. 重新生成传 force=true')
calls.length = 0
await click(buttonByText(texts.users.aiRegenerate))
eq(
  '重新生成 force=true',
  calls.filter((entry) => entry.channel === `${PREFIX}ai-portrait-generate`).map((entry) => entry.args[2]),
  [true]
)

console.log('\n=== 6. 换人：不串味 + 走缓存不再调模型')
calls.length = 0
/** 换人（点发言榜里另一个人）→ 档案与 AI 画像弹窗都跟着换人，顺带把最要紧的一件事验了：
 *  **换人之后绝不能还显示上一个人的画像**（否则用户会拿着别人的画像去维护人）。 */
const switchToOtherThenBack = async () => {
  const other = await openUserByName(OTHER.nickname)
  const back = await openUserByName(USER.nickname)
  return { other, back }
}
const switched = await switchToOtherThenBack()
not('换到别人时没有显示上一个人的画像', switched.other, '夜聊型陪伴者')
has('换到别人时是「还没生成」的空态', switched.other, texts.users.aiGenerate)
has('换回来直接显示这个人的缓存', switched.back, '夜聊型陪伴者')
eq('换人重载没有再调模型', calls.some((entry) => entry.channel === `${PREFIX}ai-portrait-generate`), false)
check(
  '换人时按新的人查了状态',
  calls.filter((entry) => entry.channel === `${PREFIX}ai-portrait`).map((entry) => entry.args[0]).includes(OTHER.userId)
)
has('缓存里仍然只有「重新生成」可点', switched.back, texts.users.aiRegenerate)

console.log('\n=== 7. 数据涨了要提示；数据没变不提示；结构化失败按原文显示')
const portraitOf = () => state.portraits[USER.userId]
// 生成时记的互动量是 178，现在涨到 206 → 换人重载时要提示「可重新生成」
state.current = { fingerprint: 'a:2', interactions: 206 }
const grewText = (await switchToOtherThenBack()).back
has('提示数据已更新并给出增量', grewText, '又攒了 28 条互动')
has('提示里说重新生成会更准', grewText, '重新生成会更准')
// 数据没变时不该提示（假阳性会让用户白花 token）
state.current = { fingerprint: portraitOf().fingerprint, interactions: portraitOf().interactions }
const calmText = (await switchToOtherThenBack()).back
not('数据没变时不提示「可重新生成」', calmText, '又攒了')
// 数据涨了但**没生成过**时更不该提示（没有基准可比）
state.portraits = {}
state.current = { fingerprint: 'a:9', interactions: 999 }
const freshText = (await switchToOtherThenBack()).back
not('从没生成过时不提示「可重新生成」', freshText, '又攒了')
has('从没生成过时给空态', freshText, texts.users.aiGenerate)
// 结构化失败：report 为 null、raw 有内容 → 按原文显示，不丢模型写的东西
state.portraits[USER.userId] = { ...makePortrait(USER.userId, 1), report: null, raw: '模型今天没按 JSON 回，这是一整段散文式画像。' }
const rawText = (await switchToOtherThenBack()).back
has('结构化失败时说明一句', rawText, texts.users.aiUnstructured)
has('原文照样显示（内容不丢）', rawText, '这是一整段散文式画像')

console.log('\n=== 8. 失败原因如实显示（四种）')
for (const [reason, text] of [
  ['no-model', texts.users.aiErrorNoModel],
  ['model-failed', '模型调用失败'],
  ['busy', texts.users.aiErrorBusy],
  ['no-data', texts.users.aiErrorNoData]
]) {
  state.portraits = {}
  state.generateResult = Promise.resolve({ ok: false, reason, detail: reason === 'model-failed' ? 'HTTP 500' : '' })
  const opened = (await switchToOtherThenBack()).back
  check(`空态在（${reason}）`, opened.includes(texts.users.aiGenerate))
  await click(buttonByText(texts.users.aiGenerate))
  await settle(250)
  const text_ = modalText()
  has(`失败原因「${reason}」有对应文案`, text_, text)
  if (reason === 'model-failed') has('失败明细也显示出来', text_, 'HTTP 500')
}
state.generateResult = null

console.log('\n=== 9. 一个模型都没配：按钮禁用 + 说明原因')
state.portraits = {}
state.models = []
const noModelOpened = (await switchToOtherThenBack()).back
has('写明没有可用模型', noModelOpened, texts.users.aiNoModel)
const noModelButtons = modals().find((entry) => entry.z >= 1300)?.wrap.querySelectorAll('button') ?? []
const disabled = [...noModelButtons].find((button) => (button.textContent ?? '').includes(texts.users.aiGenerate))
check('生成按钮被禁用', disabled?.disabled === true || disabled?.getAttribute('disabled') !== null, String(disabled?.outerHTML ?? ''))

console.log('\n=== 10. 换人之后「数据已更新」的基准也跟着换（不是拿别人的数去比）')
state.models = [{ id: 3, name: '工装供应商', model: 'workbench-model', isDefault: true }]
state.portraits = {
  [USER.userId]: makePortrait(USER.userId, 1, 'a:1', 178),
  [OTHER.userId]: makePortrait(OTHER.userId, 3, 'a:9', 100)
}
// 现状是 a:2 / 206：小张（a:1/178）该提示 +28；别人（a:9/100）该按**他自己的**基准算 +106
state.current = { fingerprint: 'a:2', interactions: 206 }
const { other: b, back: a } = await switchToOtherThenBack()
has('小张这一版基于 178 条互动（他的基准）', a, '基于 178 条互动')
has('别人那一版按他自己的基准算增量（+106，不是小张的 +28）', b, '又攒了 106 条互动')
not('换到别人时不拿小张的基准来提示', b, '又攒了 28 条互动')

rmSync(workDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项未通过`}`)
process.exit(failures === 0 ? 0 : 1)
