/**
 * 探针：「神秘人还原」到底该调哪个接口（2026-10-09）。
 *
 * 参考项目 liangshengmoran/dyMysteryManMagicMirror 用的是
 * `webcast/ranklist/audience/`（观众榜——匿名的人会在里面泄露 `sec_uid`），
 * 然后按 `sec_uid` 查第三方资料接口。两年后复测：
 * 1. 观众榜接口**已失效**：带匿名 ttwid 无论怎么拼参数都返回 200 空 body；
 * 2. 但抖音 web 端的 `aweme/v1/web/user/profile/other/` **免签名**，只要有 ttwid cookie，
 *    按 `user_id`（数字串，我们总是有）就能拿到完整资料——这就是 `main/douyin/mystery.ts` 的做法。
 *
 * 跑法：`node plugins/douyin-link/spike/mystery-probe.mjs`
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function get(url, cookie, referer, accept) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      cookie: cookie || '',
      referer: referer || 'https://live.douyin.com/',
      accept: accept || 'application/json, text/plain, */*'
    },
    signal: AbortSignal.timeout(12000)
  })
  const list = res.headers.getSetCookie?.() || []
  return { status: res.status, text: await res.text(), cookie: list.map((c) => c.split(';')[0]).join('; ') }
}

/* 1) 从直播 feed 里挑一个正在直播的房间（feed 接口本身免签名） */
const home = await fetch('https://live.douyin.com/', { headers: { 'user-agent': UA } })
const cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ')
const feed = JSON.parse(
  (await get('https://live.douyin.com/webcast/feed/?aid=6383&app_name=douyin_web&device_platform=web&count=15', cookie)).text
)
const room = (feed.data || []).map((d) => d.data).find((r) => r && r.status === 2)
const owner = room.owner
console.log('房间示例：', { roomId: room.id_str, 主播: owner?.nickname, uid: owner?.id_str })

/* 2) 观众榜：实测恒返回空 body（接口已失效），这就是不用它的原因 */
const rank = await get(
  `https://live.douyin.com/webcast/ranklist/audience/?aid=6383&rank_type=30&room_id=${room.id_str}`,
  cookie
)
console.log('观众榜 ranklist：body 长度 =', rank.text.length, '（0 = 接口不给数据了）')

/* 3) 用户资料接口：按 user_id 免签名拿真资料——神秘人还原就靠它 */
const profile = await get(
  `https://www.douyin.com/aweme/v1/web/user/profile/other/?user_id=${owner.id_str}&device_platform=webapp&aid=6383&channel=channel_pc_web&version_code=190500&publish_video_strategy_type=2`,
  cookie,
  'https://www.douyin.com/'
)
const u = JSON.parse(profile.text).user || {}
console.log('profile/other?user_id=：', {
  status_code: JSON.parse(profile.text).status_code,
  nickname: u.nickname,
  unique_id: u.unique_id,
  follower_count: u.follower_count,
  有头像: Boolean(u.avatar_300x300?.url_list?.[0])
})
