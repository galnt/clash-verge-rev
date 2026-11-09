import { useCallback, useEffect, useReducer } from 'react'

import speedManager, {
  isSpeedTestableProxy,
  type SpeedUpdate,
} from '@/services/speed'
import { debugLog } from '@/utils/debug'

const identity = (_: SpeedUpdate, next: SpeedUpdate): SpeedUpdate => next

const INITIAL_SPEED: SpeedUpdate = { speed: -1, updatedAt: 0 }

export interface UseProxySpeedState {
  speedValue: number
  /** 只测当前这一个节点的下载速度 */
  onSpeed: () => Promise<void>
  /** 是否为纯节点；策略组节点不展示也不参与测速 */
  testable: boolean
}

/**
 * 订阅单个节点的测速结果。缓存按节点名共享，因此同一节点在多个分组里的
 * 卡片会一起更新；虚拟列表卸载后重新挂载时会自动读取缓存。
 */
export function useProxySpeedState(
  proxy: IProxyItem,
  groupName: string,
): UseProxySpeedState {
  const testable = isSpeedTestableProxy(proxy)
  const [speedState, setSpeedState] = useReducer(identity, INITIAL_SPEED)

  useEffect(() => {
    if (!testable) return
    speedManager.setListener(proxy.name, setSpeedState)
    setSpeedState(speedManager.getSpeedUpdate(proxy.name) ?? INITIAL_SPEED)
    return () => {
      speedManager.removeListener(proxy.name, setSpeedState)
    }
  }, [proxy.name, testable])

  const onSpeed = useCallback(() => {
    if (!testable) return Promise.resolve()
    return speedManager
      .checkProxySpeed(groupName, proxy.name)
      .catch((error) => {
        debugLog(`[useProxySpeedState] 测速失败: ${error}`)
      })
  }, [proxy.name, groupName, testable])

  return { speedValue: testable ? speedState.speed : -1, onSpeed, testable }
}
