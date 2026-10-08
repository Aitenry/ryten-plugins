/**
 * 校验「解不出礼物名时到底会不会写日志」——**用真的 `electron-log`**，不是空壳。
 *
 * 起因：用户库里出现了一条 `content='' / to_user_name='ok绷.ఇ'` 的礼物行（0.7.7 写的），
 * 而日志里**一条 `[douyin-link][gift-unknown]` 都没有**。要么那条不是真礼物帧，
 * 要么这个诊断根本没生效——这个脚本就是来回答这个问题的（bundler 不替换 electron-log，
 * 直接加载依赖里的真模块，把它的输出原样打出来）。
 *
 * 跑法：`node plugins/douyin-link/spike/gift-log-check.mjs`
 */

import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const workDir = mkdtempSync(join(tmpdir(), 'douyin-gift-log-check-'))

/* 与 decoder-check 同一套极简编码器 */
const varint = (value) => {
  const out = []
  let rest = BigInt(value)
  while (rest > 0x7fn) {
    out.push(Number((rest & 0x7fn) | 0x80n))
    rest >>= 7n
  }
  out.push(Number(rest))
  return Buffer.from(out)
}
const tag = (field, wire) => varint(field * 8 + wire)
const pbVarint = (field, value) => Buffer.concat([tag(field, 0), varint(value)])
const pbBytes = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf])
const pbString = (field, text) => pbBytes(field, Buffer.from(text, 'utf8'))
const pbMessage = (field, buf) => pbBytes(field, buf)
const user = (id, nickname) => Buffer.concat([pbVarint(1, id), pbString(3, nickname)])

/**
 * 复刻用户库里那行的形状：**真礼物帧但没有可读的礼物结构**
 * （7 = 送礼人、8 = 收礼人，礼物结构放在我们不认识的字段里）
 */
const mysteryGiftFrame = () =>
  Buffer.concat([
    pbMessage(7, user(4178584290736830n, '0619')),
    pbMessage(8, user(4306150199668079n, 'ok绷.ఇ')),
    pbVarint(5, 1),
    pbMessage(23, pbMessage(4, Buffer.concat([pbString(9, '浪漫花火'), pbVarint(2, 599)])))
  ])

// 产物放进仓库根目录：这样 Node 能从仓库的 node_modules 里解析真正的 electron-log
const outfile = join(ROOT, '.tmp-gift-log-check.mjs')
await build({
  entryPoints: [join(ROOT, 'plugins/douyin-link/main/douyin/proto-messages.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'silent',
  // 注意：**没有** electron-log 的 stub —— 这里就是要看真模块的行为
  external: ['electron-log']
})

const { decodeProtoMessage } = await import(pathToFileURL(outfile).href)
const decoded = decodeProtoMessage('WebcastGiftMessage', mysteryGiftFrame(), undefined)

console.log('\n=== 解码结果 ===')
console.log(JSON.stringify(decoded?.item ?? null))
console.log('\n=== 上面有没有出现 [douyin-link][gift-unknown] 日志？自己看一眼 ===')
console.log(`（工作目录 ${process.cwd()}；electron-log 默认把日志写到 logs/main.log）`)

const logs = join(process.cwd(), 'logs')
if (existsSync(logs)) {
  for (const name of readdirSync(logs)) {
    const text = readFileSync(join(logs, name), 'utf8')
    const hit = text.split('\n').filter((line) => line.includes('gift-unknown'))
    console.log(`\n--- logs/${name}: gift-unknown ${hit.length} 条 ---`)
    for (const line of hit.slice(-4)) console.log(line.slice(0, 240))
  }
}

rmSync(workDir, { recursive: true, force: true })
rmSync(outfile, { force: true })
