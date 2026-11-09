import { listen } from '@tauri-apps/api/event'

import {
  cmdCancelSingboxSpeedTest,
  cmdGetSpeedTestResults,
  cmdRunSingboxSpeedTest,
  type ISpeedTestRecord,
} from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { debugLog } from '@/utils/debug'

/** 每个节点的测速时长（毫秒） */
const SPEED_TEST_TIMEOUT_MS = 5000

const PRESET_PROXY_NAMES = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
  'COMPATIBLE',
])

/** 策略组类型：它们只是别的分组里的「组节点」，没有自己的出站配置 */
const GROUP_PROXY_TYPES = new Set([
  'selector',
  'urltest',
  'fallback',
  'loadbalance',
  'relay',
])

/**
 * 只有纯节点才参与测速并展示结果。
 * 策略组（Selector/URLTest/Fallback/...）会作为节点出现在其他分组里，
 * 但不能当作真实节点去测速。
 */
export function isSpeedTestableProxy(
  proxy: Pick<IProxyItem, 'name' | 'type' | 'all'> | null | undefined,
): boolean {
  if (!proxy?.name) return false
  if (PRESET_PROXY_NAMES.has(proxy.name)) return false
  if (proxy.all?.length) return false
  if (GROUP_PROXY_TYPES.has(proxy.type?.toLowerCase() ?? '')) return false
  return true
}

export interface SpeedUpdate {
  /** -1 未测速、-2 测速中、0 失败、>0 下载速率(bytes/s) */
  speed: number
  updatedAt: number
  /** 后端测速程序给出的展示值，如 "↓ 42.60 Mbps" */
  display?: string
}

const toDisplay = (record: ISpeedTestRecord) =>
  record.dlSpeed ? `↓ ${record.dlSpeed}` : undefined

const toSpeed = (record: ISpeedTestRecord) =>
  record.error || record.bytesPerSecond <= 0
    ? 0
    : Math.max(1, record.bytesPerSecond)

/**
 * 真实下载测速。
 *
 * 后端会读取运行配置里的完整节点参数，转换成 sing-box outbounds，交给一个
 * 独立的临时 sing-box 实例直接拨号测速；不经过本机 mixed-port，也不会改动
 * 运行中的代理模式或选中节点。结果由后端写入 JSON 文件并通过事件逐条推送。
 *
 * 结果按「节点名」全局共享：同一个节点会出现在多个分组中，任意一组测完，
 * 其他分组里的同名节点会同时更新。
 */
class SpeedManager {
  private cache = new Map<string, SpeedUpdate>()
  private listeners = new Map<string, Set<(update: SpeedUpdate) => void>>()
  private statusListeners = new Set<() => void>()
  private runningGroup: string | null = null
  private runningSince = 0
  private hydrated = false

  subscribeStatus = (listener: () => void) => {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  getRunningGroup = () => this.runningGroup

  private notifyStatus() {
    this.statusListeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        console.error('[SpeedManager] 通知测速状态失败', error)
      }
    })
  }

  /** 同名的多个卡片可能同时可见，因此一个节点对应一组订阅者 */
  setListener(name: string, listener: (update: SpeedUpdate) => void) {
    const list = this.listeners.get(name) ?? new Set()
    list.add(listener)
    this.listeners.set(name, list)
  }

  removeListener(name: string, listener: (update: SpeedUpdate) => void) {
    const list = this.listeners.get(name)
    if (!list) return
    list.delete(listener)
    if (list.size === 0) this.listeners.delete(name)
  }

  getSpeedUpdate(name: string): SpeedUpdate | undefined {
    const entry = this.cache.get(name)
    return entry ? { ...entry } : undefined
  }

  getSpeed(name: string) {
    return this.getSpeedUpdate(name)?.speed ?? -1
  }

  setSpeed(name: string, speed: number, display?: string): SpeedUpdate {
    const update: SpeedUpdate = { speed, display, updatedAt: Date.now() }
    this.cache.set(name, update)

    this.listeners.get(name)?.forEach((listener) => {
      try {
        listener(update)
      } catch (error) {
        console.error(`[SpeedManager] 通知节点速度失败: ${name}`, error)
      }
    })
    return update
  }

  /** 从后端持久化的结果文件恢复历史记录 */
  async hydrate() {
    if (this.hydrated) return
    this.hydrated = true
    try {
      const records = await cmdGetSpeedTestResults()
      debugLog(`[SpeedTest] hydrate: ${records.length} persisted records`)
      for (const record of records) {
        this.setSpeed(record.name, toSpeed(record), toDisplay(record))
      }
    } catch (error) {
      debugLog(`[SpeedTest] hydrate failed: ${error}`)
    }
  }

  /** 停止当前测速 */
  cancel() {
    if (!this.runningGroup) return
    debugLog(`[SpeedTest] cancel requested for ${this.runningGroup}`)
    cmdCancelSingboxSpeedTest().catch((error) => {
      debugLog(`[SpeedTest] cancel failed: ${error}`)
    })
  }

  /** 测一个组内的全部纯节点；列表为空时由后端按组名展开 */
  async checkGroupSpeed(groupName: string, proxies: IProxyItem[]) {
    const names = proxies.filter(isSpeedTestableProxy).map((item) => item.name)
    debugLog(
      `[SpeedTest] group click: ${groupName}, cards=${proxies.length}, testable=${names.length}`,
    )
    await this.runSpeedTest(groupName, names)
  }

  /** 只测单个节点（节点卡片上的入口） */
  async checkProxySpeed(groupName: string, name: string) {
    debugLog(`[SpeedTest] node click: ${groupName} / ${name}`)
    await this.runSpeedTest(groupName, [name])
  }

  private async runSpeedTest(groupName: string, names: string[]) {
    if (this.runningGroup) {
      // 上一次任务异常中断时不要让按钮永久失效。
      if (Date.now() - this.runningSince > 2 * 60 * 1000) {
        debugLog(`[SpeedTest] stale lock cleared (was ${this.runningGroup})`)
        this.runningGroup = null
        this.notifyStatus()
      } else {
        debugLog(
          `[SpeedTest] blocked: task still running in ${this.runningGroup}`,
        )
        showNotice.error('已有测速任务在进行中，请先点击「停止」')
        return
      }
    }

    const nodes = [...new Set(names)].filter(
      (name) => name && !PRESET_PROXY_NAMES.has(name),
    )
    // nodes 允许为空：后端会按组名从运行配置展开该组节点，
    // 因此组折叠 / 虚拟列表未渲染时点击组头测速同样有效。
    debugLog(
      `[SpeedTest] start group=${groupName} nodes=${nodes.length}${nodes.length === 0 ? ' (backend will expand)' : ''}: ${nodes.join(', ')}`,
    )
    this.runningGroup = groupName
    this.runningSince = Date.now()
    this.notifyStatus()

    let unlisten: (() => void) | undefined
    try {
      unlisten = await listen<ISpeedTestRecord>(
        'speed-test://result',
        (event) => {
          const record = event.payload
          debugLog(
            `[SpeedTest] event ${record.name}: ${record.dlSpeed || record.error || 'no data'}, ${record.bytesPerSecond} B/s`,
          )
          this.setSpeed(record.name, toSpeed(record), toDisplay(record))
        },
      )
      debugLog('[SpeedTest] event listener registered')

      for (const name of nodes) {
        this.setSpeed(name, -2)
      }

      debugLog(
        `[SpeedTest] invoking run_singbox_speed_test group=${groupName} names=${nodes.length} timeout=${SPEED_TEST_TIMEOUT_MS}ms`,
      )
      await cmdRunSingboxSpeedTest({
        group: groupName,
        names: nodes,
        timeoutMs: SPEED_TEST_TIMEOUT_MS,
      })
      debugLog('[SpeedTest] invoke returned')
    } catch (error) {
      debugLog(`[SpeedTest] failed: ${error}`)
      showNotice.error(`测速失败: ${error}`)
    } finally {
      unlisten?.()
      for (const name of nodes) {
        if (this.getSpeed(name) === -2) {
          this.setSpeed(name, -1)
        }
      }
      debugLog(
        `[SpeedTest] finished group=${groupName} elapsed=${Date.now() - this.runningSince}ms`,
      )
      this.runningGroup = null
      this.notifyStatus()
    }
  }

  formatSpeed(speed: number, name?: string) {
    if (name) {
      const display = this.cache.get(name)?.display
      if (display) return display
    }
    if (speed === -1) return ''
    if (speed === -2) return '↓ ...'
    if (speed === 0) return 'Error'

    const bits = speed * 8
    if (bits >= 1e9) return `↓ ${(bits / 1e9).toFixed(2)} Gbps`
    if (bits >= 1e6) return `↓ ${(bits / 1e6).toFixed(1)} Mbps`
    if (bits >= 1e3) return `↓ ${(bits / 1e3).toFixed(0)} Kbps`
    return `↓ ${bits.toFixed(0)} bps`
  }

  formatSpeedColor(speed: number) {
    if (speed <= 0) return 'error.main'

    const mbps = (speed * 8) / 1e6
    if (mbps >= 50) return 'success.main'
    if (mbps >= 10) return 'primary.main'
    if (mbps >= 2) return 'warning.main'
    return 'error.main'
  }
}

export default new SpeedManager()
