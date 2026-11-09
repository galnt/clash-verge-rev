import { createContextState } from 'foxact/create-context-state'

const [ThemeModeProvider, useThemeMode, useSetThemeMode] = createContextState<
  'light' | 'dark'
>()

// save the state of each profile item loading
const [LoadingCacheProvider, useLoadingCache, useSetLoadingCache] =
  createContextState<Set<string>>(new Set())

// save update state
const [UpdateStateProvider, useUpdateState, useSetUpdateState] =
  createContextState<boolean>(false)

// 代理页分组树 / 首页当前代理 / 规则之间共享的当前选择
export interface SharedProxySelection {
  group: string
  proxy: string
  source: 'tree' | 'home' | 'proxies' | 'rules' | ''
  revision: number
}

const [
  ProxySelectionProvider,
  useSharedProxySelection,
  useSetSharedProxySelection,
] = createContextState<SharedProxySelection>({
  group: '',
  proxy: '',
  source: '',
  revision: 0,
})

export const publishProxySelection = (
  setSelection: (
    updater: (prev: SharedProxySelection) => SharedProxySelection,
  ) => void,
  group: string,
  proxy: string,
  source: SharedProxySelection['source'],
) => {
  setSelection((prev) => ({
    group,
    proxy,
    source,
    revision: prev.revision + 1,
  }))
}

export {
  ThemeModeProvider,
  useThemeMode,
  useSetThemeMode,
  LoadingCacheProvider,
  useLoadingCache,
  useSetLoadingCache,
  UpdateStateProvider,
  useUpdateState,
  useSetUpdateState,
  ProxySelectionProvider,
  useSharedProxySelection,
  useSetSharedProxySelection,
}
