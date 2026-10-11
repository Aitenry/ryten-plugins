/**
 * 探针：**能不能用「昵称」把匿名马甲后面那个真实账号搜出来**（dev-only，不参与打包）。
 *
 * 由来（用户 2026-10-12 的要求）：「我需要匿名用户，可以和神秘人一样获取其信息」。
 *
 * 已在 `anon-reveal-probe.mjs` 里实测排除掉的两条路：
 * - 直接拿共用占位 id `111111` 查资料 → 抖音回 `status_code 3170` + 一个空壳 user（查不到）；
 * - 「马甲名尾段 = 真实 id 尾段」再反查 → 真库里没有任何真 id 以那些尾段结尾，
 *   而且按前缀小池子扫完之后抖音开始回空 body（风控），这条路也不成立。
 *
 * 剩下**不需要猜数字**的一条路：抖音自己的用户搜索。马甲名（`dou2056511`）是抖音给它挂的
 * 展示名，那就直接拿这个名字去搜——搜到就用搜出来的真实资料走既有回填链路。
 *
 * 这个脚本只做一件事实核查：**带着应用里那份登录态 cookie** 去搜，看上不上得了、
 * 拿不拿得到 `user_list`（含 uid / 昵称 / 粉丝数）。上不了就照实说，不硬编一条查不到的路。
 *
 * 跑法：`node plugins/douyin-link/spike/anon-search-probe.mjs [昵称]`
 * ⚠️ 只读设置文件里的 cookie；输出里 cookie 只打长度，不打印内容。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const keyword = process.argv[2] || 'dou2056511'
/** 已知的对照信息（人工从档案里抄）：用来判定「搜到的到底是不是同一个人」 */
const EXPECT = {
  follower: Number(process.env.DY_PROBE_FOLLOWER ?? 9974),
  following: Number(process.env.DY_PROBE_FOLLOWING ?? 12)
}
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const TIMEOUT = 15000

/** 设置文件里的登录态 cookie（`plugin-state/douyin-link.json`；只取 `douyinCookie`） */
function readCookie() {
  const file = join(process.env.APPDATA ?? '', 'ryten-bench', 'plugin-state', 'douyin-link.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed.douyinCookie === 'string' ? parsed.douyinCookie : ''
  } catch (error) {
    console.error(`读设置失败（${file}）：${error.message}`)
    return ''
  }
}

const cookie = readCookie()
console.log(`# 昵称搜索探针：keyword=${keyword}`)
console.log(`  cookie：${cookie.length} 字符，ttwid=${cookie.includes('ttwid')}，sessionid=${cookie.includes('sessionid')}`)
if (!cookie) {
  console.error('  没有 cookie：接口会回空 body，先填好设置里的登录态 cookie 再跑')
  process.exit(2)
}

/** 一次请求：返回 { status, text }，正文截断保存（供人肉看结构，不做解析断言） */
async function get(url, { json = false } = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': UA,
        cookie,
        referer: 'https://www.douyin.com/',
        accept: json ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(TIMEOUT)
    })
    const text = await response.text()
    return { status: response.status, text }
  } catch (error) {
    return { status: 0, text: `请求失败：${String(error?.message ?? error).slice(0, 120)}` }
  }
}

console.log('\n=== 1. web 用户搜索接口（免签名的那个）===')
{
  const query = new URLSearchParams({
    keyword,
    search_channel: 'aweme_user_web',
    type: '1',
    offset: '0',
    count: '10',
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    version_code: '190500'
  })
  const result = await get(`https://www.douyin.com/aweme/v1/web/discover/search/?${query}`, { json: true })
  console.log(`  HTTP ${result.status}，正文 ${result.text.length} 字符`)
  if (result.text.startsWith('{')) {
    let json = null
    try {
      json = JSON.parse(result.text)
    } catch {
      /* 非 JSON：下面按原文打前 200 字符 */
    }
    if (json) {
      const users = json.user_list ?? []
      const flat = Array.isArray(users)
        ? users.map((entry) => entry?.user_info ?? entry).filter(Boolean)
        : []
      console.log(`  status_code=${json.status_code ?? '-'} user_list=${flat.length} 条`)
      for (const user of flat.slice(0, 10)) {
        const nickname = user.nickname ?? '-'
        const follower = Number(user.follower_count ?? -1)
        const following = Number(user.following_count ?? -1)
        const exact = nickname === keyword
        const sameNumbers = follower === EXPECT.follower && following === EXPECT.following
        console.log(
          `   ${exact ? '★' : ' '} uid=${user.uid ?? user.user_id ?? '-'} 昵称=${nickname} ` +
            `抖音号=${user.unique_id || user.short_id || '-'} 粉丝=${follower} 关注=${following}` +
            `${exact ? '（昵称完全一致）' : ''}${sameNumbers ? '（粉丝/关注也对得上）' : ''}`
        )
      }
      console.log(
        `  目标：昵称 ${keyword}、粉丝 ${EXPECT.follower}、关注 ${EXPECT.following} ` +
          `→ 精确命中 ${flat.filter((u) => (u.nickname ?? '') === keyword).length} 条`
      )
    }
  } else {
    console.log(`  正文前 200 字符：${result.text.slice(0, 200)}`)
  }
}

console.log('\n=== 2. 搜索页 HTML 里有没有内嵌的用户数据 ===')
{
  const result = await get(`https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=user`)
  console.log(`  HTTP ${result.status}，正文 ${result.text.length} 字符`)
  const markers = ['RENDER_DATA', 'user_list', 'follower_count', 'unique_id', 'sec_uid', 'window.__INITIAL']
  console.log(`  出现的关键字：${markers.filter((marker) => result.text.includes(marker)).join(' / ') || '（一个都没有）'}`)
}

console.log('\n# 结论怎么读：')
console.log('#  - 第 1 节有 user_list 且 uid 不为空 → 「按昵称搜出真实账号」这条路成立，可以接进神秘人流程；')
console.log('#  - 两节都是空 body / 风控页 → 这条也走不通，那就只能如实告诉用户「匿名身份不可还原」。')
