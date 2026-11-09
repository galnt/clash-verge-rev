import { Box } from '@mui/material'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  BaseEmpty,
  BasePage,
  BaseSearchBox,
  VirtualList,
  type VirtualListHandle,
} from '@/components/base'
import { ScrollTopButton } from '@/components/layout/scroll-top-button'
import { ProviderButton } from '@/components/rule/provider-button'
import RuleItem from '@/components/rule/rule-item'
import { useVisibility } from '@/hooks/use-visibility'
import {
  useAppRefreshers,
  useProxiesData,
  useRulesData,
} from '@/providers/app-data-context'
import { useSharedProxySelection } from '@/services/states'

const RulesPage = () => {
  const { t } = useTranslation()
  const { rules = [] } = useRulesData()
  const { proxies } = useProxiesData()
  const sharedSelection = useSharedProxySelection()
  const { refreshRules, refreshRuleProviders } = useAppRefreshers()
  const [match, setMatch] = useState(() => (_: string) => true)
  const virtuosoRef = useRef<VirtualListHandle>(null)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const pageVisible = useVisibility()

  // 在组件挂载时和页面获得焦点时刷新规则数据
  useEffect(() => {
    refreshRules()
    refreshRuleProviders()

    if (pageVisible) {
      refreshRules()
      refreshRuleProviders()
    }
  }, [refreshRules, refreshRuleProviders, pageVisible])

  const filteredRules = useMemo(() => {
    const rulesWithLineNo = rules.map((item, index) => ({
      ...item,
      // UI-only derived data; keep app context/SWR data immutable
      lineNo: index + 1,
    }))

    return rulesWithLineNo.filter((item) => match(item.payload ?? ''))
  }, [rules, match])

  // 规则里的 proxy 多是分组名，沿 now 链解析出完整路径（组 → … → 节点），和分组树/首页一致
  const resolveProxyChain = useMemo(() => {
    const groupNames = new Set<string>()
    const nowMap = new Map<string, string>()
    for (const group of proxies?.groups ?? []) {
      groupNames.add(group.name)
      if (group.now) nowMap.set(group.name, group.now)
    }

    const cache = new Map<string, string[]>()
    return (name?: string): string[] => {
      if (!name) return []
      const cached = cache.get(name)
      if (cached) return cached

      const path: string[] = [name]
      const visited = new Set<string>([name])
      let current = name
      for (let i = 0; i < 8; i += 1) {
        // 已经是叶子节点，停
        if (!groupNames.has(current)) break

        // 共享选择优先，避免代理数据未刷新时短暂不一致；
        // 共享里的 proxy 也可能是分组名，需要继续往下钻
        const shared =
          sharedSelection.group &&
          sharedSelection.proxy &&
          current === sharedSelection.group
            ? sharedSelection.proxy
            : undefined
        const next = shared ?? nowMap.get(current)
        if (!next || visited.has(next)) break

        path.push(next)
        visited.add(next)
        current = next
      }

      cache.set(name, path)
      return path
    }
  }, [proxies, sharedSelection.group, sharedSelection.proxy])

  const handleScroll = useCallback((e: Event) => {
    setShowScrollTop((e.target as HTMLElement).scrollTop > 100)
  }, [])

  const scrollToTop = () => {
    virtuosoRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <BasePage
      full
      title={t('rules.page.title')}
      contentStyle={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
      }}
      header={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ProviderButton />
        </Box>
      }
    >
      <Box
        sx={{
          pt: 1,
          mb: 0.5,
          mx: '10px',
          height: '36px',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <BaseSearchBox onSearch={(match) => setMatch(() => match)} />
      </Box>

      {filteredRules && filteredRules.length > 0 ? (
        <>
          <VirtualList
            ref={virtuosoRef}
            count={filteredRules.length}
            estimateSize={40}
            renderItem={(i) => (
              <RuleItem
                value={filteredRules[i]}
                chain={resolveProxyChain(filteredRules[i].proxy)}
              />
            )}
            style={{ flex: 1 }}
            onScroll={handleScroll}
          />
          <ScrollTopButton onClick={scrollToTop} show={showScrollTop} />
        </>
      ) : (
        <BaseEmpty />
      )}
    </BasePage>
  )
}

export default RulesPage
