/**
 * 离线渲染验证（dev-only，不参与打包）：把**真产物** `dist/douyin-link/renderer.mjs`
 * 挂到一个 jsdom 里，真的把设置页挂载一次，断言**登录态 Cookie 那条路**是通的：
 *
 * - 往里粘贴 6071 字符的 cookie（照实测那份的形状）→ 送到主进程的必须是**完整 6071 字符**；
 * - 主进程回包就是界面上显示的那一份：回包完整 → 一个字都不少，且**不出现告警行**；
 * - 回包被截短（真撞上限的情形）→ 必须冒出一行灰字告警，而不是安静地骗人；
 * - cookie 里没有 `sessionid` / `ttwid` → 也要说清「抖音会当它是匿名会话」。
 *
 * 为什么值得留：2026-10-10 的事故正是「输入框里看着完整、存下去却是前半截」——
 * `api.ts` 那行 `slice(0, 4096)` 与设置页的显示逻辑，**只有真挂一次才看得出接没接上**。
 * 宿主桥（`plugin://host/ui.js`）与 `@host/renderer/i18n` 在这里用桩顶掉，其余都是真产物代码。
 *
 * 跑法（先构建）：
 *   npm run build
 *   node plugins/douyin-link/spike/settings-render-check.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const bundlePath = join(ROOT, 'dist/douyin-link/renderer.mjs')
const distDir = join(ROOT, 'dist/douyin-link')
if (!existsSync(bundlePath)) {
  console.error('先跑 npm run build（找不到 dist/douyin-link/renderer.mjs）')
  process.exit(2)
}

/**
 * `jsdom` 是宿主仓库的依赖（本仓库不装它）。本仓库的 `node_modules/jsdom` 通常是一条
 * 指过去的目录联接；没有就现建一条（`.gitignore` 已忽略 node_modules）。
 */
const { mkdirSync, symlinkSync } = await import('node:fs')
const jsdomLink = join(ROOT, 'node_modules/jsdom')
const hostJsdom = 'E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\jsdom'
if (!existsSync(jsdomLink) && existsSync(hostJsdom)) {
  try {
    mkdirSync(join(ROOT, 'node_modules'), { recursive: true })
    symlinkSync(hostJsdom, jsdomLink, 'junction')
    console.log(`（已把 jsdom 联到宿主那份：${hostJsdom}）`)
  } catch (error) {
    console.error(
      `建链接失败（${error.message}）；手动执行：\n  New-Item -ItemType Junction -Path "${jsdomLink}" -Target "${hostJsdom}"`
    )
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
/** 把 jsdom 的浏览器全局整体搬到 Node 里（antd 的 rc-* 组件要用 SVGElement / ResizeObserver / …） */
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key === 'undefined' || key === 'window' || key === 'self' || key === 'globalThis') continue
  if (key in globalThis && !['document', 'location', 'history', 'navigator'].includes(key)) continue
  try {
    Object.defineProperty(globalThis, key, {
      value: dom.window[key],
      configurable: true,
      writable: true
    })
  } catch {
    /* 有些内置全局是只读的，跳过即可 */
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
/**
 * jsdom 不带 `ResizeObserver` / `IntersectionObserver`，而 antd 的 rc-* 组件会直接用它们
 * （挂载时 `new ResizeObserver(...)` 直接抛 ReferenceError）。给个空实现即可：
 * 这里的断言看的是文本与通道调用，跟尺寸无关。
 */
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * React 一律用 `createRequire` 从**本仓库**取，并挂到 globalThis 上给下面的桩用。
 *
 * 为什么不用 `await import('react')`（踩过）：产物里那侧走的是桩里的 `createRequire`，
 * 两边解析出的文件如果不同（symlink / 条件导出差异），就会是**两份 React**，
 * 报出来的却是「`useState` is not a function」这种看不懂的错。
 * 这里统一成一个实例：React 19 的 hooks 只认自己那份内部状态。
 */
const { createRequire } = await import('node:module')
const require_ = createRequire(pathToFileURL(join(ROOT, 'package.json')).href)
const React = require_('react')
const { createRoot } = require_('react-dom/client')
globalThis.__JSDOM_REACT__ = React
globalThis.__JSDOM_REACT_DOM_CLIENT__ = { createRoot, hydrateRoot: require_('react-dom/client').hydrateRoot }
globalThis.__JSX_RUNTIME__ = require_('react/jsx-runtime')
const { act } = React

/* ------------------------------------------------ 被测的那份 cookie（合成，无真实凭据） */

/** 页面自己设的一堆小字段 + 压在尾部的登录态字段（照实测那份 6071 字符的形状） */
function syntheticCookie({ withSession = true } = {}) {
  const junk = [
    'enter_pc_once=1',
    `UIFID=${'b'.repeat(2200)}`,
    'my_rd=2',
    `bit_env=${'0'.repeat(2600)}`,
    `sdk_source_info=${'f'.repeat(900)}`,
    'is_staff_user=false'
  ]
  const tail = withSession
    ? [
        'passport_auth_status=dcab15fcdd4db950378a53aaeb8fe2a3',
        'sessionid=1a8d5ecf86914841ab2c20ae2f4a0f49',
        'login_time=1791628916974',
        `ttwid=1%7CbDhzRjFnQzmIGSOhiWLnodUqg7ul0x9iwFJLzDkH1p0%7C1791628920%7C${'2'.repeat(64)}`,
        `odin_tt=${'7'.repeat(128)}`
      ]
    : ['csrf_session_id=77bdf524b1d9f7b092ac7dceed745d17']
  return [...junk, ...tail].join('; ')
}

const fullCookie = syntheticCookie()
const truncatedCookie = fullCookie.slice(0, 4096)
const anonymousCookie = syntheticCookie({ withSession: false })
/** 换个值的同一份长 cookie：界面上「改了才存」，要触发一次真的保存就得让它不一样 */
const fullCookieEdited = `${fullCookie}; edited=1`

/* ------------------------------------------------------------------ 主进程通道的桩 */

const calls = []
/** 主进程怎么回话（默认照**修好之后**的样子：原样收下）；测截断时换成只留前 4096 个字符 */
let mainReply = (patch) => ({ ...patch })
/** 打开时库里存的就是**一份长的** cookie：顺带验证 `api.ts` 那次归一化不会把它切短 */
let snapshotSettings = { douyinCookie: fullCookieEdited }
dom.window.api = {
  plugin: {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args })
      if (channel === 'plugin:douyin-link:snapshot') return { settings: snapshotSettings, rooms: [] }
      if (channel === 'plugin:douyin-link:db-stats') {
        return { rooms: 1, messages: 10, users: 2, minutes: 3, sessions: 1 }
      }
      if (channel === 'plugin:douyin-link:settings-set') return mainReply(args[0] ?? {})
      return null
    },
    on: () => () => {},
    off: () => {},
    send: () => {}
  }
}

/**
 * `plugin://host/ui.js?m=…` 的返回：宿主对 `@host/renderer/i18n` 给的是 i18n，
 * 其它（空 spec / vendor 名）在真宿主里是各自的模块；验证脚本只关心 i18n，
 * `default` 留给桩自己按需去 import（antd / 图标都从那里取）。
 */
const hostUi = {
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
  useHostEvent: () => () => {}
}
dom.window.__RB_HOST_UI_RESOLVE__ = () => hostUi

/* 真产物里那些 `import 'plugin://host/ui.js?m=…'` 要能在 jsdom 里解析：用 esbuild 把桥换成桩 */
const { build } = await import('esbuild')
const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-settings-render-'))
/**
 * 产物与它的桩都住在系统临时目录里，桩要能解析 `antd` 这类宿主的 vendor。
 * 所以在临时目录里挂一条指回**本仓库 node_modules** 的联接
 * （不指向宿主仓库：本仓库自己就装了 antd / react）。
 */
writeFileSync(join(workDir, 'package.json'), '{ "type": "module" }\n', 'utf8')
try {
  symlinkSync(join(ROOT, 'node_modules'), join(workDir, 'node_modules'), 'junction')
} catch (error) {
  console.log(`（临时目录没挂上 node_modules：${error.message}；裸模块可能解析不到）`)
}
/**
 * 渲染层产物里**所有** `@host/**` 与 vendor（react / antd / remixicon…）都编译成
 * 同一个宿主 UI 桥 `plugin://host/ui.js?m=<spec>`，所以这里用**一个桩**顶掉它。
 *
 * 为什么要连 React 一起放进来（踩过两次）：产物里 `import { useState } from 'react'`
 * 那条路走的是 vendor 桥，也就是**这个桩**——桩里没有 `useState` 就是
 * 「(0, w.useState) is not a function」。所以桩要同时提供：
 * - 宿主 UI（`useTranslation` / `useTheme`，见插件的 `@host/` 清单）；
 * - React 的运行时（从 `createRequire` 拿，与验证脚本用同一个实例）；
 * - automatic JSX 的 `jsx` / `jsxs`（插件入口用新转换打的）。
 */
const stubPath = join(workDir, 'host-ui-stub.mjs')
const reactCjs = `const react = globalThis.__JSDOM_REACT__\nconst require_ = (await import('node:module')).createRequire(${JSON.stringify(pathToFileURL(join(ROOT, 'package.json')).href)})\n`
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
      ...['Button', 'Input', 'InputNumber', 'Select', 'Switch', 'Typography', 'Tooltip', 'Empty', 'Spin', 'Segmented', 'Tabs', 'Tag', 'Progress', 'Table', 'Card', 'Space', 'Divider', 'Alert', 'Popconfirm', 'Dropdown', 'Badge', 'Drawer', 'Modal', 'Checkbox', 'Radio', 'DatePicker', 'Statistic', 'Descriptions', 'List', 'Avatar', 'Slider', 'Collapse', 'Form', 'Tree', 'Pagination', 'ConfigProvider', 'App', 'message', 'notification'].map(
        (name) => `export const ${name} = antd.${name}`
      ),
      'export const useTranslation = (...a) => ui().useTranslation(...a)',
      'export const useHostEvent = (...a) => ui().useHostEvent(...a)',
      'export const useTheme = (...a) => ui().useTheme(...a)',
      'export const I18nextProvider = ({ children }) => children',
      'export const HostEventProvider = ({ children }) => children',
      'export default { ...antd, ...react }'
    ].join('\n') +
    '\n',
  'utf8'
)
/**
 * `react` / `react/jsx-runtime` / `react-dom/client` 的桩。
 *
 * 为什么必须换掉：产物里 react 是 external（宿主提供），在 Node ESM 里变成
 * `import * as react` —— 而 react 是 CJS，具名 `useState` 会变成 undefined
 * （实测 `(0, w.useState) is not a function`）。统一走 `createRequire`，
 * 让**同一个 React 实例**既给验证脚本用、也给产物用。
 */
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
  external: ['@remixicon/react', 'dayjs', 'node:module'],
  plugins: [
    {
      name: 'stub-host-ui',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^plugin:\/\/host\/ui\.js/ }, () => ({ path: stubPath }))
        buildApi.onResolve({ filter: /^react$/ }, () => ({ path: reactStub }))
        buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: reactDomStub }))
        /**
         * 桩文件里对真模块的裸导入（`react` / `antd` / `node:module` …）保持 external：
         * 让 Node 自己从仓库 node_modules 解析，别把 antd 整包打进这份验证产物。
         * 注意只对**裸说明符**生效，桩文件自己的绝对路径不能被误判。
         */
        buildApi.onResolve({ filter: /^[^./\\]/ }, (args_) => {
          if (args_.path.includes('\\') || args_.path.includes('/')) return null
          if (args_.path.startsWith('@') && args_.path.split('/').length > 2) return null
          return { path: args_.path, external: true }
        })
        /**
         * 懒加载 chunk（`plugin://douyin-link/chunk-*.mjs`）在浏览器里由宿主 blob import；
         * 这里指回 `dist/douyin-link/` 下的**真 chunk**——页面本体就在里面，
         * 换成空桩会因缺少具名导出而构建失败（入口静态 import 了它们）。
         */
        buildApi.onResolve({ filter: /^plugin:\/\/douyin-link\// }, (args_) => {
          const name = args_.path.replace(/^plugin:\/\/douyin-link\//, '').split('?')[0]
          return { path: join(distDir, name) }
        })
      }
    }
  ]
})

const plugin = (await import(pathToFileURL(outfile).href)).default
let registered = null
plugin.install({
  use: (kind) => ({
    register: (entry) => {
      if (kind === 'settingsSection') registered = entry
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

check('插件装了设置页', Boolean(registered?.Component), true)

const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(registered.Component))
})
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
}
await settle()

const text = () => dom.window.document.body.textContent ?? ''
const textarea = () => dom.window.document.querySelector('textarea')
/** 粘贴进 TextArea：React 认的是原生 setter 派发的 input 事件 */
const paste = async (value) => {
  const el = textarea()
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    // React 19 的 onBlur 走的是原生 **focusout**（冒泡），派发不冒泡的 `blur` 是叫不醒它的
    el.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
  })
  await settle()
}
const setCalls = () => calls.filter((call) => call.channel === 'plugin:douyin-link:settings-set')

/* -------------------------------------------- 1. 打开就是主进程存的那一份（一个字不动） */

check('cookie 输入框渲染出来了', Boolean(textarea()), true)
check('初次打开：框里就是主进程存的那份（逐字相同）', textarea()?.value, fullCookieEdited)
check(
  '初次打开：长 cookie 经 api.ts 归一化后一个字不少',
  textarea()?.value?.length,
  fullCookieEdited.length
)
check('初次打开：不出现截断告警', text().includes('超过上限'), false)
check('初次打开：完整 cookie 不出现匿名告警', text().includes('没有 sessionid'), false)

/* --------------------------------- 2. 粘贴一份完整的长 cookie：不许在渲染层被切短 */

check(`合成样本长度 > 旧上限（${fullCookie.length} 字符）`, fullCookie.length > 4096, true)
check('合成样本里登录态字段整体落在 4096 之后（与实测事故同一形状）', fullCookie.indexOf('sessionid=') > 4096, true)
calls.length = 0
await paste(fullCookie)
const longSet = setCalls().at(-1)
check('粘贴后调了设置通道', Boolean(longSet), true)
check('送到主进程的就是**完整那一行**（渲染层不许自己切）', longSet?.args?.[0]?.douyinCookie?.length, fullCookie.length)
check('回包完整 → 框里仍是完整那一行', textarea()?.value?.length, fullCookie.length)
check('回包完整 → 没有告警行', text().includes('超过上限'), false)

/* ---------------------------- 3. 主进程真的截短了（撞上限）：必须冒出一行灰字告警 */

mainReply = (patch) => ({ ...patch, douyinCookie: patch.douyinCookie.slice(0, 4096) })
calls.length = 0
await paste(fullCookieEdited)
check('被截短后：框里显示的就是主进程回的那一份', textarea()?.value, truncatedCookie)
check('被截短后：告警行说了实话（被截了）', text().includes(`这段 Cookie 有 ${fullCookieEdited.length} 字符`), true)
check('被截短后：告警行点出上限与后果', [text().includes('12288'), text().includes('ttwid')], [true, true])

/* ---------------------------------------- 4. 匿名 cookie（缺 sessionid/ttwid）也要说出来 */

mainReply = (patch) => ({ ...patch })
snapshotSettings = { douyinCookie: anonymousCookie }
calls.length = 0
await paste(anonymousCookie)
check('匿名 cookie：没有告警行（没超限）', text().includes('超过上限'), false)
check('匿名 cookie：说清它缺什么', text().includes('没有 sessionid / ttwid'), true)
check('匿名 cookie：说清后果（收不到礼物）', text().includes('礼物收不到'), true)

/* ------------------------------------------------- 5. 完整 cookie：一句废话都不多说 */

snapshotSettings = { douyinCookie: fullCookie }
calls.length = 0
await paste(fullCookie)
check('完整 cookie：一次设置通道调用（粘贴的与库里不同，该存）', setCalls().length, 1)
check('完整 cookie：不出现匿名告警', text().includes('没有 sessionid'), false)
check('完整 cookie：不出现截断告警', text().includes('超过上限'), false)

/* ------------------------------------ 6. 再粘一次**同一份**：不该反复写盘 */

calls.length = 0
await paste(fullCookie)
check('粘贴的就是库里那份 → 不重复调设置通道', setCalls().length, 0)
check('粘贴的就是库里那份 → 框里一个字不变', textarea()?.value, fullCookie)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
