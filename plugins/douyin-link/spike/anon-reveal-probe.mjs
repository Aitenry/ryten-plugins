/**
 * 探针：**匿名占位 id（`111111`）能不能像神秘人那样把资料查回来**（dev-only，不参与打包）。
 *
 * 背景：抖音给「隐藏身份」观众发的 id 全是共用占位串 `111111`，昵称则是一个马甲名
 * （实测形如 `dou2056511`）。用户要求「匿名用户可以和神秘人一样获取其信息」，
 * 所以这里要真刀真枪测三件事，**不靠推理**：
 *
 * 1. **直接拿占位 id 查**：`aweme/v1/web/user/profile/other/?user_id=111111` 有回话吗？
 *    （预期 notFound——真实账号标识被抹平了，但要拿到实测证据）
 * 2. **马甲名是不是「dou + 真实 id 尾段」**：真库里搜过一遍，**没有一个真账号**的 id
 *    以这些尾段结尾（所以尾段只可能是真实 id 的后 7 位，不是完整 id）；
 * 3. **反查可不可行**：如果 (2) 成立，真实 id = `<未知前缀><尾段>`，那就用**同房间同昵称档案里
 *    已知的字段**（荣誉等级 / 粉丝数 / 关注数）做判定标准，把候选 id 拿去查抖音资料，
 *    命中（昵称 == 马甲名 且 粉丝数与关注数都对得上）就说明「匿名身份可以还原」。
 *
 * 跑法：`node plugins/douyin-link/spike/anon-reveal-probe.mjs [--sweep=起点,终点] [--mask=dou2056511]`
 *  - 默认只探 ①（直接查占位 id）与 ③ 的**极小规模**扫描（各长度取 40 个候选；
 *    前缀取真库里真账号的常见前缀规律：19 位 → `73` + 8 位增量；10 位 → `93xxx`）。
 *  - `--sweep=930000000,930999999` 这种显式区间才会大规模扫（自己控制量，别刷爆接口）。
 *
 * ⚠️ 这个脚本会**真的请求抖音**（公开接口、带游客 ttwid），只在你想验证时手动跑。
 */
import { existsSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const sweepArg = args.find((a) => a.startsWith('--sweep='))
const maskArg = args.find((a) => a.startsWith('--mask='))?.slice('--mask='.length) || 'dou2056511'
/** 马甲名 → 需要被解释成真实 id 尾段的那几位数字 */
const tail = maskArg.replace(/^dou/, '')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const PROFILE = 'https://www.douyin.com/aweme/v1/web/user/profile/other/'
const TIMEOUT = 12000

/** 取一份游客 cookie（与 `main/douyin/mystery.ts` 同款：接口没 ttwid 会 200 空 body） */
async function getCookie() {
  const response = await fetch('https://live.douyin.com/', {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(TIMEOUT)
  })
  const headers = response.headers
  const list =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ?? '').split(/,(?=[^;,=]+=)/)
  void response.text().catch(() => undefined)
  return list
    .map((entry) => entry.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

let cookie = ''
let requests = 0
const startedAt = Date.now()

async function profiles(userId) {
  const query = new URLSearchParams({
    user_id: String(userId),
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    version_code: '190500',
    publish_video_strategy_type: '2'
  })
  requests += 1
  try {
    const response = await fetch(`${PROFILE}?${query}`, {
      headers: {
        'user-agent': UA,
        cookie,
        referer: 'https://www.douyin.com/',
        accept: 'application/json, text/plain, */*'
      },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    const text = await response.text()
    if (!text) return { userId, status: `HTTP ${response.status} 空 body` }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return { userId, status: `非 JSON：${text.slice(0, 60)}` }
    }
    const user = json.user
    if (!user) return { userId, status: `status_code=${json.status_code} 无 user` }
    return {
      userId,
      nickname: user.nickname ?? '',
      displayId: user.unique_id ?? '',
      secUid: user.sec_uid ?? '',
      follower: user.follower_count ?? 0,
      following: user.following_count ?? 0,
      honor: user.pay_grade?.level ?? user.pay_grade?.score ?? 0,
      status: 'ok'
    }
  } catch (error) {
    return { userId, status: `请求失败：${String(error?.message ?? error).slice(0, 80)}` }
  }
}

/** 已知的真实账号档案（人工从日志/帧里抄，或用 `--expect=` 覆盖） */
const EXPECT = {
  follower: Number(process.env.DY_PROBE_FOLLOWER ?? 9974),
  following: Number(process.env.DY_PROBE_FOLLOWING ?? 12)
}

/**
 * 候选 id 的长度档位（真实 id 实测 10~19 位都有）。
 *
 * 反查的规模完全由「几位未知」决定：id 总长 L、前缀 P、尾段 7 位 → 未知 L−P−7 位。
 * 所以先扫**小池子**（10 位全量 = 1e3、11 位带常见前缀 = 1e4），撞到就说明这条路走得通。
 */
/**
 * 候选 id：**固定总长 L**，尾部就是马甲名里那 7 位，前面用给定前缀 + 未知位补足。
 *
 * 例如马甲 `dou2056511`（尾段 `2056511`，7 位）、L=11、前缀 `93` → `93` + 2 位未知 + 尾段
 * = 10000 个候选。`L - prefix.length - 7` 就是未知位数，也就是这条路的搜索规模。
 */
function candidatesForPrefix(prefix, totalLength) {
  const unknown = Math.max(0, totalLength - prefix.length - tail.length)
  const out = []
  for (let index = 0; index < 10 ** unknown; index += 1) {
    out.push(`${prefix}${String(index).padStart(unknown, '0')}${tail}`)
  }
  return out
}

console.log(`# 匿名身份还原探针（马甲 ${maskArg} → 尾段 ${tail}）`)

console.log('\n=== 0. 取游客 cookie ===')
try {
  cookie = await getCookie()
} catch (error) {
  console.error(`  取 cookie 失败：${error.message}`)
  process.exit(2)
}
console.log(`  cookie ${cookie.length} 字符（${cookie.split('; ').length} 个键）`)
if (!cookie.includes('ttwid')) {
  console.error('  没有 ttwid：接口会 200 空 body，先解决网络/风控再跑')
  process.exit(2)
}

console.log('\n=== 1. 直接拿共用占位 id 查资料 ===')
{
  /** 原始回话也打出来：`user` 是「对象但没名字」还是「根本没有 user」，决定了失败码怎么给 */
  const query = new URLSearchParams({ user_id: '111111', device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', version_code: '190500' })
  const response = await fetch(`${PROFILE}?${query}`, {
    headers: { 'user-agent': UA, cookie, referer: 'https://www.douyin.com/', accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(TIMEOUT)
  })
  const raw = await response.text()
  console.log(`  原始回话（前 400 字符）：${raw.slice(0, 400)}`)
}
for (const id of ['111111', '0']) {
  const row = await profiles(id)
  console.log(`  user_id=${id} → ${JSON.stringify(row)}`)
}

console.log('\n=== 2. 对照：拿一个已知的真实 id 查（证明接口本身是通的）===')
const control = process.env.DY_PROBE_CONTROL ?? ''
if (control) {
  console.log(`  user_id=${control} → ${JSON.stringify(await profiles(control))}`)
} else {
  console.log('  （没给 DY_PROBE_CONTROL：跳过。给一个你库里的真实 id 就能看到「接口通」的对照组）')
}

console.log('\n=== 3. 反查：真实 id = 未知前缀 + 尾段，按「昵称 + 粉丝 + 关注」判定 ===')
const candidates = []
if (sweepArg) {
  const [from, to] = sweepArg.slice('--sweep='.length).split(',').map((v) => Number(v))
  const step = from <= to ? 1 : -1
  for (let value = from; step > 0 ? value <= to : value >= to; value += step) candidates.push(String(value))
  console.log(`  显式区间扫描：${candidates.length} 个候选`)
} else {
  /**
   * 默认扫**两档**：总长 10 位（前缀 `93` + 0 位未知 → 1 个）+ 总长 11 位（前缀 + 2 位未知）。
   * 真实 id 实测 10~19 位都有；prefix 取真库里最常见的那几个开头（`93`/`97`/`73`）。
   * 想换池子：`--prefix=93 --len=11`（4 位未知 = 10000 个）或 `--sweep=起点,终点`。
   */
  const prefixArg = args.find((a) => a.startsWith('--prefix='))?.slice('--prefix='.length)
  const lenArg = Number(args.find((a) => a.startsWith('--len='))?.slice('--len='.length) ?? 0)
  if (prefixArg) {
    const pool = candidatesForPrefix(prefixArg, lenArg || 11)
    candidates.push(...pool)
    console.log(`  前缀 ${prefixArg} / 总长 ${lenArg || 11} → ${pool.length} 个候选`)
  } else {
    const pools = [
      { prefix: '93', len: 11 },
      { prefix: '97', len: 11 },
      { prefix: '73', len: 12 }
    ]
    let total = 0
    for (const pool of pools) {
      const list = candidatesForPrefix(pool.prefix, pool.len)
      total += list.length
      console.log(`  · 前缀 ${pool.prefix} / 总长 ${pool.len} → ${list.length} 个候选（示例 ${list[0] ?? '-'}）`)
      candidates.push(...list)
    }
    console.log(`  小池子扫描合计 ${total} 个候选（想换池子用 --prefix= --len= 或 --sweep=）`)
  }
}

let hits = 0
let ok = 0
const CONCURRENCY = Number(process.env.DY_PROBE_CONCURRENCY ?? 12)
for (let index = 0; index < candidates.length; index += CONCURRENCY) {
  const slice = candidates.slice(index, index + CONCURRENCY)
  const rows = await Promise.all(slice.map((id) => profiles(id)))
  for (const row of rows) {
    if (row.status !== 'ok') continue
    ok += 1
    const nicknameHit = row.nickname === maskArg
    const followerHit = row.follower === EXPECT.follower
    const followingHit = row.following === EXPECT.following
    if (nicknameHit && followerHit && followingHit) {
      hits += 1
      console.log(`\n  ★★ 命中：${JSON.stringify(row)}`)
    } else if (nicknameHit) {
      console.log(`\n  · 昵称撞上但数字不符：${JSON.stringify(row)}（目标 粉丝 ${EXPECT.follower} / 关注 ${EXPECT.following}）`)
    } else if (followerHit && followingHit) {
      console.log(`\n  · 数字对得上但昵称不同：${JSON.stringify(row)}`)
    }
  }
  if (index % (CONCURRENCY * 25) === 0) {
    const done = Math.min(index + CONCURRENCY, candidates.length)
    const rate = (requests / ((Date.now() - startedAt) / 1000)).toFixed(1)
    process.stdout.write(
      `  …${done}/${candidates.length}（有 user 的 ${ok} 个 · 命中 ${hits} · ${rate} req/s · ${((Date.now() - startedAt) / 1000).toFixed(0)}s）\r`
    )
  }
}

console.log(
  `\n  小计：请求 ${requests} 次 / 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s / ` +
    `有 user 的响应 ${ok} 个 / **命中 ${hits} 个**`
)
const file = process.env.DY_PROBE_OUT
if (file && existsSync(file)) readFileSync(file)
