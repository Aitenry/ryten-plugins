/**
 * 极简 protobuf 读取器（只读，不依赖任何第三方库）。
 *
 * 为什么自己写：插件产物里没有 node_modules（第三方包一律不可用），
 * 而抖音弹幕走的是 gzip + protobuf 的推送帧，必须自己解。
 *
 * 只实现实际会遇到的四种线格式：varint(0)、fixed64(1)、length-delimited(2)、fixed32(5)；
 * group(3/4) 直接跳过所在字段（不该出现在这些消息里）。
 * varint 一律按 Number 解（> 2^53 的 id 会丢精度，我们只用它做展示，不当标识用）。
 */

export type PbField =
  | { kind: 'varint'; value: number; raw: Buffer }
  | { kind: 'bytes'; value: Buffer }
  | { kind: 'fixed32'; value: number }
  | { kind: 'fixed64'; value: Buffer }

export interface PbMessage {
  fields: Map<number, PbField[]>
}

/** 解一段 message 字节 */
export function readMessage(buf: Buffer): PbMessage {
  const fields = new Map<number, PbField[]>()
  let offset = 0
  while (offset < buf.length) {
    const tag = readVarint(buf, offset)
    if (!tag) break
    offset = tag.next
    const fieldNo = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    if (fieldNo <= 0) break
    if (wire === 0) {
      const start = offset
      const next = readVarint(buf, offset)
      if (!next) break
      push(fields, fieldNo, { kind: 'varint', value: next.value, raw: buf.subarray(start, next.next) })
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
    } else {
      break
    }
  }
  return { fields }
}

function push(fields: Map<number, PbField[]>, no: number, value: PbField): void {
  const list = fields.get(no)
  if (list) list.push(value)
  else fields.set(no, [value])
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } | null {
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

/** 取第一个 varint 字段 */
export function getVarint(msg: PbMessage, field: number): number | undefined {
  for (const value of msg.fields.get(field) ?? []) {
    if (value.kind === 'varint') return value.value
  }
  return undefined
}

/** 取第一个 bytes 字段（注意：调 protobuf `string` 字段会直接命中这里） */
export function getBytes(msg: PbMessage, field: number): Buffer | undefined {
  for (const value of msg.fields.get(field) ?? []) {
    if (value.kind === 'bytes') return value.value
  }
  return undefined
}

/**
 * 取一个字符串字段。**带校验**：只有「能原样 UTF-8 往返 + 无控制字符 + 长度合理」才认，
 * 这样字段号猜错时拿到的是 undefined（走兜底文案），而不是一串乱码。
 */
export function getString(msg: PbMessage, field: number, maxLength = 120): string | undefined {
  const raw = getBytes(msg, field)
  if (!raw || raw.length === 0 || raw.length > maxLength * 4) return undefined
  const text = raw.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(raw)) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return undefined
  return text.slice(0, maxLength)
}

/** 取一个嵌套 message 字段 */
export function getMessage(msg: PbMessage, field: number): PbMessage | undefined {
  const raw = getBytes(msg, field)
  return raw ? readMessage(raw) : undefined
}

/** 取重复的嵌套 message 字段 */
export function getMessages(msg: PbMessage, field: number): PbMessage[] {
  const out: PbMessage[] = []
  for (const value of msg.fields.get(field) ?? []) {
    if (value.kind === 'bytes') out.push(readMessage(value.value))
  }
  return out
}

/** 按优先顺序取第一个能通过校验的字符串字段（字段号不确定时的兜底写法） */
export function pickString(msg: PbMessage, candidates: number[], maxLength = 120): string | undefined {
  for (const field of candidates) {
    const text = getString(msg, field, maxLength)
    if (text) return text
  }
  return undefined
}

/** 按优先顺序取第一个 varint 字段 */
export function pickVarint(msg: PbMessage, candidates: number[]): number | undefined {
  for (const field of candidates) {
    const value = getVarint(msg, field)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * 取 varint 字段的**精确十进制串**（int64 用）。
 *
 * 为什么不能让 Number 顶：用户 id / 消息 id 都在 10^15~10^19 量级，超过 2^53（约 9.007e15）
 * 之后 Number 会静默丢低位——真机 dump 里就有 `7693982388758455000` 这种被抹平的值，
 * 拿它当用户标识会让两个不同的人撞成同一个。所以从**原始字节**用 BigInt 还原。
 */
export function getVarintString(msg: PbMessage, field: number): string | undefined {
  for (const value of msg.fields.get(field) ?? []) {
    if (value.kind !== 'varint') continue
    if (!value.raw) return String(value.value)
    let result = 0n
    let shift = 0n
    for (const byte of value.raw) {
      result |= BigInt(byte & 0x7f) << shift
      shift += 7n
      if ((byte & 0x80) === 0) break
    }
    return result.toString()
  }
  return undefined
}

/** 按候选顺序取第一个能解出的 int64 串（字段号不确定时的兜底写法） */
export function pickVarintString(msg: PbMessage, candidates: number[]): string | undefined {
  for (const field of candidates) {
    const value = getVarintString(msg, field)
    if (value !== undefined && value !== '0') return value
  }
  return undefined
}

/**
 * 取重复的字符串字段的全部值（`ImageModel.url_list` 这类 repeated string）。
 * 带校验：解不出合法 UTF-8 的项直接跳过。
 */
export function getStrings(msg: PbMessage, field: number, maxLength = 200): string[] {
  const out: string[] = []
  for (const value of msg.fields.get(field) ?? []) {
    if (value.kind !== 'bytes' || value.value.length === 0) continue
    const text = value.value.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(value.value)) continue
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) continue
    out.push(text.slice(0, maxLength))
  }
  return out
}

/**
 * 猜字段号时的**带范围校验**取值：只认落在 [min, max] 里的候选。
 * 用在「礼物额度」这类字段号没实测过的场景：宁可拿不到（返回 undefined），不给错数字。
 */
export function pickVarintInRange(
  msg: PbMessage,
  candidates: number[],
  min: number,
  max: number
): number | undefined {
  for (const field of candidates) {
    const value = getVarint(msg, field)
    if (value !== undefined && value >= min && value <= max) return value
  }
  return undefined
}

/** 字段是否存在（不看值） */
export function hasField(msg: PbMessage, field: number): boolean {
  return (msg.fields.get(field)?.length ?? 0) > 0
}
