/**
 * 取一份「正在开播」的房间号清单（dev-only）：给 `anon-live-probe.mjs --rooms=` 用。
 *
 * 为什么需要：匿名（隐藏身份）观众只在**正在播的房间**里出现，而房间号猜不得——
 * 上面几轮都是「跳过：没开播」。抖音的推荐流接口给的是一批**此刻在播**的房间。
 *
 * 跑法：`node plugins/douyin-link/spike/live-rooms.mjs` → 打印逗号分隔的 web_rid
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const res = await fetch('https://live.douyin.com/', { headers: { 'user-agent': UA } })
const cookie = (res.headers.getSetCookie?.() ?? []).map((e) => e.split(';')[0]).join('; ')
const home = await res.text()

const sources = [
  { label: '首页 HTML', url: 'https://live.douyin.com/', body: home },
  {
    label: '分类页（热门）',
    url: 'https://live.douyin.com/category/1',
    body: await (
      await fetch('https://live.douyin.com/category/1', { headers: { 'user-agent': UA, cookie } })
    ).text()
  }
]

const seen = new Set()
for (const source of sources) {
  const matches = [
    ...source.body.matchAll(/\\?"web_rid\\?"\s*:\s*\\?"(\d{6,})\\?"/g),
    ...source.body.matchAll(/live\.douyin\.com\/(\d{6,})/g),
    ...source.body.matchAll(/"webRid"\s*:\s*"(\d{6,})"/g)
  ]
  for (const match of matches) seen.add(match[1])
  console.log(`# ${source.label}：${source.body.length} 字符 → 累计 ${seen.size} 个房间号`)
}
const rooms = [...seen]
console.log(`# 共 ${rooms.length} 个在播房间`)
console.log(rooms.join(','))
