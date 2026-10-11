/**
 * 探针：**「匿名」昵称 + 真实 id 的那一类能不能还原**（dev-only，不参与打包）。
 *
 * 2026-10-12 真机抓帧（`anon-live-probe.mjs`，5,087 帧 / 11,820 个 User 段）抓到 4 条关键帧：
 *
 * ```
 * id=97987526879       昵称=匿名        sec_uid=有
 * id=3350907373498030  昵称=匿名        sec_uid=有
 * id=3350907373498030  昵称=匿名        sec_uid=有（同一个人再次出现）
 * id=91906055010       昵称=神秘人二阶   sec_uid=有
 * ```
 *
 * 也就是说抖音的「匿名」分两种，**不能一锅端**：
 * - A 类：`id = 111111`（**共用占位**）+ 昵称打码 `秋***` 或马甲 `dou2056511` → 身份真的没了；
 * - B 类：`id = 真实数字 id` + 昵称才是「匿名/神秘人二阶」→ **id 还在**，拿它直接查资料就行。
 *
 * 这个探针用 B 类那条真实 id 走一遍 `fetchUserProfile`（与用户档案里「查看真实资料」同一条链），
 * 证明「匿名的人也能查到资料」在 B 类上是**真的成立**的。
 *
 * 跑法：`node plugins/douyin-link/spike/anon-mystery-probe.mjs [真实id...]`
 * 默认拿一个库里的真实 id 当对照，确保是接口通、不是运气。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const PROFILE = 'https://www.douyin.com/aweme/v1/web/user/profile/other/'
const TIMEOUT = 15000

const ids = process.argv.slice(2).filter((a) => /^\d{4,}$/.test(a))
if (ids.length === 0) {
  /** 真机抓到的那两条（此刻可能已被抖音处理，查不到也算证据）+ 一个已知真人做对照 */
  ids.push('97987526879', '3350907373498030', '91906055010', '97537436664')
}

const response = await fetch('https://live.douyin.com/', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT) })
const cookie = (response.headers.getSetCookie?.() ?? []).map((e) => e.split(';')[0]).join('; ')
await response.text().catch(() => undefined)
console.log(`# cookie ${cookie.length} 字符\n`)

for (const id of ids) {
  const query = new URLSearchParams({
    user_id: id,
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    version_code: '190500',
    publish_video_strategy_type: '2'
  })
  try {
    const profile = await fetch(`${PROFILE}?${query}`, {
      headers: { 'user-agent': UA, cookie, referer: 'https://www.douyin.com/', accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    const text = await profile.text()
    if (!text) {
      console.log(`id=${id} → HTTP ${profile.status} 空 body`)
      continue
    }
    const json = JSON.parse(text)
    const user = json.user
    if (!user?.nickname) {
      console.log(`id=${id} → status_code=${json.status_code}（没有 user）`)
      continue
    }
    console.log(
      `id=${id} → ★ 查到资料：昵称=${user.nickname} 抖音号=${user.unique_id ?? '-'} ` +
        `粉丝=${user.follower_count} 关注=${user.following_count} sec_uid=${String(user.sec_uid ?? '').slice(0, 16)}…`
    )
  } catch (error) {
    console.log(`id=${id} → 失败：${String(error?.message ?? error).slice(0, 80)}`)
  }
}

console.log(
  '\n# 读法：带 id 的「匿名」用户能查到资料 → 插件的「查看真实资料」对这类人是**有效**的；\n' +
    '#       只有 `id = 111111`（共用占位）的那类才真的还原不了（见 main/douyin/anonymous-reveal.ts）。'
)
