import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core'
import {
  CheckBoxOutlineBlankRounded,
  CheckBoxRounded,
  DragIndicatorRounded,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Box,
  CircularProgress,
  IconButton,
  keyframes,
  LinearProgress,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material'
import { open } from '@tauri-apps/plugin-shell'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import {
  memo,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog } from '@/components/base'
import { getNextUpdateTime, updateProfile } from '@/services/cmds'
import { useLoadingCache, useSetLoadingCache } from '@/services/states'
import type { TranslationKey } from '@/types/generated/i18n-keys'
import { debugLog } from '@/utils/debug'
import parseTraffic from '@/utils/parse-traffic'

import { ProfileBox } from './profile-box'

const round = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`

export interface ProfileItemProps {
  selected: boolean
  activating: boolean
  itemData: IProfileItem
  mutateProfiles: () => Promise<void>
  onSelect: (force: boolean) => void
  onEdit: () => void
  onDelete: () => void
  batchMode?: boolean
  isSelected?: boolean
  onSelectionChange?: () => void
  timerUpdateRevision: number
  completedUpdateRevision: number
  dragHandleRef: (node: HTMLElement | null) => void
  dragHandleAttributes: DraggableAttributes
  dragHandleListeners: DraggableSyntheticListeners
}

const ProfileItemBase = (props: ProfileItemProps) => {
  const {
    selected,
    activating,
    itemData,
    mutateProfiles,
    onSelect,
    onEdit,
    onDelete,
    batchMode,
    isSelected,
    onSelectionChange,
    timerUpdateRevision,
    completedUpdateRevision,
    dragHandleRef,
    dragHandleAttributes,
    dragHandleListeners,
  } = props

  const { t } = useTranslation()
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const loadingCache = useLoadingCache()
  const setLoadingCache = useSetLoadingCache()

  // 新增状态：是否显示下次更新时间
  const [showNextUpdate, setShowNextUpdate] = useState(false)
  const showNextUpdateRef = useRef(false)
  const [nextUpdateTime, setNextUpdateTime] = useState('')
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const setLoading = useCallback(
    (loading: boolean) => {
      setLoadingCache((cache) => {
        const next = new Set(cache)
        if (loading) {
          next.add(itemData.uid)
        } else {
          next.delete(itemData.uid)
        }
        return next
      })
    },
    [itemData.uid, setLoadingCache],
  )

  const { name = 'Profile', extra, updated = 0 } = itemData

  // 获取下次更新时间的函数
  const fetchNextUpdateTimeCallback = useCallback(
    async (forceRefresh = false) => {
      if (
        itemData.option?.update_interval &&
        itemData.option.update_interval > 0
      ) {
        try {
          debugLog(`尝试获取配置 ${itemData.uid} 的下次更新时间`)

          // 如果需要强制刷新，先触发Timer.refresh()
          if (forceRefresh) {
            // 这里可以通过一个新的API来触发刷新，但目前我们依赖patch_profile中的刷新
            debugLog(`强制刷新定时器任务`)
          }

          const nextUpdate = await getNextUpdateTime(itemData.uid)
          debugLog(`获取到下次更新时间结果:`, nextUpdate)

          if (nextUpdate) {
            const nextUpdateDate = dayjs(nextUpdate * 1000)
            const now = dayjs()

            // 如果已经过期，显示"更新失败"
            if (nextUpdateDate.isBefore(now)) {
              setNextUpdateTime(
                t('profiles.components.profileItem.status.lastUpdateFailed'),
              )
            } else {
              // 否则显示剩余时间
              const diffMinutes = nextUpdateDate.diff(now, 'minute')

              if (diffMinutes < 60) {
                if (diffMinutes <= 0) {
                  setNextUpdateTime(
                    `${t('profiles.components.profileItem.status.nextUp')} <1m`,
                  )
                } else {
                  setNextUpdateTime(
                    `${t('profiles.components.profileItem.status.nextUp')} ${diffMinutes}m`,
                  )
                }
              } else {
                const hours = Math.floor(diffMinutes / 60)
                const mins = diffMinutes % 60
                setNextUpdateTime(
                  `${t('profiles.components.profileItem.status.nextUp')} ${hours}h ${mins}m`,
                )
              }
            }
          } else {
            debugLog(`返回的下次更新时间为空`)
            setNextUpdateTime(
              t('profiles.components.profileItem.status.noSchedule'),
            )
          }
        } catch (err) {
          console.error(`获取下次更新时间出错:`, err)
          setNextUpdateTime(t('profiles.components.profileItem.status.unknown'))
        }
      } else {
        debugLog(`该配置未设置更新间隔或间隔为0`)
        setNextUpdateTime(
          t('profiles.components.profileItem.status.autoUpdateDisabled'),
        )
      }
    },
    [itemData.option?.update_interval, itemData.uid, t],
  )
  const fetchNextUpdateTime = useLockFn(fetchNextUpdateTimeCallback)

  // 切换显示模式的函数
  const toggleUpdateTimeDisplay = (e: React.MouseEvent) => {
    e.stopPropagation()

    if (!showNextUpdate) {
      fetchNextUpdateTime()
    }

    setShowNextUpdate(!showNextUpdate)
  }

  useEffect(() => {
    showNextUpdateRef.current = showNextUpdate
  }, [showNextUpdate])

  // 当组件加载或更新间隔变化时更新下次更新时间
  useEffect(() => {
    if (showNextUpdate) {
      fetchNextUpdateTime()
    }
  }, [
    fetchNextUpdateTime,
    showNextUpdate,
    itemData.option?.update_interval,
    updated,
  ])

  // 页面统一订阅定时器事件，这里只响应当前配置的更新信号
  useEffect(() => {
    if (timerUpdateRevision === 0 || !showNextUpdateRef.current) return

    if (refreshTimeoutRef.current !== undefined) {
      clearTimeout(refreshTimeoutRef.current)
    }
    refreshTimeoutRef.current = window.setTimeout(() => {
      fetchNextUpdateTime(true)
    }, 1000)

    return () => {
      if (refreshTimeoutRef.current !== undefined) {
        clearTimeout(refreshTimeoutRef.current)
      }
    }
  }, [fetchNextUpdateTime, timerUpdateRevision])

  useEffect(() => {
    if (completedUpdateRevision === 0 || !showNextUpdateRef.current) return
    fetchNextUpdateTime()
  }, [completedUpdateRevision, fetchNextUpdateTime])

  // local file mode
  // remote file mode
  // remote file mode
  const hasUrl = !!itemData.url
  const hasExtra = !!extra // only subscription url has extra info
  const hasHome = !!itemData.home // only subscription url has home page

  const { upload = 0, download = 0, total = 0 } = extra ?? {}
  const from = parseUrl(itemData.url)
  const description = itemData.desc
  const expire = parseExpire(extra?.expire)
  const progress = Math.min(
    Math.round(((download + upload) * 100) / (total + 0.01)) + 1,
    100,
  )

  const loading = loadingCache.has(itemData.uid)

  // interval update fromNow field
  const [, forceRefresh] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    if (!hasUrl) return

    let timer: ReturnType<typeof setTimeout> | undefined

    const handler = () => {
      const now = Date.now()
      const lastUpdate = updated * 1000
      // 大于一天的不管
      if (now - lastUpdate >= 24 * 36e5) return

      const wait = now - lastUpdate >= 36e5 ? 30e5 : 5e4

      timer = setTimeout(() => {
        forceRefresh()
        handler()
      }, wait)
    }

    handler()

    return () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    }
  }, [forceRefresh, hasUrl, updated])

  const [confirmOpen, setConfirmOpen] = useState(false)

  const onOpenHome = () => {
    setAnchorEl(null)
    open(itemData.home ?? '')
  }

  const onEditInfo = () => {
    setAnchorEl(null)
    onEdit()
  }

  const onForceSelect = () => {
    setAnchorEl(null)
    onSelect(true)
  }

  /// 0 不使用任何代理
  /// 1 使用订阅好的代理
  /// 2 至少使用一个代理，根据订阅，如果没订阅，默认使用系统代理
  const onUpdate = useLockFn(async (type: 0 | 1 | 2): Promise<void> => {
    setAnchorEl(null)
    setLoading(true)

    // 根据类型设置初始更新选项
    const option: Partial<IProfileOption> = {}
    if (type === 0) {
      option.with_proxy = false
      option.self_proxy = false
    } else if (type === 2) {
      if (itemData.option?.self_proxy) {
        option.with_proxy = false
        option.self_proxy = true
      } else {
        option.with_proxy = true
        option.self_proxy = false
      }
    }

    try {
      // 调用后端更新（后端会自动处理回退逻辑）
      const payload = Object.keys(option).length > 0 ? option : undefined
      await updateProfile(itemData.uid, payload)

      // 更新成功，刷新列表
      void mutateProfiles()
    } catch {
      // 更新完全失败（包括后端的回退尝试）
      // 不需要做处理，后端会通过事件通知系统发送错误
    } finally {
      setLoading(false)
    }
  })

  type ContextMenuItem = {
    label: string
    handler: () => void
    disabled: boolean
  }

  const menuLabels: Record<string, TranslationKey> = {
    home: 'profiles.components.menu.home',
    select: 'profiles.components.menu.select',
    editInfo: 'profiles.components.menu.editInfo',
    update: 'profiles.components.menu.update',
    updateViaProxy: 'profiles.components.menu.updateViaProxy',
    delete: 'shared.actions.delete',
  } as const

  const urlModeMenu: ContextMenuItem[] = [
    ...(hasHome
      ? [
          {
            label: menuLabels.home,
            handler: onOpenHome,
            disabled: false,
          } satisfies ContextMenuItem,
        ]
      : []),
    {
      label: menuLabels.select,
      handler: onForceSelect,
      disabled: false,
    },
    {
      label: menuLabels.editInfo,
      handler: onEditInfo,
      disabled: false,
    },
    {
      label: menuLabels.update,
      handler: () => onUpdate(0),
      disabled: false,
    },
    {
      label: menuLabels.updateViaProxy,
      handler: () => onUpdate(2),
      disabled: false,
    },
    {
      label: menuLabels.delete,
      handler: () => {
        setAnchorEl(null)
        if (batchMode) {
          // If in batch mode, just toggle selection instead of showing delete confirmation
          if (onSelectionChange) {
            onSelectionChange()
          }
        } else {
          setConfirmOpen(true)
        }
      },
      disabled: false,
    },
  ]
  const fileModeMenu: ContextMenuItem[] = [
    {
      label: menuLabels.select,
      handler: onForceSelect,
      disabled: false,
    },
    {
      label: menuLabels.editInfo,
      handler: onEditInfo,
      disabled: false,
    },
    {
      label: menuLabels.delete,
      handler: () => {
        setAnchorEl(null)
        if (batchMode) {
          // If in batch mode, just toggle selection instead of showing delete confirmation
          if (onSelectionChange) {
            onSelectionChange()
          }
        } else {
          setConfirmOpen(true)
        }
      },
      disabled: false,
    },
  ]

  const boxStyle = {
    height: 26,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  }

  return (
    <Box sx={{ position: 'relative' }}>
      <ProfileBox
        aria-selected={selected}
        onClick={(e) => {
          // 如果正在激活中，阻止重复点击
          if (activating) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          onSelect(false)
        }}
        onContextMenu={(event) => {
          const { clientX, clientY } = event
          setPosition({ top: clientY, left: clientX })
          setAnchorEl(event.currentTarget as HTMLElement)
          event.preventDefault()
        }}
      >
        {activating && (
          <Box
            sx={{
              position: 'absolute',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              top: 10,
              left: 10,
              right: 10,
              bottom: 2,
              zIndex: 10,
              backdropFilter: 'blur(2px)',
              backgroundColor: 'rgba(0, 0, 0, 0.1)',
            }}
          >
            <CircularProgress
              color="inherit"
              size={20}
              sx={{
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          </Box>
        )}
        <Box sx={{ position: 'relative' }}>
          <Box sx={{ display: 'flex', justifyContent: 'start' }}>
            {batchMode && (
              <IconButton
                size="small"
                sx={{ padding: '2px', marginRight: '4px', marginLeft: '-8px' }}
                onClick={(e) => {
                  e.stopPropagation()
                  if (onSelectionChange) {
                    onSelectionChange()
                  }
                }}
              >
                {isSelected ? (
                  <CheckBoxRounded color="primary" />
                ) : (
                  <CheckBoxOutlineBlankRounded />
                )}
              </IconButton>
            )}
            <Box
              ref={dragHandleRef}
              sx={{
                display: 'flex',
                margin: 'auto 0',
                ...(batchMode && { marginLeft: '-4px' }),
              }}
              {...dragHandleAttributes}
              {...dragHandleListeners}
            >
              <DragIndicatorRounded
                sx={[
                  { cursor: 'move', marginLeft: '-6px' },
                  ({ palette: { text } }) => {
                    return { color: text.primary }
                  },
                ]}
              />
            </Box>

            <Typography
              sx={{
                width: batchMode ? 'calc(100% - 56px)' : 'calc(100% - 36px)',
                fontSize: '18px',
                fontWeight: '600',
                lineHeight: '26px',
              }}
              variant="h6"
              component="h2"
              noWrap
              title={name}
            >
              {name}
            </Typography>
          </Box>

          {/* only if has url can it be updated */}
          {hasUrl && (
            <IconButton
              title={t('shared.actions.refresh')}
              sx={{
                position: 'absolute',
                p: '3px',
                top: -1,
                right: -5,
                animation: loading ? `1s linear infinite ${round}` : 'none',
              }}
              size="small"
              color="inherit"
              disabled={loading}
              onClick={(e) => {
                e.stopPropagation()
                // 如果正在激活或加载中，阻止更新操作
                if (activating || loading) {
                  return
                }
                onUpdate(1)
              }}
            >
              <RefreshRounded color="inherit" />
            </IconButton>
          )}
        </Box>
        {/* the second line show url's info or description */}
        <Box sx={boxStyle}>
          {
            <>
              {description ? (
                <Typography
                  noWrap
                  title={description}
                  sx={{ fontSize: '14px' }}
                >
                  {description}
                </Typography>
              ) : (
                hasUrl && (
                  <Typography
                    noWrap
                    title={`${t('shared.labels.from')} ${from}`}
                  >
                    {from}
                  </Typography>
                )
              )}
              {hasUrl && (
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    ml: 'auto',
                  }}
                >
                  <Typography
                    noWrap
                    component="span"
                    title={
                      showNextUpdate
                        ? t('profiles.components.profileItem.tooltips.showLast')
                        : `${t('shared.labels.updateTime')}: ${parseExpire(updated)}\n${t('profiles.components.profileItem.tooltips.showNext')}`
                    }
                    sx={{
                      fontSize: 14,
                      textAlign: 'right',
                      cursor: 'pointer',
                      display: 'inline-block',
                      borderBottom: '1px dashed transparent',
                      transition: 'all 0.2s',
                      '&:hover': {
                        borderBottomColor: 'primary.main',
                        color: 'primary.main',
                      },
                    }}
                    onClick={toggleUpdateTimeDisplay}
                  >
                    {showNextUpdate
                      ? nextUpdateTime
                      : updated > 0
                        ? dayjs(updated * 1000).fromNow()
                        : ''}
                  </Typography>
                </Box>
              )}
            </>
          }
        </Box>
        {/* the third line show extra info or last updated time */}
        {hasExtra ? (
          <Box sx={{ ...boxStyle, fontSize: 14 }}>
            <span title={t('shared.labels.usedTotal')}>
              {parseTraffic(upload + download)} / {parseTraffic(total)}
            </span>
            <span title={t('shared.labels.expireTime')}>{expire}</span>
          </Box>
        ) : (
          <Box sx={{ ...boxStyle, fontSize: 12, justifyContent: 'flex-end' }}>
            <span title={t('shared.labels.updateTime')}>
              {parseExpire(updated)}
            </span>
          </Box>
        )}
        <LinearProgress
          variant="determinate"
          value={progress}
          style={{ opacity: total > 0 ? 1 : 0 }}
        />
      </ProfileBox>

      <Menu
        open={!!anchorEl}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorPosition={position}
        anchorReference="anchorPosition"
        transitionDuration={225}
        slotProps={{ list: { sx: { py: 0.5 } } }}
        onContextMenu={(e) => {
          setAnchorEl(null)
          e.preventDefault()
        }}
      >
        {(hasUrl ? urlModeMenu : fileModeMenu).map((item) => (
          <MenuItem
            key={item.label}
            onClick={item.handler}
            disabled={item.disabled}
            sx={[
              {
                minWidth: 120,
              },
              (theme) => {
                return {
                  color:
                    item.label === menuLabels.delete
                      ? theme.palette.error.main
                      : undefined,
                }
              },
            ]}
            dense
          >
            {t(item.label)}
          </MenuItem>
        ))}
      </Menu>

      <BaseDialog
        title={t('profiles.modals.confirmDelete.title')}
        open={confirmOpen}
        okBtn={t('shared.actions.confirm')}
        cancelBtn={t('shared.actions.cancel')}
        contentSx={{ width: { xs: 320, sm: 420 }, userSelect: 'text' }}
        onCancel={() => setConfirmOpen(false)}
        onClose={() => setConfirmOpen(false)}
        onOk={() => {
          onDelete()
          setConfirmOpen(false)
        }}
      >
        <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
          {t('profiles.modals.confirmDelete.message')}
        </Typography>
      </BaseDialog>
    </Box>
  )
}

export const ProfileItem = memo(ProfileItemBase)

function parseUrl(url?: string) {
  if (!url) return ''
  const regex = /https?:\/\/(.+?)\//
  const result = url.match(regex)
  return result ? result[1] : 'local file'
}

function parseExpire(expire?: number) {
  if (!expire) return '-'
  return dayjs(expire * 1000).format('YYYY-MM-DD')
}
