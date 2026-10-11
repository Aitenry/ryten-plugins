/**
 * 探针：**拿匿名帧里泄漏出来的 `sec_uid`（字段 73）去还原真实账号**（dev-only，不参与打包）。
 *
 * 这是 2026-10-12 抓帧时发现的**突破口**（`spike/anon-live-probe.mjs` 抓到的匿名帧里，
 * 916/923 条都带着字段 73 = `MS4wLjMk…`，正是抖音的 `sec_uid`）：
 * 匿名帧的 `id` 是占位 `111111`，但**`sec_uid` 没被抹掉**。
 *
 * 已试过一条：`aweme/v1/web/user/profile/other/?sec_user_id=…` → `status_code 2`（不给资料，
 * 这条接口要 `a_bogus` 签名）。所以这里一次把**不需要签名的几条老路**都试一遍：
 * 1. `https://www.iesdouyin.com/share/user/<sec_uid>`（分享页，历史上免签名、HTML 里内嵌资料）
 * 2. `https://www.douyin.com/user/<sec_uid>`（web 主页 HTML，可能内嵌 RENDER_DATA）
 * 3. `https://www.iesdouyin.com/web/api/v2/user/info/?sec_uid=…`（老 web 接口）
 * 4. `https://aweme.snssdk.com/aweme/v1/aweme/post/?sec_user_id=…`（老 App 接口）
 *
 * 跑法：`node plugins/douyin-link/spike/anon-secuid-probe.mjs <sec_uid>`
 * sec_uid 从真机抓：`node plugins/douyin-link/spike/anon-live-probe.mjs 60 3 --resolve`（日志里看「字段 73」）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function readCookie() {
  const file = join(process.env.APPDATA ?? '', 'ryten-bench', 'plugin-state', 'douyin-link.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed.douyinCookie === 'string' ? parsed.douyinCookie : ''
  } catch {
    return ''
  }
}
const cookie = readCookie()

/**
 * **对照组**：拿一个已知真实用户的 sec_uid（`--control=<sec_uid>`）查一遍。
 *
 * 为什么必须要这一步：`status_code 2 ｜ UserId不合法` 有两种可能——
 * ① 这个接口根本不吃 `sec_user_id`（参数被丢了）；② 我们抓到的那个 sec_uid 是**诱饵**（真人才查得到）。
 * 只有对照组能分开这两件事：真人的 sec_uid 查得到 = 接口吃这个参数 → 抓到的那个是假的；
 * 真人的也报同一个错 = 接口不吃 → 得换接口。
 */
const control = process.argv.find((a) => a.startsWith('--control='))?.slice('--control='.length)
if (control) {
  const url = `https://www.douyin.com/aweme/v1/web/user/profile/other/?sec_user_id=${control}&device_platform=webapp&aid=6383&channel=channel_pc_web&version_code=190500`
  const response = await fetch(url, {
    headers: { 'user-agent': UA, cookie, referer: 'https://www.douyin.com/', accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(15000)
  })
  const text = await response.text()
  console.log(`# 对照组（已知真人 sec_uid=…${control.slice(-10)}）→ HTTP ${response.status}`)
  console.log(`  ${text.slice(0, 240)}\n`)
}
const secUid = String(process.argv[2] ?? '').trim()
if (!/^MS4wLj/.test(secUid)) {
  console.error('用法：node anon-secuid-probe.mjs <sec_uid>（`MS4wLj…` 开头）')
  console.error('sec_uid 从真机抓一条：node anon-live-probe.mjs 60 3 --resolve，日志里看「字段 73」')
  process.exit(2)
}
console.log(`# sec_uid=${secUid.slice(0, 28)}…（${secUid.length} 字符）\n`)

async function probe(label, url, { json = false } = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': UA,
        cookie,
        referer: 'https://www.douyin.com/',
        accept: json ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(15000)
    })
    const text = await response.text()
    if (!text) {
      console.log(`${label} → HTTP ${response.status} 空 body`)
      return
    }
    /** 只抽可读的几条线索，不打印整页 */
    const nick =
      text.match(/"nickname"\s*:\s*"([^"]{1,40})"/)?.[1] ?? text.match(/<title>([^<]{1,60})<\/title>/)?.[1] ?? ''
    const uid = text.match(/"uid"\s*:\s*"(\d{6,})"/)?.[1] ?? text.match(/"user_id"\s*:\s*"(\d{6,})"/)?.[1] ?? ''
    const uniqueId = text.match(/"unique_id"\s*:\s*"([^"]{1,40})"/)?.[1] ?? ''
    const follower = text.match(/"follower_count"\s*:\s*(\d+)/)?.[1] ?? ''
    console.log(
      `${label} → HTTP ${response.status}，${text.length} 字符` +
        (nick || uid
          ? `：昵称=${nick || '-'} uid=${uid || '-'} 抖音号=${uniqueId || '-'} 粉丝=${follower || '-'}`
          : '（没看到资料字段）')
    )
  } catch (error) {
    console.log(`${label} → 失败：${String(error?.message ?? error).slice(0, 80)}`)
  }
}

await probe('① iesdouyin 分享页', `https://www.iesdouyin.com/share/user/${secUid}`)
await probe('② 抖音 web 主页', `https://www.douyin.com/user/${secUid}`)
await probe('③ 老 web 用户接口', `https://www.iesdouyin.com/web/api/v2/user/info/?sec_uid=${secUid}`, { json: true })
await probe('④ 老 App 作品接口', `https://aweme.snssdk.com/aweme/v1/aweme/post/?sec_user_id=${secUid}&count=1&aid=1128`, {
  json: true
})
await probe(
  '⑤ webcast 用户接口',
  `https://live.douyin.com/webcast/user/?sec_user_id=${secUid}&aid=6383&device_platform=web`,
  { json: true }
)

console.log('\n# 读法：哪一条回了昵称/uid，就用那条接进还原链路（写进 main/douyin/mystery.ts）。')
