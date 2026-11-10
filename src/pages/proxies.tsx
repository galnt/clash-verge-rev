import {
  AccountTreeOutlined,
  LanOutlined,
  LanRounded,
  WarningRounded,
} from '@mui/icons-material'
import { Box, Button, ButtonGroup } from '@mui/material'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { closeAllConnections } from 'tauri-plugin-mihomo-api'

import { BasePage, TooltipIcon } from '@/components/base'
import { ProviderButton } from '@/components/proxy/provider-button'
import { ProxyGroupTree } from '@/components/proxy/proxy-group-tree'
import { ProxyGroups } from '@/components/proxy/proxy-groups'
import { useVerge } from '@/hooks/use-verge'
import {
  useAppRefreshers,
  useClashConfigData,
} from '@/providers/app-data-context'
import {
  getRuntimeProxyChainConfig,
  patchClashMode,
  updateProxyChainConfigInRuntime,
} from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { debugLog } from '@/utils/debug'

const MODES = ['rule', 'global', 'direct'] as const
type Mode = (typeof MODES)[number]
const MODE_SET = new Set<string>(MODES)
const isMode = (value: unknown): value is Mode =>
  typeof value === 'string' && MODE_SET.has(value)

const ProxyPage = () => {
  const { t } = useTranslation()

  // 从 localStorage 恢复链式代理按钮状态
  const [isChainMode, setIsChainMode] = useState(() => {
    try {
      const saved = localStorage.getItem('proxy-chain-mode-enabled')
      return saved === 'true'
    } catch {
      return false
    }
  })

  // 目录树归入「规则」视图：默认跟随当前模式，单独点击目录树按钮时覆盖
  const [treeModeOverride, setTreeModeOverride] = useState<boolean | null>(null)

  const [chainConfigData, dispatchChainConfigData] = useReducer(
    (_: string | null, action: string | null) => action,
    null as string | null,
  )

  const { clashConfig } = useClashConfigData()
  const { refreshClashConfig } = useAppRefreshers()

  const updateChainConfigData = useCallback((value: string | null) => {
    dispatchChainConfigData(value)
  }, [])
  const { verge } = useVerge()

  const normalizedMode = clashConfig?.mode?.toLowerCase()
  const curMode = isMode(normalizedMode) ? normalizedMode : undefined
  const isTreeMode =
    treeModeOverride ?? ((curMode ?? 'rule') === 'rule' && !isChainMode)
  const chainWarning = t('proxies.page.chain.warning')

  const exitChainMode = useLockFn(async () => {
    setIsChainMode(false)
    // 保存链式代理按钮状态到 localStorage
    localStorage.setItem('proxy-chain-mode-enabled', 'false')

    // 退出链式代理模式时，清除链式代理配置
    try {
      debugLog('Exiting chain mode, clearing chain configuration')
      await updateProxyChainConfigInRuntime(null)
      debugLog('Chain configuration cleared successfully')
    } catch (error) {
      console.error('Failed to clear chain configuration:', error)
    }
  })

  const onChangeMode = useLockFn(async (mode: Mode) => {
    // 断开连接
    if (mode !== curMode && verge?.auto_close_connection) {
      closeAllConnections()
    }
    try {
      // patchClashMode 在后端 PATCH 失败时会 reject，需提示用户而非静默失败
      await patchClashMode(mode)
      refreshClashConfig()

      // 目录树归入「规则」：切模式后清除手动覆盖，重新由模式决定
      if (mode === 'rule' && isChainMode) await exitChainMode()
      setTreeModeOverride(null)
    } catch (error) {
      showNotice.error(error)
    }
  })

  const onToggleChainMode = useLockFn(async () => {
    if (isChainMode) {
      await exitChainMode()
      return
    }

    setIsChainMode(true)
    localStorage.setItem('proxy-chain-mode-enabled', 'true')
  })

  const setTreeMode = (value: boolean) => {
    setTreeModeOverride(value)
  }

  const onToggleTreeMode = () => {
    const next = !isTreeMode
    setTreeMode(next)
    // 分组树与链式代理互斥，开启树视图时先退出链式模式
    if (next && isChainMode) void onToggleChainMode()
  }

  const onEnableChainMode = () => {
    // 拉链与目录树互斥；退出拉链后回到由模式决定的视图
    setTreeModeOverride(null)
    void onToggleChainMode()
  }

  // 当开启链式代理模式时，获取配置数据
  useEffect(() => {
    if (!isChainMode) {
      updateChainConfigData(null)
      return
    }

    let cancelled = false

    const fetchChainConfig = async () => {
      try {
        const exitNode = localStorage.getItem('proxy-chain-exit-node')

        if (!exitNode) {
          console.error('No proxy chain exit node found in localStorage')
          if (!cancelled) {
            updateChainConfigData('')
          }
          return
        }

        const configData = await getRuntimeProxyChainConfig(exitNode)
        if (!cancelled) {
          updateChainConfigData(configData || '')
        }
      } catch (error) {
        console.error('Failed to get runtime proxy chain config:', error)
        if (!cancelled) {
          updateChainConfigData('')
        }
      }
    }

    fetchChainConfig()

    return () => {
      cancelled = true
    }
  }, [isChainMode, updateChainConfigData])

  useEffect(() => {
    if (normalizedMode && !isMode(normalizedMode)) {
      onChangeMode('rule')
    }
  }, [normalizedMode, onChangeMode])

  return (
    <BasePage
      full
      contentStyle={{ height: '100%' }}
      title={
        isTreeMode ? (
          t('proxies.page.title.tree')
        ) : isChainMode ? (
          <Box
            component="span"
            data-tauri-drag-region="true"
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
          >
            {t('proxies.page.title.chainMode')}
            <TooltipIcon
              title={chainWarning}
              icon={WarningRounded}
              color="warning"
              sx={{ p: 0.25 }}
            />
          </Box>
        ) : (
          t('proxies.page.title.default')
        )
      }
      header={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ProviderButton />

          <ButtonGroup size="small">
            {MODES.map((mode) => (
              <Button
                key={mode}
                variant={mode === curMode ? 'contained' : 'outlined'}
                onClick={() => onChangeMode(mode)}
                sx={{ textTransform: 'capitalize' }}
              >
                {t(`proxies.page.modes.${mode}`)}
              </Button>
            ))}
          </ButtonGroup>

          <Button
            size="small"
            variant={isChainMode ? 'contained' : 'outlined'}
            onClick={onEnableChainMode}
            title={t('proxies.page.title.chainMode')}
            sx={{ ml: 1 }}
            startIcon={
              isChainMode ? (
                <LanRounded fontSize="small" />
              ) : (
                <LanOutlined fontSize="small" />
              )
            }
          >
            {t('proxies.page.actions.toggleChain')}
          </Button>

          <Button
            size="small"
            variant={isTreeMode ? 'contained' : 'outlined'}
            onClick={onToggleTreeMode}
            startIcon={<AccountTreeOutlined fontSize="small" />}
          >
            {t('proxies.page.actions.toggleTree')}
          </Button>
        </Box>
      }
    >
      {isTreeMode ? (
        <ProxyGroupTree />
      ) : (
        <ProxyGroups
          mode={curMode ?? 'rule'}
          isChainMode={isChainMode}
          chainConfigData={chainConfigData}
        />
      )}
    </BasePage>
  )
}

export default ProxyPage
