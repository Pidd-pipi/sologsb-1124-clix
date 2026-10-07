import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, saveAsset } from '@/utils/db'
import type { Cover, FrankingItem, ReconcileSide } from '@/types/cover'
import type { StamplessEntry } from '@/types/stampentry'
import { nextSerialNo, nowIso } from '@/utils/id'
import type { ImagePayload } from './postmarkStore'
import {
  buildDeficitFillEntries,
  buildToFillEntries,
  evaluateCover,
  excessEntryLines,
  frankingTotal,
  normalizeFranking
} from '@/utils/frankingReconcile'

export interface ConfirmOutcome {
  ok: boolean
  reason?: 'empty-frank' | 'empty-entries' | 'excess-entries' | 'has-tofill'
  excessText?: string
}

export const useCoverStore = defineStore('cover', () => {
  const list = ref<Cover[]>([])
  const entries = ref<StamplessEntry[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      list.value = await db.covers.orderBy('coverNo').toArray()
      entries.value = await db.stampEntries.toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 生成下一个封号，如 CV-0005 */
  function nextCoverNo(): string {
    return nextSerialNo('CV-', list.value.map((c) => c.coverNo))
  }

  /**
   * 新建封：贴票构成先归一化入账，同时按构成逐枚预生成「待填」票戳行；
   * 待填行补齐前该封处于待核对状态。全部写在一个事务里，失败整体回滚。
   */
  async function create(
    input: Cover,
    images?: Partial<Record<'front' | 'back', ImagePayload>>
  ): Promise<number> {
    const now = nowIso()
    const franking = normalizeFranking(input.franking)
    const record: Cover = {
      ...input,
      coverNo: input.coverNo || nextCoverNo(),
      franking,
      cancelPmIds: [...input.cancelPmIds],
      viaPoints: [...input.viaPoints],
      reconcileStatus: 'pending',
      reconcileSide: null,
      reconcileSnapshot: [],
      createdAt: now,
      updatedAt: now
    }
    delete record.id
    const id = await db.transaction('rw', db.covers, db.stampEntries, async () => {
      const newId = await db.covers.add(record)
      const fillRows = buildToFillEntries(newId, franking, now)
      if (fillRows.length) await db.stampEntries.bulkAdd(fillRows)
      return newId
    })
    // 原图单独建表；失败不影响已入账的封（用户可在详情页重新上传）
    for (const side of ['front', 'back'] as const) {
      const payload = images?.[side]
      if (payload && payload.dataUrl) {
        await saveAsset({
          ownerType: 'cover',
          ownerId: id,
          side,
          dataUrl: payload.dataUrl,
          fileName: payload.fileName,
          updatedAt: now
        })
      }
    }
    await load()
    return id
  }

  /**
   * 改封（含登记表贴票构成）：归一化贴票构成并重新对账；
   * 已确认的封一旦两侧数据被改动，结论失效、回到待核对（结论快照保留待重新确认）。
   */
  async function update(id: number, patch: Partial<Cover>): Promise<void> {
    const now = nowIso()
    await db.transaction('rw', db.covers, db.stampEntries, async () => {
      const current = await db.covers.get(id)
      if (!current) throw new Error(`cover ${id} not found`)
      const next: Cover = { ...current, ...patch }
      if (patch.franking) next.franking = normalizeFranking(patch.franking)
      if (patch.cancelPmIds) next.cancelPmIds = [...patch.cancelPmIds]
      if (patch.viaPoints) next.viaPoints = [...patch.viaPoints]
      await recomputeInTx(next, now, Boolean(patch.franking))
    })
    await load()
  }

  async function remove(id: number): Promise<void> {
    await db.transaction('rw', db.covers, db.stampEntries, async () => {
      await db.covers.delete(id)
      const own = await db.stampEntries.where('coverId').equals(id).toArray()
      await db.stampEntries.bulkDelete(
        own.map((e) => e.id).filter((v): v is number => typeof v === 'number')
      )
    })
    await load()
  }

  /**
   * 录入票戳组合明细：与重算同事务，明细侧改动后另一侧的已确认结果立即失效。
   */
  async function addEntry(input: StamplessEntry): Promise<number> {
    const now = nowIso()
    const id = await db.transaction('rw', db.covers, db.stampEntries, async () => {
      const entry: StamplessEntry = { ...input, toFill: input.toFill ?? false, createdAt: now }
      const newId = await db.stampEntries.add(entry)
      await invalidateCoverInTx(input.coverId, now)
      return newId
    })
    await load()
    return id
  }

  /** 删除明细：同样触发重算。 */
  async function removeEntry(id: number): Promise<void> {
    const now = nowIso()
    await db.transaction('rw', db.covers, db.stampEntries, async () => {
      const found = await db.stampEntries.get(id)
      await db.stampEntries.delete(id)
      if (found) await invalidateCoverInTx(found.coverId, now)
    })
    await load()
  }

  /** 保存一条明细（待填行补齐 / 编辑）：保存后立即重算，失败回滚到改动前。 */
  async function saveEntry(input: StamplessEntry): Promise<void> {
    if (typeof input.id !== 'number') throw new Error('entry id required')
    const now = nowIso()
    await db.transaction('rw', db.covers, db.stampEntries, async () => {
      await db.stampEntries.put({ ...input, createdAt: input.createdAt || now })
      await invalidateCoverInTx(input.coverId, now)
    })
    await load()
  }

  /**
   * 选定以哪边为准并写入（同一份账）。
   * - entries：以票戳组合明细回算结果覆盖登记表贴票构成；
   * - franking：以贴票构成为准，只补差（补待填行），不删已有明细；
   *   明细多出且无法收敛时拒绝写入，要求先处理多余明细。
   * 全部同事务，任一步失败回滚，已确认的结论不受影响。
   */
  async function confirmReconcile(coverId: number, side: ReconcileSide): Promise<ConfirmOutcome> {
    const now = nowIso()
    const outcome = await db.transaction(
      'rw',
      db.covers,
      db.stampEntries,
      async (): Promise<ConfirmOutcome> => {
        const cover = await db.covers.get(coverId)
        if (!cover) throw new Error(`cover ${coverId} not found`)
        const own = await db.stampEntries.where('coverId').equals(coverId).toArray()
        const state = evaluateCover(cover.franking, own)

        let canonical: FrankingItem[]
        if (side === 'entries') {
          canonical = state.derived
          if (!canonical.length) return { ok: false, reason: 'empty-entries' }
          if (state.toFillCount > 0) return { ok: false, reason: 'has-tofill' }
        } else {
          canonical = state.declared
          if (!canonical.length) return { ok: false, reason: 'empty-frank' }
          const excess = excessEntryLines(cover.franking, own)
          if (excess.length) {
            return {
              ok: false,
              reason: 'excess-entries',
              excessText: excess
                .map((r) => `${r.stampName} ${r.denomination}（明细 ${r.derivedCount} / 登记 ${r.declaredCount}）`)
                .join('、')
            }
          }
          const fills = buildDeficitFillEntries(coverId, canonical, own, now)
          if (fills.length) await db.stampEntries.bulkAdd(fills)
        }

        const next: Cover = {
          ...cover,
          franking: canonical,
          reconcileStatus: 'confirmed',
          reconcileSide: side,
          reconcileSnapshot: canonical,
          updatedAt: now
        }
        await db.covers.put(next)
        return { ok: true }
      }
    )
    await load()
    return outcome
  }

  /**
   * 事务内重算：按最新两侧数据评估；对得上且无待填行即按明细侧结论入账，
   * 否则置为待核对。wasFrankingEdited 用于决定已确认封失效时保留的基准侧。
   */
  async function recomputeInTx(
    cover: Cover,
    stamp: string,
    wasFrankingEdited: boolean
  ): Promise<void> {
    const own = await db.stampEntries.where('coverId').equals(cover.id as number).toArray()
    const state = evaluateCover(cover.franking, own)
    const next: Cover = { ...cover }
    if (state.canConfirm) {
      next.reconcileStatus = 'confirmed'
      next.reconcileSide = 'entries'
      next.reconcileSnapshot = state.derived
    } else {
      next.reconcileStatus = 'pending'
      // 已确认封因改动失效：保留原结论快照与基准侧，便于重新核对
      if (cover.reconcileStatus === 'confirmed') {
        next.reconcileSide = wasFrankingEdited ? 'franking' : cover.reconcileSide ?? 'entries'
      } else {
        next.reconcileSide = cover.reconcileSide
      }
    }
    next.updatedAt = stamp
    await db.covers.put(next)
  }

  /** 明细侧改动后的失效重算。 */
  async function invalidateCoverInTx(coverId: number, stamp: string): Promise<void> {
    const cover = await db.covers.get(coverId)
    if (!cover) return
    await recomputeInTx(cover, stamp, false)
  }

  function byId(id: number | null | undefined): Cover | null {
    if (id == null) return null
    return list.value.find((c) => c.id === id) ?? null
  }

  /** 某个封下的票戳组合明细 */
  function entriesOf(coverId: number | null | undefined): StamplessEntry[] {
    if (coverId == null) return []
    return entries.value.filter((e) => e.coverId === coverId)
  }

  /**
   * 贴票枚数：目录与卡片一律按同一份归一后的贴票构成合计展示，
   * 不直接数明细，避免两处口径不一。
   */
  function frankingCount(cover: Cover | null): number {
    return cover ? frankingTotal(cover.franking) : 0
  }

  /** 封的实时对账状态（待核对时详情页据此标出差异）。 */
  function reconcileOf(cover: Cover | null | undefined) {
    if (!cover) return null
    return evaluateCover(cover.franking, entriesOf(cover.id))
  }

  /** 是否处于待核对（票名/枚数对不上或仍有待填行）。 */
  function isPending(cover: Cover | null | undefined): boolean {
    if (!cover) return false
    if (cover.reconcileStatus !== 'confirmed') return true
    const state = reconcileOf(cover)
    return !state?.canConfirm
  }

  /** 关联邮戳数（行内展示用） */
  function cancelCount(cover: Cover | null): number {
    return cover ? cover.cancelPmIds.length : 0
  }

  const coversOfRoute = computed(() => {
    return (routeId: number): Cover[] => list.value.filter((c) => c.routeId === routeId)
  })

  const total = computed(() => list.value.length)
  const registeredCount = computed(() => list.value.filter((c) => c.registered).length)
  /** 待核对封数（目录合计按同一结果展示） */
  const pendingCount = computed(() => list.value.filter((c) => isPending(c)).length)

  return {
    list,
    entries,
    loading,
    loaded,
    total,
    registeredCount,
    pendingCount,
    coversOfRoute,
    load,
    nextCoverNo,
    create,
    update,
    remove,
    addEntry,
    removeEntry,
    saveEntry,
    confirmReconcile,
    byId,
    entriesOf,
    frankingCount,
    reconcileOf,
    isPending,
    cancelCount
  }
})
