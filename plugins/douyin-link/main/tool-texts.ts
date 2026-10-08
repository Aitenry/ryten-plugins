import { getMainLanguage } from '@host/main/i18n'

/**
 * 抖音直播分析器 工具的返回文案（显示在工具卡片上，跟随界面语言）。
 *
 * 为什么单独一份：模型看到的字符串会原样进对话，**用户也会看到**——
 * 文案随插件走，插件停用就一起消失（别塞进宿主内核的文案表）。
 * 英文那份用 `typeof zhCNToolTexts` 约束：**逐键对齐**，删键加键都会编译报错。
 * 这里**不加 `as const`**：加了会把每个值收窄成中文那几个字面量，英文照着写就整份不兼容
 * ——要约束的只是「键一致」，值本来就是另一种语言。
 */
export const zhCNToolTexts = {
  common: {
    unknownAction: '未知动作：{{action}}。支持：{{supported}}'
  },
  kinds: {
    chat: '弹幕',
    member: '进场',
    like: '点赞',
    social: '关注',
    gift: '礼物',
    stats: '在线人数',
    control: '直播状态',
    system: '系统'
  },
  douyin_live: {
    noRooms: '还没有加入任何直播间。请先在「抖音直播分析器」页面里添加直播间链接或房间号。',
    noRoom: '没找到这个直播间。先用 action=rooms 看清单里的房间号或标题。',
    roomsHeader: '**抖音直播分析器**：共 {{count}} 个直播间（★ = 正在分析，🔊 = 正在出声）',
    roomLine:
      '- {{room}} | 状态 {{phase}} | 监控 {{monitor}} | 声音 {{audio}}{{focus}} | 速率 {{rate}} 条/分 | 本场 {{received}} 条 / {{users}} 人 | 库里累计 {{stored}} 条 / {{storedUsers}} 人',
    roomFailure: '  - 失败原因：{{code}}',
    /** roomLine 的 {{focus}}：正在分析的那个房间缀一颗星（与表头图例同一枚） */
    focusYes: ' ★',
    phaseLive: '监控中',
    phaseConnecting: '连接中',
    phaseRetrying: '重连中',
    phaseQueued: '排队中（并发已满）',
    phaseError: '出错',
    phaseEnded: '已下播',
    phaseOff: '未监控',
    monitorOn: '开',
    monitorOff: '关',
    monitorDone: '{{room}} 的监控已{{state}}。',
    audioYes: '开',
    audioNo: '关',
    audioStarted: '声音已切到 {{room}}（同一时间只有一个直播间出声，其它房间继续监听弹幕）。',
    audioStopped: '已停止播放声音（监控不受影响）。',
    audioFailed: '没能开始播放：这个直播间没有可拉的音频流，或地址解析失败（详见日志）。',
    summaryHeader: '**{{room}}** 最近 {{minutes}} 分钟',
    summaryTotals:
      '- 消息 {{messages}} 条：弹幕 {{chat}} · 进场 {{member}} · 点赞 {{like}} · 关注 {{social}} · 礼物 {{gift}}（{{diamonds}} 抖币）；活跃用户 {{users}} 人',
    summaryWindow: '- 数据时段：{{from}} → {{to}}',
    summaryKinds: '- 类型分布：{{kinds}}',
    summaryTopChat: '- 发言榜 Top：{{list}}',
    usersHeader: '**{{room}}** 用户榜（前 {{count}} 名，跨会话累计）',
    usersEmpty: '这个直播间还没有用户记录。',
    userLine:
      '- {{user}} | 发言 {{chat}} · 进场 {{enter}} · 点赞 {{like}} · 关注 {{follow}} · 礼物 {{gift}}（{{diamonds}} 抖币） | 荣誉等级 {{honor}} · 粉丝团 {{fans}}',
    danmakuHeader: '消息检索：本页 {{count}} 条（命中 {{total}} 条，新 → 旧）：',
    danmakuEmpty: '没有匹配的消息（换个关键词，或确认这个直播间在监控中）。',
    line: '- [{{kind}}] {{time}} {{user}}{{text}}',
    countSuffix: ' ×{{count}}',
    compareHeader: '**多直播间对比**（最近 {{minutes}} 分钟）',
    compareRow:
      '- {{room}} | 消息 {{messages}}（{{chat}} 弹幕 / {{member}} 进场 / {{like}} 点赞 / {{social}} 关注 / {{gift}} 礼物 · {{diamonds}} 抖币）| 活跃用户 {{users}} | {{rate}} 条/分 | 库里累计 {{total}} 条'
  }
}

export const enUSToolTexts: typeof zhCNToolTexts = {
  common: {
    unknownAction: 'Unknown action: {{action}}. Supported: {{supported}}'
  },
  kinds: {
    chat: 'chat',
    member: 'join',
    like: 'like',
    social: 'follow',
    gift: 'gift',
    stats: 'viewers',
    control: 'status',
    system: 'system'
  },
  douyin_live: {
    noRooms: 'No live room has been added yet. Add a room link or room id on the "Douyin Live Analyzer" page first.',
    noRoom: 'No such room. Use action=rooms to see the room ids and titles in the list.',
    roomsHeader: '**Douyin Live Analyzer**: {{count}} rooms (★ = focused, 🔊 = playing audio)',
    roomLine:
      '- {{room}} | state {{phase}} | monitor {{monitor}} | audio {{audio}}{{focus}} | {{rate}} msg/min | this session {{received}} msgs / {{users}} users | stored {{stored}} msgs / {{storedUsers}} users',
    roomFailure: '  - failure: {{code}}',
    /** {{focus}} value of roomLine: a star on the room being analyzed (same glyph as the header legend) */
    focusYes: ' ★',
    phaseLive: 'monitoring',
    phaseConnecting: 'connecting',
    phaseRetrying: 'retrying',
    phaseQueued: 'queued (concurrency limit)',
    phaseError: 'error',
    phaseEnded: 'stream ended',
    phaseOff: 'not monitored',
    monitorOn: 'on',
    monitorOff: 'off',
    monitorDone: 'Monitoring for {{room}} is now {{state}}.',
    audioYes: 'on',
    audioNo: 'off',
    audioStarted: 'Audio switched to {{room}} (only one room can play audio at a time; the others keep collecting danmaku).',
    audioStopped: 'Audio stopped (monitoring is unaffected).',
    audioFailed: 'Cannot start audio: this room has no pullable audio stream, or resolving failed (see the log).',
    summaryHeader: '**{{room}}** last {{minutes}} minutes',
    summaryTotals:
      '- {{messages}} messages: chat {{chat}} · join {{member}} · like {{like}} · follow {{social}} · gift {{gift}} ({{diamonds}} coins); {{users}} active users',
    summaryWindow: '- Data window: {{from}} → {{to}}',
    summaryKinds: '- Kind breakdown: {{kinds}}',
    summaryTopChat: '- Top chatters: {{list}}',
    usersHeader: '**{{room}}** user leaderboard (top {{count}}, across sessions)',
    usersEmpty: 'No user records for this room yet.',
    userLine:
      '- {{user}} | chat {{chat}} · join {{enter}} · like {{like}} · follow {{follow}} · gift {{gift}} ({{diamonds}} coins) | honor {{honor}} · fan club {{fans}}',
    danmakuHeader: 'Message search: {{count}} rows on this page ({{total}} matches, new → old):',
    danmakuEmpty: 'No matching messages (try another keyword, or make sure the room is being monitored).',
    line: '- [{{kind}}] {{time}} {{user}}{{text}}',
    countSuffix: ' ×{{count}}',
    compareHeader: '**Multi-room comparison** (last {{minutes}} minutes)',
    compareRow:
      '- {{room}} | {{messages}} messages ({{chat}} chat / {{member}} join / {{like}} like / {{social}} follow / {{gift}} gift · {{diamonds}} coins) | {{users}} active users | {{rate}} msg/min | {{total}} stored'
  }
}

/** 当前界面语言对应的文案 */
export function getToolTexts(): typeof zhCNToolTexts {
  return getMainLanguage() === 'en-US' ? enUSToolTexts : zhCNToolTexts
}

/** 工具描述（给模型看的；也显示在设置 → 智能体 → 工具里） */
export function toolDescriptions(): { zh: string; en: string } {
  return {
    zh:
      '多直播间分析器（抖音直播）：rooms 看房间清单与状态；summary 出某个房间最近 N 分钟的分析报告（互动量/类型分布/发言榜，含礼物条数与抖币价值）；messages 在自己存的库里检索消息（支持关键词与类型）；users 出用户榜（跨会话累计，可按最近出现 / 发言最多 / 刷礼物最多排序）；compare 做多房间对比；monitor 开关某个房间的监控；audio 开关声音（同一时间只有最新选中的那个房间出声，其它房间只监听弹幕）。只返回文字，不返回音频。',
    en:
      'Multi-room analyzer for Douyin live rooms: rooms lists rooms and states; summary returns an analysis report for one room over the last N minutes (interactions, kind breakdown, top chatters, plus gift counts and coin value); messages searches the plugin\'s own message store (keyword and kind filters); users returns a leaderboard (across sessions; sort by most recent, most chat or top gifters); compare compares all rooms; monitor toggles monitoring; audio toggles sound (only the most recently focused room plays audio, the others just collect danmaku). Text only, no audio.'
  }
}
