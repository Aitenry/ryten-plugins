import * as crypto from 'node:crypto'
import * as buffer from 'node:buffer'
import * as zlib from 'node:zlib'
import { SIGN_SCRIPT_GZ_B64 } from './sign-data'

/**
 * 抖音推送 ws 的**离线签名**：纯 Node 就能建上 `…/webcast/im/push/v2/`，不需要浏览器。
 *
 * 算法本体内嵌在 `sign-data.ts`（由参考项目 `LiukerSun/DouyinDanmu` 的
 * `backend/scripts/sign.js` 原样生成），这里是它的一层壳：解压 → 非严格求值 → 取 `get_sign`。
 *
 * 为什么用 `new Function` 而不是直接 import：那段脚本顶部用**非严格赋值**自建
 * `document/window/navigator`（`document = {}` 之类），在 ESM/严格作用域里会直接抛错。
 * `new Function` 的函数体默认是非严格的（脚本自己没有 "use strict"），实测可用。
 *
 * 为什么签名不用浏览器算（旧 `ws-capture.ts` 的做法）：那次只在**页面的 webmssdk 补环境**里
 * 试过，被 `DEVICE_BLOCKED` 拒；但这段**静态算法**不依赖运行时设备指纹，2026-10 实测纯 Node
 * 直连返回 101 并收到弹幕/进场/点赞等全量帧。
 */

/**
 * 握手 UA：签名与 UA 无强绑定，但 URL 里的 `browser_version` 取的是它的一段——
 * 因此握手必须用**同一个** UA（与参考项目一致）。
 */
export const PUSH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const PUSH_HOST = 'wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/'

type SignFn = (md5: string) => string

let signFn: SignFn | null = null

/**
 * 脚本内部只 `require('crypto')` 与 `require('buffer')` 两个 Node 内置模块（实测），
 * 所以给它一个只认这两个的 shim 即可——比把宿主环境的 `require` 传进去更可控。
 */
function scriptRequire(name: string): unknown {
  if (name === 'crypto') return crypto
  if (name === 'buffer') return buffer
  throw new Error(`sign script required an unsupported module: ${name}`)
}

/** 懒加载签名函数（只在第一次连接时解压并求值，失败会抛错） */
function getSignFn(): SignFn {
  if (signFn) return signFn
  const code = zlib.inflateRawSync(Buffer.from(SIGN_SCRIPT_GZ_B64, 'base64')).toString('utf8')
  // eslint-disable-next-line no-new-func
  const factory = new Function('require', `${code}\nreturn get_sign;`) as (req: typeof scriptRequire) => SignFn
  const fn = factory(scriptRequire)
  if (typeof fn !== 'function') throw new Error('sign script did not return get_sign')
  signFn = fn
  return fn
}

/**
 * 生成一条**已签名**的推送 ws URL（每次调用都是新的 `user_unique_id` 与 `signature`，
 * 这样重连等于换一份新签名）。
 */
export function buildPushUrl(roomId: string): string {
  const id = String(roomId ?? '').trim()
  if (!/^\d+$/.test(id)) throw new Error(`invalid roomId: ${id}`)

  const uid = String(7000000000000000000n + BigInt(`0x${crypto.randomBytes(7).toString('hex')}`))
  const signed = [
    'live_id=1',
    'aid=6383',
    'version_code=180800',
    'webcast_sdk_version=1.0.14-beta.0',
    `room_id=${id}`,
    'sub_room_id=',
    'sub_channel_id=',
    'did_rule=3',
    `user_unique_id=${uid}`,
    'device_platform=web',
    'device_type=',
    'ac=',
    'identity=audience'
  ].join(',')
  const signature = getSignFn()(crypto.createHash('md5').update(signed).digest('hex'))

  const params = new URLSearchParams({
    aid: '6383',
    app_name: 'douyin_web',
    browser_language: 'zh-CN',
    browser_name: 'Mozilla',
    browser_online: 'true',
    browser_platform: 'Win32',
    browser_version: PUSH_UA.slice(8),
    compress: 'gzip',
    cookie_enabled: 'true',
    cursor: `d-1_u-1_fh-${uid}_t-${Date.now()}_r-1`,
    device_platform: 'web',
    device_type: '',
    did_rule: '3',
    endpoint: 'live_pc',
    heartbeatDuration: '0',
    host: 'https://live.douyin.com',
    identity: 'audience',
    im_path: '/webcast/im/fetch/',
    internal_ext:
      `internal_src:dim|wss_push_room_id:${id}|wss_push_did:${uid}|dim_log_id:${crypto.randomBytes(4).toString('hex')}`,
    live_id: '1',
    need_persist_msg_count: '15',
    room_id: id,
    screen_height: '864',
    screen_width: '1536',
    sub_channel_id: '',
    sub_room_id: '',
    support_wrds: '1',
    tz_name: 'Asia/Shanghai',
    update_version_code: '1.0.14-beta.0',
    user_unique_id: uid,
    version_code: '180800',
    webcast_sdk_version: '1.0.14-beta.0',
    signature
  })
  return `${PUSH_HOST}?${params.toString()}`
}