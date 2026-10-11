/**
 * 探针：**用项目里那份离线签名算法给 web 资料接口签名**（dev-only，不参与打包）。
 *
 * 背景（2026-10-12）：抓帧发现匿名帧的**字段 73 = `sec_uid` 没被抹掉**
 * （`anon-live-probe.mjs`：916/923 条匿名帧都带它）。于是「按 sec_uid 查资料」成了唯一还没死的路，
 * 但实测：
 * - `aweme/v1/web/user/profile/other/?sec_user_id=…` → `status_code 2`（不给资料）
 * - iesdouyin 分享页 / 老 web 接口 / 老 App 接口 / webcast 用户接口 → 全是空 body 或没有资料字段
 * 共同点：这些接口都要**签名**（`X-Bogus` / `a_bogus`）。
 *
 * 而项目里**已经内嵌了抖音的离线签名算法**（`main/douyin/sign.ts` → `sign-data.ts`，
 * 源自 `saermart/DouyinLiveWebFetcher`，给推送 ws 用）。这个探针试的就是：
 * 同一份算法能不能给**网页接口**签出可用的 `X-Bogus`——能，还原链路就通了。
 *
 * 跑法：`node plugins/douyin-link/spike/anon-sign-probe.mjs <sec_uid>`
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ROOT = join(HERE, '../../../')
const PLUGIN = join(HERE, '..')

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
const secUid = String(process.argv[2] ?? '').trim()
if (!/^MS4wLj/.test(secUid)) {
  console.error('用法：node anon-sign-probe.mjs <sec_uid>')
  process.exit(2)
}

/** 打包 `sign.ts` 里那个懒加载的签名函数（`get_sign`）出来直接用 */
const workDir = join(process.env.TEMP ?? '.', `anon-sign-${Date.now()}`)
const outfile = join(workDir, 'signer.mjs')
await build({
  stdin: {
    contents: `
export { PUSH_UA } from '${PLUGIN.replace(/\\/g, '/')}/main/douyin/sign.ts'
`,
    loader: 'ts',
    resolveDir: PLUGIN
  },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning',
  nodePaths: [join(ROOT, 'node_modules')],
  external: ['electron', 'electron-log', 'node:*']
})

/** `sign.ts` 的 `getSignFn` 没有导出，这里按同样的方式自己解一次脚本 */
const signData = await import(pathToFileURL(join(PLUGIN, 'main/douyin/sign-data.ts')).href).catch(() => null)
const gz = signData?.SIGN_SCRIPT_GZ_B64
if (!gz) {
  console.error('拿不到 SIGN_SCRIPT_GZ_B64（改过 sign-data.ts？）')
  process.exit(2)
}
const zlib = await import('node:zlib')
const code = zlib.inflateRawSync(Buffer.from(gz, 'base64')).toString('utf8')
const scriptRequire = (name) => {
  if (name === 'crypto') return { createHash, randomBytes }
  if (name === 'buffer') return { Buffer }
  throw new Error(`unsupported module ${name}`)
}
// eslint-disable-next-line no-new-func
const sign = new Function('require', `${code}\nreturn get_sign;`)(scriptRequire)
console.log(`# 签名算法已加载；sec_uid=${secUid.slice(0, 24)}…\n`)

/** X-Bogus 的算法：把 query 串喂进去，出来的就是 ?X-Bogus=… */
function xBogus(query) {
  try {
    return sign(createHash('md5').update(query).digest('hex'))
  } catch (error) {
    return `签名失败：${String(error?.message ?? error).slice(0, 80)}`
  }
}

async function probe(label, path, params, { withSign = true, host = 'https://www.douyin.com' } = {}) {
  const query = new URLSearchParams(params).toString()
  const signedQuery = withSign ? `${query}&X-Bogus=${encodeURIComponent(xBogus(query))}` : query
  try {
    const response = await fetch(`${host}${path}?${signedQuery}`, {
      headers: {
        'user-agent': UA,
        cookie,
        referer: 'https://www.douyin.com/',
        accept: 'application/json, text/plain, */*'
      },
      signal: AbortSignal.timeout(15000)
    })
    const text = await response.text()
    if (!text) {
      console.log(`${label} → HTTP ${response.status} 空 body`)
      return
    }
    const nick = text.match(/"nickname"\s*:\s*"([^"]{1,40})"/)?.[1] ?? ''
    const uid = text.match(/"uid"\s*:\s*"(\d{6,})"/)?.[1] ?? text.match(/"user_id"\s*:\s*"(\d{6,})"/)?.[1] ?? ''
    const last = text.match(/"status_code"\s*:\s*(-?\d+)/)?.[1] ?? '-'
    console.log(
      `${label} → HTTP ${response.status}，${text.length} 字符，status_code=${last}` +
        (nick ? ` ★ 昵称=${nick} uid=${uid || '-'}` : '（没有昵称）')
    )
  } catch (error) {
    console.log(`${label} → 失败：${String(error?.message ?? error).slice(0, 80)}`)
  }
}

const base = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  version_code: '190500',
  publish_video_strategy_type: '2'
}

console.log('=== A. 不签名（对照，已知失败）===')
await probe('profile?sec_user_id（无签名）', '/aweme/v1/web/user/profile/other/', { ...base, sec_user_id: secUid }, { withSign: false })
console.log('\n=== B. 带 X-Bogus 签名 ===')
await probe('profile?sec_user_id（X-Bogus）', '/aweme/v1/web/user/profile/other/', { ...base, sec_user_id: secUid })
await probe('profile?user_id=111111（X-Bogus）', '/aweme/v1/web/user/profile/other/', { ...base, user_id: '111111' })
console.log('\n=== C. 用户主页 HTML / 作品列表（可能带资料）===')
await probe('web 主页 HTML', `/user/${secUid}`, {}, { withSign: false })
await probe('aweme/post（X-Bogus）', '/aweme/v1/web/aweme/post/', { ...base, sec_user_id: secUid, count: '1', max_cursor: '0' })
await probe('user/following（X-Bogus）', '/aweme/v1/web/user/following/list/', { ...base, sec_user_id: secUid, count: '1', offset: '0' })

console.log('\n# 读法：B 组里出现「昵称=…」就是通了——把 X-Bogus 签名接进 mystery.ts 的 sec_uid 查询即可。')
