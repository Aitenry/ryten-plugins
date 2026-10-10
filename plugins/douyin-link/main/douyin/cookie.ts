/**
 * Cookie 合并：把**用户配置的登录态 Cookie** 与 **进房拿到的匿名 Cookie**（ttwid 等）合到一行。
 *
 * 为什么需要：**抖音只向「已登录会话」推送礼物消息**（`WebcastGiftMessage`）。匿名会话
 * （只有进房时发的 ttwid）在普通直播间基本收不到礼物——这正是「礼物检测只在聊天室能用」
 * 的原因（聊天室那条走的是点歌，不走礼物授权）。用户把自己的登录 Cookie 填进设置后，
 * 推送 ws 握手与房间接口就会带上它，普通直播间也能收到礼物。
 *
 * 合并规则（**用户那份在前、且一个字段都不许被动**）：
 * - 用户 cookie 的字段**排在最前**，匿名那份只补用户没有的名字；
 * - 同名以**用户那份**为准（尤其是它自己的 ttwid / sessionid）。
 *
 * 为什么顺序这么重要：`cookie.ts` 与 `renderer/api.ts` 曾把用户粘贴的 cookie 静默切到
 * 4096 字符（见 `shared/cookie.ts` 的说明），而截断砍的是**尾部**——登录态字段恰好排在后面。
 * 把用户那份排到最前，等于给「任何长度限制」划了一条底线：要砍先砍匿名那份的尾巴。
 * 解析器对畸形输入宽容（认不出名字的片段跳过，绝不抛）。
 */

import { parseCookiePairs } from '../../shared/cookie'

/**
 * 把 `configured`（用户登录 Cookie）合并到 `anonymous`（进房拿到的）上，返回一行请求头值。
 * 只需其中一份时另一份传空串即可。
 */
export function mergeCookieHeaders(configured: string, anonymous: string): string {
  const user = parseCookiePairs(configured)
  const known = new Set(user.map(([name]) => name))
  const extra = parseCookiePairs(anonymous).filter(([name]) => !known.has(name))
  // 用户在前、匿名在后；同名只留用户那份（`extra` 已按名字过滤过）
  return [...user, ...extra].map(([name, value]) => `${name}=${value}`).join('; ')
}
