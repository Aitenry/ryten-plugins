# 抖音直播分析器：用户榜 / 在线观众 / 发言榜 / 用户档案历史 修复计划

## Context（为什么做）

用户在「用户」页签与「在线观众」页签上反馈了 4 个问题（附截图）：

1. **用户榜被固定写死 300 条**：`UsersPanel` 查询时硬编码 `limit = 300`，超出部分永远看不到（也无法翻页到达）。
2. **用户榜一直刷新列表**：只要用户页签开着，`onUsers` 推送（最多 1.5s 一次）就不断 `usersReloadKey++`，导致列表反复重查、重渲染，观感上「列表一直在闪/跳」。
3. **用户信息丢失**：在线观众表里「成员」（接口给的 `admin_user_ids_str`，只有 id）以及部分人只显示一串数字 id，昵称/头像为空——但用户的 id 是**可以**按 id 去抖音查回真实资料的（插件里已有这条能力，见 `reveal-mystery`）。截图里第 38/39 页就是一整页只有 id 的成员。
4. **发言榜按「累计」而不是「当天」排**：概览页的**发言榜**（`summary.topChat`）用 `store.listUsers(webRid,'chat','',10)`，是跨会话累计，与概览其余部分的时间范围（默认今天）口径不一致。
5. **用户档案里的历史弹幕不能按房间选、不能按时间区间看**：`UserHistory` 只有「本房间 / 全部房间」二元切换，没有具体房间选择、也没有时间区间选择。

目标：修掉 1、2，让 3 能显示真实昵称/头像，让 4 跟随概览的时间范围（默认今天），给 5 加上「按房间选择」与「按时间区间查看」。

---

## 改动总览（按文件）

### 1. 用户榜：去掉固定 300 + 停止常刷（渲染层为主）

**`renderer/components/UsersPanel.tsx`**
- 新增本地状态 `page`（0 起）、`total`、`pageSize`（建议 50）。
- 查询改为服务端分页：`api.usersList(webRid, sort, keyword, { limit: pageSize, offset: page * pageSize })`，拿到 `{ rows, total }`。
- `FitTable` 传入 `pagination={{ current: page+1, pageSize, total, showSizeChanger:false, onChange:(p)=>setPage(p-1) }}`（`ui.tsx` 的 `FitTable` 会把调用方 `pagination` 展开覆盖它自己算的 `pageSize`，因此服务端分页可用）。
- **移除 `props.reloadKey` 依赖**：effect 依赖改为 `[webRid, sort, keyword, page]`；不再因为用户事件重查。
- 标题栏右侧（清空按钮旁）加一个「刷新」按钮（`RiRefreshLine`），手动 `tick++` 触发重查；搜索沿用现有 200ms 防抖。
- 空态/加载态不改。

**`renderer/Page.tsx`**
- `UsersPanel` 不再传 `reloadKey`（`PresencePanel` 继续传，它本身每 5s 轮询，事件加快刷新无副作用）。
- `loadRoomData` 里 `api.usersList(...)` 调用改为取 `.rows`（返回形状变了）。

**`renderer/api.ts`**
- `usersList(webRid, sort, keyword, options?: {limit, offset})` 返回 `UserRankPage`（`{rows, total}`）；内部调 `users-list` 传 `limit/offset`。

**`main/db/mapper.ts`**
- 新增 `listUsersPage(webRid, sort, keyword, limit, offset): Promise<{rows: UserRankRow[]; total: number}>`：在现有 `listUsers` 基础上加 `count(*)` 总数与 `.offset()`，排序逻辑不变（`recent`/`chat`/`gift`）。保留旧 `listUsers`（概览的窗口版发言榜会替换它，`loadRoomData` 也可以用分页版）。
- 用现有索引 `idx_douyin_link_user_room_chat`。

**`main/monitor/hub.ts`**
- `listUsers(...)` 增加 `offset` 透传，返回 `{rows,total}`。

**`main/ipc.ts`**
- `users-list` 通道增加 `offset` 参数。

### 2. 发言榜按当天（概览窗口内）排

**`main/db/mapper.ts`**
- 新增 `chatRankByPerson(webRid, fromMs, toMs, limit): Promise<UserRankRow[]>`：
  - 以 `douyin_link_messages`（`kind='chat'`、`at_ms between`）按 `user_id` 分组计 `count`，`LEFT JOIN douyin_link_users` 取静态信息（昵称/头像/等级等，回退逻辑与 `giftRankByPerson` 一致：`coalesce(nullif(max(user_name),''), max(users.nickname),'')`）。
  - 返回形状对齐 `UserRankRow`（`stats.chat` = 窗口内条数，其余字段取自用户表；缺失则 0/空）。
  - 空 `user_id` 排除。排序按窗口内 chat 降序，再按最近时间。

**`main/monitor/hub.ts`**
- `summary()` 里 `const topChat = await store.listUsers(webRid,'chat','',10)` 改为 `store.chatRankByPerson(webRid, fromMs, toMs, 10)`。
  - `fromMs`/`toMs` 已是概览的当前窗口（默认今天；左侧「每日记录」选某天 / 拖时间条都走同一路径），因此发言榜天然「按当天/所选区间」。
  - `all` 模式（from=0）即全时段，行为不变。
- 渲染层 `OverviewPanel` 的 `RankList` 已用 `row.stats.chat`，无需改动。

### 3. 在线观众：补齐只有 id 的用户的真实资料

复用已有的按 id 查资料能力（`main/douyin/mystery.ts` 的 `aweme/v1/web/user/profile/other/`，`reveal-mystery` 已验证可用）。

**`main/douyin/mystery.ts`**
- 抽出 `fetchUserProfile(userId): Promise<{ok:true; profile: RawUserProfile}|{ok:false; code}>`，返回**原始静态字段**（nickname/displayId/secUid/gender/region/follower/following/signature + 头像 URL），不做 data URL 下载。
- `revealMysteryProfile` 改为基于它 + 下载头像（保持现有返回 `MysteryProfile` 不变）。

**`main/db/mapper.ts`**
- 新增 `upsertUserStatic(webRid, rows: Array<{userId,nickname,displayId,gender,signature,city,avatar,following,follower,secUid}>): Promise<void>`：
  - `ON CONFLICT (web_rid,user_id) DO UPDATE`，只写静态字段（`keepNonEmpty` 昵称/头像等），**不动统计与 first/lastSeen**（新行的 first/lastSeen 保持 0，避免污染榜的「最近出现」排序）。
- 复用 `schemaReady` / `MSG_CHUNK`。

**`main/monitor/hub.ts`**
- 新增内部方法 `enrichUnknownUsers(webRid, ids)`：
  - 过滤出「recorder 无昵称 + `store.getUsers` 无昵称」的 id；叠加**内存缓存**（`Map<userId, {at, ok}>`，失败冷却如 10 分钟，避免反复打接口）。
  - 用 `fetchUserProfile` 抓取，**并发 2、单次预算 ~20 个**（一次最多补 20 人，其余下一轮），成功后 `store.upsertUserStatic` 落库。
  - 完成后 `storeCache.at = 0`（让「成员/本场」数字与昵称刷新），并可广播一次 `USERS_EVENT`（无需新通道）。
  - 全程 `try/catch` 且 `void` 调用（**fire-and-forget**，绝不拖慢 `presence()` 的返回）。
- `presence()` 末尾：若存在无昵称的行，`void this.enrichUnknownUsers(webRid, [...ids])`（有冷却/在跑标记，避免每 5s 重复触发）。下一轮轮询（5s）即可看到补齐的昵称/头像。
- 范围收敛：只补 **listed（成员）/ 麦上 / 主播** 以及「本场但缺名」的 id，受预算与冷却约束；不无限抓。

> 说明：这是唯一涉及外部网络的改动，做了并发/预算/冷却三重约束，失败即如实显示 id（不编造）。

### 4. 用户档案历史弹幕：按房间选择 + 时间区间

**`renderer/api.ts`**
- `userMessages(webRid, userId, options)` 的 `options` 增加 `from` / `to`，透传给 `messages-query`（该通道/`queryMessages` 已支持时间范围）。

**`renderer/components/UserHistory.tsx`**
- 把「本房间 / 全部房间」`Segmented` 换成**房间选择 `Select`**（"按容器选择"）：
  - options：`[{value:'', label: 全部房间}, ...props.rooms.map(r => ({value:r.webRid, label:r.title||r.webRid}))]`；
  - 默认值为 `props.webRid`（当前房间）；`value === ''` 即原来的跨房间口径。
- 保留「只看弹幕 / 全部互动」`Segmented`。
- 新增**时间区间**选择 `DatePicker.RangePicker`（antd + 已装的 `dayjs`）：起止按**本地自然日**边界转 ms（`from = 当天 00:00:00`，`to = 当天 23:59:59.999`），可清空 = 不限区间。查询把 `from/to` 传下去。
- 切换房间/区间/类型时 `setPage(0)`；`roomLabel` 逻辑保留（列表里仍显示消息所属房间，仅当选择「全部房间」时显示）。
- 空态文案不再提「切到全部房间」的旧措辞（改为「换个房间或区间」）。

**`locales/zh-CN.ts` / `locales/en-US.ts`**（两份必须逐键对齐）
- 新增：用户榜「刷新」、用户档案历史的「房间」选择标签/「全部房间」/「时间区间」占位文案、空态措辞。
- 复用已有：`page.total/prev/next/pageOf`（分页）。

---

## 不做的事（避免过度设计）

- 不改用户榜其余列「累计」口径（它是按房间的跨会话累计，符合产品定位）；本次只解决「固定 300」与「常刷」。
- 不给在线观众表加服务端分页（本次只补昵称，分页非诉求）。
- 不新增数据库表/列（补齐的资料写进现有 `douyin_link_users`，`ddl.ts` 无需迁移）。

## 关键文件清单

- 渲染层：`UsersPanel.tsx`、`UserHistory.tsx`、`PresencePanel.tsx`（仅在需要提示时微调）、`Page.tsx`、`api.ts`
- 主进程：`monitor/hub.ts`、`db/mapper.ts`、`douyin/mystery.ts`、`ipc.ts`
- 契约/文案：`shared/types.ts`（新增 `UserRankPage`）、`locales/zh-CN.ts`、`locales/en-US.ts`

## 验证

1. `npm run typecheck`（`tsc --noEmit -p tsconfig.json`）必须通过。
2. `npm run build` 产出正常。
3. 功能自检（本地跑插件）：
   - 用户页签：能翻到第 300 条之后；停留时列表不再每 1.5s 重查（点「刷新」才重查）。
   - 概览「发言榜」：默认显示今天的发言量排序；在「每日记录」切到某一天后，榜随之变化。
   - 在线观众：只有 id 的成员在若干秒后出现真实昵称/头像；（可选）断网时仍显示 id，不报错、不卡面板。
   - 用户档案弹窗「历史弹幕」：可按房间下拉切换、可按日期区间筛选，条数/内容随之变化。

## 待确认的取舍（实现时按此默认，如有异议请指出）

- 「发言榜按当天」按**概览当前时间范围**（默认今天；跟随左侧每日记录/时间条）实现。
- 「容器」理解为**直播间（房间）**，历史弹幕用房间下拉选择。
- 在线观众补齐资料会**访问抖音接口**（并发 2、单次 ≤20 人、失败冷却 10 分钟）。