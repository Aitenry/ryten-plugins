/**
 * dev-only 探针共用的**极简 protobuf 读取器 + 帧解码**（不参与打包）。
 *
 * 为什么单独一份：`live-probe.mjs`（走主进程那条 HTTP 路）与 `ws-spike.mjs`（走页面自己的
 * websocket）都要「解字段号」这件事；两份复制会各自漂移，而它们存在的意义就是互相印证。
 *
 * 与插件里的 `main/douyin/protobuf.ts` 是同一套读法（varint / length-delimited / fixed32 /
 * fixed64），只是这边不需要类型与字符串校验——探针要的是**把原始字段全打出来**，
 * 哪怕它是乱码（乱码本身也是证据）。
 */

/** 解一段 message 字节 → 字段号 → 值列表 */
export function readMessage(buf) {
  const fields = new Map()
  let offset = 0
  while (offset < buf.length) {
    const tag = readVarint(buf, offset)
    if (!tag) break
    offset = tag.next
    const fieldNo = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    if (fieldNo <= 0) break
    if (wire === 0) {
      const next = readVarint(buf, offset)
      if (!next) break
      push(fields, fieldNo, { kind: 'varint', value: next.value, raw: buf.subarray(offset, next.next) })
      offset = next.next
    } else if (wire === 2) {
      const len = readVarint(buf, offset)
      if (!len) break
      const end = len.next + len.value
      if (end > buf.length) break
      push(fields, fieldNo, { kind: 'bytes', value: buf.subarray(len.next, end) })
      offset = end
    } else if (wire === 5) {
      if (offset + 4 > buf.length) break
      push(fields, fieldNo, { kind: 'fixed32', value: buf.readUInt32LE(offset) })
      offset += 4
    } else if (wire === 1) {
      if (offset + 8 > buf.length) break
      push(fields, fieldNo, { kind: 'fixed64', value: buf.subarray(offset, offset + 8) })
      offset += 8
    } else break
  }
  return { fields }
}

function push(fields, no, value) {
  const list = fields.get(no)
  if (list) list.push(value)
  else fields.set(no, [value])
}

export function readVarint(buf, offset) {
  let result = 0
  let shift = 0
  let cursor = offset
  while (cursor < buf.length) {
    const byte = buf[cursor]
    cursor += 1
    result += (byte & 0x7f) * Math.pow(2, shift)
    if ((byte & 0x80) === 0) return { value: result, next: cursor }
    shift += 7
    if (shift > 63) return null
  }
  return null
}

/** varint 的原始字节 → 精确十进制串（int64 用；Number 会丢低位） */
export function varintString(raw) {
  let result = 0n
  let shift = 0n
  for (const byte of raw) {
    result |= BigInt(byte & 0x7f) << shift
    shift += 7n
    if ((byte & 0x80) === 0) break
  }
  return result.toString()
}

export function getVarint(msg, field) {
  for (const value of msg.fields.get(field) ?? []) if (value.kind === 'varint') return value
  return undefined
}

export function getBytes(msg, field) {
  for (const value of msg.fields.get(field) ?? []) if (value.kind === 'bytes') return value.value
  return undefined
}

export function getBytesAll(msg, field) {
  return (msg.fields.get(field) ?? []).filter((v) => v.kind === 'bytes').map((v) => v.value)
}

/** 这段字节像不像合法 UTF-8 文本（判「bytes 是 string 还是嵌套 message」） */
export function asText(buf) {
  if (buf.length === 0 || buf.length > 400) return null
  const text = buf.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buf)) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return null
  return text
}

/** 递归打字段树（深度 4；bytes 能当文本读就显示文本，否则当嵌套 message） */
export function dumpTree(buf, depth = 0, label = '', sink = console.log) {
  const indent = '  '.repeat(depth)
  let msg
  try {
    msg = readMessage(buf)
  } catch {
    return
  }
  for (const [no, list] of [...msg.fields.entries()].sort((a, b) => a[0] - b[0])) {
    for (const value of list) {
      if (value.kind === 'varint') {
        sink(`${indent}${label}${no}: varint ${value.value} (int64=${varintString(value.raw)})`)
        continue
      }
      if (value.kind === 'fixed32') {
        sink(`${indent}${label}${no}: fixed32 ${value.value}`)
        continue
      }
      if (value.kind === 'fixed64') {
        sink(`${indent}${label}${no}: fixed64 ${value.value.toString('hex')}`)
        continue
      }
      const bytes = value.value
      const text = asText(bytes)
      if (text) {
        sink(`${indent}${label}${no}: string "${text}"`)
        continue
      }
      sink(`${indent}${label}${no}: bytes(${bytes.length})`)
      if (depth < 3 && bytes.length > 1) dumpTree(bytes, depth + 1, `${label}${no}.`, sink)
    }
  }
}

/**
 * 一份 `WebcastResponse`（HTTP 回包或 ws 帧解压后的 body）→ `[{ method, body }]`。
 *
 * 顶层结构两边完全一样：`1` = repeated `Message{ 1 method, 2 payload }`。
 */
export function readResponseMessages(buf) {
  const root = readMessage(buf)
  const out = []
  for (const payload of getBytesAll(root, 1)) {
    const message = readMessage(payload)
    const methodRaw = getBytes(message, 1)
    const body = getBytes(message, 2)
    if (!methodRaw || !body) continue
    out.push({ method: methodRaw.toString('utf8'), body })
  }
  return { root, messages: out }
}

/** 从任意输入里抠出网页房间号（与插件 `shared/types.ts` 的 `parseWebRid` 同口径） */
export function parseWebRid(text) {
  const raw = String(text ?? '').trim()
  if (/^\d{4,}$/.test(raw)) return raw
  const direct = raw.match(/live\.douyin\.com\/(?:u\/)?(\d{4,})/)
  if (direct) return direct[1]
  const query = raw.match(/[?&](?:web_rid|room_id|rid)=(\d{4,})/)
  if (query) return query[1]
  const loose = raw.match(/(\d{6,})/)
  return loose ? loose[1] : null
}
