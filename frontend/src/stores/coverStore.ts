import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db, saveAsset } from '@/utils/db'
import type { Cover, FrankingBasis, FrankingItem } from '@/types/cover'
import type { StamplessEntry } from '@/types/stampentry'
import { nextSerialNo, nowIso } from '@/utils/id'
import type { ImagePayload } from './postmarkStore'
import {
  buildDraftEntries,
  effectiveFrankingTotal,
  entriesSignature,
  frankingSignature,
  reconcileFranking,
  type ReconcileResult,
  type ReconcileStatus
} from '@/utils/frankingReconcile'

/** 选边写入前的校验结果，交由详情页提示具体差异。 */
export interface ResolveCheck {
  ok: boolean
  message: string
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

  async function create(
    input: Cover,
    images?: Partial<Record<'front' | 'back', ImagePayload>>
  ): Promise<number> {
    const now = nowIso()
    const record: Cover = {
      ...input,
      coverNo: input.coverNo || nextCoverNo(),
      franking: input.franking.map((f) => ({ ...f })),
      cancelPmIds: [...input.cancelPmIds],
      viaPoints: [...input.viaPoints],
      // 新登记的封尚未核对；明细补齐前按未确认处理
      frankingBasis: null,
      frankingSig: '',
      entriesSig: '',
      createdAt: now,
      updatedAt: now
    }
    delete record.id
    const id = await db.covers.add(record)
    try {
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
    } catch (err) {
      // 保存失败恢复到改动前：删掉刚建的封及其待填结论，不留半截记录
      await db.covers.delete(id)
      await load()
      throw err
    }
    await load()
    return id
  }

  async function update(id: number, patch: Partial<Cover>): Promise<void> {
    await db.covers.update(id, { ...patch, updatedAt: nowIso() })
    await load()
  }

  async function remove(id: number): Promise<void> {
    await db.covers.delete(id)
    const own = await db.stampEntries.where('coverId').equals(id).toArray()
    await db.stampEntries.bulkDelete(own.map((e) => e.id).filter((v): v is number => typeof v === 'number'))
    await load()
  }

  async function addEntry(input: StamplessEntry): Promise<number> {
    const id = await db.stampEntries.add({ ...input, createdAt: nowIso() })
    await load()
    return id
  }

  /** 补录待填行：把待填占位转成一条正式票戳明细，任一步失败整体回滚。 */
  async function fillDraftEntry(draftId: number, form: StamplessEntry): Promise<void> {
    await db.transaction('rw', db.stampEntries, async () => {
      const draft = await db.stampEntries.get(draftId)
      if (!draft) throw new Error('待填行已不存在')
      await db.stampEntries.put({
        ...draft,
        ...form,
        id: draftId,
        coverId: draft.coverId,
        draft: false,
        createdAt: draft.createdAt || nowIso()
      })
    })
    await load()
  }

  /** 更新一条正式票戳明细（票名/面值/变体等改动会使本封核对结论失效）。 */
  async function updateEntry(id: number, patch: Partial<StamplessEntry>): Promise<void> {
    await db.stampEntries.update(id, patch)
    await load()
  }

  async function removeEntry(id: number): Promise<void> {
    await db.stampEntries.delete(id)
    await load()
  }

  function byId(id: number | null | undefined): Cover | null {
    if (id == null) return null
    return list.value.find((c) => c.id === id) ?? null
  }

  /** 某个封下的票戳组合明细（待填行排在正式明细之后） */
  function entriesOf(coverId: number | null | undefined): StamplessEntry[] {
    if (coverId == null) return []
    return entries.value
      .filter((e) => e.coverId === coverId)
      .sort((a, b) => Number(a.draft) - Number(b.draft))
  }

  /** 某个封的贴票对账结果（目录与详情共用的同一份账） */
  function reconcileOf(cover: Cover | null): ReconcileResult {
    if (!cover) {
      return {
        status: 'matched',
        lines: [],
        effectiveFranking: [],
        frankingTotal: 0,
        entriesTotal: 0,
        draftTotal: 0,
        confirmedBasis: null
      }
    }
    return reconcileFranking(
      cover,
      entries.value.filter((e) => e.coverId === cover.id)
    )
  }

  /** 选边写入前校验：明细多出或存在待填行时不能直接确认。 */
  function checkResolve(cover: Cover | null, basis: FrankingBasis): ResolveCheck {
    const result = reconcileOf(cover)
    if (!cover) return { ok: false, message: '实寄封不存在' }
    if (basis === 'franking') {
      const extra = result.lines.filter(
        (line) => line.entriesCount - line.draftCount > line.frankingCount
      )
      if (extra.length) {
        return {
          ok: false,
          message: `票戳明细多出 ${extra
            .map((l) => `${l.stampName || '（未填票名）'}×${l.entriesCount - l.draftCount - l.frankingCount}`)
            .join('、')}，请先在明细中删除或改以明细为准`
        }
      }
      return { ok: true, message: '' }
    }
    // 以明细为准：存在待填行说明明细还没补齐
    if (result.draftTotal > 0) {
      return {
        ok: false,
        message: `尚有 ${result.draftTotal} 条待填行，请在票戳组合表补录后再以明细为准`
      }
    }
    return { ok: true, message: '' }
  }

  /**
   * 选好以哪边为准后写入，同事务更新两侧并落核对签名。
   * - 以明细为准：用回算结果覆盖登记表贴票构成；
   * - 以构成为准：清掉旧待填行，按缺口重新补待填行；
   * 任一步失败事务回滚，两侧都恢复到改动前，已确认的其他封结论不动。
   */
  async function resolveFranking(id: number, basis: FrankingBasis): Promise<void> {
    const cover = byId(id)
    if (!cover) throw new Error('实寄封不存在')
    const check = checkResolve(cover, basis)
    if (!check.ok) throw new Error(check.message)

    const now = nowIso()
    await db.transaction('rw', db.covers, db.stampEntries, async () => {
      const current = await db.covers.get(id)
      if (!current) throw new Error('实寄封已被删除')
      const own = await db.stampEntries.where('coverId').equals(id).toArray()
      let finalFranking = current.franking.map((f) => ({ ...f }))
      let finalEntries = own.map((e) => ({ ...e }))

      if (basis === 'entries') {
        const grouped = new Map<string, FrankingItem>()
        for (const entry of own) {
          const key = `${entry.stampName.trim()}@${Number(entry.denomination) || 0}`
          const acc = grouped.get(key)
          if (acc) acc.count += 1
          else grouped.set(key, { stampName: entry.stampName.trim(), denomination: Number(entry.denomination) || 0, count: 1 })
        }
        finalFranking = [...grouped.values()]
      } else {
        // 以构成为准：旧待填行清掉，按当前构成缺口重补
        const formal = finalEntries.filter((e) => !e.draft)
        await db.stampEntries.bulkDelete(
          finalEntries.filter((e) => e.draft).map((e) => e.id).filter((v): v is number => typeof v === 'number')
        )
        const drafts = buildDraftEntries(id, finalFranking, formal, now)
        if (drafts.length) await db.stampEntries.bulkAdd(drafts)
        finalEntries = [...formal, ...drafts]
      }

      await db.covers.update(id, {
        franking: finalFranking,
        frankingBasis: basis,
        frankingSig: frankingSignature(finalFranking),
        entriesSig: entriesSignature(finalEntries),
        updatedAt: now
      })
    })
    await load()
  }

  /** 贴票枚数：统一按明细回算结果（含待填行），目录与详情同一数字。 */
  function frankingCount(cover: Cover | null): number {
    if (!cover) return 0
    return effectiveFrankingTotal(reconcileOf(cover))
  }

  /** 待核对封数（对不上、缺待填行、结论失效）。 */
  const pendingCount = computed(() =>
    list.value.filter((c) => reconcileOf(c).status !== 'matched').length
  )

  /** 全目录贴票总枚数（按同一份账合计）。 */
  const totalStampCount = computed(() =>
    list.value.reduce((sum, cover) => sum + effectiveFrankingTotal(reconcileOf(cover)), 0)
  )

  /** 关联邮戳数（行内展示用） */
  function cancelCount(cover: Cover | null): number {
    return cover ? cover.cancelPmIds.length : 0
  }

  const coversOfRoute = computed(() => {
    return (routeId: number): Cover[] => list.value.filter((c) => c.routeId === routeId)
  })

  const total = computed(() => list.value.length)
  const registeredCount = computed(() => list.value.filter((c) => c.registered).length)

  return {
    list,
    entries,
    loading,
    loaded,
    total,
    registeredCount,
    pendingCount,
    totalStampCount,
    coversOfRoute,
    load,
    nextCoverNo,
    create,
    update,
    remove,
    addEntry,
    fillDraftEntry,
    updateEntry,
    removeEntry,
    resolveFranking,
    checkResolve,
    byId,
    entriesOf,
    reconcileOf,
    frankingCount,
    cancelCount
  }
})

export type { ReconcileResult, ReconcileStatus }
