import yaml from 'js-yaml'

interface GroupDefinition {
  name: string
  type: string
  members: string[]
}

export interface ProxyDetail {
  type: string
  server: string
  port: string
}

export interface GroupTreeData {
  root: string
  groupNames: string[]
  ruleTargets: string[]
  definitions: Record<string, GroupDefinition>
  proxyDetails: Record<string, ProxyDetail>
}

const EMPTY_TREE: GroupTreeData = {
  root: '',
  groupNames: [],
  ruleTargets: [],
  definitions: {},
  proxyDetails: {},
}

export const POLICY_NAMES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'])

const toNameList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim() !== '',
      )
    : []

// 组名可能自带逗号（如 "🌱CF-根节点, Inc. 域名 2 节点"），不能简单按逗号取最后一段。
// 只在规则里以 ",<组名>" 结尾（后面可跟 ,no-resolve 等参数）时认定为跳转目标。
const findRuleTarget = (rule: string, names: readonly string[]) => {
  let best: { name: string; index: number } | undefined

  for (const name of names) {
    const needle = `,${name}`
    const index = rule.lastIndexOf(needle)
    if (index < 0) continue

    const rest = rule.slice(index + needle.length)
    if (rest !== '' && !rest.startsWith(',')) continue

    if (
      !best ||
      index > best.index ||
      (index === best.index && name.length > best.name.length)
    ) {
      best = { name, index }
    }
  }

  return best?.name
}

export function parseGroupTree(text: string): GroupTreeData {
  let doc: Record<string, unknown>

  try {
    const loaded = yaml.load(text)
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      return EMPTY_TREE
    }
    doc = loaded as Record<string, unknown>
  } catch {
    return EMPTY_TREE
  }

  const rawGroups = Array.isArray(doc['proxy-groups'])
    ? doc['proxy-groups']
    : []
  const definitions: Record<string, GroupDefinition> = {}
  const groupNames: string[] = []

  for (const raw of rawGroups) {
    if (!raw || typeof raw !== 'object') continue
    const group = raw as Record<string, unknown>
    const name = typeof group.name === 'string' ? group.name : ''
    if (!name || definitions[name]) continue

    definitions[name] = {
      name,
      type: typeof group.type === 'string' ? group.type : '',
      members: toNameList(group.proxies),
    }
    groupNames.push(name)
  }

  const rawProxies = Array.isArray(doc.proxies) ? doc.proxies : []
  const proxyDetails: Record<string, ProxyDetail> = {}

  for (const raw of rawProxies) {
    if (!raw || typeof raw !== 'object') continue
    const proxy = raw as Record<string, unknown>
    const name = typeof proxy.name === 'string' ? proxy.name : ''
    if (!name || proxyDetails[name]) continue

    proxyDetails[name] = {
      type: typeof proxy.type === 'string' ? proxy.type : '',
      server: typeof proxy.server === 'string' ? proxy.server : '',
      port:
        proxy.port === undefined || proxy.port === null
          ? ''
          : String(proxy.port),
    }
  }

  const rules = Array.isArray(doc.rules) ? doc.rules : []
  const ruleTargets: string[] = []
  let matchTarget = ''

  for (const raw of rules) {
    if (typeof raw !== 'string') continue
    const rule = raw
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .trim()

    if (/^MATCH\s*,/i.test(rule)) {
      matchTarget = rule
        .slice(rule.indexOf(',') + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .trim()
    }

    const target = findRuleTarget(rule, groupNames)
    if (target && !POLICY_NAMES.has(target) && !ruleTargets.includes(target)) {
      ruleTargets.push(target)
    }
  }

  return {
    root: matchTarget || groupNames[0] || '',
    groupNames,
    ruleTargets,
    definitions,
    proxyDetails,
  }
}
