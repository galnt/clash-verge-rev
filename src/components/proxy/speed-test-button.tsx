import SpeedRounded from '@mui/icons-material/SpeedRounded'
import StopRounded from '@mui/icons-material/StopRounded'
import { IconButton } from '@mui/material'
import { useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import speedManager from '@/services/speed'

interface Props {
  groupName: string
  onCheckSpeed: () => void
}

/** 组级测速按钮：运行中可点击停止，且同时只允许一组测速 */
export const SpeedTestButton = ({ groupName, onCheckSpeed }: Props) => {
  const { t } = useTranslation()

  useEffect(() => {
    void speedManager.hydrate()
  }, [])

  const runningGroup = useSyncExternalStore(
    speedManager.subscribeStatus,
    speedManager.getRunningGroup,
  )
  const running = runningGroup === groupName

  return (
    <IconButton
      size="small"
      color={running ? 'warning' : 'inherit'}
      disabled={runningGroup !== null && !running}
      title={
        running
          ? t('proxies.page.actions.speedTestStop')
          : t('proxies.page.tooltips.speedTest')
      }
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (running) {
          speedManager.cancel()
        } else {
          onCheckSpeed()
        }
      }}
    >
      {running ? (
        <StopRounded fontSize="inherit" />
      ) : (
        <SpeedRounded fontSize="inherit" />
      )}
    </IconButton>
  )
}
