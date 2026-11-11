import {
  AccountTreeOutlined,
  ExpandLessRounded,
  ExpandMoreRounded,
  NetworkCheckRounded,
  RefreshRounded,
  SortRounded,
  SpeedRounded,
} from '@mui/icons-material'
import {
  alpha,
  Alert,
  Box,
  Button,
  ButtonBase,
  ButtonGroup,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { delayGroup } from 'tauri-plugin-mihomo-api'

import NodePulse from '@/assets/image/node-pulse.svg?react'
import { formatConnectionTraffic } from '@/components/connection/connection-row-view'
import {
  getConnectionSnapshot,
  subscribeConnectionData,
} from '@/hooks/use-connection-data'
import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import {
  useAppRefreshers,
  useProxiesData,
  useRulesData,
} from '@/providers/app-data-context'
import {
  calcuProxies,
  getProfiles,
  getRuntimeYaml,
  readProfileFile,
} from '@/services/cmds'
import delayManager from '@/services/delay'
import { showNotice } from '@/services/notice-service'
import { useQuery } from '@/services/query-client'
import speedManager from '@/services/speed'
import {
  publishProxySelection,
  useSetSharedProxySelection,
  useSharedProxySelection,
} from '@/services/states'
import { resolveProxyColor } from '@/utils/proxy-color'

import { parseGroupTree } from './parse-group-tree'
import {
  buildTreeLayout,
  fitColumns,
  NODE_RADIUS,
  topPath,
  type LayoutNode,
  type ProxySection,
} from './proxy-group-tree-layout'
import { ProxyItemMini } from './proxy-item-mini'
import { filterSort, type ProxySortType } from './use-filter-sort'

type SourceKind = 'profile' | 'runtime'

interface Selection {
  kind: 'group' | 'proxy'
  name: string
  key?: string
  groupType?: string
  memberCount?: number
  now?: string
  type?: string
  server?: string
  delay?: number
}

interface Transform {
  x: number
  y: number
  scale: number
}

const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1 }

/**
 * 首帧按窗口宽度估算栏宽：固定 1280 窗口下右栏约 620，
 * 代入 fitColumns 正好是 3 列，避免用 420 占位值算出 2 列。
 */
const estimatePaneWidth = () =>
  Math.max(420, Math.min(620, Math.floor(window.innerWidth / 2)))

/** 滚轮上下滚动的回弹余量 */
const SCROLL_SLACK = 40

const formatSpeedLabel = (value: number) =>
  value > 0 ? `${formatConnectionTraffic(value)}/s` : '0'

const SORT_TOOLTIP_KEYS = [
  'proxies.page.tooltips.sortDefault',
  'proxies.page.tooltips.sortDelay',
  'proxies.page.tooltips.sortName',
] as const

const NameChips = ({ names }: { names: string[] }) => (
  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
    {names.length ? (
      names.map((name) => (
        <Chip
          key={name}
          size="small"
          label={name}
          title={name}
          sx={{
            maxWidth: 260,
            '& .MuiChip-label': {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          }}
        />
      ))
    ) : (
      <Typography variant="caption" color="text.secondary">
        —
      </Typography>
    )}
  </Box>
)

const GroupDot = ({
  node,
  isRoot = false,
  selected,
  active,
  nodeWidth,
  now,
  onClick,
  onToggle,
}: {
  node: LayoutNode
  isRoot?: boolean
  selected: boolean
  active: boolean
  nodeWidth: number
  /** 运行时该组当前生效的节点，和代理页组标签的 group.now 一致 */
  now?: string
  onClick: (node: LayoutNode) => void
  /** 点击角标展开/收起该组：只影响左栏，不改变右栏 */
  onToggle?: (node: LayoutNode) => void
}) => {
  const theme = useTheme()
  const { t } = useTranslation()
  const isLight = theme.palette.mode === 'light'
  // 与规则页同一套取色逻辑：同名节点颜色一致
  const color = isRoot
    ? theme.palette.primary.main
    : resolveProxyColor(theme, node.name)

  return (
    <Tooltip
      title={`${node.name}${node.groupType ? ` · ${node.groupType}` : ''} · ${now || '—'} · ${node.memberCount}${active ? ` · ${t('proxies.page.tree.current')}` : ''}`}
      arrow
    >
      <ButtonBase
        onClick={() => onClick(node)}
        onPointerDown={(event) => event.stopPropagation()}
        sx={{
          position: 'absolute',
          left: node.x,
          top: node.y,
          transform: 'translate(-50%, -50%)',
          zIndex: 2,
          width: nodeWidth,
          height: NODE_RADIUS * 2,
          px: 1,
          py: 0.75,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '2px',
          borderRadius: 2,
          color: selected ? '#fff' : color,
          backgroundColor: selected
            ? color
            : alpha(color, isLight ? 0.12 : 0.22),
          backgroundImage: selected
            ? `linear-gradient(160deg, ${alpha(theme.palette.common.white, 0.28)}, transparent 70%)`
            : 'none',
          border: `1px solid ${alpha(color, selected ? 0.9 : 0.5)}`,
          outline: active ? `2px dashed ${theme.palette.success.main}` : 'none',
          outlineOffset: 3,
          boxShadow: selected
            ? `0 0 12px ${alpha(color, 0.7)}`
            : `0 2px 6px ${alpha(theme.palette.common.black, 0.2)}`,
        }}
      >
        {!isRoot && (
          <Box
            component="span"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={
              onToggle && node.childGroupCount > 0
                ? (event) => {
                    // 只切换左栏展开层级，不触发节点的选中/右栏切换
                    event.stopPropagation()
                    onToggle(node)
                  }
                : undefined
            }
            sx={{
              position: 'absolute',
              top: 2,
              right: 4,
              px: '3px',
              borderRadius: '3px',
              fontSize: 9,
              lineHeight: 1.4,
              opacity: node.childGroupCount > 0 ? 0.9 : 0.4,
              cursor: node.childGroupCount > 0 ? 'pointer' : 'default',
              '&:hover':
                node.childGroupCount > 0
                  ? { backgroundColor: alpha(color, 0.2) }
                  : undefined,
            }}
          >
            {node.expanded ? '▼' : '▶'}
          </Box>
        )}
        <Box
          component="span"
          sx={{
            position: 'absolute',
            top: 3,
            left: 6,
            fontSize: 9,
            lineHeight: 1,
            opacity: 0.7,
          }}
        >
          {node.memberCount}
        </Box>

        {/* 上：组名称 */}
        <Typography
          component="span"
          noWrap
          sx={{
            width: '100%',
            textAlign: 'center',
            fontSize: 13,
            lineHeight: 1.2,
            fontWeight: 700,
          }}
        >
          {isRoot ? `★ ${node.name}` : node.name}
        </Typography>

        {/* 下：类型徽章 + 当前生效节点，参考代理页组标签 */}
        <Box
          component="span"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.5,
            width: '100%',
            minWidth: 0,
          }}
        >
          {node.groupType && (
            <Box
              component="span"
              sx={{
                flexShrink: 0,
                px: '3px',
                fontSize: 9,
                lineHeight: 1.5,
                borderRadius: '3px',
                border: `1px solid ${alpha(color, selected ? 0.8 : 0.45)}`,
                color: selected ? '#fff' : alpha(color, 0.9),
              }}
            >
              {node.groupType}
            </Box>
          )}
          <Typography
            component="span"
            noWrap
            title={now}
            sx={{
              minWidth: 0,
              fontSize: 11,
              lineHeight: 1.3,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: selected ? 'rgba(255,255,255,0.9)' : 'text.secondary',
            }}
          >
            {now || '—'}
          </Typography>
        </Box>
      </ButtonBase>
    </Tooltip>
  )
}

export const ProxyGroupTree = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const { proxies } = useProxiesData()
  const { rules } = useRulesData()
  const { refreshProxy } = useAppRefreshers()
  const { verge } = useVerge()
  const sharedSelection = useSharedProxySelection()
  const setSharedSelection = useSetSharedProxySelection()

  // 逐级写回父组选中，全部成功后再广播：避免内核没切过去时树/首页先乐观显示
  const pendingSelectionRef = useRef<{
    group: string
    proxy: string
    remaining: number
  } | null>(null)

  const { changeProxy } = useProxySelection({
    onSuccess: () => {
      const pending = pendingSelectionRef.current
      if (pending) {
        pending.remaining -= 1
        if (pending.remaining <= 0) {
          pendingSelectionRef.current = null
          publishProxySelection(
            setSharedSelection,
            pending.group,
            pending.proxy,
            'tree',
          )
        }
      }
      void refreshProxy()
    },
    onError: (error) => {
      pendingSelectionRef.current = null
      showNotice.error(error)
    },
  })

  const [source, setSource] = useState<SourceKind>('profile')
  const [pathKeys, setPathKeys] = useState<string[]>(() => [])
  // 右栏固定展示的组：点击左栏组时只改这里，左栏的层级与展开状态不动
  const [focusGroup, setFocusGroup] = useState<{
    name: string
    pathNames: string[]
  } | null>(null)
  const [showCheck, setShowCheck] = useState(false)
  const [transform, setTransform] = useState<Transform>(DEFAULT_TRANSFORM)
  const [dragging, setDragging] = useState(false)
  const [width, setWidth] = useState(estimatePaneWidth)
  const [rightWidth, setRightWidth] = useState(estimatePaneWidth)
  const [sortTypes, setSortTypes] = useState<Record<string, ProxySortType>>({})
  const [collapsedSections, setCollapsedSections] = useState<
    Record<string, boolean>
  >({})
  const [busySection, setBusySection] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const leftRef = useRef<HTMLDivElement | null>(null)
  const rightRef = useRef<HTMLDivElement | null>(null)
  const sectionElsRef = useRef<Record<string, HTMLElement | null>>({})
  const lineElsRef = useRef<Record<string, SVGPathElement | null>>({})
  const nodeLineElsRef = useRef<Record<string, SVGPathElement | null>>({})
  const headerTagRef = useRef<Record<string, HTMLElement | null>>({})
  const cardElsRef = useRef<Record<string, HTMLElement | null>>({})
  const speedTextElsRef = useRef<Record<string, SVGTextElement | null>>({})
  const speedBgElsRef = useRef<Record<string, SVGRectElement | null>>({})
  const dragRef = useRef<{
    x: number
    y: number
    tx: number
    ty: number
    moved: boolean
  } | null>(null)

  useQuery({
    queryKey: ['getProxies'],
    queryFn: calcuProxies,
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    staleTime: 1500,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const {
    data: yamlText,
    isPending,
    error,
    refetch,
  } = useQuery<string>({
    queryKey: ['proxyGroupTreeYaml', source],
    queryFn: async () => {
      if (source === 'runtime') return (await getRuntimeYaml()) ?? ''
      const profiles = await getProfiles()
      if (!profiles.current) return (await getRuntimeYaml()) ?? ''
      return readProfileFile(profiles.current)
    },
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const tree = useMemo(() => parseGroupTree(yamlText ?? ''), [yamlText])

  const runtimeGroups = useMemo<Map<string, IProxyGroupItem>>(
    () =>
      new Map((proxies?.groups ?? []).map((g: IProxyGroupItem) => [g.name, g])),
    [proxies],
  )
  const records = useMemo<Record<string, IProxyItem>>(
    () => proxies?.records ?? {},
    [proxies],
  )

  const membersOf = useCallback(
    (name: string) => {
      const list = [...new Set(tree.definitions[name]?.members ?? [])]
      for (const item of runtimeGroups.get(name)?.all ?? []) {
        if (item?.name && !list.includes(item.name)) list.push(item.name)
      }
      return list
    },
    [tree, runtimeGroups],
  )

  const isGroup = useCallback(
    (name: string) => !!tree.definitions[name] || runtimeGroups.has(name),
    [tree, runtimeGroups],
  )

  const groupTypeOf = useCallback(
    (name: string) =>
      runtimeGroups.get(name)?.type || tree.definitions[name]?.type || '',
    [tree, runtimeGroups],
  )

  // 沿「根 → … → 直接父组」逐级写回，最后把目标组/节点设为父组的 now
  const selectChain = useCallback(
    (
      chain: string[],
      owner: string,
      proxyName: string,
      publish: { group: string; proxy: string },
    ) => {
      const targets: Array<{ group: string; proxy: string }> = []
      for (let i = 0; i < chain.length - 1; i += 1) {
        const group = chain[i]
        const proxy = chain[i + 1]
        if (!group || !proxy || group === proxy) continue
        if (runtimeGroups.get(group)?.now === proxy) continue
        targets.push({ group, proxy })
      }
      if (runtimeGroups.get(owner)?.now !== proxyName) {
        targets.push({ group: owner, proxy: proxyName })
      }

      if (targets.length === 0) {
        publishProxySelection(
          setSharedSelection,
          publish.group,
          publish.proxy,
          'tree',
        )
        return
      }

      pendingSelectionRef.current = {
        group: publish.group,
        proxy: publish.proxy,
        remaining: targets.length,
      }
      for (const target of targets) {
        changeProxy(
          target.group,
          target.proxy,
          runtimeGroups.get(target.group)?.now,
        )
      }
    },
    [runtimeGroups, changeProxy, setSharedSelection],
  )

  // 运行时规则里的 MATCH 目标优先于 YAML 文本，规则改动会即时反映到树
  const matchPolicy = useMemo(() => {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index]
      if (rule?.type?.toUpperCase() === 'MATCH') return rule.proxy ?? ''
    }
    return ''
  }, [rules])
  const rootName = matchPolicy || tree.root

  // 当前生效的选择：根节点是 MATCH 目标组，第一层是它的子组，
  // 再沿每个子组的 now 下钻到实体节点。
  const activeChain = useMemo(() => {
    const keys: string[] = []
    const names: string[] = [rootName]
    const visited = new Set<string>([rootName])
    let current = runtimeGroups.get(rootName)?.now ?? ''
    let parentKey = ''

    while (current && isGroup(current) && !visited.has(current)) {
      const key = parentKey
        ? `${parentKey}/${encodeURIComponent(current)}`
        : topPath(current)
      keys.push(key)
      names.push(current)
      visited.add(current)

      const now = runtimeGroups.get(current)?.now ?? ''
      if (!now || !isGroup(now)) {
        return { keys, names, proxy: now }
      }
      parentKey = key
      current = now
    }

    return { keys, names, proxy: '' }
  }, [rootName, runtimeGroups, isGroup])

  const defaultPathKeys = useMemo(() => {
    if (activeChain.keys.length) return activeChain.keys
    const firstChild = membersOf(rootName).find(
      (name) => name !== rootName && isGroup(name),
    )
    return firstChild ? [topPath(firstChild)] : []
  }, [activeChain.keys, rootName, membersOf, isGroup])

  // 左栏的展开层级只由本地状态决定（首次按当前生效链展开一次），
  // 之后点击组只切换右栏内容，不再因为选择变化而重排左侧。
  const pathKeysInitializedRef = useRef(false)
  if (!pathKeysInitializedRef.current && defaultPathKeys.length) {
    // 树数据是异步来的：首次拿到生效链时同步展开，之后不再跟随选择变化
    pathKeysInitializedRef.current = true
    setPathKeys(defaultPathKeys)
  }

  const effectivePathKeys = pathKeys
  const activeKeys = useMemo(
    () => new Set(activeChain.keys),
    [activeChain.keys],
  )

  // 组节点下方展示的「当前节点」：优先运行时 now，刚切换还没刷新时用共享选择兜底
  const nowOf = (name: string) =>
    runtimeGroups.get(name)?.now ||
    (sharedSelection.group === name ? sharedSelection.proxy : '') ||
    ''

  // 树内的"选中"完全由共享状态/运行时生效链派生，任意视图改动都会同步
  const selection = useMemo<Selection | null>(() => {
    const { group, proxy } = sharedSelection
    const detail = tree.proxyDetails[proxy]
    const record = records[proxy]
    const server = detail?.server
      ? `${detail.server}${detail.port ? `:${detail.port}` : ''}`
      : ''

    // 首页切换组时 now 可能仍是子组名，此时按"组"展示而不是当成节点
    const proxyIsGroup = !!tree.definitions[proxy]
    if (group && proxy && !proxyIsGroup) {
      return {
        kind: 'proxy',
        name: proxy,
        key: group,
        type: record?.type || detail?.type || '—',
        server,
        delay: record?.history?.at(-1)?.delay,
      }
    }
    if (group) {
      const runtime = runtimeGroups.get(group)
      return {
        kind: 'group',
        name: group,
        key: group,
        groupType: runtime?.type || tree.definitions[group]?.type || '',
        memberCount:
          runtime?.all?.length ?? tree.definitions[group]?.members.length ?? 0,
        now: runtime?.now,
      }
    }

    const activeProxy = activeChain.proxy
    if (!activeProxy) return null
    const activeDetail = tree.proxyDetails[activeProxy]
    const activeRecord = records[activeProxy]
    const activeServer = activeDetail?.server
      ? `${activeDetail.server}${activeDetail.port ? `:${activeDetail.port}` : ''}`
      : ''
    return {
      kind: 'proxy',
      name: activeProxy,
      type: activeRecord?.type || activeDetail?.type || '—',
      server: activeServer,
      delay: activeRecord?.history?.at(-1)?.delay,
    }
  }, [sharedSelection, tree, records, runtimeGroups, activeChain])

  // 唯一的"当前选择"：顶部、状态卡、树内高亮共用，树里选中即改变它
  const currentChainText = useMemo(() => {
    if (selection?.kind === 'proxy') {
      const group = selection.key || activeChain.names.at(-1) || ''
      return [group, selection.name].filter(Boolean).join(' → ')
    }
    if (selection?.kind === 'group') {
      return [selection.name, selection.now].filter(Boolean).join(' → ')
    }
    return (
      [...activeChain.names, activeChain.proxy].filter(Boolean).join(' → ') ||
      '—'
    )
  }, [selection, activeChain])

  // 左右两栏共用同一个列数与块宽：以较窄的右栏为准
  const { columns, nodeW } = useMemo(
    () => fitColumns(rightWidth, 4),
    [rightWidth],
  )

  const layout = useMemo(
    () =>
      buildTreeLayout({
        tree,
        rootName,
        pathKeys: effectivePathKeys,
        width,
        maxCols: columns,
        nodeW,
        membersOf,
        isGroup,
        groupTypeOf,
        focus: focusGroup ?? undefined,
      }),
    [
      tree,
      rootName,
      effectivePathKeys,
      width,
      columns,
      nodeW,
      membersOf,
      isGroup,
      groupTypeOf,
      focusGroup,
    ],
  )

  // 树数据是异步加载的，左右栏 DOM 就绪后需要重新挂观察器
  const hasTree = tree.groupNames.length > 0

  useLayoutEffect(() => {
    const left = leftRef.current
    const right = rightRef.current
    if (!left) return
    const measure = () => {
      setWidth(left.clientWidth)
      if (right) setRightWidth(right.clientWidth)
    }
    // observe 后的首次回调会在本帧绘制前送达，首帧宽度已由 estimatePaneWidth 保证
    const observer = new ResizeObserver(measure)
    observer.observe(left)
    if (right) observer.observe(right)
    return () => observer.disconnect()
  }, [hasTree])

  // 实时速率：按连接链里的出口节点（非分组名）汇总。
  // 连接快照每 500ms 一次，但树里只有分组连线上的速率文字用到它，
  // 所以这里不进 React state，直接算进 ref 再命令式写 SVG，
  // 避免成百上千个节点卡片刻意跟着重渲染。
  const pageVisible = useVisibility()
  const sectionSpeedsRef = useRef(
    new Map<string, { up: number; down: number }>(),
  )

  const computeSectionSpeeds = useCallback(() => {
    const byProxy = new Map<string, { up: number; down: number }>()
    for (const connection of getConnectionSnapshot().activeConnections) {
      const chain = connection.chains ?? []
      const proxy = chain.find((name) => !isGroup(name)) ?? chain[0]
      if (!proxy) continue
      const speed = byProxy.get(proxy) ?? { up: 0, down: 0 }
      speed.up += connection.curUpload ?? 0
      speed.down += connection.curDownload ?? 0
      byProxy.set(proxy, speed)
    }

    const bySection = new Map<string, { up: number; down: number }>()
    for (const section of layout.sections) {
      let up = 0
      let down = 0
      for (const name of section.proxies) {
        const speed = byProxy.get(name)
        if (!speed) continue
        up += speed.up
        down += speed.down
      }
      bySection.set(section.groupKey, { up, down })
    }

    sectionSpeedsRef.current = bySection
  }, [isGroup, layout.sections])

  // 该分组当前使用（或选中的）实体节点名，用于多画一条连到卡片的线
  const sectionTargetName = useCallback(
    (section: ProxySection) => {
      const now = runtimeGroups.get(section.groupName)?.now
      if (now && section.proxies.includes(now)) return now
      if (
        selection?.kind === 'proxy' &&
        section.proxies.includes(selection.name)
      ) {
        return selection.name
      }
      return ''
    },
    [runtimeGroups, selection],
  )

  const updateCrossLines = useCallback(() => {
    const container = containerRef.current
    const left = leftRef.current
    if (!container || !left) return

    const cr = container.getBoundingClientRect()
    const lr = left.getBoundingClientRect()

    for (const section of layout.sections) {
      const node = layout.nodeByKey.get(section.groupKey)
      const header = sectionElsRef.current[section.groupKey]
      const path = lineElsRef.current[section.groupKey]
      if (!node || !header || !path) continue

      const r = header.getBoundingClientRect()
      const x1 = lr.left - cr.left + transform.x + node.x * transform.scale
      const y1 = lr.top - cr.top + transform.y + node.y * transform.scale
      // 状态栏吸顶时用了负外边距铺满右栏，这里补回原来的左右内边距
      const x2 = r.left - cr.left + 14
      const y2 = r.top - cr.top + r.height / 2
      const highlight =
        selection?.kind === 'proxy' && section.proxies.includes(selection.name)

      path.setAttribute(
        'd',
        `M${x1},${y1} C${x1 + 80},${y1} ${x2 - 80},${y2} ${x2},${y2}`,
      )
      path.setAttribute(
        'stroke',
        highlight ? theme.palette.info.main : theme.palette.text.disabled,
      )
      path.setAttribute('stroke-width', highlight ? '2' : '1')
      path.setAttribute('opacity', highlight ? '0.9' : '0.45')

      // 速率文字画在同一条 SVG 上，位置取曲线中点，背景块遮住线
      const textEl = speedTextElsRef.current[section.groupKey]
      const bgEl = speedBgElsRef.current[section.groupKey]
      if (textEl && bgEl) {
        const mx = (x1 + x2) / 2
        const my = (y1 + y2) / 2
        textEl.setAttribute('x', String(mx))
        textEl.setAttribute('y', String(my))

        const speed = sectionSpeedsRef.current.get(section.groupKey)
        textEl.textContent = `↑ ${formatSpeedLabel(speed?.up ?? 0)}  ↓ ${formatSpeedLabel(speed?.down ?? 0)}`

        const box = textEl.getBBox()
        bgEl.setAttribute('x', String(box.x - 4))
        bgEl.setAttribute('y', String(box.y - 2))
        bgEl.setAttribute('width', String(box.width + 8))
        bgEl.setAttribute('height', String(box.height + 4))
      }

      // 第二条线：从分组头第一个标签（分组名）往下连到具体节点卡片顶部
      const nodePath = nodeLineElsRef.current[section.groupKey]
      if (nodePath) {
        const target = sectionTargetName(section)
        const card = target
          ? cardElsRef.current[`${section.groupKey}/${target}`]
          : null
        const tag = headerTagRef.current[section.groupKey]

        if (card && tag) {
          const cardRect = card.getBoundingClientRect()
          const tagRect = tag.getBoundingClientRect()
          const tx = cardRect.left - cr.left + cardRect.width / 2
          const ty = cardRect.top - cr.top
          const sx = tagRect.left - cr.left + tagRect.width / 2
          const sy = tagRect.bottom - cr.top
          nodePath.setAttribute(
            'd',
            `M${sx},${sy} C${sx},${sy + 40} ${tx},${ty - 40} ${tx},${ty}`,
          )
          nodePath.setAttribute('opacity', '0.9')
        } else {
          nodePath.setAttribute('d', '')
        }
      }
    }
  }, [layout, transform, selection, theme, sectionTargetName])

  useLayoutEffect(() => {
    computeSectionSpeeds()
    updateCrossLines()
  }, [computeSectionSpeeds, updateCrossLines])

  // updateCrossLines 的引用会随拖拽/缩放频繁变化，用 ref 避免反复订阅连接数据
  const updateCrossLinesRef = useRef(updateCrossLines)
  useEffect(() => {
    updateCrossLinesRef.current = updateCrossLines
  }, [updateCrossLines])

  // 连接快照只驱动 SVG 上的速率文字：命令式更新，不触发 React 渲染
  useEffect(() => {
    if (!pageVisible) return

    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        computeSectionSpeeds()
        updateCrossLinesRef.current()
      }, 1000)
    }

    const unsubscribe = subscribeConnectionData(schedule)
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [pageVisible, computeSectionSpeeds])

  useEffect(() => {
    const right = rightRef.current
    const onResize = () => updateCrossLines()
    window.addEventListener('resize', onResize)
    right?.addEventListener('scroll', updateCrossLines, { passive: true })
    return () => {
      window.removeEventListener('resize', onResize)
      right?.removeEventListener('scroll', updateCrossLines)
    }
  }, [updateCrossLines])

  useEffect(() => {
    const el = leftRef.current
    if (!el) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()

      // 按住 Ctrl 才缩放，普通滚轮上下平移
      if (event.ctrlKey) {
        const rect = el.getBoundingClientRect()
        const mx = event.clientX - rect.left
        const my = event.clientY - rect.top
        const factor = event.deltaY < 0 ? 1.08 : 0.92

        setTransform((prev) => {
          const scale = Math.min(2.5, Math.max(0.4, prev.scale * factor))
          const ratio = scale / prev.scale
          return {
            scale,
            x: mx - (mx - prev.x) * ratio,
            y: my - (my - prev.y) * ratio,
          }
        })
        return
      }

      const delta =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * el.clientHeight
            : event.deltaY

      setTransform((prev) => {
        // 与左侧 SVG 画布实际高度保持一致，初始即使节点少也能滚动
        const contentH = Math.max(layout.bottom + 240, 900)
        const minY = Math.min(-SCROLL_SLACK, el.clientHeight - contentH)
        const maxY = SCROLL_SLACK
        return {
          ...prev,
          y: Math.min(maxY, Math.max(minY, prev.y - delta)),
        }
      })
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // 树数据是异步加载的，左右栏 DOM 就绪后必须重新绑定
  }, [layout.bottom, hasTree, error])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      tx: transform.x,
      ty: transform.y,
      moved: false,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < 4) return
    if (!drag.moved) {
      drag.moved = true
      // 只在真正开始拖拽时捕获指针，否则会吞掉圆圈的 click 事件
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
    }
    setTransform((prev) => ({ ...prev, x: drag.tx + dx, y: drag.ty + dy }))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const moved = dragRef.current?.moved ?? false
    dragRef.current = null
    if (moved) {
      setDragging(false)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    }
  }

  // 点击左栏的组：只把右栏切到该组，左栏的层级与展开状态保持不变
  const onNodeClick = (node: LayoutNode) => {
    if (node.key === 'root') {
      pathKeysInitializedRef.current = true
      setFocusGroup(null)
      setPathKeys([])
      publishProxySelection(setSharedSelection, '', '', 'tree')
      return
    }

    setFocusGroup({
      name: node.name,
      pathNames: node.pathKeys
        .map((key) => layout.nodeByKey.get(key)?.name ?? '')
        .filter(Boolean),
    })
    // 同时把父组的 now 写回该组，树内高亮与首页保持一致
    selectChain(node.parentChain, node.parentName, node.name, {
      group: node.name,
      proxy: '',
    })
  }

  // 只改左栏展开层级：展开某个组，或收起它之后的所有层级
  const onToggleExpand = (node: LayoutNode) => {
    pathKeysInitializedRef.current = true
    setPathKeys((prev) => {
      if (!node.expanded) return node.pathKeys
      const index = prev.indexOf(node.key)
      return index < 0 ? prev : prev.slice(0, index)
    })
    // 右栏回到「跟随最后展开的组」
    setFocusGroup(null)
  }

  const onChangeSource = (next: SourceKind) => {
    setSource(next)
    pathKeysInitializedRef.current = true
    setFocusGroup(null)
    setPathKeys([])
    setTransform(DEFAULT_TRANSFORM)
  }

  const timeout = verge?.default_latency_timeout || 10000

  // 树与右栏共用同一份兜底数据：配置里有、运行时不存在的节点也要能展示
  const proxyItemOf = (name: string): IProxyItem =>
    records[name] ?? {
      name,
      type: tree.proxyDetails[name]?.type ?? '—',
      udp: false,
      xudp: false,
      tfo: false,
      mptcp: false,
      smux: false,
      history: [],
    }

  const proxyGroupOf = (name: string): IProxyGroupItem =>
    runtimeGroups.get(name) ?? {
      name,
      type: 'Selector',
      udp: false,
      xudp: false,
      tfo: false,
      mptcp: false,
      smux: false,
      history: [],
      all: [],
    }

  const sectionProxies = (section: ProxySection): IProxyItem[] =>
    section.proxies
      .map((name) => records[name])
      .filter((item): item is IProxyItem => !!item)

  // 组级延迟测试：与代理页分组头相同的实现
  const handleCheckDelay = useLockFn(async (section: ProxySection) => {
    setBusySection(section.groupKey)
    try {
      await Promise.race([
        delayManager.checkListDelay(
          sectionProxies(section),
          section.groupName,
          timeout,
        ),
        delayGroup(
          section.groupName,
          delayManager.getUrl(section.groupName),
          timeout,
        ),
      ])
    } catch (error) {
      showNotice.error(error)
    } finally {
      setBusySection(null)
      await refreshProxy()
    }
  })

  // 组级测速
  const handleCheckSpeed = useLockFn(async (section: ProxySection) => {
    setBusySection(section.groupKey)
    try {
      await speedManager.checkGroupSpeed(
        section.groupName,
        sectionProxies(section),
      )
    } catch (error) {
      showNotice.error(error)
    } finally {
      setBusySection(null)
      await refreshProxy()
    }
  })

  // 排序复用代理页的 filterSort：默认 / 按延迟 / 按名称
  const sortedSectionNames = (section: ProxySection): string[] => {
    const sortType = sortTypes[section.groupKey] ?? 0
    if (sortType === 0) return section.proxies
    const items = section.proxies.map(
      (name) =>
        records[name] ?? {
          name,
          type: '—',
          udp: false,
          xudp: false,
          tfo: false,
          mptcp: false,
          smux: false,
          history: [],
        },
    )
    return filterSort(items, section.groupName, '', sortType, timeout).map(
      (item) => item.name,
    )
  }

  return (
    <Box
      ref={containerRef}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      <Stack
        spacing={0.75}
        sx={{ p: 1, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flexWrap: 'wrap',
          }}
        >
          <Chip
            size="small"
            color="primary"
            label={`${t('proxies.page.tree.root')}: ${rootName || '—'}`}
            sx={{
              maxWidth: 300,
              '& .MuiChip-label': {
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            }}
          />
          <Chip
            size="small"
            variant="outlined"
            label={`${t('proxies.page.tree.groups')}: ${tree.groupNames.length}`}
          />
          <Chip
            size="small"
            variant="outlined"
            label={`${t('proxies.page.tree.ruleTargets')}: ${tree.ruleTargets.length}`}
          />
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            variant="outlined"
            onClick={() => setTransform(DEFAULT_TRANSFORM)}
          >
            {t('proxies.page.tree.resetView')}
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              pathKeysInitializedRef.current = true
              setFocusGroup(null)
              setPathKeys([])
              publishProxySelection(setSharedSelection, '', '', 'tree')
            }}
          >
            {t('proxies.page.tree.collapseAll')}
          </Button>
          <ButtonGroup size="small">
            <Button
              variant={source === 'profile' ? 'contained' : 'outlined'}
              onClick={() => onChangeSource('profile')}
            >
              {t('proxies.page.tree.sourceProfile')}
            </Button>
            <Button
              variant={source === 'runtime' ? 'contained' : 'outlined'}
              onClick={() => onChangeSource('runtime')}
            >
              {t('proxies.page.tree.sourceRuntime')}
            </Button>
          </ButtonGroup>
          <Tooltip title={t('proxies.page.tree.refresh')} arrow>
            <IconButton size="small" onClick={() => void refetch()}>
              {isPending ? (
                <CircularProgress size={16} />
              ) : (
                <RefreshRounded fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
          <Button
            size="small"
            variant={showCheck ? 'contained' : 'outlined'}
            onClick={() => setShowCheck((prev) => !prev)}
            endIcon={
              <ExpandMoreRounded
                sx={{
                  fontSize: 16,
                  transform: showCheck ? 'rotate(180deg)' : 'none',
                }}
              />
            }
          >
            {t('proxies.page.tree.checkConfig')}
          </Button>
        </Box>

        {showCheck && (
          <Box sx={{ maxHeight: 130, overflowY: 'auto' }}>
            <Typography variant="caption" color="text.secondary">
              {t('proxies.page.tree.groups')}
            </Typography>
            <NameChips names={tree.groupNames} />
            <Typography variant="caption" color="text.secondary">
              {t('proxies.page.tree.ruleTargets')}
            </Typography>
            <NameChips names={tree.ruleTargets} />
          </Box>
        )}

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            flexWrap: 'wrap',
          }}
        >
          <Chip
            size="small"
            color="success"
            variant="outlined"
            label={t('proxies.page.tree.current')}
            sx={{ height: 20 }}
          />
          <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
            {currentChainText}
          </Typography>
        </Box>

        <Typography variant="caption" color="text.secondary">
          {t('proxies.page.tree.hint')}
        </Typography>
      </Stack>

      <Box
        sx={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}
      >
        {error ? (
          <Alert severity="error" sx={{ m: 2 }}>
            {t('proxies.page.tree.loadFailed')}
          </Alert>
        ) : !tree.groupNames.length ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 3 }}>
            {isPending && <CircularProgress size={18} />}
            <Typography color="text.secondary">
              {t('proxies.page.tree.empty')}
            </Typography>
            <AccountTreeOutlined fontSize="small" color="disabled" />
          </Box>
        ) : (
          <>
            <Box
              ref={leftRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              sx={{
                width: '50%',
                flexShrink: 0,
                position: 'relative',
                overflow: 'hidden',
                cursor: dragging ? 'grabbing' : 'grab',
                touchAction: 'none',
              }}
            >
              <Typography
                sx={{
                  position: 'absolute',
                  top: 8,
                  left: 12,
                  zIndex: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 1,
                  color: 'text.disabled',
                  pointerEvents: 'none',
                }}
              >
                {t('proxies.page.tree.groupTopology')}
              </Typography>

              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                  transformOrigin: '0 0',
                }}
              >
                <GroupDot
                  node={layout.root}
                  isRoot
                  selected={false}
                  active={activeChain.names.length > 0}
                  nodeWidth={nodeW}
                  now={nowOf(rootName)}
                  onClick={onNodeClick}
                  onToggle={onToggleExpand}
                />
                {/* 左栏只画组：叶子节点统一在右栏展示，不再多铺一层 */}
                {layout.nodes.map((node) => (
                  <GroupDot
                    key={node.key}
                    node={node}
                    selected={
                      selection?.kind === 'group' &&
                      selection.name === node.name
                    }
                    active={activeKeys.has(node.key)}
                    nodeWidth={nodeW}
                    now={nowOf(node.name)}
                    onClick={onNodeClick}
                    onToggle={onToggleExpand}
                  />
                ))}

                {/* 连线画在节点之上：组关系与选中链都清晰可见 */}
                <svg
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: Math.max(width, 1400),
                    height: Math.max(layout.bottom + 240, 900),
                    overflow: 'visible',
                    pointerEvents: 'none',
                    zIndex: 3,
                  }}
                >
                  {layout.links.map((link) => (
                    <path
                      key={link.key}
                      d={`M${link.x1},${link.y1} C${link.x1},${(link.y1 + link.y2) / 2} ${link.x2},${(link.y1 + link.y2) / 2} ${link.x2},${link.y2}`}
                      fill="none"
                      stroke={
                        link.highlighted
                          ? theme.palette.info.main
                          : theme.palette.text.disabled
                      }
                      strokeWidth={link.highlighted ? 2.5 : 1}
                      opacity={link.highlighted ? 0.9 : 0.35}
                    />
                  ))}
                </svg>
              </Box>
            </Box>

            <Box
              sx={{
                width: '1px',
                flexShrink: 0,
                bgcolor: 'divider',
                zIndex: 4,
              }}
            />

            <Box
              ref={rightRef}
              sx={{
                flex: 1,
                minWidth: 0,
                overflowY: 'auto',
                p: 1.5,
                position: 'relative',
                zIndex: 2,
              }}
            >
              {layout.sections.length ? (
                layout.sections.map((section) => {
                  const sectionGroup = runtimeGroups.get(section.groupName)
                  const sortType = sortTypes[section.groupKey] ?? 0
                  const collapsed = !!collapsedSections[section.groupKey]
                  const busy = busySection !== null

                  return (
                    <Box key={section.groupKey} sx={{ mb: 2 }}>
                      <Box
                        ref={(el) => {
                          sectionElsRef.current[section.groupKey] =
                            el instanceof HTMLElement ? el : null
                        }}
                        sx={{
                          // 组状态栏紧贴右栏顶部吸顶
                          position: 'sticky',
                          top: 0,
                          zIndex: 5,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          mb: 1,
                          minWidth: 0,
                          py: 0.5,
                          mx: -1.5,
                          px: 1.5,
                          bgcolor: 'background.paper',
                          borderBottom: 1,
                          borderColor: 'divider',
                        }}
                      >
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          <Chip
                            size="small"
                            color="success"
                            label={section.groupName}
                            title={section.groupName}
                            ref={(el) => {
                              headerTagRef.current[section.groupKey] =
                                el instanceof HTMLElement ? el : null
                            }}
                            sx={{
                              maxWidth: 180,
                              '& .MuiChip-label': {
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              },
                            }}
                          />
                          <Chip
                            size="small"
                            variant="outlined"
                            label={
                              sectionGroup?.type ||
                              tree.definitions[section.groupName]?.type ||
                              '—'
                            }
                          />
                          <Typography
                            variant="caption"
                            noWrap
                            color="text.secondary"
                            title={sectionGroup?.now}
                            sx={{ flex: 1, minWidth: 0 }}
                          >
                            {sectionGroup?.now || '—'}
                          </Typography>
                        </Box>
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.25,
                            flexShrink: 0,
                            ml: 'auto',
                          }}
                        >
                          <Tooltip
                            title={t('proxies.page.tooltips.delayCheck')}
                            arrow
                          >
                            <span>
                              <IconButton
                                size="small"
                                disabled={busy}
                                onClick={() => void handleCheckDelay(section)}
                              >
                                <NetworkCheckRounded fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip
                            title={t('proxies.page.tooltips.speedTest')}
                            arrow
                          >
                            <span>
                              <IconButton
                                size="small"
                                disabled={busy}
                                onClick={() => void handleCheckSpeed(section)}
                              >
                                <SpeedRounded fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title={t(SORT_TOOLTIP_KEYS[sortType])} arrow>
                            <IconButton
                              size="small"
                              color={sortType === 0 ? 'default' : 'primary'}
                              onClick={() =>
                                setSortTypes((prev) => ({
                                  ...prev,
                                  [section.groupKey]: ((sortType + 1) %
                                    3) as ProxySortType,
                                }))
                              }
                            >
                              <SortRounded fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Chip
                            size="small"
                            label={section.proxies.length}
                            sx={(theme) => ({
                              backgroundColor: alpha(
                                theme.palette.primary.main,
                                0.1,
                              ),
                              color: 'primary.main',
                            })}
                          />
                          <IconButton
                            size="small"
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                [section.groupKey]: !collapsed,
                              }))
                              requestAnimationFrame(() => updateCrossLines())
                            }}
                          >
                            {collapsed ? (
                              <ExpandMoreRounded fontSize="small" />
                            ) : (
                              <ExpandLessRounded fontSize="small" />
                            )}
                          </IconButton>
                        </Box>
                      </Box>
                      {!collapsed && (
                        <Box
                          sx={{
                            display: 'grid',
                            // 与左侧节点块同宽同高、同列数、同间距
                            gridTemplateColumns: `repeat(${columns}, ${nodeW}px)`,
                            gap: 1,
                          }}
                        >
                          {sortedSectionNames(section).map((name) => {
                            const owner =
                              section.owners[name] ?? section.groupName
                            const proxyItem = proxyItemOf(name)
                            const miniGroup = proxyGroupOf(owner)

                            const cardKey = `${section.groupKey}/${name}`

                            return (
                              <Box
                                key={cardKey}
                                ref={(el) => {
                                  cardElsRef.current[cardKey] =
                                    el instanceof HTMLElement ? el : null
                                }}
                                sx={{ minWidth: 0 }}
                              >
                                <ProxyItemMini
                                  group={miniGroup}
                                  proxy={proxyItem}
                                  accentColor={resolveProxyColor(theme, name)}
                                  showPulseWaveform
                                  selected={
                                    selection?.kind === 'proxy' &&
                                    selection.name === name &&
                                    section.owners[name] === selection.key
                                  }
                                  onClick={() =>
                                    selectChain(
                                      section.ownerPaths[name] ?? [owner],
                                      owner,
                                      name,
                                      { group: owner, proxy: name },
                                    )
                                  }
                                />
                              </Box>
                            )
                          })}
                        </Box>
                      )}
                    </Box>
                  )
                })
              ) : (
                <Box
                  sx={{
                    mt: 4,
                    p: 3,
                    textAlign: 'center',
                    border: '1px dashed',
                    borderColor: 'divider',
                    borderRadius: 2,
                  }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      justifyContent: 'center',
                      mb: 1,
                      '& svg': { width: 160, height: 96 },
                    }}
                  >
                    <NodePulse />
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {t('proxies.page.tree.emptyHint')}
                  </Typography>
                </Box>
              )}
            </Box>
          </>
        )}
      </Box>

      {!!tree.groupNames.length && (
        <svg
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            // 连线始终画在最上层：吸顶状态栏、节点卡片都不遮住它
            zIndex: 7,
            overflow: 'visible',
          }}
        >
          {layout.sections.map((section) => (
            <g key={section.groupKey}>
              <path
                ref={(el) => {
                  lineElsRef.current[section.groupKey] = el
                }}
                fill="none"
                stroke={theme.palette.text.disabled}
                strokeWidth={1}
                strokeDasharray="4 4"
                opacity={0.45}
              />
              <path
                ref={(el) => {
                  nodeLineElsRef.current[section.groupKey] = el
                }}
                fill="none"
                stroke={theme.palette.success.main}
                strokeWidth={2.5}
                strokeDasharray="7 5"
                opacity={0.9}
              />
              <rect
                ref={(el) => {
                  speedBgElsRef.current[section.groupKey] = el
                }}
                fill={theme.palette.background.paper}
                rx={3}
                ry={3}
              />
              <text
                ref={(el) => {
                  speedTextElsRef.current[section.groupKey] = el
                }}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={10}
                fill={theme.palette.text.secondary}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              />
            </g>
          ))}
        </svg>
      )}
    </Box>
  )
}
