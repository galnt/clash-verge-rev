import type { Theme } from '@mui/material/styles'

/** 与规则页保持一致的调色板顺序 */
export const PROXY_COLOR_TOKENS = [
  'primary',
  'secondary',
  'info.main',
  'warning.main',
  'success.main',
] as const

/**
 * 按名称哈希分配调色板 token（规则页与分组树共用，保证同一名称颜色一致）
 */
export const proxyColorToken = (name: string): string => {
  if (name === 'REJECT' || name === 'REJECT-DROP') return 'error.main'
  if (name === 'DIRECT') return 'text.primary'

  let sum = 0
  for (let i = 0; i < name.length; i++) {
    sum += name.charCodeAt(i)
  }
  return PROXY_COLOR_TOKENS[sum % PROXY_COLOR_TOKENS.length]
}

/** 把 token（如 info.main）解析成具体颜色值 */
export const resolveProxyColor = (theme: Theme, name: string): string => {
  const [group, shade = 'main'] = proxyColorToken(name).split('.')
  const section = (theme.palette as unknown as Record<string, unknown>)[group]

  if (typeof section === 'string') return section

  const value = (section as Record<string, string> | undefined)?.[shade]
  return value ?? theme.palette.text.primary
}
