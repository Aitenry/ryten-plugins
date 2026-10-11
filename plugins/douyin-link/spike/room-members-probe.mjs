/**
 * 探针：**房间成员名单（`webcast/room/web/enter/` 的 `admin_user_ids_str`）里是真实 id 还是占位**（dev-only）。
 *
 * 这条是「匿名还原」最后一条还没试过的路（2026-10-12）：
 * 匿名观众的 id 在所有推送帧里都是占位 `111111`，但**房间接口的成员名单**是另一条链
 * （不是推送帧，是进房时调的 HTTP 接口）。如果那里给的是**真实 id**，
 * 就能拿「马甲名尾段」在名单里筛一遍，再按粉丝/关注核对——匿名身份就还原了。
 *
 * 跑法：`node plugins/douyin-link/spike/room-members-probe.mjs [webRid...]`
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

const rooms = process.argv.slice(2).filter((a) => /^\d+$/.test(a))
if (rooms.length === 0) rooms.push('108011161837', '760604769280', '41498419462')

async function enter(webRid) {
  /** 先抓页面拿 roomId（与 `main/douyin/room.ts` 同款） */
  const page = await fetch(`https://live.douyin.com/${webRid}`, {
    headers: { 'user-agent': UA, cookie, referer: 'https://live.douyin.com/' }
  })
  const html = await page.text()
  const roomId = html.match(/\\?"roomId\\?"\s*:\s*\\?"(\d{6,})\\?"/)?.[1] ?? ''
  if (!roomId) return { webRid, error: '取不到 roomId（没开播？）' }
  const query = new URLSearchParams({
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    enter_from: 'web_live',
    cookie_enabled: 'true',
    screen_width: '2560',
    screen_height: '1440',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '126.0.0.0',
    web_rid: webRid,
    room_id: roomId,
    did_rule: '3',
    debug: 'false',
    endpoint: 'live_pc',
    support_wrds: '1',
    im_path: '/webcast/im/fetch/',
    resp_content_type: 'protobuf',
    fetch_rule: '1',
    last_rtt: '0',
    user_unique_id: '',
    timestamp: String(Date.now())
  })
  const response = await fetch(`https://live.douyin.com/webcast/room/web/enter/?${query}`, {
    headers: { 'user-agent': UA, cookie, referer: `https://live.douyin.com/${webRid}`, accept: 'application/json, text/plain, */*' }
  })
  const text = await response.text()
  if (!text) return { webRid, roomId, error: 'HTTP 200 空 body（风控/未登录）' }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { webRid, roomId, error: `非 JSON：${text.slice(0, 80)}` }
  }
  const room = json?.data?.data?.[0]
  if (!room) return { webRid, roomId, error: `status_code=${json?.status_code ?? '-'} 没有 data` }
  const members = (room.admin_user_ids_str ?? []).map((id) => String(id))
  return {
    webRid,
    roomId,
    title: room.title ?? '',
    anchor: room.owner?.nickname ?? '',
    online: room.user_count_str ?? '',
    members
  }
}

for (const webRid of rooms) {
  const result = await enter(webRid)
  console.log(`\n=== ${webRid} ===`)
  if (result.error) {
    console.log(`  ${result.error}`)
    continue
  }
  console.log(`  主播=${result.anchor} 在线=${result.online} 标题=${String(result.title).slice(0, 30)}`)
  console.log(`  成员名单 ${result.members.length} 个：${result.members.join(', ') || '(空)'}`)
  const placeholder = result.members.filter((id) => id === '111111').length
  const longIds = result.members.filter((id) => id.length >= 10).length
  console.log(`  其中占位 111111 ${placeholder} 个 / 10 位以上 ${longIds} 个`)
  if (result.members.length > 0 && placeholder === result.members.length) {
    console.log('  → 名单里全是占位 id：这条路对匿名用户没用')
  } else if (longIds > 0) {
    console.log('  → 名单里有真实 id：可以拿「马甲名尾段」来筛！（把这段结论告诉我，我接还原链路）')
  }
}
