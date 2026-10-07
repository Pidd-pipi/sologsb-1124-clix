/**
 * 贴票构成 ↔ 票戳组合明细对账工具。
 *
 * 两处记账：
 * - 登记表里的贴票构成 Cover.franking：按「票名 + 面值 + 枚数」汇总；
 * - 详情页里的票戳组合明细 StamplessEntry：一行一枚封上票。
 * 明细回算（按票名 + 面值聚合枚数）应与贴票构成完全一致，对不上就要标出差异、
 * 选定以哪边为准后才写入；任一侧改动后已确认结论失效，需要重新对账。
 */
import type { FrankingItem } from '@/types/cover'
import type { StamplessEntry } from '@/types/stampentry'
import { createEmptyStampEntry } from '@/types/stampentry'

/** 票名归一：去首尾空白。 */
export function normalizeStampName(name: unknown): string {
  return typeof name === 'string' ? name.trim() : ''
}

/** 同一票种 = 同名 + 同面值。 */
export function frankingKey(name: string, denomination: number): string {
  return `${normalizeStampName(name)}|${Number(denomination) || 0}`
}

/**
 * 归一贴票构成：去空名 / 非法枚数，同名同面值合并，按票名、面值排序。
 * 比较两侧前都先走一遍，避免重复行与顺序造成假差异。
 */
export function normalizeFranking(items: FrankingItem[] | undefined | null): FrankingItem[] {
  const map = new Map<string, FrankingItem>()
  for (const raw of items ?? []) {
    const stampName = normalizeStampName(raw?.stampName)
    const denomination = Number(raw?.denomination) || 0
    const count = Math.trunc(Number(raw?.count) || 0)
    if (!stampName || count <= 0) continue
    const key = frankingKey(stampName, denomination)
    const found = map.get(key)
    if (found) found.count += count
    else map.set(key, { stampName, denomination, count })
  }
  return [...map.values()].sort((a, b) => {
    if (a.stampName !== b.stampName) return a.stampName.localeCompare(b.stampName, 'zh-Hans-CN')
    return a.denomination - b.denomination
  })
}

/**
 * 以票戳组合明细回算贴票构成：一行明细算一枚，按票名 + 面值聚合。
 * 待填行也占枚数（票名面值已知，只是发行年份 / 齿度等明细待补）。
 */
export function aggregateEntries(entries: StamplessEntry[]): FrankingItem[] {
  const items: FrankingItem[] = entries.map((e) => ({
    stampName: e.stampName,
    denomination: e.denomination,
    count: 1
  }))
  return normalizeFranking(items)
}

/** 两份贴票构成是否逐行一致。 */
export function sameFranking(a: FrankingItem[], b: FrankingItem[]): boolean {
  const na = normalizeFranking(a)
  const nb = normalizeFranking(b)
  if (na.length !== nb.length) return false
  return na.every((item, i) => {
    const other = nb[i]
    return (
      other.stampName === item.stampName &&
      other.denomination === item.denomination &&
      other.count === item.count
    )
  })
}

/** 贴票总枚数（目录合计展示用，一律走同一份归一结果）。 */
export function frankingTotal(items: FrankingItem[] | undefined | null): number {
  return normalizeFranking(items).reduce((sum, f) => sum + f.count, 0)
}

export interface FrankingDiffRow {
  stampName: string
  denomination: number
  /** 登记表贴票构成枚数 */
  declaredCount: number
  /** 详情页明细回算枚数 */
  derivedCount: number
  /** derived - declared，正数明细多，负数明细少 */
  delta: number
}

export interface FrankingDiff {
  declared: FrankingItem[]
  derived: FrankingItem[]
  rows: FrankingDiffRow[]
  matched: boolean
}

/** 逐行比对贴票构成与明细回算结果，列出差异。 */
export function diffFranking(
  declaredRaw: FrankingItem[],
  entries: StamplessEntry[]
): FrankingDiff {
  const declared = normalizeFranking(declaredRaw)
  const derived = aggregateEntries(entries)
  const index = new Map<string, FrankingDiffRow>()
  const rowOf = (name: string, denomination: number): FrankingDiffRow => {
    const key = frankingKey(name, denomination)
    let row = index.get(key)
    if (!row) {
      row = { stampName: name, denomination, declaredCount: 0, derivedCount: 0, delta: 0 }
      index.set(key, row)
    }
    return row
  }
  for (const f of declared) {
    rowOf(f.stampName, f.denomination).declaredCount = f.count
  }
  for (const f of derived) {
    rowOf(f.stampName, f.denomination).derivedCount = f.count
  }
  const rows = [...index.values()]
    .map((r) => ({ ...r, delta: r.derivedCount - r.declaredCount }))
    .sort((a, b) => {
      if (a.stampName !== b.stampName) return a.stampName.localeCompare(b.stampName, 'zh-Hans-CN')
      return a.denomination - b.denomination
    })
  const matched = rows.length > 0 && rows.every((r) => r.delta === 0)
  return { declared, derived, rows, matched }
}

/** 是否存在待填行（明细缺发行年份 / 齿度等，占位待补）。 */
export function hasToFillEntries(entries: StamplessEntry[]): boolean {
  return entries.some((e) => e.toFill)
}

export interface CoverReconcileState {
  /** 归一后的登记表贴票构成 */
  declared: FrankingItem[]
  /** 明细回算结果 */
  derived: FrankingItem[]
  diff: FrankingDiff
  /** 明细待填行数 */
  toFillCount: number
  /** 两侧枚数 / 票名是否对得上（不看待填标记） */
  countsMatched: boolean
  /** 是否已可入账：对得上且无待填行 */
  canConfirm: boolean
}

/** 计算封的当前对账状态（不落库，纯计算）。 */
export function evaluateCover(
  franking: FrankingItem[],
  entries: StamplessEntry[]
): CoverReconcileState {
  const diff = diffFranking(franking, entries)
  const toFillCount = entries.filter((e) => e.toFill).length
  return {
    declared: diff.declared,
    derived: diff.derived,
    diff,
    toFillCount,
    countsMatched: diff.matched,
    canConfirm: diff.matched && toFillCount === 0
  }
}

/** 生成一条待填行：票名 / 面值取自贴票构成，其余明细待补。 */
function buildToFillEntry(
  coverId: number,
  item: FrankingItem,
  createdAt: string
): StamplessEntry {
  const entry = createEmptyStampEntry(coverId)
  return {
    ...entry,
    stampName: item.stampName,
    denomination: item.denomination,
    toFill: true,
    createdAt
  }
}

/** 按整条贴票构成展开为待填行（每枚一行），新建封时使用。 */
export function buildToFillEntries(
  coverId: number,
  franking: FrankingItem[],
  createdAt: string
): StamplessEntry[] {
  const rows: StamplessEntry[] = []
  for (const item of normalizeFranking(franking)) {
    for (let i = 0; i < item.count; i += 1) {
      rows.push(buildToFillEntry(coverId, item, createdAt))
    }
  }
  return rows
}

/**
 * 以贴票构成为准时，为明细缺口补待填行：
 * 仅对「明细回算枚数 < 贴票构成枚数」的票种补差，多出的明细不动。
 */
export function buildDeficitFillEntries(
  coverId: number,
  franking: FrankingItem[],
  existing: StamplessEntry[],
  createdAt: string
): StamplessEntry[] {
  const derivedMap = new Map<string, FrankingItem>()
  for (const f of aggregateEntries(existing)) derivedMap.set(frankingKey(f.stampName, f.denomination), f)
  const rows: StamplessEntry[] = []
  for (const item of normalizeFranking(franking)) {
    const have = derivedMap.get(frankingKey(item.stampName, item.denomination))?.count ?? 0
    const deficit = item.count - have
    for (let i = 0; i < deficit; i += 1) {
      rows.push(buildToFillEntry(coverId, item, createdAt))
    }
  }
  return rows
}

/** 明细超出贴票构成的票种（以贴票构成为准时无法自动收敛，需要人工处理）。 */
export function excessEntryLines(
  franking: FrankingItem[],
  entries: StamplessEntry[]
): FrankingDiffRow[] {
  return diffFranking(franking, entries).rows.filter((r) => r.delta > 0)
}
