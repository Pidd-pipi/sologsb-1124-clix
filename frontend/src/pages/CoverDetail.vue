<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile } from 'element-plus'
import RouteTimeline from '@/components/common/RouteTimeline.vue'
import ScarceTag from '@/components/common/ScarceTag.vue'
import StampCard from '@/components/common/StampCard.vue'
import { useCoverRoute } from '@/hooks/useCoverRoute'
import { useCoverStore } from '@/stores/coverStore'
import { usePostmarkStore } from '@/stores/postmarkStore'
import { useRouteStore } from '@/stores/routeStore'
import type { FrankingItem, ReconcileSide } from '@/types/cover'
import type { Postmark } from '@/types/postmark'
import type { TimelineNode } from '@/types/route'
import type { StamplessEntry } from '@/types/stampentry'
import {
  COVER_POSITIONS,
  VARIETY_TYPES,
  createEmptyStampEntry
} from '@/types/stampentry'
import { CONDITION_GRADES } from '@/types/cover'
import { loadAssets, saveAsset } from '@/utils/db'
import { frankingTotal } from '@/utils/frankingReconcile'
import { nowIso } from '@/utils/id'

const props = defineProps<{ id: string }>()
const router = useRouter()
const coverStore = useCoverStore()
const postmarkStore = usePostmarkStore()
const routeStore = useRouteStore()

const coverId = computed<number | null>(() => {
  const n = Number(props.id)
  return Number.isFinite(n) && n > 0 ? n : null
})

const { cover, route, timeline, transitDays, missingDateNodes, chronological, error, load } =
  useCoverRoute(coverId)

const frontUrl = ref('')
const backUrl = ref('')
const entryDialog = ref(false)
const entryDialogTitle = ref('录入票戳组合')
const exportDialog = ref(false)
const exportText = ref('')
const pmDialog = ref(false)
const activePostmark = ref<Postmark | null>(null)
const entryForm = reactive<StamplessEntry>(createEmptyStampEntry(0))

const entries = computed<StamplessEntry[]>(() => coverStore.entriesOf(coverId.value))

/** 对账状态：以票戳组合明细回算贴票构成，与登记表逐行比对 */
const reconcile = computed(() =>
  cover.value ? coverStore.reconcileOf(cover.value) : null
)

/** 数据库里记录的确认状态，与实时计算合并得到当前是否有效 */
const confirmed = computed(
  () => cover.value?.reconcileStatus === 'confirmed' && !!reconcile.value?.canConfirm
)

const diffRows = computed(() => reconcile.value?.diff.rows ?? [])
const declaredTotal = computed(() => frankingTotal(cover.value?.franking ?? []))
const derivedTotal = computed(() =>
  reconcile.value ? frankingTotal(reconcile.value.derived) : 0
)
const toFillEntries = computed(() => entries.value.filter((e) => e.toFill))
const stale = computed(
  () => cover.value?.reconcileStatus === 'confirmed' && !reconcile.value?.canConfirm
)

function formatFranking(items: FrankingItem[]): string {
  return items.length
    ? items.map((f) => `${f.stampName} ${f.denomination}×${f.count}`).join('，')
    : '（空）'
}

onMounted(async () => {
  if (!coverStore.loaded) await coverStore.load()
  if (!postmarkStore.loaded) await postmarkStore.load()
  if (!routeStore.loaded) await routeStore.load()
  await loadAssetsForCover()
})

watch(coverId, () => void loadAssetsForCover())

watch(
  () => cover.value?.id,
  () => {
    if (cover.value) void loadAssetsForCover()
  }
)

async function loadAssetsForCover(): Promise<void> {
  const id = coverId.value
  frontUrl.value = cover.value?.frontImage ?? ''
  backUrl.value = cover.value?.backImage ?? ''
  if (id == null) return
  const assets = await loadAssets('cover', id)
  const front = assets.find((a) => a.side === 'front')
  const back = assets.find((a) => a.side === 'back')
  if (front) frontUrl.value = front.dataUrl
  if (back) backUrl.value = back.dataUrl
}

async function replaceImage(side: 'front' | 'back', file: UploadFile): Promise<void> {
  const id = coverId.value
  const raw = file.raw
  if (id == null || !raw) return
  if (raw.size > 2 * 1024 * 1024) {
    ElMessage.warning('封图请控制在 2MB 以内')
    return
  }
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(raw)
  })
  await saveAsset({
    ownerType: 'cover',
    ownerId: id,
    side,
    dataUrl,
    fileName: raw.name,
    updatedAt: nowIso()
  })
  await coverStore.update(id, side === 'front' ? { frontImage: dataUrl } : { backImage: dataUrl })
  await loadAssetsForCover()
  ElMessage.success(side === 'front' ? '已更新正面图' : '已更新背面图')
}

function onFrontChange(file: UploadFile): void {
  void replaceImage('front', file)
}

function onBackChange(file: UploadFile): void {
  void replaceImage('back', file)
}

async function setGrade(grade: string): Promise<void> {
  const id = coverId.value
  if (id == null) return
  await coverStore.update(id, { conditionGrade: grade as '上品' | '中品' | '下品' })
  await load()
  ElMessage.success(`品相已标记为${grade}`)
}

function openEntryDialog(): void {
  const id = coverId.value
  if (id == null) return
  Object.assign(entryForm, createEmptyStampEntry(id))
  entryDialogTitle.value = '录入票戳组合'
  entryDialog.value = true
}

/** 编辑已有明细（含待填行补齐）：补齐后 toFill 置否并保存，保存触发重新对账。 */
function openEntryEdit(entry: StamplessEntry): void {
  Object.assign(entryForm, { ...entry })
  entryDialogTitle.value = entry.toFill ? '补齐票戳明细' : '编辑票戳组合'
  entryDialog.value = true
}

async function submitEntry(): Promise<void> {
  const id = coverId.value
  if (id == null) return
  if (!entryForm.stampName.trim()) {
    ElMessage.warning('请填写邮票名称')
    return
  }
  let failed = false
  try {
    if (typeof entryForm.id === 'number') {
      const wasToFill = entryForm.toFill
      await coverStore.saveEntry({ ...entryForm, coverId: id, toFill: false })
      ElMessage.success(wasToFill ? '明细已补齐，对账结果已重算' : '票戳组合已保存')
    } else {
      await coverStore.addEntry({ ...entryForm, coverId: id, toFill: false })
      ElMessage.success('已加入票戳组合')
    }
  } catch {
    failed = true
    ElMessage.error('保存失败，已恢复到改动前，可修改后重试')
  }
  if (failed) return
  entryDialog.value = false
  await load()
}

async function removeEntry(entry: StamplessEntry): Promise<void> {
  if (typeof entry.id !== 'number') return
  try {
    await coverStore.removeEntry(entry.id)
    await load()
    ElMessage.success('已移除该组合，对账结果已重算')
  } catch {
    ElMessage.error('删除失败，已恢复到改动前')
  }
}

/** 选定以哪边为准后才写入；任一步失败事务回滚，已确认的封保留结论。 */
async function confirmWith(side: ReconcileSide): Promise<void> {
  const id = coverId.value
  if (id == null) return
  const label = side === 'entries' ? '票戳组合明细' : '登记表贴票构成'
  try {
    await ElMessageBox.confirm(
      `确认以${label}为准写入同一份账？${side === 'entries' ? '登记表贴票构成将被明细回算结果覆盖。' : '将按贴票构成补出待填行，已有明细不删除。'}`,
      '确认入账基准',
      { confirmButtonText: `以${label}为准`, cancelButtonText: '再核一核', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    const outcome = await coverStore.confirmReconcile(id, side)
    await load()
    if (!outcome.ok) {
      if (outcome.reason === 'empty-entries') ElMessage.warning('票戳明细为空，无法以明细为准')
      else if (outcome.reason === 'has-tofill')
        ElMessage.warning('尚有待填行未补齐，请先补齐票戳明细或改以贴票构成为准')
      else if (outcome.reason === 'empty-frank') ElMessage.warning('贴票构成为空，无法以登记表为准')
      else if (outcome.reason === 'excess-entries')
        ElMessage.warning(
          `明细多出贴票构成（${outcome.excessText}），请先删除多余明细或改以明细为准`
        )
      return
    }
    ElMessage.success(`已按${label}入账，两处已对齐`)
  } catch {
    ElMessage.error('写入失败，已整体回滚到改动前，已确认结论不变')
  }
}

function buildExportText(): string {
  const c = cover.value
  if (!c) return ''
  const state = reconcile.value
  const lines = [
    `票戳明细导出 · ${c.coverNo}`,
    `收寄：${c.sentFrom} → ${c.sentTo}`,
    `寄出/到达：${c.postDate || '待考'} / ${c.arriveDate || '待考'}`,
    `品相：${c.conditionGrade}　给据：${c.registered ? '是' : '否'}`,
    `对账：${confirmed.value ? '已确认入账' : '待核对'}（登记 ${declaredTotal.value} 枚 / 明细回算 ${derivedTotal.value} 枚）`,
    '序号,邮票名称,面值,发行年份,齿度,变体,封上位置,待填'
  ]
  entries.value.forEach((e, i) => {
    lines.push(
      [
        i + 1,
        e.stampName,
        e.denomination,
        e.issueYear,
        e.perforation,
        e.variety,
        e.positionOnCover,
        e.toFill ? '待填' : ''
      ].join(',')
    )
  })
  if (!entries.value.length) lines.push('（暂无票戳组合，请先录入）')
  if (state && !state.canConfirm) {
    lines.push('差异：')
    for (const row of state.diff.rows) {
      if (row.delta !== 0) {
        lines.push(
          `${row.stampName} ${row.denomination}：登记 ${row.declaredCount} 枚，明细 ${row.derivedCount} 枚，差 ${row.delta > 0 ? '+' : ''}${row.delta}`
        )
      }
    }
  }
  return lines.join('\n')
}

async function exportEntries(): Promise<void> {
  exportText.value = buildExportText()
  exportDialog.value = true
}

async function copyExport(): Promise<void> {
  try {
    await navigator.clipboard.writeText(exportText.value)
    ElMessage.success('票戳明细已复制')
  } catch {
    ElMessage.info('浏览器未授权剪贴板，请手动选择文本')
  }
}

function showPostmark(pm: Postmark): void {
  activePostmark.value = pm
  pmDialog.value = true
}

/** 待填行整行淡色底，提示需要补齐。 */
function entryRowClass({ row }: { row: StamplessEntry }): string {
  return row.toFill ? 'row-tofill' : ''
}

const cancelPostmarks = computed<Postmark[]>(() =>
  (cover.value?.cancelPmIds ?? [])
    .map((id) => postmarkStore.byId(id))
    .filter((pm): pm is Postmark => pm != null)
)

function onTimelineSelect(node: TimelineNode): void {
  if (node.kind === 'transit') ElMessage.info(`中转节点：${node.office}（${node.mark}）`)
}

function backToList(): void {
  void router.push('/covers')
}

function openRoute(): void {
  if (route.value?.id != null) void router.push(`/routes/${route.value.id}`)
}
</script>

<template>
  <div class="gb-page cover-detail">
    <header class="gb-page__head">
      <div>
        <h1 class="gb-page__title">
          实寄封详情
          <span v-if="cover" class="cover-detail__no">{{ cover.coverNo }}</span>
        </h1>
        <p class="gb-page__subtitle">
          <template v-if="cover">
            {{ cover.sentFrom }} → {{ cover.sentTo }} · 寄出 {{ cover.postDate || '待考' }} · 到达
            {{ cover.arriveDate || '待考' }}
          </template>
          <template v-else>按封号读取寄递事实、票戳组合与邮路时间轴。</template>
        </p>
      </div>
      <div class="cover-detail__actions">
        <el-button @click="backToList">返回目录</el-button>
        <el-button v-if="route" type="primary" plain @click="openRoute">打开邮路编辑器</el-button>
      </div>
    </header>

    <p v-if="error" class="gb-empty">{{ error }}</p>

    <template v-else-if="cover">
      <section class="gb-panel">
        <h2 class="gb-panel__title">寄递事实</h2>
        <dl class="gb-facts">
          <div><dt>封号</dt><dd>{{ cover.coverNo }}</dd></div>
          <div><dt>寄出地</dt><dd>{{ cover.sentFrom }}</dd></div>
          <div><dt>收件地</dt><dd>{{ cover.sentTo }}</dd></div>
          <div><dt>寄出日期</dt><dd>{{ cover.postDate || '待考' }}</dd></div>
          <div><dt>到达日期</dt><dd>{{ cover.arriveDate || '待考' }}</dd></div>
          <div><dt>在途天数</dt><dd>{{ transitDays == null ? '待考' : `${transitDays} 天` }}</dd></div>
          <div><dt>中转地</dt><dd>{{ cover.viaPoints.length ? cover.viaPoints.join('、') : '直封' }}</dd></div>
          <div><dt>给据邮件</dt><dd>{{ cover.registered ? '是' : '否' }}</dd></div>
          <div><dt>来源</dt><dd>{{ cover.acquireFrom || '未记' }}</dd></div>
          <div><dt>购入价</dt><dd>{{ cover.price }} 元</dd></div>
          <div><dt>藏册页位</dt><dd>{{ cover.storageAlbum || '未入册' }}</dd></div>
          <div>
            <dt>贴票枚数</dt>
            <dd>
              {{ declaredTotal }} 枚
              <el-tag v-if="!confirmed" size="small" type="warning" effect="plain">待核对</el-tag>
              <el-tag v-else size="small" type="success" effect="plain">已核对</el-tag>
            </dd>
          </div>
          <div><dt>所属邮路</dt><dd>{{ route ? `${route.routeNo} ${route.name}` : '未挂邮路' }}</dd></div>
        </dl>
        <div class="cover-detail__grade">
          <span class="cover-detail__grade-label">标记品相：</span>
          <el-radio-group
            :model-value="cover.conditionGrade"
            size="small"
            @update:model-value="setGrade(String($event))"
          >
            <el-radio-button v-for="g in CONDITION_GRADES" :key="g" :value="g">{{ g }}</el-radio-button>
          </el-radio-group>
          <ScarceTag :level="cover.conditionGrade" kind="grade" prefix="当前：" />
        </div>
      </section>

      <section class="cover-detail__figures">
        <div class="gb-figure">
          <img v-if="frontUrl" :src="frontUrl" :alt="`${cover.coverNo} 正面`" />
          <span v-else class="cover-detail__no-image">尚未上传正面图</span>
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            accept="image/*"
            :on-change="onFrontChange"
          >
            <el-button size="small">上传/替换正面图</el-button>
          </el-upload>
        </div>
        <div class="gb-figure">
          <img v-if="backUrl" :src="backUrl" :alt="`${cover.coverNo} 背面`" />
          <span v-else class="cover-detail__no-image">尚未上传背面图</span>
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            accept="image/*"
            :on-change="onBackChange"
          >
            <el-button size="small">上传/替换背面图</el-button>
          </el-upload>
        </div>
      </section>

      <section class="gb-panel">
        <h2 class="gb-panel__title">寄递事实时间轴</h2>
        <p v-if="!chronological" class="cover-detail__warn">
          日期先后有误：请核对寄出、中转与到达日期的顺序。
        </p>
        <p v-else-if="missingDateNodes.length" class="cover-detail__warn">
          缺日警示：{{ missingDateNodes.map((n) => n.office).join('、') }} 尚未确定日期。
        </p>
        <RouteTimeline :nodes="timeline" @select="onTimelineSelect" />
      </section>

      <section class="gb-panel cover-detail__reconcile">
        <div class="cover-detail__section-head">
          <h2 class="gb-panel__title">
            贴票对账
            <el-tag v-if="confirmed" size="small" type="success" effect="plain" class="cover-detail__reconcile-tag">
              已确认入账
            </el-tag>
            <el-tag v-else size="small" type="warning" effect="plain" class="cover-detail__reconcile-tag">
              待核对
            </el-tag>
          </h2>
          <span class="cover-detail__reconcile-count">
            登记 {{ declaredTotal }} 枚 · 明细回算 {{ derivedTotal }} 枚
          </span>
        </div>

        <p v-if="stale" class="cover-detail__warn">
          原已确认的结论已因数据改动失效，请按下方差异重新核对；改动未确认前目录暂按登记表贴票构成合计。
        </p>

        <template v-if="reconcile">
          <el-table :data="diffRows" border stripe size="small" class="cover-detail__diff">
            <el-table-column label="邮票名称" min-width="150">
              <template #default="{ row }">{{ row.stampName }}</template>
            </el-table-column>
            <el-table-column prop="denomination" label="面值" width="90" />
            <el-table-column label="登记表（贴票构成）" width="150" align="center">
              <template #default="{ row }">
                <span :class="{ 'cover-detail__diff-bad': row.delta !== 0 }">{{ row.declaredCount }} 枚</span>
              </template>
            </el-table-column>
            <el-table-column label="详情页（明细回算）" width="150" align="center">
              <template #default="{ row }">
                <span :class="{ 'cover-detail__diff-bad': row.delta !== 0 }">{{ row.derivedCount }} 枚</span>
              </template>
            </el-table-column>
            <el-table-column label="差异" width="120" align="center">
              <template #default="{ row }">
                <el-tag v-if="row.delta === 0" size="small" type="success" effect="plain">一致</el-tag>
                <el-tag v-else size="small" type="danger" effect="dark">
                  {{ row.delta > 0 ? `明细多 ${row.delta}` : `明细少 ${-row.delta}` }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>

          <p v-if="toFillEntries.length" class="cover-detail__warn">
            有 {{ toFillEntries.length }} 行票戳明细待补（按贴票构成预生成）：
            {{ formatFranking(reconcile.declared) }}。补全行内信息后自动重新对账。
          </p>

          <div v-if="!confirmed" class="cover-detail__reconcile-actions">
            <span class="cover-detail__reconcile-hint">对不上时请先选好以哪边为准，再写入：</span>
            <el-button
              size="small"
              type="primary"
              plain
              :disabled="derivedTotal === 0"
              @click="confirmWith('entries')"
            >
              以票戳明细为准（回算 {{ derivedTotal }} 枚写入登记）
            </el-button>
            <el-button
              size="small"
              type="warning"
              plain
              :disabled="declaredTotal === 0"
              @click="confirmWith('franking')"
            >
              以贴票构成为准（按 {{ declaredTotal }} 枚补待填行）
            </el-button>
          </div>
          <p v-else class="cover-detail__reconcile-ok">
            两处已按同一结果入账：{{ formatFranking(reconcile.derived) }}。
          </p>
        </template>
      </section>

      <section class="gb-panel">
        <div class="cover-detail__section-head">
          <h2 class="gb-panel__title">
            票戳组合表（{{ entries.length }} 条）
            <el-tag v-if="toFillEntries.length" size="small" type="info" effect="plain">
              {{ toFillEntries.length }} 行待填
            </el-tag>
          </h2>
          <span>
            <el-button size="small" @click="exportEntries">导出票戳明细</el-button>
            <el-button size="small" type="primary" @click="openEntryDialog">录入组合</el-button>
          </span>
        </div>
        <el-table :data="entries" border stripe :row-class-name="entryRowClass">
          <el-table-column label="序号" width="64">
            <template #default="{ $index }">{{ $index + 1 }}</template>
          </el-table-column>
          <el-table-column prop="stampName" label="邮票名称" min-width="140">
            <template #default="{ row }">
              {{ row.stampName }}
              <el-tag v-if="row.toFill" size="small" type="info" effect="plain">待填</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="denomination" label="面值" width="80" />
          <el-table-column prop="issueYear" label="发行年份" width="92" />
          <el-table-column prop="perforation" label="齿度" width="84">
            <template #default="{ row }">{{ row.perforation || '待补' }}</template>
          </el-table-column>
          <el-table-column prop="variety" label="变体" width="92" />
          <el-table-column prop="positionOnCover" label="封上位置" width="96" />
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button size="small" link type="primary" @click="openEntryEdit(row)">
                {{ row.toFill ? '补齐' : '编辑' }}
              </el-button>
              <el-button size="small" link type="danger" @click="removeEntry(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section class="gb-panel">
        <h2 class="gb-panel__title">关联邮戳（{{ cancelPostmarks.length }} 枚）</h2>
        <p v-if="!cancelPostmarks.length" class="gb-empty">该封尚未关联销票邮戳。</p>
        <div v-else class="gb-grid">
          <StampCard
            v-for="pm in cancelPostmarks"
            :key="pm.id"
            :postmark="pm"
            @select="showPostmark"
          />
        </div>
      </section>
    </template>

    <el-dialog v-model="entryDialog" :title="entryDialogTitle" width="560px">
      <el-form label-width="96px">
        <el-form-item label="邮票名称">
          <el-input v-model="entryForm.stampName" placeholder="如 蟠龙邮票" />
        </el-form-item>
        <el-form-item label="面值">
          <el-input-number v-model="entryForm.denomination" :min="0" :precision="1" />
        </el-form-item>
        <el-form-item label="发行年份">
          <el-input-number v-model="entryForm.issueYear" :min="1800" :max="2100" />
        </el-form-item>
        <el-form-item label="齿度">
          <el-input v-model="entryForm.perforation" placeholder="如 P11 / P12.5" />
        </el-form-item>
        <el-form-item label="变体">
          <el-select v-model="entryForm.variety" style="width: 100%">
            <el-option v-for="v in VARIETY_TYPES" :key="v" :label="v" :value="v" />
          </el-select>
        </el-form-item>
        <el-form-item label="封上位置">
          <el-select v-model="entryForm.positionOnCover" style="width: 100%">
            <el-option v-for="p in COVER_POSITIONS" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="entryDialog = false">取消</el-button>
        <el-button type="primary" @click="submitEntry">保存组合</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="exportDialog" title="票戳明细导出" width="620px">
      <el-input v-model="exportText" type="textarea" :rows="12" readonly />
      <template #footer>
        <el-button @click="exportDialog = false">关闭</el-button>
        <el-button type="primary" @click="copyExport">复制明细</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pmDialog" title="邮戳档案" width="520px">
      <div v-if="activePostmark" class="cover-detail__pm">
        <img
          v-if="activePostmark.imageDataUrl"
          :src="activePostmark.imageDataUrl"
          :alt="`${activePostmark.pmNo} 戳样`"
        />
        <dl class="gb-facts">
          <div><dt>编目号</dt><dd>{{ activePostmark.pmNo }}</dd></div>
          <div><dt>戳型</dt><dd>{{ activePostmark.type }}</dd></div>
          <div><dt>局所</dt><dd>{{ activePostmark.office }}</dd></div>
          <div><dt>使用年代</dt><dd>{{ activePostmark.yearFrom }}-{{ activePostmark.yearTo }}</dd></div>
          <div><dt>戳面日期</dt><dd>{{ activePostmark.dateOnStamp || '未注' }}</dd></div>
          <div><dt>戳径/墨色</dt><dd>{{ activePostmark.diameter }}mm / {{ activePostmark.inkColor }}</dd></div>
        </dl>
        <ScarceTag :level="activePostmark.scarceLevel" />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.cover-detail__no {
  color: #5d3325;
  font-size: 18px;
  margin-left: 8px;
}
.cover-detail__actions {
  display: flex;
  gap: 10px;
}
.cover-detail__grade {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.cover-detail__grade-label {
  font-size: 13px;
  color: var(--gb-muted);
}
.cover-detail__figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}
.cover-detail__no-image {
  display: block;
  font-size: 12px;
  color: var(--gb-muted);
  margin-bottom: 8px;
}
.cover-detail__warn {
  margin: 0 0 10px;
  font-size: 13px;
  color: #b06f16;
  background: #fdf5e6;
  border: 1px solid #ecd3a5;
  border-radius: 8px;
  padding: 6px 10px;
}
.cover-detail__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.cover-detail__pm img {
  max-width: 100%;
  border-radius: 8px;
  margin-bottom: 10px;
}
.cover-detail__reconcile {
  border-color: #d8b88c;
}
.cover-detail__reconcile-tag {
  margin-left: 8px;
}
.cover-detail__reconcile-count {
  font-size: 13px;
  color: var(--gb-muted);
}
.cover-detail__diff-bad {
  color: #b3261e;
  font-weight: 600;
}
.cover-detail__reconcile-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.cover-detail__reconcile-hint {
  font-size: 13px;
  color: var(--gb-muted);
}
.cover-detail__reconcile-ok {
  margin: 10px 0 0;
  font-size: 13px;
  color: #2f7a4d;
}
.cover-detail__diff {
  margin-top: 8px;
}
:deep(.row-tofill) {
  background: #faf4e6 !important;
}
</style>
