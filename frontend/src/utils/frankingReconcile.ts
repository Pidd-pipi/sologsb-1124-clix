/**
 * 贴票对账：以详情页「票戳组合明细」回算登记表「贴票构成」，
 * 两侧按「票名 + 面值」逐行比对枚数，产出同一份账。
 *
 * - 明细是一枚一行，回算时按票名/面值聚合计数；
 * - 登记表贴票构成可能把同一票种拆成多行，比对前先合并；
 * - 签名（signature）用于判定已确认结论是否因任一侧改动而失效；
 * - 旧数据升级时缺明细的封，会补出 draft 待填行，补齐前状态为 missing。
 */
import type { Cover, FrankingBasis, FrankingItem } from '@/types/cover'
import type { StamplessEntry } from '@/types/stampentry'

/** 一个「票名 + 面值」分组的枚数对照 */
export interface ReconcileLine {
  key: string
  stampName: string
  denomination: number
  /** 登记表贴票构成枚数（同票名/面值多行已合并） */
  frankingCount: number
  /** 票戳组合明细回算枚数（含待填行） */
  entriesCount: number
  /** 仅存在于明细（含待填行）的待填行枚数，用于引导补录 */
  draftCount: number
  /** 两侧枚数是否一致 */
  match: boolean
}

/** 核对状态：一致 / 枚数票名对不上 / 缺待填行 / 已确认结论失效 */
export type ReconcileStatus = 'matched' | 'mismatch' | 'missing' | 'stale'

export interface ReconcileResult {
  status: ReconcileStatus
  lines: ReconcileLine[]
  /** 明细回算后的贴票构成（待填行也计入，保证目录与详情同一结果） */
  effectiveFranking: FrankingItem[]
  /** 登记表贴票总枚数 */
  frankingTotal: number
  /** 明细回算总枚数（含待填行） */
  entriesTotal: number
  /** 待填行总数 */
  draftTotal: number
  /** 已确认且未失效的结论；失效时为 null */
  confirmedBasis: FrankingBasis | null
}

/** 规范化票名，空票名归入待补占位，避免空白与真实票名错并。 */
function normName(name: string): string {
  return (name ?? '').trim()
}

function groupKey(name: string, denomination: number): string {
  return `${normName(name)}@${Number(denomination) || 0}`
}

interface CountAcc {
  stampName: string
  denomination: number
  count: number
  draftCount: number
}

/** 把贴票构按票名/面值合并计数。 */
export function groupFranking(items: FrankingItem[]): Map<string, CountAcc> {
  const map = new Map<string, CountAcc>()
  for (const item of items ?? []) {
    const key = groupKey(item.stampName, item.denomination)
    const acc = map.get(key)
    const count = Math.max(0, Number(item.count) || 0)
    if (acc) {
      acc.count += count
    } else {
      map.set(key, {
        stampName: normName(item.stampName),
        denomination: Number(item.denomination) || 0,
        count,
        draftCount: 0
      })
    }
  }
  return map
}

/** 把票戳组合明细（一枚一行）按票名/面值聚合计数，待填行单独累计。 */
export function groupEntries(entries: StamplessEntry[]): Map<string, CountAcc> {
  const map = new Map<string, CountAcc>()
  for (const entry of entries ?? []) {
    const key = groupKey(entry.stampName, entry.denomination)
    const acc = map.get(key)
    if (acc) {
      acc.count += 1
      if (entry.draft) acc.draftCount += 1
    } else {
      map.set(key, {
        stampName: normName(entry.stampName),
        denomination: Number(entry.denomination) || 0,
        count: 1,
        draftCount: entry.draft ? 1 : 0
      })
    }
  }
  return map
}

/** 稳定序列化：调用方已把键排序，直接序列化即可。 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

/** 贴票构成签名：排序后序列化，登记侧改动即变。 */
export function frankingSignature(items: FrankingItem[]): string {
  const rows = (items ?? [])
    .map((f) => ({
      stampName: normName(f.stampName),
      denomination: Number(f.denomination) || 0,
      count: Math.max(0, Number(f.count) || 0)
    }))
    .sort((a, b) => {
      const byName = a.stampName.localeCompare(b.stampName, 'zh-Hans-CN')
      return byName !== 0 ? byName : a.denomination - b.denomination
    })
  return stableStringify(rows)
}

/** 票戳明细签名：含 draft 标记，补录待填行或改票名面值都会使结论失效。 */
export function entriesSignature(entries: StamplessEntry[]): string {
  const rows = (entries ?? [])
    .map((e) => ({
      stampName: normName(e.stampName),
      denomination: Number(e.denomination) || 0,
      draft: e.draft === true
    }))
    .sort((a, b) => {
      const keyA = `${a.stampName}@${a.denomination}@${a.draft ? 1 : 0}`
      const keyB = `${b.stampName}@${b.denomination}@${b.draft ? 1 : 0}`
      return keyA.localeCompare(keyB, 'zh-Hans-CN')
    })
  return stableStringify(rows)
}

/** 按「贴票构成为准」需要补出的待填行：同票名/面值缺口逐枚生成。 */
export function buildDraftEntries(
  coverId: number,
  franking: FrankingItem[],
  entries: StamplessEntry[],
  createdAt: string
): StamplessEntry[] {
  const need = groupFranking(franking)
  const have = groupEntries(entries.filter((e) => !e.draft))
  const drafts: StamplessEntry[] = []
  for (const acc of need.values()) {
    const formal = have.get(groupKey(acc.stampName, acc.denomination))?.count ?? 0
    const missing = acc.count - formal
    for (let i = 0; i < missing; i += 1) {
      drafts.push({
        coverId,
        stampName: acc.stampName,
        denomination: acc.denomination,
        issueYear: 1949,
        perforation: '',
        variety: '正品',
        positionOnCover: '右上',
        draft: true,
        createdAt
      })
    }
  }
  return drafts
}

/** 以同一顺序合并两侧分组，产出逐行对照。 */
function buildLines(
  franking: Map<string, CountAcc>,
  fromEntries: Map<string, CountAcc>
): ReconcileLine[] {
  const keys = Array.from(new Set([...franking.keys(), ...fromEntries.keys()])).sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN')
  )
  return keys.map((key) => {
    const f = franking.get(key)
    const e = fromEntries.get(key)
    const base = e ?? f
    const frankingCount = f?.count ?? 0
    const entriesCount = e?.count ?? 0
    return {
      key,
      stampName: base?.stampName ?? '',
      denomination: base?.denomination ?? 0,
      frankingCount,
      entriesCount,
      draftCount: e?.draftCount ?? 0,
      match: frankingCount === entriesCount
    }
  })
}

/**
 * 回算一份封的贴票对账结果。
 * @param cover    封记录（持有登记表贴票构成与已确认结论快照）
 * @param entries  该封全部票戳组合明细（含待填行）
 */
export function reconcileFranking(
  cover: Cover | null,
  entries: StamplessEntry[]
): ReconcileResult {
  const own = (entries ?? []).filter((e) => cover && e.coverId === cover.id)
  const franking = groupFranking(cover?.franking ?? [])
  const fromEntries = groupEntries(own)
  const lines = buildLines(franking, fromEntries)

  const frankingTotal = [...franking.values()].reduce((sum, acc) => sum + acc.count, 0)
  const entriesTotal = [...fromEntries.values()].reduce((sum, acc) => sum + acc.count, 0)
  const draftTotal = own.filter((e) => e.draft).length

  const effectiveFranking: FrankingItem[] = lines.map((line) => ({
    stampName: line.stampName,
    denomination: line.denomination,
    count: line.entriesCount
  }))

  const sigFranking = frankingSignature(cover?.franking ?? [])
  const sigEntries = entriesSignature(own)
  const conclusionIntact =
    !!cover?.frankingBasis &&
    cover.frankingSig === sigFranking &&
    cover.entriesSig === sigEntries
  const confirmedBasis: FrankingBasis | null = conclusionIntact
    ? (cover?.frankingBasis as FrankingBasis)
    : null

  const hasDraft = draftTotal > 0
  const allMatch = lines.every((line) => line.match)

  let status: ReconcileStatus
  if (confirmedBasis) {
    status = 'matched'
  } else if (cover?.frankingBasis) {
    // 曾确认过，但任一侧改动导致签名对不上 → 结论失效，重新核对
    status = 'stale'
  } else if (hasDraft) {
    status = 'missing'
  } else {
    status = allMatch ? 'matched' : 'mismatch'
  }

  return {
    status,
    lines,
    effectiveFranking,
    frankingTotal,
    entriesTotal,
    draftTotal,
    confirmedBasis
  }
}

/** 目录/详情共用的贴票枚数：统一取明细回算结果（含待填行）。 */
export function effectiveFrankingTotal(result: ReconcileResult): number {
  return result.lines.reduce((sum, line) => sum + line.entriesCount, 0)
}
