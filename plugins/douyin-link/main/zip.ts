import { deflateRawSync, inflateRawSync } from 'zlib'

/**
 * 最小可用的 ZIP 读写（**不引第三方**）。
 *
 * 为什么自己写：插件主进程侧的**裸模块导入会交给宿主运行时解析**（见 scripts/build.mjs），
 * `jszip` 未必在宿主的依赖里——引了它就是「构建能过、运行期找不到模块」。ZIP 的
 * 「deflate 存储」这一路子集很小，用 Node 内置 `zlib` 几十行就能自足，
 * 而且不会把第二份压缩库塞进插件包。
 *
 * 只实现我们真正需要的：
 * - 写：每项一个本地文件头 + 中央目录 + EOCD；能 deflate 就 deflate（压不小就 store）；
 * - 读：扫 EOCD → 遍历中央目录 → 按方法 inflateRaw / 原样拷贝。
 *
 * 不支持（也用不到）：Zip64（>4GB）、加密、多卷、目录显式条目（路径名自带 `/` 即可）。
 * 时间戳固定成 2020-01-01，让同一份数据导出的包字节级稳定。
 */

const FIXED_DOS_DATE = 20513 // (2020-1980)<<9 | 1<<5 | 1
const FIXED_DOS_TIME = 0

const SIGNATURE_LOCAL = 0x04034b50
const SIGNATURE_CENTRAL = 0x02014b50
const SIGNATURE_EOCD = 0x06054b50

/** CRC-32（ZIP 用的 IEEE 多项式，反射版） */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntryInput {
  /** 包内路径（正斜杠），如 `records/108011161837/2026-10-09.json` */
  name: string
  data: Buffer | string
}

/** 把一组文件打成 ZIP（内存里完成，调用方再落盘） */
export function createZip(entries: ZipEntryInput[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf-8')
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf-8') : entry.data
    const crc = crc32(raw)
    const deflated = deflateRawSync(raw)
    // 压缩后没变小就原样存（小文件/已压缩内容常见），读的时候按方法号还原
    const useDeflate = deflated.length < raw.length
    const payload = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIGNATURE_LOCAL, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // 通用标志：文件名 UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(FIXED_DOS_TIME, 10)
    local.writeUInt16LE(FIXED_DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18) // 压缩后
    local.writeUInt32LE(raw.length, 22) // 原始
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度
    localChunks.push(local, nameBuffer, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIGNATURE_CENTRAL, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(FIXED_DOS_TIME, 12)
    central.writeUInt16LE(FIXED_DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30) // 扩展
    central.writeUInt16LE(0, 32) // 注释
    central.writeUInt16LE(0, 34) // 起始磁盘
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(0, 38) // 外部属性
    central.writeUInt32LE(offset, 42) // 本地头偏移
    centralChunks.push(central, nameBuffer)

    offset += local.length + nameBuffer.length + payload.length
  }

  const centralBuffer = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIGNATURE_EOCD, 0)
  eocd.writeUInt16LE(0, 4) // 本磁盘号
  eocd.writeUInt16LE(0, 6) // 中央目录起始磁盘
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...localChunks, centralBuffer, eocd])
}

/** 从 EOCD 往后找（注释最长 64KB，所以最多回扫这么多） */
function findEocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === SIGNATURE_EOCD) return i
  }
  return -1
}

/** 解开一个 ZIP，返回「包内路径 → 内容」 */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()

  let pointer = centralOffset
  for (let i = 0; i < count; i += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== SIGNATURE_CENTRAL) {
      throw new Error('ZIP 中央目录损坏')
    }
    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    const name = buffer.toString('utf-8', pointer + 46, pointer + 46 + nameLength)

    // 本地头里的文件名/扩展长度可能与中央目录不同，必须以本地头为准算数据起点
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = buffer.subarray(dataStart, dataStart + compressedSize)
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data))

    pointer += 46 + nameLength + extraLength + commentLength
  }
  return out
}