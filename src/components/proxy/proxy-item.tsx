import { CheckCircleOutlineRounded } from '@mui/icons-material'
import {
  alpha,
  Box,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  styled,
  type SxProps,
  type Theme,
} from '@mui/material'
import { useTranslation } from 'react-i18next'

import NodePulse from '@/assets/image/node-pulse.svg?react'
import { BaseLoading } from '@/components/base'
import { useProxyDelayState } from '@/hooks/use-proxy-delay-state'
import { useProxySpeedState } from '@/hooks/use-proxy-speed-state'
import delayManager from '@/services/delay'
import speedManager from '@/services/speed'

interface Props {
  group: IProxyGroupItem
  proxy: IProxyItem
  selected: boolean
  showType?: boolean
  sx?: SxProps<Theme>
  onClick?: (name: string) => void
}

const Widget = styled(Box)(({ theme: { typography } }) => ({
  padding: '3px 6px',
  fontSize: 14,
  fontFamily: typography.fontFamily,
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1.5,
  whiteSpace: 'nowrap',
  borderRadius: '4px',
}))

const SpeedWidget = styled(Widget)(() => ({
  padding: '0 6px',
}))

// 与分组树右栏卡片的类型标签保持同一套尺寸
const TypeBox = styled('span')(({ theme: { typography, palette } }) => ({
  display: 'inline-block',
  border: '1px solid #ccc',
  borderColor: palette.text.secondary,
  color: palette.text.secondary,
  borderRadius: 4,
  fontSize: 10,
  fontFamily: typography.fontFamily,
  marginRight: '4px',
  padding: '0 4px',
  lineHeight: 1.5,
}))

export const ProxyItem = (props: Props) => {
  const { group, proxy, selected, showType = true, sx, onClick } = props

  const { t } = useTranslation()

  // -1/<=0 为不显示，-2 为 loading
  const { delayValue, isPreset, timeout, onDelay } = useProxyDelayState(
    proxy,
    group.name,
  )
  const { speedValue, onSpeed, testable } = useProxySpeedState(
    proxy,
    group.name,
  )

  return (
    <ListItem sx={sx}>
      <ListItemButton
        dense
        selected={selected}
        onClick={() => onClick?.(proxy.name)}
        sx={[
          { borderRadius: 1 },
          ({ palette: { mode, primary } }) => {
            const bgcolor = mode === 'light' ? '#ffffff' : '#24252f'
            const selectColor = mode === 'light' ? primary.main : primary.light
            const showDelay = delayValue > 0

            return {
              '&:hover .the-check': { display: !showDelay ? 'block' : 'none' },
              '&:hover .the-delay': { display: showDelay ? 'block' : 'none' },
              '&:hover .the-icon': { display: 'none' },
              '&.Mui-selected': {
                width: `calc(100% + 3px)`,
                marginLeft: `-3px`,
                borderLeft: `3px solid ${selectColor}`,
                bgcolor:
                  mode === 'light'
                    ? alpha(primary.main, 0.15)
                    : alpha(primary.main, 0.35),
              },
              backgroundColor: bgcolor,
              marginBottom: '8px',
              minHeight: 56,
              py: 0.5,
            }
          },
        ]}
      >
        <ListItemText
          title={proxy.name}
          secondary={
            <>
              <Box
                sx={{
                  display: 'inline-block',
                  marginRight: '8px',
                  fontSize: '14px',
                  color: 'text.primary',
                }}
              >
                {proxy.name}
                {showType && proxy.now && ` - ${proxy.now}`}
              </Box>
              {showType && !!proxy.provider && (
                <TypeBox>{proxy.provider}</TypeBox>
              )}
              {showType && <TypeBox>{proxy.type}</TypeBox>}
              {showType && proxy.udp && <TypeBox>UDP</TypeBox>}
              {showType && proxy.xudp && <TypeBox>XUDP</TypeBox>}
              {showType && proxy.tfo && <TypeBox>TFO</TypeBox>}
              {showType && proxy.mptcp && <TypeBox>MPTCP</TypeBox>}
              {showType && proxy.smux && <TypeBox>SMUX</TypeBox>}
            </>
          }
        />

        <ListItemIcon
          sx={{
            minWidth: 'auto',
            ml: 0.5,
            flexDirection: 'column',
            alignItems: 'flex-end',
            justifyContent: 'center',
            color: 'primary.main',
            display: isPreset ? 'none' : 'flex',
          }}
        >
          {delayValue === -2 && (
            <Widget>
              <BaseLoading />
            </Widget>
          )}

          {delayValue !== -2 && (
            <Widget
              className="the-check"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onDelay(proxy.provider)
              }}
              sx={({ palette }) => ({
                display: 'none', // hover 时显示
                ':hover': { bgcolor: alpha(palette.primary.main, 0.15) },
              })}
            >
              Check
            </Widget>
          )}

          {delayValue > 0 && (
            // 显示延迟
            <Widget
              className="the-delay"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onDelay(proxy.provider)
              }}
              sx={({ palette }) => ({
                color: delayManager.formatDelayColor(delayValue, timeout),
                ':hover': { bgcolor: alpha(palette.primary.main, 0.15) },
              })}
            >
              {delayManager.formatDelay(delayValue, timeout)}
            </Widget>
          )}

          {delayValue !== -2 && delayValue <= 0 && selected && (
            // 展示已选择的 icon
            <CheckCircleOutlineRounded
              className="the-icon"
              sx={{ fontSize: 16 }}
            />
          )}

          {testable && (
            <SpeedWidget
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void onSpeed()
              }}
              title={t('proxies.page.tooltips.speedTest')}
              sx={{
                cursor: 'pointer',
                color:
                  speedValue === -2
                    ? 'text.secondary'
                    : speedValue === -1
                      ? 'primary.main'
                      : speedManager.formatSpeedColor(speedValue),
                ':hover': { bgcolor: 'action.hover', borderRadius: '4px' },
              }}
            >
              {speedValue === -1 ? (
                // 未测速时和分组树卡片一致，用静态波形代替图标
                <Box
                  component="span"
                  sx={{ display: 'flex', '& svg': { width: 48, height: 20 } }}
                >
                  <NodePulse />
                </Box>
              ) : (
                speedManager.formatSpeed(speedValue, proxy.name)
              )}
            </SpeedWidget>
          )}
        </ListItemIcon>
      </ListItemButton>
    </ListItem>
  )
}
