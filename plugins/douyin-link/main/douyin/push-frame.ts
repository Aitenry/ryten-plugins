import { getBytes, getString, readMessage } from './protobuf'

/**
 * 抖音推送 ws 的 **PushFrame** 编解码（收发两头）。
 *
 * `PushFrame` 字段号（见参考项目 `backend/proto/douyin.proto`）：
 *   `2 = logId(uint64)`、`7 = payloadType(string)`、`8 = payload(bytes)`。
 *
 * 我们只需要自己**发**两种帧：心跳 `hb` 与应答 `ack`（参考项目同款做法）。
 * `logId` 是 int64、常超 2^53，所以 `readPushFrame` 保留它的**原始字节**，
 * `encodeAck` 直接回填那串字节，避免 Number 丢精度导致 ack 对不上。
 */

export interface PushFrame {
  /** 帧类型：`msg`（业务消息）/ `hb`（服务端心跳）/ `ack` 等 */
  payloadType: string
  /** 业务负载（gzip 或裸 protobuf）；心跳帧为空 */
  payload: Buffer | null
  /** `logId` 的原始 varint 字节（回 ack 时原样带回） */
  logIdRaw: Buffer | null
}

/** 解一个 PushFrame */
export function readPushFrame(buf: Buffer): PushFrame {
  const msg = readMessage(buf)
  const logIdField = (msg.fields.get(2) ?? []).find((value) => value.kind === 'varint')
  return {
    payloadType: getString(msg, 7, 16) ?? '',
    payload: getBytes(msg, 8) ?? null,
    logIdRaw: logIdField && logIdField.kind === 'varint' ? logIdField.raw : null
  }
}

/** 心跳：`PushFrame{ payloadType: 'hb' }` */
export function encodeHeartbeat(): Buffer {
  return stringField(7, 'hb')
}

/** 应答：`PushFrame{ logId, payloadType:'ack', payload:internalExt }` */
export function encodeAck(logIdRaw: Buffer | null, internalExt: string): Buffer {
  const parts: Buffer[] = []
  if (logIdRaw && logIdRaw.length > 0) {
    parts.push(Buffer.from([(2 << 3) | 0]), logIdRaw)
  }
  parts.push(stringField(7, 'ack'))
  if (internalExt) parts.push(bytesField(8, Buffer.from(internalExt, 'utf8')))
  return Buffer.concat(parts)
}

/* --------------------------------------------------------------- 极简写入 */

function stringField(no: number, value: string): Buffer {
  return bytesField(no, Buffer.from(value, 'utf8'))
}

function bytesField(no: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(no << 3) | 2]), writeVarint(value.length), value])
}

function writeVarint(value: number): Buffer {
  const bytes: number[] = []
  let n = value
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  bytes.push(n)
  return Buffer.from(bytes)
}