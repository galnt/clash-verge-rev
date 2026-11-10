import { useCallback, useMemo, useRef } from 'react'
import {
  closeConnection,
  getConnections,
  selectNodeForGroup,
} from 'tauri-plugin-mihomo-api'

import { useProfiles } from '@/hooks/use-profiles'
import { useVerge } from '@/hooks/use-verge'
import { syncTrayProxySelection } from '@/services/cmds'
import { debugLog } from '@/utils/debug'

// 缓存连接清理
const cleanupConnections = async (previousProxy: string) => {
  try {
    const { connections } = await getConnections()
    const cleanupPromises = (connections ?? [])
      .filter((conn) => conn.chains.includes(previousProxy))
      .map((conn) => closeConnection(conn.id))

    if (cleanupPromises.length > 0) {
      await Promise.allSettled(cleanupPromises)
      debugLog(`[ProxySelection] 清理了 ${cleanupPromises.length} 个连接`)
    }
  } catch (error) {
    console.warn('[ProxySelection] 连接清理失败:', error)
  }
}

interface ProxySelectionOptions {
  onSuccess?: () => void
  onError?: (error: any) => void
  enableConnectionCleanup?: boolean
}

interface ProxyChangeRequest {
  groupName: string
  proxyName: string
  previousProxy?: string
  skipConfigSave: boolean
}

// 代理选择 Hook
export const useProxySelection = (options: ProxySelectionOptions = {}) => {
  const { current, patchCurrent } = useProfiles()
  const { verge } = useVerge()
  // 队列而非单槽：一次点击可能需要沿组链逐级切换，不能被后一次调用覆盖
  const pendingRequestsRef = useRef<ProxyChangeRequest[]>([])
  const isProcessingRef = useRef(false)

  const { onSuccess, onError, enableConnectionCleanup = true } = options

  // 缓存
  const config = useMemo(
    () => ({
      autoCloseConnection: verge?.auto_close_connection ?? false,
      enableConnectionCleanup,
    }),
    [verge?.auto_close_connection, enableConnectionCleanup],
  )

  // 切换节点
  const syncTraySelection = useCallback(() => {
    syncTrayProxySelection().catch((error) => {
      console.error('[ProxySelection] 托盘状态同步失败:', error)
    })
  }, [])

  const persistSelection = useCallback(
    (groupName: string, proxyName: string, skipConfigSave: boolean) => {
      if (!current || skipConfigSave) return

      const selected = current.selected ? [...current.selected] : []
      const index = selected.findIndex((item) => item.name === groupName)

      if (index < 0) {
        selected.push({ name: groupName, now: proxyName })
      } else {
        selected[index] = { name: groupName, now: proxyName }
      }

      patchCurrent({ selected }).catch((error) => {
        console.error('[ProxySelection] 保存代理选择失败:', error)
      })
    },
    [current, patchCurrent],
  )

  const executeChange = useCallback(
    async (request: ProxyChangeRequest) => {
      const { groupName, proxyName, previousProxy, skipConfigSave } = request
      debugLog(`[ProxySelection] 代理切换: ${groupName} -> ${proxyName}`)

      try {
        await selectNodeForGroup(groupName, proxyName)
        onSuccess?.()
        syncTraySelection()
        persistSelection(groupName, proxyName, skipConfigSave)
        debugLog(
          `[ProxySelection] 代理和状态同步完成: ${groupName} -> ${proxyName}`,
        )

        if (
          config.enableConnectionCleanup &&
          config.autoCloseConnection &&
          previousProxy
        ) {
          void cleanupConnections(previousProxy)
        }
      } catch (error) {
        console.error(
          `[ProxySelection] 代理切换失败: ${groupName} -> ${proxyName}`,
          error,
        )
        onError?.(error)
      }
    },
    [config, onError, onSuccess, persistSelection, syncTraySelection],
  )

  const flushChangeQueue = useCallback(async () => {
    if (isProcessingRef.current) return
    isProcessingRef.current = true

    try {
      while (pendingRequestsRef.current.length) {
        const request = pendingRequestsRef.current.shift()
        if (!request) break
        await executeChange(request)
      }
    } finally {
      isProcessingRef.current = false
      if (pendingRequestsRef.current.length) {
        void flushChangeQueue()
      }
    }
  }, [executeChange])

  const changeProxy = useCallback(
    (
      groupName: string,
      proxyName: string,
      previousProxy?: string,
      skipConfigSave: boolean = false,
    ) => {
      pendingRequestsRef.current.push({
        groupName,
        proxyName,
        previousProxy,
        skipConfigSave,
      })
      void flushChangeQueue()
    },
    [flushChangeQueue],
  )

  const handleSelectChange = useCallback(
    (
      groupName: string,
      previousProxy?: string,
      skipConfigSave: boolean = false,
    ) =>
      (event: { target: { value: string } }) => {
        const newProxy = event.target.value
        changeProxy(groupName, newProxy, previousProxy, skipConfigSave)
      },
    [changeProxy],
  )

  const handleProxyGroupChange = useCallback(
    (group: { name: string; now?: string }, proxy: { name: string }) => {
      changeProxy(group.name, proxy.name, group.now)
    },
    [changeProxy],
  )

  return {
    changeProxy,
    handleSelectChange,
    handleProxyGroupChange,
  }
}
