/** 实寄封（Cover）数据模型：一封实际寄递过的信封的全部编目事实。 */

/** 品相 */
export type ConditionGrade = '上品' | '中品' | '下品'

/** 贴票构成：票种 + 面值 + 枚数 */
export interface FrankingItem {
  stampName: string
  denomination: number
  count: number
}

/** 对账基准侧：以详情页票戳组合明细为准，或以登记表贴票构成为准 */
export type ReconcileSide = 'entries' | 'franking'

/** 对账状态：pending 待核对（含结果未确认），confirmed 已确认入账 */
export type ReconcileStatus = 'pending' | 'confirmed'

export interface Cover {
  id?: number
  /** 封号，如 CV-0001 */
  coverNo: string
  sentFrom: string
  sentTo: string
  /** 寄出日期 YYYY-MM-DD */
  postDate: string
  /** 到达日期 YYYY-MM-DD */
  arriveDate: string
  franking: FrankingItem[]
  /** 关联邮戳 id 列表 */
  cancelPmIds: number[]
  /** 所属邮路 id */
  routeId: number | null
  /** 中转地数组 */
  viaPoints: string[]
  /** 是否给据邮件 */
  registered: boolean
  conditionGrade: ConditionGrade
  /** 来源 */
  acquireFrom: string
  /** 购入价（元） */
  price: number
  /** 藏册页位 */
  storageAlbum: string
  /** 封面正面图（缩略 dataURL；原图存 assets 表） */
  frontImage: string
  /** 封面背面图（缩略 dataURL；原图存 assets 表） */
  backImage: string
  note: string
  /** pending 待核对（含旧数据升级后对不上 / 缺明细）/ confirmed 已确认入账 */
  reconcileStatus: ReconcileStatus
  /** 入账基准侧：确认时以哪边结果写入并同步两侧；待核对时保留上次选择 */
  reconcileSide: ReconcileSide | null
  /** 已确认结论的快照（归一后的贴票构成）；任一侧改动后失效重算，结论保留待重新确认 */
  reconcileSnapshot: FrankingItem[]
  createdAt: string
  updatedAt: string
}

export const CONDITION_GRADES: ConditionGrade[] = ['上品', '中品', '下品']

/** 生成一条空白实寄封记录，供表单初始化使用。 */
export function createEmptyCover(): Cover {
  return {
    coverNo: '',
    sentFrom: '',
    sentTo: '',
    postDate: '',
    arriveDate: '',
    franking: [],
    cancelPmIds: [],
    routeId: null,
    viaPoints: [],
    registered: false,
    conditionGrade: '中品',
    acquireFrom: '',
    price: 0,
    storageAlbum: '',
    frontImage: '',
    backImage: '',
    note: '',
    reconcileStatus: 'pending',
    reconcileSide: null,
    reconcileSnapshot: [],
    createdAt: '',
    updatedAt: ''
  }
}
