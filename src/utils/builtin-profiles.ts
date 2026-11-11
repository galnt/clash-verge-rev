/**
 * 内置订阅：对应 src-tauri/src/config/prfitem.rs 的 BUILTIN_SUBSCRIPTIONS。
 * 后端启动时会补建这些订阅，且禁止删除；前端据此隐藏删除入口、排除批量操作。
 */
export const BUILTIN_PROFILE_UIDS = [
  'RbuiltinCf',
  'RbuiltinCollect',
  'RbuiltinQuality',
] as const

export const isBuiltinProfile = (uid?: string): boolean =>
  !!uid && (BUILTIN_PROFILE_UIDS as readonly string[]).includes(uid)

/** 遮住链接里的文件名与查询参数（含 access_token）时统一使用的长度 */
const SUBSCRIPTION_URL_MASK = '*'.repeat(50)

/**
 * 订阅地址展示的统一处理：
 * 判断是否为 http(s) URL，保留「协议 + 域名 + 到最后一个 / 为止的路径」，
 * 其余部分（文件名、?access_token=…）全部用星号替代。
 * 例：https://gitee.com/api/v5/repos/galnt/transsub/raw/7chGw9rrjF-WPQg2.yaml?access_token=xxx
 *  → https://gitee.com/api/v5/repos/galnt/transsub/raw/**********************************************
 */
export const maskSubscriptionUrl = (url?: string): string => {
  if (!url) return ''

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return SUBSCRIPTION_URL_MASK
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return SUBSCRIPTION_URL_MASK
  }

  const path = parsed.pathname
  const base = `${parsed.origin}${path.slice(0, path.lastIndexOf('/') + 1)}`
  return `${base}${SUBSCRIPTION_URL_MASK}`
}
