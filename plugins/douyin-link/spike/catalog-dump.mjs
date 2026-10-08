/*
 * 把官方礼物目录列成一张表（Markdown / CSV），看「礼物 id → 名字 → 抖币价」到底有哪些。
 *
 * 为什么需要它：插件里「送了什么、值多少」全靠这份目录（推送帧里点歌那类只有一个礼物 id
 * 和一个场景标签「点唱礼物」）。用户在界面里看不到目录本身，排查「这件礼物查不到」时
 * 需要能把整份目录摊开看——尤其是**目录里到底有没有这件礼物、价格是多少**。
 *
 * 目录来源与 `main/gift/catalog.ts` 完全一致（`webcast/gift/list/`，免签名）：
 * 所以这里量到的件数/价格就是插件运行时用的那份；抓取结果**不落库**，只打印。
 *
 * 用法：
 *   node plugins/douyin-link/spike/catalog-dump.mjs                      # 直接打 Markdown 到屏幕
 *   node plugins/douyin-link/spike/catalog-dump.mjs --out=礼物目录.md     # 写文件
 *   node plugins/douyin-link/spike/catalog-dump.mjs --json=<map.json>     # 用离线快照（{id:{name,diamonds}}）
 *   node plugins/douyin-link/spike/catalog-dump.mjs --top=50              # 只列最贵的 50 件
 */
import { writeFileSync } from 'node:fs'

const CATALOG_URL =
  'https://live.douyin.com/webcast/gift/list/?aid=6383&app_name=douyin_web&device_platform=web&live_id=1&language=zh-CN&cookie_enabled=true'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const jsonPath = arg('json')
const outPath = arg('out')
const top = Number(arg('top') ?? 0)

/** 取目录：优先用离线快照，其次抓官方接口（和插件同一条 URL） */
async function loadGifts() {
  if (jsonPath) {
    const snap = JSON.parse((await import('node:fs')).readFileSync(jsonPath, 'utf8'))
    return Object.entries(snap).map(([id, gift]) => ({
      id: Number(id),
      name: String(gift.name ?? ''),
      diamonds: Number(gift.diamonds ?? 0) || 0
    }))
  }
  const response = await fetch(CATALOG_URL, {
    headers: {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://live.douyin.com/'
    },
    signal: AbortSignal.timeout(25000)
  })
  if (!response.ok) throw new Error(`礼物目录返回 HTTP ${response.status}`)
  const json = await response.json()
  const list = json?.data?.gifts
  if (!Array.isArray(list) || list.length === 0) throw new Error('礼物目录里没有 gifts 数组')
  return list
    .map((raw) => ({
      id: Number(raw?.id ?? 0),
      name: String(raw?.name ?? '').slice(0, 40),
      diamonds: Number(raw?.diamond_count ?? 0) || 0
    }))
    .filter((gift) => Number.isFinite(gift.id) && gift.id > 0)
}

const gifts = await loadGifts()
const priced = gifts.filter((gift) => gift.diamonds > 0)
const free = gifts.filter((gift) => gift.diamonds <= 0)
const byPrice = [...gifts].sort((a, b) => b.diamonds - a.diamonds || a.id - b.id)
const shown = top > 0 ? byPrice.slice(0, top) : byPrice

const row = (gift) => `| ${gift.id} | ${gift.name || '（无名）'} | ${gift.diamonds || '—'} |`
const lines = [
  '# 抖音礼物目录（官方 `webcast/gift/list/`）',
  '',
  `- 来源：\`${CATALOG_URL}\`（免签名，与插件运行时用的同一条接口）`,
  jsonPath ? `- 本次用的是离线快照：\`${jsonPath}\`` : '- 本次是现抓的',
  `- 件数：**${gifts.length}**（有价 ${priced.length}、官方没给价 ${free.length}）`,
  `- 生成时间：${new Date().toLocaleString()}`,
  '',
  '> 插件里礼物的**名字与价格**就按这张表查（推送帧只给礼物 id）；查不到就不显示，绝不猜。',
  '',
  `## ${top > 0 ? `最贵的 ${shown.length} 件` : '全部礼物（按抖币从高到低）'}`,
  '',
  '| 礼物 id | 礼物名 | 抖币 |',
  '| --- | --- | --- |',
  ...shown.map(row),
  ''
]
if (top > 0) {
  lines.push(`## 全部 ${gifts.length} 件`, '', '| 礼物 id | 礼物名 | 抖币 |', '| --- | --- | --- |', ...byPrice.map(row), '')
}
if (free.length > 0) {
  lines.push('## 官方没给价的（`diamond_count` 缺失或 0）', '', '| 礼物 id | 礼物名 | 抖币 |', '| --- | --- | --- |', ...free.map(row), '')
}

const text = lines.join('\n')
if (outPath) {
  writeFileSync(outPath, text, 'utf8')
  console.log(`已写入 ${outPath}（${gifts.length} 件，有价 ${priced.length}）`)
} else {
  console.log(text)
}
