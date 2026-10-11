/**
 * 「下播之后重新开播，监控能不能自己回来」自检工装（dev-only，不参与打包）。
 *
 * 为什么要单独搭这个工装（2026-10-11）：用户反馈「直播间断播后重新开播拉不起来，丢监控数据」。
 * 这件事**没法等真机复现**——要等主播真的下播再开播，而且现场（真日志 `logs/main.log`）里
 * 两次故障长得完全不一样：
 *
 * - A 类：房间下播了，但推送 ws **既不断也不报错**（只推没有业务内容的心跳帧），
 *   `state.roomSocket` 一直非空 → `planRelive`/`reconcile` 都不会碰它，界面还显示「直播中」，
 *   主播重开后这条废连接永远收不到东西（实测 108011161837 从 02:23 到 10:06 一直是
 *   「实时通道推送过的消息：（一条都没有）」）。
 * - B 类：等开播那条链只要**探测失败一次**（或相位被别的回调改掉），
 *   `scheduleRelive` 就再也没人排 → 开关开着、没有任何采集、没有任何定时器，永久停摆。
 *
 * 做法：用 esbuild 把**真的 `main/monitor/hub.ts`** 打成一个 ESM 包（只把 electron / 日志 /
 * 数据库 / 采集器 / 解析器换成桩），装虚拟时钟，按秒级脚本驱动「下播 → 重开播」，
 * 断言「重开播之后真的又有一条活通道，而且用的是重开播后的房间号」。
 *
 * 跑法（仓库根目录；esbuild 已在 devDependencies）：
 *   node plugins/douyin-link/spike/relive-check.mjs
 *
 * 桩的边界：`resolveLiveRoom` / `DirectPushCapture` / `store` 都是假的（它们本来就是网络与库），
 * hub 的调度、相位、定时器、看门狗、串行链**全是真的**——要验的就是这些。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const HUB_ENTRY = join(PLUGIN, 'main/monitor/hub.ts')
const require_ = createRequire(import.meta.url)
/** RELIVE_TRACE=1 时把每一次解析的调用栈也记下来（排查「探测怎么这么频繁」用） */
globalThis.__RELIVE_TRACE__ = process.env.RELIVE_TRACE === '1'

/* ------------------------------------------------------------------ 桩模块 */

const STUBS = {}

STUBS['electron-log'] = `
const sink = (...args) => {
  const line = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ')
  ;(globalThis.__RELIVE_LOGS__ ??= []).push(line)
}
const logger = { info: sink, warn: sink, error: sink, debug: sink, verbose: sink, silly: sink }
export default logger
`

STUBS['electron'] = `
export const app = { getPath: () => '.' }
export const net = { fetch: async () => { throw new Error('probe: 不该走网络') } }
export class BrowserWindow { static getAllWindows() { return [] } }
export const ipcMain = { handle() {}, on() {} }
export default { app, net, BrowserWindow, ipcMain }
`

STUBS['@host/main/safe-send'] = `
export const safeSend = () => {}
export const isSenderAlive = () => false
`

STUBS['../avatar'] = `
export const avatarCache = { dataUrl: () => '', dispose() {} }
`

STUBS['../douyin/mystery'] = `
export async function fetchUserProfile() { return null }
export async function revealMysteryProfile() { return null }
`

STUBS['../analysis/portrait'] = `
export function buildUserAnalysis() { return { ok: false } }
`

STUBS['../audio/pump'] = `
export class AudioPump {
  constructor() {}
  start() {}
  stop() {}
}
`

/** 实时通道的桩：把 hub 调过来的钩子记下来，脚本想让它「来消息」「报错」「装死」都能控制 */
STUBS['../douyin/push-capture'] = `
const world = () => globalThis.__RELIVE_WORLD__

let seq = 0
function itemFor(socket) {
  seq += 1
  return {
    id: seq,
    kind: 'chat',
    user: '观众' + seq,
    userId: '900' + seq,
    text: '工装消息 ' + seq,
    count: 0,
    diamonds: 0,
    toUser: '',
    toUserId: '',
    at: Date.now()
  }
}

export class DirectPushCapture {
  constructor(target, hooks) {
    this.target = target
    this.hooks = hooks
    this.stopped = false
    world().sockets.push(this)
  }

  get connected() { return !this.stopped }

  setTarget(target) { this.target = target }

  start() {
    if (this.stopped) return
    this.hooks.onStatus({ phase: 'connecting', failure: null })
    const script = world().script
    if (script.silent) return
    if (script.status === 'live') this.emitItems()
  }

  /** 来一批真业务消息（= 这条通道还活着） */
  emitItems(count = 2) {
    if (this.stopped) return
    const items = Array.from({ length: count }, () => itemFor(this))
    this.hooks.onItems(items, [], { roomEnded: false })
    this.hooks.onStatus({ phase: 'live', failure: null })
  }

  /** 服务端推下播帧 */
  emitRoomEnded() {
    if (this.stopped) return
    this.hooks.onItems([itemFor(this)], [], { roomEnded: true })
  }

  /** 通道报错（握手被拒 / 掉线到底） */
  emitError() {
    if (this.stopped) return
    this.hooks.onStatus({ phase: 'error', failure: { code: 'realtimeChannelLost' } })
  }

  /** 装死：不报错、不断开、也不再有任何业务消息（真机上「连接活着但房间早没了」的样子） */
  goSilent() {}

  stop() { this.stopped = true }
}
`

/** 直播间解析的桩：状态与房间号由脚本控制（真机上一次解析要 1~2 秒，这里立刻回） */
STUBS['../douyin/room'] = `
const world = () => globalThis.__RELIVE_WORLD__

export class ResolveFailure extends Error {
  constructor(code, detail = '') {
    super(detail ? code + ': ' + detail : code)
    this.name = 'ResolveFailure'
    this.code = code
    this.detail = detail
  }
}

function roomInfo(webRid) {
  const script = world().script
  return {
    webRid,
    roomId: script.roomId,
    title: '工装房间 ' + webRid,
    anchor: '工装主播',
    cover: '',
    onlineText: '1',
    status: script.status,
    voice: false
  }
}

export async function resolveLiveRoom(input) {
  const world_ = world()
  world_.resolveCalls += 1
  world_.resolveTimes.push(Date.now())
  if (globalThis.__RELIVE_TRACE__) {
    world_.resolveStacks.push(String(new Error().stack).split(String.fromCharCode(10)).slice(2, 5).map((line) => line.trim()))
  }
  if (world_.script.failResolve > 0) {
    world_.script.failResolve -= 1
    throw new ResolveFailure('network', '工装：解析失败')
  }
  const webRid = String(input).replace(/\\D/g, '')
  return { room: roomInfo(webRid), flv: {}, cookie: 'ttwid=probe', roomUserIds: [], anchorUser: null }
}

export async function enterLiveRoom(webRid) {
  const world_ = world()
  world_.lightRefreshCalls += 1
  return { room: roomInfo(webRid), flv: {}, roomUserIds: [], anchorUser: null }
}

export async function fetchPage() { throw new ResolveFailure('network', '工装不抓页面') }
`

/** 数据库的桩：房间清单 / 会话号是真的要用的，其余按需给空值 */
STUBS['../db/mapper'] = `
const world = () => globalThis.__RELIVE_WORLD__
let sessionSeq = 0

export const listRooms = async () => world().rooms
export const upsertRoom = async (room) => {
  const row = world().rooms.find((r) => r.webRid === room.webRid)
  if (row) Object.assign(row, room)
}
export const setRoomMonitor = async () => {}
export const setRoomNote = async () => {}
export const touchRoom = async () => {}
export const forgetRoom = async () => {}
export const openSession = async () => { world().openSessions += 1; return (sessionSeq += 1) }
export const closeSession = async () => { world().closeSessions += 1 }
export const roomStores = async () => new Map()
export const dbStats = async () => ({ messages: 0, users: 0, sessions: 0, sizeBytes: 0 })
export const getUsers = async () => new Map()
export const getUser = async () => null
export const upsertUserStatic = async () => {}
export const insertMessages = async () => {}
export const bumpMinutes = async () => {}
export const upsertUserDeltas = async () => {}
export const clearMessages = async () => 0
export const clearUsers = async () => {}
export const deleteMessagesBefore = async () => 0
export const deleteMinutesBefore = async () => 0
export const listSessions = async () => []
export const dayRecords = async () => []
export const queryMessages = async () => ({ items: [], total: 0 })
export const windowAggregates = async () => ({})
export const windowTotals = async () => ({})
export const minuteSeries = async () => []
export const minuteSeriesAll = async () => []
export const minuteSeriesPerRoom = async () => []
export const activeMinutes = async () => []
export const activeUsersAll = async () => []
export const chatRankByPerson = async () => []
export const giftRankByPerson = async () => []
export const giftRankByPersonAll = async () => []
export const giftBreakdown = async () => []
export const giftBreakdownAll = async () => []
export const kindBreakdown = async () => []
export const userAnalysisData = async () => ({})
export const userGiftBreakdown = async () => []
export const listUsersPage = async () => ({ rows: [], total: 0 })
`

/* --------------------------------------------------------------- 打包真 hub */

const workDir = mkdtempSync(join(tmpdir(), 'douyin-relive-'))
const stubDir = join(workDir, 'stubs')
require_('node:fs').mkdirSync(stubDir, { recursive: true })
for (const [spec, code] of Object.entries(STUBS)) {
  const safe = spec.replace(/[^a-z0-9]+/gi, '_')
  writeFileSync(join(stubDir, safe + '.mjs'), code)
}

const outfile = join(workDir, 'hub.mjs')
await build({
  entryPoints: [HUB_ENTRY],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning',
  plugins: [
    {
      name: 'relive-stubs',
      setup(api) {
        api.onResolve({ filter: /.*/ }, (args) => {
          if (args.path in STUBS) {
            const safe = args.path.replace(/[^a-z0-9]+/gi, '_')
            return { path: join(stubDir, safe + '.mjs') }
          }
          return null
        })
      }
    }
  ]
})

/* ------------------------------------------------------------------ 虚拟时钟 */

let now = Date.parse('2026-10-11T12:00:00Z')
let timerSeq = 0
const timers = new Map()
const realSetImmediate = globalThis.setImmediate
const realSetTimeout = globalThis.setTimeout

globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const id = (timerSeq += 1)
  timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, every: 0, fired: 0 })
  return id
}
globalThis.setInterval = (fn, ms = 0, ...args) => {
  const every = Math.max(1, Number(ms) || 1)
  const id = (timerSeq += 1)
  timers.set(id, { at: now + every, fn, args, every, fired: 0 })
  return id
}
globalThis.clearTimeout = (id) => timers.delete(id)
globalThis.clearInterval = (id) => timers.delete(id)
// hub 用 Date.now() 记时刻（相位 since、看门狗、房间活跃）：跟着虚拟时钟走
Date.now = () => now

const tick = () => new Promise((resolve) => realSetImmediate(resolve))
const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await tick()
}

/** 推进虚拟时间：到点的定时器按时间顺序一个个跑，每个之后让微任务跑完 */
async function advance(ms) {
  const target = now + ms
  for (;;) {
    let pick = null
    for (const [id, timer] of timers) {
      if (timer.at > target) continue
      if (!pick || timer.at < pick.timer.at) pick = { id, timer }
    }
    if (!pick) break
    const { id, timer } = pick
    now = timer.at
    if (timer.every > 0) timer.at = now + timer.every
    else timers.delete(id)
    timer.fired += 1
    try {
      timer.fn(...timer.args)
    } catch (error) {
      globalThis.__RELIVE_WORLD__?.errors.push(String(error))
    }
    await settle(3)
  }
  now = target
  await settle(3)
}

/* -------------------------------------------------------------------- 断言 */

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label}` +
      (ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`)
  )
}
const info = (label) => console.log(`     · ${label}`)

/* ------------------------------------------------------------- 一个房间的脚本 */

let importSeq = 0

async function boot({ rooms, script = {}, settings = {} }) {
  // 上一个场景的 hub 还挂在内存里，它的 flush / 探测定时器必须清掉：虚拟时钟的队列是全局的，
  // 不清就会拿旧实例的调用去污染新场景的计数（实测第一版工装就是这么把 30 次算成 173 次的）。
  timers.clear()
  const world = {
    rooms: rooms.map((room) => ({ status: 'unknown', title: '工装', ...room })),
    script: { status: 'live', roomId: '1001', failResolve: 0, silent: false, ...script },
    sockets: [],
    resolveCalls: 0,
    resolveTimes: [],
    resolveStacks: [],
    lightRefreshCalls: 0,
    openSessions: 0,
    closeSessions: 0,
    errors: []
  }
  globalThis.__RELIVE_WORLD__ = world
  globalThis.__RELIVE_LOGS__ = []
  importSeq += 1
  const mod = await import(`${pathToFileURL(outfile).href}?n=${importSeq}`)
  const hub = new mod.AnalyzerHub()
  await hub.init({ monitorConcurrency: 1, resumeOnStart: true, ...settings })
  await settle()
  return { hub, world, logs: () => globalThis.__RELIVE_LOGS__ }
}

const live = (world, webRid) =>
  world.sockets.filter((socket) => socket.target.webRid === webRid && !socket.stopped)
const phaseOf = (hub, webRid) => hub.states.get(webRid)?.phase

/* ==================================================================== 场景 */

console.log('工装：真 hub.ts + 桩（解析 / 直连通道 / 数据库），虚拟时钟按分钟推进\n')

/* ------------------------------------------------- 1. 下播后通道装死，重开播要能自己回来 */
console.log('[1] 下播（连接不断、只是没消息）→ 重开播：必须自己换一条新通道')
{
  const { hub, world, logs } = await boot({
    rooms: [{ webRid: '111111', roomId: '1001', monitor: true, addedAt: Date.parse('2026-10-11T11:00:00Z') }],
    script: { status: 'live', roomId: '1001' }
  })
  check('开播时建了一路通道', live(world, '111111').length, 1)
  check('通道用的是解析到的房间号', world.sockets.at(-1)?.target.roomId, '1001')

  // 主播下播：网关既不推下播帧，也不断连接（真机上就是这样），我们只是收不到任何消息
  world.script.status = 'ended'
  await advance(2 * 60_000)
  check('下播两分钟内不乱动通道（没有下播帧，只能靠没数据判断）', live(world, '111111').length, 1)

  // 下播期间也不该反复重连（真机日志里那条「已经废了」的连接一直挂着）
  await advance(4 * 60_000)
  check('下播期间没有反复重连（最多一条新通道）', world.sockets.length <= 2, true)
  info(`此刻通道数 ${world.sockets.length}、相位 ${phaseOf(hub, '111111')}`)

  // 主播重开播：抖音会给一个新的内部房间号，旧连接再也收不到东西
  world.script.status = 'live'
  world.script.roomId = '1002'
  await advance(4 * 60_000)

  const active = live(world, '111111')
  check('重开播之后又有一条活通道', active.length >= 1, true)
  check('新通道用的是重开播后的房间号', active.at(-1)?.target.roomId, '1002')
  check('旧的那条废通道被收掉了', world.sockets[0]?.stopped, true)
  check(
    '看门狗说了实话（日志里能看见「没有任何消息」）',
    logs().some((line) => line.includes('没有任何消息')),
    true
  )
}

/* ---------------------------------------------------------- 2. 探测失败不能把等待链打死 */
console.log('\n[2] 房间没在播 → 某一次探测失败 → 之后重开播仍要能拉起')
{
  const { hub, world } = await boot({
    rooms: [{ webRid: '222222', roomId: '2001', monitor: true, addedAt: Date.parse('2026-10-11T11:00:00Z') }],
    script: { status: 'ended', roomId: '2001' }
  })
  check('没在播 → 相位是「已下播 · 等开播」', phaseOf(hub, '222222'), 'ended')
  check('排了第一次探测', hub.reliveTimers.has('222222'), true)

  world.script.failResolve = 1 // 这一次解析失败（真机里轻刷新就常常失败）
  await advance(61_000)
  check('探测失败后相位不装死机（还是等开播）', phaseOf(hub, '222222'), 'ended')
  check('失败之后仍排着下一次探测', hub.reliveTimers.has('222222'), true)

  world.script.status = 'live'
  world.script.roomId = '2002'
  await advance(10 * 60_000)
  check('重开播后拉起监听', live(world, '222222').length >= 1, true)
  check('并用的是重开播后的房间号', live(world, '222222').at(-1)?.target.roomId, '2002')
}

/* ------------------------------------------------------- 3. 重试次数用尽不能永久放弃 */
console.log('\n[3] 通道连续报错、解析一直失败（网络断了）→ 重试上限之后网络恢复仍要能拉起')
{
  const { hub, world } = await boot({
    rooms: [{ webRid: '333333', roomId: '3001', monitor: true, addedAt: Date.parse('2026-10-11T11:00:00Z') }],
    script: { status: 'live', roomId: '3001' }
  })
  check('先有一路活通道', live(world, '333333').length, 1)

  world.script.failResolve = 10_000 // 之后每一次解析都失败
  world.sockets.at(-1).emitError()
  await settle()
  check('报错后相位是错误', phaseOf(hub, '333333'), 'error')

  await advance(7 * 60_000) // 让重试链跑到 RETRY_LIMIT
  check('用尽后房间仍挂着监控（开关不撒谎）', hub.states.get('333333').monitor, true)
  check(
    '用尽后还有人在管它（探测或重试定时器）',
    hub.reliveTimers.has('333333') || hub.retryTimers.has('333333'),
    true
  )
  info(`此刻 attempts=${hub.states.get('333333').attempts}、解析调用 ${world.resolveCalls} 次`)

  world.script.failResolve = 0
  world.script.status = 'live'
  world.script.roomId = '3002'
  await advance(10 * 60_000)
  check('网络恢复后自己拉起来', live(world, '333333').length >= 1, true)
  check('并且换了新房间号', live(world, '333333').at(-1)?.target.roomId, '3002')
}

/* ------------------------------------------------------------- 4. 正常路径（别改坏） */
console.log('\n[4] 正常路径：等一分钟探测到开播 → 自动开始监控')
{
  const { hub, world } = await boot({
    rooms: [{ webRid: '444444', roomId: '4001', monitor: true, addedAt: Date.parse('2026-10-11T11:00:00Z') }],
    script: { status: 'ended', roomId: '4001' }
  })
  await advance(61_000)
  check('还是没播：继续等', phaseOf(hub, '444444'), 'ended')

  world.script.status = 'live'
  world.script.roomId = '4002'
  await advance(2 * 60_000)
  check('探测到开播 → 建通道', live(world, '444444').length, 1)
  check('相位变成直播中', phaseOf(hub, '444444'), 'live')
}

/* ------------------------------------------------------- 5. 下播帧（服务端真推了下播）路径 */
console.log('\n[5] 服务端推了下播帧：停采集但开关不关，重开播要能回来')
{
  const { hub, world } = await boot({
    rooms: [{ webRid: '555555', roomId: '5001', monitor: true, addedAt: Date.parse('2026-10-11T11:00:00Z') }],
    script: { status: 'live', roomId: '5001' }
  })
  world.sockets.at(-1).emitRoomEnded()
  await settle()
  check('收到下播帧 → 相位「已下播 · 等开播」', phaseOf(hub, '555555'), 'ended')
  check('监控开关保持开着', hub.states.get('555555').monitor, true)
  check('通道收掉了', live(world, '555555').length, 0)

  world.script.status = 'live'
  world.script.roomId = '5002'
  await advance(2 * 60_000)
  check('重开播后拉起', live(world, '555555').length, 1)
  check('用的是新房间号', live(world, '555555').at(-1)?.target.roomId, '5002')
}

/* ------------------------------------------------------------- 6. 别把探测搞成风暴 */
console.log('\n[6] 等待期间探测频率不能失控（每分钟一次就是上限）')
{
  const { world } = await boot({
    rooms: [{ webRid: '666666', roomId: '6001', monitor: true, addedAt: Date.parse('2026-10-11T11:00:00Z') }],
    script: { status: 'ended', roomId: '6001' }
  })
  const before = world.resolveCalls
  await advance(30 * 60_000)
  const called = world.resolveCalls - before
  info(`30 分钟里解析 ${called} 次（轻刷新 ${world.lightRefreshCalls} 次）`)
  const gaps = world.resolveTimes.slice(-12).map((t, i, arr) => (i === 0 ? 0 : Math.round((t - arr[i - 1]) / 1000)))
  info(`最近 12 次探测的间隔（秒）：${gaps.join(', ')}`)
  if (globalThis.__RELIVE_TRACE__) {
    const seen = new Map()
    for (const frames of world.resolveStacks) {
      const key = frames.join(' | ')
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    for (const [key, count] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, 6)) info(`x${count} ${key}`)
  }
  check('30 分钟解析次数在 25~35 之间（一分钟一次）', called >= 25 && called <= 35, true)
}

/* ------------------------------------------- 7. 并发满被排队之后，开播了也要能排到队 */
console.log('\n[7] 并发上限占满：房间重开播先排队，位子一空出来要能真的开跑')
{
  const { hub, world } = await boot({
    rooms: [
      { webRid: '777001', roomId: '7001', monitor: true, addedAt: Date.parse('2026-10-11T11:00:00Z'), lastActiveAt: 2 },
      { webRid: '777002', roomId: '7002', monitor: true, addedAt: Date.parse('2026-10-11T10:00:00Z'), lastActiveAt: 1 }
    ],
    script: { status: 'ended', roomId: '7002' },
    settings: { monitorConcurrency: 1 }
  })
  // 只让 A 占住唯一的并发位（B 还在等开播）
  world.script.status = 'live'
  world.script.roomId = '7001'
  await hub.setMonitor('777001', true)
  await settle()
  check('并发位被 A 占着', live(world, '777001').length, 1)
  check('B 还没在跑', live(world, '777002').length, 0)

  // B 也开播了，但位子被占着 → 只能排队
  world.script.roomId = '7003'
  await advance(61_000)
  check('B 排进了队（相位 queued）', phaseOf(hub, '777002'), 'queued')
  check('排队期间仍然盯着它（还有下一次探测）', hub.reliveTimers.has('777002'), true)

  const before = world.resolveCalls
  await advance(10 * 60_000)
  const called = world.resolveCalls - before
  info(`排队的 10 分钟里解析 ${called} 次`)
  check('排队的探测也是每分钟一次（没有风暴）', called <= 14, true)

  // 用户把 A 的开关关掉 → 位子空出来，B 必须自己开跑
  await hub.setMonitor('777001', false)
  await settle()
  check('B 拿到位子后开跑', live(world, '777002').length >= 1, true)
  check('用的是重开播后的房间号', live(world, '777002').at(-1)?.target.roomId, '7003')
}

/* -------------------------------------------------------------------- 收摊 */

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
rmSync(workDir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)


