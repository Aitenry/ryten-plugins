import { getMainLanguage } from '@host/main/i18n'

/**
 * music 工具的返回文案（显示在工具卡片上，跟随界面语言）。
 *
 * 原先它与 planner/todos 的文案挤在应用内核的 `src/main/i18n/tool-results-planner.ts` 里；
 * music 变成独立插件后，这份文案随插件走——插件自己负责自己的用户可见文本。
 */
export const zhCNToolTexts = {
  /** 未知命令的兜底提示（与 planner 的工具同一套措辞） */
  common: {
    unknownCommand: '未知命令：{{command}}。支持：{{supported}}'
  },

  music: {
    playlistsHeader: '🎵 **歌单列表**\n',
    playlistsEmpty: '还没有任何歌单。',
    playlistLine: '  [{{id}}] **{{name}}**（{{trackCount}} 首）',
    playlistDescription: '    描述：{{description}}',
    /** 可用歌单之间用中文顿号分隔，英文用逗号 */
    availablePlaylistsSeparator: '、',
    playlistNotFound: '未找到名为 "{{name}}" 的歌单。可用歌单：{{available}}',
    playlistTracksEmpty: '歌单 "{{name}}" 中还没有曲目。',
    trackListHeader_one: '🎵 **{{name}}**（共 {{count}} 首，显示前 {{shown}} 首）\n',
    trackListHeader_other: '🎵 **{{name}}**（共 {{count}} 首，显示前 {{shown}} 首）\n',
    trackLine: '  [{{id}}] {{title}} - {{artist}} ({{duration}}){{liked}}',
    unknownArtist: '未知艺术家',
    liked: '收藏',
    nowPlaying: '正在播放：{{title}} - {{artist}}',
    trackNotFound: '未找到 ID 为 {{id}} 的曲目。',
    noPlayerWindow: '无法通知播放器窗口。'
  }
}

export const enUSToolTexts: typeof zhCNToolTexts = {
  common: {
    unknownCommand: 'Unknown command: {{command}}. Supported: {{supported}}'
  },

  music: {
    playlistsHeader: '🎵 **Playlists**\n',
    playlistsEmpty: 'No playlists yet.',
    playlistLine: '  [{{id}}] **{{name}}** ({{trackCount}} tracks)',
    playlistDescription: '    Description: {{description}}',
    availablePlaylistsSeparator: ', ',
    playlistNotFound: 'No playlist named "{{name}}" was found. Available playlists: {{available}}',
    playlistTracksEmpty: 'Playlist "{{name}}" has no tracks yet.',
    trackListHeader_one: '🎵 **{{name}}** ({{count}} track, showing the first {{shown}})\n',
    trackListHeader_other: '🎵 **{{name}}** ({{count}} tracks, showing the first {{shown}})\n',
    trackLine: '  [{{id}}] {{title}} - {{artist}} ({{duration}}){{liked}}',
    unknownArtist: 'Unknown artist',
    liked: ' liked',
    nowPlaying: 'Now playing: {{title}} - {{artist}}',
    trackNotFound: 'No track found with ID {{id}}.',
    noPlayerWindow: 'Could not reach the player window.'
  }
}

export function getToolTexts(): typeof zhCNToolTexts {
  return getMainLanguage() === 'en-US' ? enUSToolTexts : zhCNToolTexts
}
