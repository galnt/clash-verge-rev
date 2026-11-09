import { POLICY_NAMES, type GroupTreeData } from './parse-group-tree'

export const NODE_RADIUS = 32
/** 节点块的基础宽度（仅在未按容器宽度铺满时作为默认值） */
export const NODE_W = 176
/** 一行要排 n 列时允许的最小宽度 */
export const NODE_W_MIN = 148
/** 节点块之间的间距：与右栏卡片的网格间距（8px）保持一致 */
export const CELL_GAP = 8
export const ROOT_Y = 64
export const LEVEL1_Y = 176
export const CELL_H = NODE_RADIUS * 2 + CELL_GAP
/** 层级之间的纵向间距 */
export const LEVEL_GAP = 96
const MAX_DEPTH = 8

export interface LayoutNode {
  key: string
  name: string
  depth: number
  x: number
  y: number
  pathKeys: string[]
  expanded: boolean
  groupType: string
  memberCount: number
  proxyCount: number
}

export interface LayoutLink {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  highlighted: boolean
}

export interface ProxySection {
  groupKey: string
  groupName: string
  proxies: string[]
  // 节点名 -> 直接包含它的组名，用于把选择写回正确的代理组
  owners: Record<string, string>
  // 节点名 -> 从根组到"直接包含它的组"的完整链（含根），点击时逐级写回
  ownerPaths: Record<string, string[]>
}

export interface TreeLayout {
  root: LayoutNode
  nodes: LayoutNode[]
  links: LayoutLink[]
  nodeByKey: Map<string, LayoutNode>
  sections: ProxySection[]
  bottom: number
}

export const topPath = (name: string) => `g/${encodeURIComponent(name)}`
const childPath = (parentKey: string, name: string) =>
  `${parentKey}/${encodeURIComponent(name)}`

interface PendingNode {
  name: string
  key: string
  pathKeys: string[]
}

interface BuildParams {
  tree: GroupTreeData
  rootName?: string
  pathKeys: string[]
  width: number
  /** 一行最多几个节点：左右两栏共用同一个值 */
  maxCols?: number
  /** 节点块宽度：左右两栏共用同一个值 */
  nodeW?: number
  membersOf: (name: string) => string[]
  isGroup: (name: string) => boolean
  groupTypeOf: (name: string) => string
}

/**
 * 按容器宽度算出列数与块宽：
 * 先保证列数（2/3/4），再把块宽均分到可用宽度，从而铺满整栏
 */
export const fitColumns = (width: number, max = 4) => {
  const avail = Math.max(width - 24, NODE_W_MIN)
  const columns = Math.max(
    1,
    Math.min(max, Math.floor((avail + CELL_GAP) / (NODE_W_MIN + CELL_GAP))),
  )
  const nodeW = Math.max(
    NODE_W_MIN,
    Math.floor((avail - CELL_GAP * (columns - 1)) / columns),
  )
  return { columns, nodeW }
}

export function buildTreeLayout({
  tree,
  rootName = tree.root,
  pathKeys,
  width,
  maxCols = 3,
  nodeW = NODE_W,
  membersOf,
  isGroup,
  groupTypeOf,
}: BuildParams): TreeLayout {
  const centerX = Math.max(width, 320) / 2
  const pathSet = new Set(pathKeys)
  const childGroups = membersOf(rootName).filter(
    (name) => name !== rootName && isGroup(name),
  )
  const root: LayoutNode = {
    key: 'root',
    name: rootName,
    depth: 0,
    x: centerX,
    y: ROOT_Y,
    pathKeys: [],
    expanded: true,
    groupType: 'MATCH',
    memberCount: childGroups.length,
    proxyCount: 0,
  }

  const nodes: LayoutNode[] = []
  const links: LayoutLink[] = []
  const nodeByKey = new Map<string, LayoutNode>([['root', root]])

  const placeLevel = (
    pending: PendingNode[],
    levelCenterX: number,
    y0: number,
    depth: number,
  ) => {
    const count = pending.length
    // 横纵间距统一用 CELL_GAP，列数与右栏保持一致
    const stepX = nodeW + CELL_GAP
    const fitCols = Math.max(
      1,
      Math.min(maxCols, Math.floor((width - 24 + CELL_GAP) / stepX)),
    )
    const cols = Math.min(count, maxCols, fitCols)
    const rowWidth = (cols - 1) * stepX + nodeW
    // 整行落在画布内并居中，避免深层子树被裁掉
    const left = Math.min(
      Math.max(levelCenterX - rowWidth / 2, 12),
      Math.max(width - rowWidth - 12, 12),
    )
    const startX = left + nodeW / 2
    const placed: LayoutNode[] = []
    let levelBottom = y0

    pending.forEach((item, index) => {
      const col = index % cols
      const row = Math.floor(index / cols)
      const x = startX + col * stepX
      const y = y0 + row * CELL_H
      const members = membersOf(item.name)

      const node: LayoutNode = {
        key: item.key,
        name: item.name,
        depth,
        x,
        y,
        pathKeys: item.pathKeys,
        expanded: pathSet.has(item.key),
        groupType: groupTypeOf(item.name),
        memberCount: members.length,
        proxyCount: members.filter(
          (name) => !isGroup(name) && !POLICY_NAMES.has(name),
        ).length,
      }

      nodes.push(node)
      nodeByKey.set(node.key, node)
      placed.push(node)
      levelBottom = Math.max(levelBottom, y)
    })

    return { placed, levelBottom }
  }

  const addLinks = (parent: LayoutNode, children: LayoutNode[]) => {
    for (const child of children) {
      links.push({
        key: `${parent.key}->${child.key}`,
        x1: parent.x,
        y1: parent.y + NODE_RADIUS,
        x2: child.x,
        y2: child.y - NODE_RADIUS,
        highlighted: pathSet.has(child.key),
      })
    }
  }

  // 第一层只放根组 proxies 里引用的子组，不再平铺 proxy-groups 的全部组
  let pending: PendingNode[] = childGroups.map((name) => {
    const key = topPath(name)
    return { name, key, pathKeys: [key] }
  })
  let parent: LayoutNode = root
  let depth = 1
  let bottom = ROOT_Y

  while (pending.length && depth <= MAX_DEPTH) {
    const y0 = depth === 1 ? LEVEL1_Y : bottom + LEVEL_GAP
    const { placed, levelBottom } = placeLevel(
      pending,
      depth === 1 ? centerX : parent.x,
      y0,
      depth,
    )
    bottom = levelBottom
    addLinks(parent, placed)

    const nextKey = pathKeys[depth - 1]
    const expanded = nextKey ? nodeByKey.get(nextKey) : undefined
    if (!expanded) break

    pending = membersOf(expanded.name)
      .filter(isGroup)
      .map((name) => {
        const key = childPath(expanded.key, name)
        return { name, key, pathKeys: [...expanded.pathKeys, key] }
      })
    parent = expanded
    depth += 1
  }

  const sections: ProxySection[] = []
  const lastKey = pathKeys[pathKeys.length - 1]
  const lastNode = lastKey ? nodeByKey.get(lastKey) : undefined

  if (lastNode) {
    const sectionByKey = new Map<string, ProxySection>()
    const getSection = (key: string, name: string) => {
      let section = sectionByKey.get(key)
      if (!section) {
        section = {
          groupKey: key,
          groupName: name,
          proxies: [],
          owners: {},
          ownerPaths: {},
        }
        sectionByKey.set(key, section)
        sections.push(section)
      }
      return section
    }

    // sectionKey 对应的组名链（根 → section 所在层）
    const pathNamesOf = (key: string): string[] => {
      const node = nodeByKey.get(key)
      if (!node) return [root.name]
      const names = node.pathKeys
        .map((k) => nodeByKey.get(k)?.name ?? '')
        .filter(Boolean)
      return [root.name, ...names]
    }

    const collect = (
      groupName: string,
      sectionKey: string,
      sectionName: string,
      visited: Set<string>,
      ancestors: string[],
    ) => {
      for (const child of membersOf(groupName)) {
        if (isGroup(child)) {
          if (visited.has(child)) continue
          visited.add(child)
          collect(child, sectionKey, sectionName, visited, [
            ...ancestors,
            groupName,
          ])
        } else if (!POLICY_NAMES.has(child)) {
          const section = getSection(sectionKey, sectionName)
          section.proxies.push(child)
          section.owners[child] ??= groupName

          // 组装"根 → … → 直接父组"的完整链，相邻重名去重
          const chain = pathNamesOf(sectionKey)
          for (const name of [...ancestors, groupName]) {
            if (chain[chain.length - 1] !== name) chain.push(name)
          }
          section.ownerPaths[child] ??= chain
        }
      }
    }

    for (const child of membersOf(lastNode.name)) {
      if (isGroup(child)) {
        const childKey = childPath(lastNode.key, child)
        const sectionKey = nodeByKey.has(childKey) ? childKey : lastNode.key
        collect(
          child,
          sectionKey,
          nodeByKey.get(sectionKey)?.name ?? child,
          new Set([lastNode.name, child]),
          [],
        )
      } else if (!POLICY_NAMES.has(child)) {
        const section = getSection(lastNode.key, lastNode.name)
        section.proxies.push(child)
        section.owners[child] ??= lastNode.name
        section.ownerPaths[child] ??= pathNamesOf(lastNode.key)
      }
    }
  }

  return { root, nodes, links, nodeByKey, sections, bottom }
}
