/*
 * 从探针日志里挑真帧，直接打印成 `decoder-check.mjs --frame=…` 能粘贴的整行命令。
 *
 * 为什么需要它：本仓库的纪律是「字段号必须实测」——每次改解码器，都要把**真帧**喂回
 * `decoder-check.mjs` 复核一遍。探针（`live-probe.mjs --hex` / `ws-spike.mjs`）的日志里每条 dump
 * 都带 `hex=…`，而那个 hex **就是 `decodeProtoMessage(method, body)` 要吃的 body**（不是整条 Message），
 * 所以挑出来直接用。
 *
 * 用法：
 *   node plugins/douyin-link/spike/frame-extract.mjs <探针日志> [方法名] [条数，默认 3]
 * 例：
 *   node plugins/douyin-link/spike/frame-extract.mjs "$env:TEMP\dy-watch-http.txt" WebcastLinkmicOrderSingMessage 3
 *   → 打印三行 `--frame=…` 命令；整段日志回放用 decoder-check 的 `--replay=<日志>`
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const want = process.argv[3] ?? ''
const limit = Number(process.argv[4] ?? 3)
if (!file) {
  console.error('用法：node frame-extract.mjs <探针日志> [方法名] [条数]')
  process.exit(2)
}

const buf = readFileSync(file)
/** PowerShell 的 `*>` 写出来的是 UTF-16LE（带 BOM）；读成 utf8 会一条都匹配不上（踩过一次） */
const text =
  buf[0] === 0xff && buf[1] === 0xfe
    ? buf.subarray(2).toString('utf16le')
    : buf[0] === 0xfe && buf[1] === 0xff
      ? buf.subarray(2).swap16().toString('utf16le')
      : buf.toString('utf8')

const lines = text.split(/\r?\n/)
let printed = 0
for (let index = lines.length - 1; index >= 0 && printed < limit; index -= 1) {
  const head = /^=== dump #\d+ (\w+) len=(\d+) ===$/.exec(lines[index] ?? '')
  if (!head) continue
  if (want && head[1] !== want) continue
  const hex = /^hex=([0-9a-fA-F]+)$/.exec((lines[index + 1] ?? '').trim())
  if (!hex) continue
  const bytes = hex[1].length / 2
  if (bytes !== Number(head[2])) {
    // 探针没开 `--hex` 时只打了前缀，喂回解码器只会解出半截东西
    console.error(`# 跳过 ${head[1]}：日志里只有前 ${bytes} 字节（要全文请用 live-probe.mjs --hex）`)
    continue
  }
  console.log(`# ${head[1]} ${bytes} 字节（日志第 ${index + 1} 行）`)
  console.log(`node plugins/douyin-link/spike/decoder-check.mjs --frame=${head[1]}:${hex[1]}`)
  printed += 1
}
if (printed === 0) console.error('# 这个日志里没有可用的 dump（没开 --hex 或没抓到这个方法）')
