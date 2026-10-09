import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 发现本机可用的 **Chromium 系浏览器**（用于「借真实浏览器上下文产生已签名的推送 ws URL」）。
 *
 * 为什么要找浏览器、而不是纯 Node 算签名：抖音推送 ws 的 `signature` 依赖页面里
 * `webmssdk` + 网页安全 SDK（secsdk/isaac）的**运行时设备指纹**，纯 Node 复刻会一直
 * 被 `DEVICE_BLOCKED` 拒（见 spike/gate-spike.mjs 的实测）。所以签名交给真实浏览器，
 * 主进程只负责连接与解码。
 *
 * **只认 Chromium 系**（Chrome/Edge/Brave/Chromium）：它们支持 `--remote-debugging-port` 与 CDP；
 * 默认浏览器若是 Firefox/Safari 则驱动不了（无 CDP）。
 *
 * 覆盖顺序：显式配置（设置项/环境变量）→ 各平台常见安装路径。
 */

export interface FoundBrowser {
  /** 可执行文件绝对路径 */
  path: string
  /** 人类可读的名字（写日志用） */
  kind: string
}

/** 环境变量兜底：用户可用这些显式指定（不写设置项时也生效） */
const ENV_KEYS = ['DOUYIN_LINK_BROWSER', 'CHROME_PATH', 'BROWSER']

/** 各平台的候选路径（按优先级） */
function candidates(): Array<{ path: string; kind: string }> {
  const out: Array<{ path: string; kind: string }> = []
  const programFiles = process.env['PROGRAMFILES'] ?? ''
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? ''
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''

  if (process.platform === 'win32') {
    const rel = [
      ['Google/Chrome/Application/chrome.exe', 'Chrome'],
      ['Microsoft/Edge/Application/msedge.exe', 'Edge'],
      ['BraveSoftware/Brave-Browser/Application/brave.exe', 'Brave'],
      ['Chromium/Application/chrome.exe', 'Chromium']
    ] as const
    for (const [suffix, kind] of rel) {
      if (programFiles) out.push({ path: join(programFiles, suffix), kind })
      if (programFilesX86) out.push({ path: join(programFilesX86, suffix), kind })
      if (localAppData) out.push({ path: join(localAppData, suffix), kind })
    }
    return out
  }

  if (process.platform === 'darwin') {
    const apps = [
      ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome'],
      ['Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Edge'],
      ['Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave'],
      ['Chromium.app/Contents/MacOS/Chromium', 'Chromium']
    ] as const
    for (const [suffix, kind] of apps) {
      out.push({ path: `/Applications/${suffix}`, kind })
      if (home) out.push({ path: join(home, 'Applications', suffix), kind })
    }
    return out
  }

  // Linux（含 /snap）
  const dirs = ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/google/chrome']
  const names = [
    ['google-chrome', 'Chrome'],
    ['google-chrome-stable', 'Chrome'],
    ['chromium', 'Chromium'],
    ['chromium-browser', 'Chromium'],
    ['microsoft-edge', 'Edge'],
    ['microsoft-edge-stable', 'Edge'],
    ['brave-browser', 'Brave']
  ] as const
  for (const dir of dirs) for (const [name, kind] of names) out.push({ path: join(dir, name), kind })
  return out
}

/**
 * 找一个可用浏览器。`override` 优先（设置项里显式指定的路径）。
 * 找不到返回 `null`（调用方据此报 `noBrowser` 并回落 HTTP 轮询）。
 */
export function findBrowser(override?: string): FoundBrowser | null {
  const explicit = [override, ...ENV_KEYS.map((key) => process.env[key])]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  for (const path of explicit) {
    if (existsSync(path)) return { path, kind: '指定' }
  }
  for (const candidate of candidates()) {
    if (existsSync(candidate.path)) return candidate
  }
  return null
}