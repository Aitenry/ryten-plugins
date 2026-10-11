/**
 * 探针：**马甲名里的数字是不是「短 id」**（dev-only，不参与打包）。
 *
 * 线索（2026-10-12）：真机上见过的马甲名都是 `dou` + 7 位数字（`dou2056511`），
 * 而抖音每个账号还有一个**短 id**（`short_id`，界面上的「抖音号」之前那一代标识）。
 * 如果 `2056511` 就是那个短 id，那么：
 *   `dou2056511` → 短 id `2056511` → 用短 id 查资料接口 → 拿回真实 uid
 * 这条路**不需要枚举**，一次请求就能通——所以值得单独验一次。
 *
 * 三个候选接口（都是免签名的 web 端接口，带登录态 cookie）：
 * 1. `aweme/v1/web/user/profile/other/?short_id=`（`mystery.ts` 那条链的兄弟参数）
 * 2. `aweme/v1/web/discover/search/?keyword=2056511&search_channel=aweme_user_web`（按短 id 搜）
 * 3. `www.douyin.com/user/self` 之外最朴素的：`/webcast/room/web/enter/` 的成员名单里找短 id 对不上号，跳过
 *
 * 跑法：`node plugins/douyin-link/spike/anon-shortid-probe.mjs [马甲名...]`
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
const masks = process.argv.slice(2).filter((a) => /^dou\d{4,}$/i.test(a))
if (masks.length === 0) masks.push('dou2056511', 'dou1330533')

async function getJson(path, params) {
  const query = new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    version_code: '190500',
    ...params
  })
  try {
    const response = await fetch(`https://www.douyin.com${path}?${query}`, {
      headers: { 'user-agent': UA, cookie, referer: 'https://www.douyin.com/', accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(15000)
    })
    const text = await response.text()
    if (!text) return { empty: true, status: response.status }
    return { status: response.status, json: JSON.parse(text) }
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 80) }
  }
}

for (const mask of masks) {
  const shortId = mask.replace(/^dou/i, '')
  console.log(`\n=== 马甲 ${mask}（候选短 id ${shortId}）===`)

  /** ① 用短 id 直接查资料 */
  const byShort = await getJson('/aweme/v1/web/user/profile/other/', { short_id: shortId })
  if (byShort.json) {
    const user = byShort.json.user
    console.log(
      `  ① profile?short_id=${shortId} → status=${byShort.json.status_code ?? '-'} ` +
        (user?.nickname ? `★ 有资料：昵称=${user.nickname} uid=${user.uid ?? user.user_id ?? '-'} 粉丝=${user.follower_count ?? '-'}` : '（没有 user）')
    )
  } else {
    console.log(`  ① profile?short_id → ${byShort.error ?? `HTTP ${byShort.status} 空 body`}`)
  }

  /** ② 把短 id 当关键词搜用户 */
  const search = await getJson('/aweme/v1/web/discover/search/', {
    keyword: shortId,
    search_channel: 'aweme_user_web',
    type: '1',
    offset: '0',
    count: '10'
  })
  if (search.json) {
    const list = (search.json.user_list ?? []).map((entry) => entry?.user_info ?? entry).filter(Boolean)
    const exact = list.filter((user) => String(user.short_id ?? '') === shortId || String(user.unique_id ?? '').toLowerCase() === mask.toLowerCase())
    console.log(`  ② search?keyword=${shortId} → status=${search.json.status_code ?? '-'} 结果 ${list.length} 条，其中短 id/抖音号命中的 ${exact.length} 条`)
    for (const user of list.slice(0, 4)) {
      console.log(`     · uid=${user.uid ?? user.user_id ?? '-'} 昵称=${user.nickname ?? '-'} 短id=${user.short_id ?? '-'} 抖音号=${user.unique_id ?? '-'} 粉丝=${user.follower_count ?? '-'}`)
    }
  } else {
    console.log(`  ② search → ${search.error ?? `HTTP ${search.status} 空 body`}`)
  }
}

console.log('\n# 读法：①或②里只要出现「昵称 == 马甲名」或「短 id 命中且数字对得上」，短 id 这条路就成立。')
