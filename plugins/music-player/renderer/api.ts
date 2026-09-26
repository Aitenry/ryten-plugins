import type { AddTracksResult, MusicFolder, MusicPlayRequest, Track } from '../shared/types'

/**
 * music 插件主进程通道的薄封装。
 *
 * 原先散在 `src/preload/index.ts` 的 `api.music` 命名空间已删除；这里的方法
 * **同名、同参数、同返回类型**，实现改为走 preload 唯一暴露的通用桥
 * （`window.api.plugin.invoke` / `window.api.plugin.on`，通道名 `plugin:music-player:*`）。
 * 类型沿用 `shared/types.ts` 的 DTO 形状，未改语义。
 */
const invoke = window.api.plugin.invoke

export const musicApi = {
  selectDirectory: () => invoke('plugin:music-player:select-directory') as Promise<string | null>,
  getFolders: () => invoke('plugin:music-player:get-folders') as Promise<MusicFolder[]>,
  getTracks: (folderId: string) => invoke('plugin:music-player:get-tracks', folderId) as Promise<Track[]>,
  deleteFolder: (folderId: string) =>
    invoke('plugin:music-player:delete-folder', folderId) as Promise<void>,
  createFolder: (name: string, description?: string) =>
    invoke('plugin:music-player:create-folder', name, description) as Promise<MusicFolder>,
  updateFolderDescription: (folderId: string, description: string | null) =>
    invoke('plugin:music-player:update-folder-description', folderId, description) as Promise<void>,
  updateFolderCover: (folderId: string) =>
    invoke('plugin:music-player:update-folder-cover', folderId) as Promise<string | null>,
  saveFolderCover: (folderId: string, coverDataUrl: string | null) =>
    invoke('plugin:music-player:save-folder-cover', folderId, coverDataUrl) as Promise<void>,
  selectImage: () => invoke('plugin:music-player:select-image') as Promise<string | null>,
  updateFolder: (folderId: string, fields: { name?: string; description?: string | null }) =>
    invoke('plugin:music-player:update-folder', folderId, fields) as Promise<void>,
  addTracks: (folderId: string) =>
    invoke('plugin:music-player:add-tracks', folderId) as Promise<AddTracksResult | null>,
  updateTrack: (trackId: number, fields: { title?: string; artist?: string; album?: string }) =>
    invoke('plugin:music-player:update-track', trackId, fields) as Promise<void>,
  updateTrackCover: (trackId: number) =>
    invoke('plugin:music-player:update-track-cover', trackId) as Promise<string | null>,
  deleteTrack: (trackId: number) => invoke('plugin:music-player:delete-track', trackId) as Promise<void>,
  readFile: (filePath: string) =>
    invoke('plugin:music-player:read-file', filePath) as Promise<ArrayBuffer>,
  toggleLike: (trackId: number) => invoke('plugin:music-player:toggle-like', trackId) as Promise<boolean>,
  updateLastPlayed: (trackId: number) =>
    invoke('plugin:music-player:update-last-played', trackId) as Promise<void>,
  getLikedTracks: () => invoke('plugin:music-player:get-liked-tracks') as Promise<Track[]>,
  getRecentlyPlayed: () => invoke('plugin:music-player:get-recently-played') as Promise<Track[]>,
  /**
   * 监听来自 AI 对话的播放请求（主进程 → 渲染层事件通道），返回取消监听的函数。
   * 事件通道名经主进程 `ctx.registerEvent` 声明后才进 preload 白名单。
   */
  onMusicPlay: (callback: (data: MusicPlayRequest) => void): (() => void) =>
    window.api.plugin.on('plugin:music-player:play-track', (data) => callback(data as MusicPlayRequest))
}

export default musicApi
