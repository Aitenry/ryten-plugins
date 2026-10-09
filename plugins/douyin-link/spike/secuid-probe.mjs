/**
 * 验证「User 的**字段 73** 是不是可用的 `sec_user_id`」（dev-only，不参与打包）。
 *
 * 由来（2026-10-09）：匿名用户的 `id` 是共用占位 `111111`、字段 46（secUid）也没有，
 * 看似不可查；但批量抓帧发现**每个用户的字段 73 都不一样**（`MS4wLj…`），正常用户身上也有。
 * 如果它是 `sec_user_id`，那 `main/douyin/mystery.ts` 那条「按 sec_user_id 查资料」的路就能
 * 把匿名用户还原出来。这个脚本用**已知昵称**的正常用户做对照，一次性判定：
 * - 正常用户 `趣味`：用 `user_id` 查得到 → 再用 `sec_user_id=<字段73>` 查，若也查得到同一个账号，
 *   就证明字段 73 是有效 sec_user_id；
 * - 匿名 `丹***`：直接用 `<字段73>` 查，看能不能揭开真身。
 *
 * 跑法：node plugins/douyin-link/spike/secuid-probe.mjs
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const CHROME = { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }
const PROFILE = 'https://www.douyin.com/aweme/v1/web/user/profile/other/'

/** 抓帧时抄下来的样本（字段 73 与 46 都是日志原文，别改） */
const SAMPLES = [
  {
    label: '对照·正常用户「趣味」',
    userId: '2129126935772616',
    secUid46: 'MS4wLjABAAAAWlq9pG9D04sDdPGHeb9Qbvw_Gi9d23H19pRQ6dY9VaketICX_hQTv1v2UnEwZkkK',
    field73: 'MS4wLjM5MpGa0mKU1jQ0mCrF4H85TFOYS2mTEcYuu9Yrk7snRLj8TuobZ4hTTtXeTbQPJ9I'
  },
  {
    label: '对照·正常用户「Li」',
    userId: '62285497267',
    secUid46: 'MS4wLjABAAAA_HReNP7xUpdvkV9oPB6AioQ1cFQt2l5HZVOWXiFJVCY',
    field73: 'MS4wLjMvwbjLYT3VhcjdEIArsZZv9vQMuWgjJgTeEAnsQm2_PO6jiCzcayrFriZ_Tokp2j8'
  },
  {
    label: '目标·匿名「丹***」',
    userId: '111111',
    secUid46: '',
    field73: 'MS4wLjO2MpFX5h1xAU-NZHxbtyKltXK3dbdxR7CBnaAUEVPl47ewHnwiRPWwLEqw2va3zAw'
  },
  {
    label: '目标·匿名「燕***」',
    userId: '111111',
    secUid46: '',
    field73: 'MS4wLjPcrxYur82AGW_XhDEX9vxlfnnOb6U7FFTS-1fgKjCzOrVt3XcFkouUwBo7uYkDC7Q'
  }
]

async function getCookie() {
  const res = await fetch('https://live.douyin.com/', { headers: CHROME })
  return (res.headers.getSetCookie?.() ?? [])
    .map((e) => e.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

async function query(paramName, value, cookie) {
  const q = new URLSearchParams({
    [paramName]: value,
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    version_code: '190500',
    publish_video_strategy_type: '2'
  })
  try {
    const res = await fetch(`${PROFILE}?${q}`, {
      headers: { ...CHROME, cookie, referer: 'https://www.douyin.com/', accept: 'application/json,*/*' },
      signal: AbortSignal.timeout(12000)
    })
    const text = await res.text()
    if (!text) return { http: res.status, empty: true }
    const j = JSON.parse(text)
    const u = j.user || {}
    return {
      http: res.status,
      status_code: j.status_code,
      nickname: u.nickname,
      unique_id: u.unique_id,
      follower: u.follower_count,
      hasAvatar: Boolean(u.avatar_300x300?.url_list?.[0])
    }
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 120) }
  }
}

const cookie = await getCookie()
console.log(`# ttwid cookie ${cookie ? '已拿到' : '没拿到（后面都会空 body）'}\n`)

for (const s of SAMPLES) {
  console.log(`=== ${s.label} ===`)
  const byId = await query('user_id', s.userId, cookie)
  console.log(`  user_id=${s.userId}                → ${JSON.stringify(byId)}`)
  if (s.secUid46) {
    const by46 = await query('sec_user_id', s.secUid46, cookie)
    console.log(`  sec_user_id=<字段46>              → ${JSON.stringify(by46)}`)
  }
  const by73 = await query('sec_user_id', s.field73, cookie)
  console.log(`  sec_user_id=<字段73>              → ${JSON.stringify(by73)}`)
  console.log('')
}

console.log('# 判读：若「正常用户」按 <字段73> 查到的是**同一个账号**（昵称对得上），字段 73 就是有效 sec_user_id；')
console.log('#      那么匿名用户按 <字段73> 查到的昵称，就是他藏起来的真身。')