/**
 * 探针：**用宿主（Electron/Chromium）的网络栈去查匿名用户的 sec_uid 资料**（dev-only）。
 *
 * 由来（2026-10-12）：抓帧确认匿名帧里 **字段 73 = `sec_uid` 没被抹掉**，但
 * `www.douyin.com` 的资料接口要浏览器算的 `a_bogus`——项目内嵌的离线 `X-Bogus` 只能用给
 * 直播推送 ws（实测 web 接口照旧 `status_code 2`，见 `anon-sign-probe.mjs`）。
 *
 * 剩下最后一个变量：**换网络栈**。应用的 `main/douyin/avatar.ts` / `mystery.ts` 本来就
 * 「先 Node fetch、失败再回落到 Electron 的 `net.fetch`」，说明 Chromium 那套请求头/TLS 指纹
 * 有时能让接口放行。这个探针就是把同一份请求交给 Chromium 发一次，看回不回资料。
 *
 * 跑法（会真的启一个 Electron 子进程，几秒后自己退出）：
 *   node plugins/douyin-link/spike/anon-netfetch-probe.mjs <sec_uid>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const secUid = String(process.argv[2] ?? '').trim()
if (!/^MS4wLj/.test(secUid)) {
  console.error('用法：node anon-netfetch-probe.mjs <sec_uid>')
  process.exit(2)
}
function readCookie() {
  const file = join(process.env.APPDATA ?? '', 'ryten-bench', 'plugin-state', 'douyin-link.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8')).douyinCookie ?? ''
  } catch {
    return ''
  }
}
const cookie = readCookie()

/** Electron 里找不找得到：宿主仓库装了 electron */
const electronPath = join('E:\\Development-Warehouse\\github\\ryten-bench', 'node_modules', 'electron')
let electronBin = ''
try {
  electronBin = join(electronPath, 'dist', 'electron.exe')
  if (!readFileSync(join(electronPath, 'path.txt'), 'utf8')) throw new Error('no path.txt')
} catch {
  /* 下面统一报错 */
}
if (!electronBin) {
  console.error('找不到宿主那份 electron（E:\\Development-Warehouse\\github\\ryten-bench\\node_modules\\electron）')
  process.exit(2)
}

const script = `
const { app, net } = require('electron')
const secUid = ${JSON.stringify(secUid)}
const cookie = ${JSON.stringify(cookie)}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
app.whenReady().then(async () => {
  const query = new URLSearchParams({
    sec_user_id: secUid,
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    version_code: '190500'
  })
  const url = 'https://www.douyin.com/aweme/v1/web/user/profile/other/?' + query
  try {
    const response = await net.fetch(url, { headers: { 'user-agent': UA, cookie, referer: 'https://www.douyin.com/', accept: 'application/json, text/plain, */*' } })
    const text = await response.text()
    console.log('[netfetch] HTTP ' + response.status + '，' + text.length + ' 字符')
    console.log('[netfetch] 正文：' + text.slice(0, 300))
  } catch (error) {
    console.log('[netfetch] 失败：' + (error && error.message ? error.message : String(error)))
  }
  app.quit()
})
`
const file = join(process.env.TEMP ?? '.', `anon-netfetch-${Date.now()}.cjs`)
writeFileSync(file, script, 'utf8')
console.log(`# 用 Chromium 网络栈请求 sec_user_id=…${secUid.slice(-12)}\n`)
const result = spawnSync(electronBin, [file], { encoding: 'utf8', timeout: 60000, windowsHide: true })
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
for (const line of output.split(/\r?\n/)) if (line.includes('[netfetch]')) console.log(line)
if (!output.includes('[netfetch]')) console.log(`（没有输出，退出码 ${result.status}）\n${output.slice(-400)}`)
