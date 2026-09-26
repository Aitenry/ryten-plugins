/**
 * 离线 fixture 服务器：把 `dist/` 与 `plugins.json` 用 HTTP 暴露出来，
 * 让 RytenBench 的「从 GitHub 安装」在不联网的情况下跑完整链路。
 *
 * 目录结构与 GitHub 的对应关系（应用侧同时支持两种 URL 形态）：
 *
 *   fixture                          GitHub
 *   ─────────────────────────────    ────────────────────────────────────────────────
 *   GET /plugins.json                raw.githubusercontent.com/<repo>/main/plugins.json
 *   GET /<asset>                     github.com/<repo>/releases/download/<tag>/<asset>
 *
 * 跑法（先 `npm run build` 产出 dist/）：
 *   node scripts/fixture-server.mjs [--port 8799]
 * 然后在 RytenBench 里把插件源设为 `http://127.0.0.1:8799`（见应用侧 `RB_PLUGINS_REPO`）。
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const args = process.argv.slice(2)
const portIndex = args.indexOf('--port')
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 8799

/**
 * 索引里的 `size` / `sha256` 必须描述**本机 dist 里这份 zip**，否则应用会以
 * 「sha256 不一致」拒绝安装——而这个文件是 CI 生成的（指向 Release 上的另一份构建，
 * zip 内嵌时间戳，两份构建字节不同）。所以 fixture 模式下一律现算，只沿用索引里的
 * id / 名称 / 版本 / asset 字段。
 */
function localIndexBody() {
  const p = join(ROOT, 'plugins.json')
  if (!existsSync(p)) return null
  const index = JSON.parse(readFileSync(p, 'utf-8'))
  const plugins = (index.plugins ?? []).map((entry) => {
    const file = join(DIST, entry.asset)
    if (!existsSync(file)) return entry
    const buf = readFileSync(file)
    return {
      ...entry,
      size: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex')
    }
  })
  // fixture 模式下资产与索引同源，tag 不参与 URL 拼装，去掉以免误以为是真实 Release 版本
  return JSON.stringify({ schema: index.schema ?? 1, plugins }, null, 2)
}

const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  const name = url.replace(/^\/+/, '')
  const send = (status, body, type) => {
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }

  // 索引（与仓库根同名文件，但 size/sha256 按本机 dist 现算）
  if (name === 'plugins.json' || name === '') {
    const body = localIndexBody()
    if (body === null) return send(404, 'plugins.json 不存在：先跑 npm run build', 'text/plain')
    return send(200, body, 'application/json')
  }
  // Release 资产（zip）
  const file = join(DIST, name)
  if (existsSync(file) && statSync(file).isFile()) {
    const body = readFileSync(file)
    res.writeHead(200, {
      'content-type': name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
      'content-length': body.length
    })
    return res.end(body)
  }
  send(404, `未找到 ${name}`, 'text/plain')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`插件 fixture 服务器：http://127.0.0.1:${PORT}`)
  console.log(`  索引  http://127.0.0.1:${PORT}/plugins.json（size/sha256 按本机 dist 现算）`)
  const body = localIndexBody()
  const index = body ? JSON.parse(body) : null
  for (const p of index?.plugins ?? []) {
    console.log(
      `  ${p.id.padEnd(8)} http://127.0.0.1:${PORT}/${p.asset}（${(p.size / 1024).toFixed(1)}KB, sha256 ${p.sha256.slice(0, 12)}…）`
    )
  }
})
