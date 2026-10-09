import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import { join } from 'node:path'
import logger from 'electron-log'
import { Cdp, devtoolsVersion } from './cdp'

/**
 * 本机 Chromium 进程的单例管理器。
 *
 * 职责：spawn 一个**无头**浏览器（独立临时 profile、随机调试端口，只绑 127.0.0.1），
 * 连上它的浏览器级 CDP；按房间需求开标签页。**不再创建任何 Electron 窗口**。
 *
 * 为什么单例单进程：多个直播间共享同一台浏览器与同一份设备身份（更像「一直待在这个房间的
 * 设备」），也省内存；单个房间的 tab 崩溃不会拖垮整份身份，靠上层退避重开。
 *
 * 收尾：`dispose()` 里杀进程（Windows 用 taskkill /T 杀进程树）并删临时 profile；
 * 由 `AnalyzerHub.dispose()` / `suspend()` 触发（`APP_BEFORE_QUIT` 会走 suspend）。
 */

/**
 * 普通 Windows Chrome 的 UA：无头默认 UA 带 `HeadlessChrome`，抖音据此可能不给分配推送节点。
 * 也导出给 ws-capture 用：推送 ws 的签名与 UA 绑定，主进程直连时必须用**同一个** UA。
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 一个标签页的会话句柄：命令/事件自动带上 sessionId */
export interface BrowserPage {
  sessionId: string
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(method: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void
  close(): Promise<void>
}

class BrowserHost {
  private proc: ChildProcess | null = null
  private cdp: Cdp | null = null
  private port = 0
  private profile = ''
  private exe = ''
  /** 启动中（防并发 ensure 起两个进程） */
  private starting: Promise<void> | null = null

  isRunning(): boolean {
    return Boolean(this.cdp && this.proc && this.proc.exitCode === null)
  }

  get executable(): string {
    return this.exe
  }

  /** 确保浏览器在跑（幂等）。同一 exe 已在跑则直接返回 */
  async ensure(exe: string): Promise<void> {
    if (this.isRunning() && this.exe === exe) return
    if (this.isRunning()) await this.dispose()
    if (this.starting) return this.starting
    this.starting = this.start(exe).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /**
   * 开一个空白标签页并返回会话句柄。
   *
   * **不在这里导航**：调用方要先 `Network.enable` / `Page.enable` 再 `Page.navigate`，
   * 否则页面建 ws 的那一刻我们还没订阅事件，会漏掉那条已签名的推送 URL。
   */
  async openPage(): Promise<BrowserPage> {
    const cdp = this.cdp
    if (!cdp) throw new Error('browser not running')
    const created = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }
    const targetId = created.targetId
    const attached = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
    const sessionId = attached.sessionId
    return {
      sessionId,
      send: (method, params = {}) => cdp.send(method, params, sessionId),
      on: (method, handler) => cdp.on(method, handler),
      close: async () => {
        try {
          await cdp.send('Target.closeTarget', { targetId })
        } catch {
          /* 进程可能已退出 */
        }
      }
    }
  }

  async dispose(): Promise<void> {
    const cdp = this.cdp
    const proc = this.proc
    const profile = this.profile
    this.cdp = null
    this.proc = null
    this.profile = ''
    this.port = 0
    this.exe = ''
    if (cdp) {
      try {
        cdp.close()
      } catch {
        /* ignore */
      }
    }
    if (proc && proc.pid && proc.exitCode === null) killTree(proc.pid)
    if (profile) {
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        /* 文件被占用删不掉也无所谓（临时目录） */
      }
    }
  }

  /* --------------------------------------------------------------- 内部 */

  private async start(exe: string): Promise<void> {
    if (!existsSync(exe)) throw new Error(`browser not found: ${exe}`)
    const port = await freePort()
    const profile = mkdtempSync(join(os.tmpdir(), 'douyin-link-browser-'))
    const args = [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      `--user-agent=${BROWSER_UA}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
      '--window-size=480,320',
      '--autoplay-policy=no-user-gesture-required',
      // Linux root（容器/CI）下 Chromium 不给起沙箱：仅在 uid=0 时关掉
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      'about:blank'
    ]
    logger.info(`[douyin-link] 启动本机浏览器做签名：${exe}（headless，port=${port}）`)
    const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true })
    this.proc = proc
    this.profile = profile
    this.exe = exe
    this.port = port
    proc.on('exit', (code) => {
      logger.warn(`[douyin-link] 本机浏览器退出（code=${code}），实时通道将退避重试`)
      if (this.proc === proc) {
        this.proc = null
        this.cdp?.close()
        this.cdp = null
      }
    })

    const wsUrl = await waitForDevtools(port, 20000)
    if (!wsUrl) {
      await this.dispose()
      throw new Error('devtools not ready')
    }
    this.cdp = await Cdp.connect(wsUrl)
  }
}

/** 取一个空闲端口（listen 0 拿系统分配，然后关掉；有极小竞态，失败会重试整进程） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/** 轮询 devtools 就绪，返回浏览器级 webSocketDebuggerUrl */
async function waitForDevtools(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const info = await devtoolsVersion(port, 800)
      const wsUrl = String(info.webSocketDebuggerUrl ?? '')
      if (wsUrl) return wsUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  return ''
}

/** 杀进程树：Windows 用 taskkill /T /F；其它先 SIGTERM，2 秒后 SIGKILL */
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      return
    }
    process.kill(pid, 'SIGTERM')
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已经没了 */
      }
    }, 2000).unref?.()
  } catch {
    /* 进程可能已退出 */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 单例（进程级） */
export const browserHost = new BrowserHost()