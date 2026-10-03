/**
 * 封存档案领域模型
 * 按「电梯 + 结清月份」把已签署保养计划、对应保养项及异常项转出的整改单
 * 装成独立档案（archive）；现行台账（elevators/plans/checkItems/rectifies）保留不动。
 * 档案导出 / 导入使用独立 JSON，粘回空库或已有台账时逐层核对，
 * 缺项或号段冲突进待处理区，不写入半份数据。
 */
import type { Elevator } from './elevator';
import type { Plan } from './plan';
import type { CheckItem } from './checkItem';
import type { Rectify } from './rectify';
import type { Revisioned } from './persistence';

/** 档案格式版本（随封存结构调整而 +1） */
export const ARCHIVE_FORMAT_VERSION = 1;

/** 封存范围状态：待处理（校验未过）/ 已封存（完整档案） */
export type ArchiveScopeState = 'pending' | 'sealed';

/** 独立封存档案：一台电梯 × 一个结清月份区间 × 一组已签署计划 */
export interface Archive extends Revisioned {
  /** 档案号（唯一、人读，导入冲突时据此判定号段冲突） */
  archiveNo: string;
  elevatorId: string;
  /** 封存时的电梯快照 */
  elevator: Elevator;
  monthFrom: string;
  monthTo: string;
  /** 封存的已签署计划 */
  plans: Plan[];
  /** 上述计划的保养项 */
  checkItems: CheckItem[];
  /** 异常 / 建议项转出的整改单 */
  rectifies: Rectify[];
  sealedAt: string;
  /** 备注（导入补录档案号等可在此说明） */
  note: string;
  createdAt: string;
}

/** 待处理区中的档案包：校验未通过，等待人工处理后重试 */
export interface PendingArchive extends Revisioned {
  id: string;
  /** 解析出的档案号（可能与现有号段冲突） */
  archiveNo: string;
  elevatorId: string;
  /** 原始档案包内容（保留，重试时直接复用，避免重复解析） */
  payload: Archive;
  /** 缺项 / 冲突原因 */
  reasons: string[];
  /** 来源文件名 */
  sourceFile: string;
  createdAt: string;
}

/** 导出给外部的档案包格式（一个 JSON 可含多份档案） */
export interface ArchivePackage {
  kind: typeof ARCHIVE_PACKAGE_KIND;
  formatVersion: number;
  exportedAt: string;
  archives: Archive[];
}

export const ARCHIVE_PACKAGE_KIND = 'gbelevsvc-archive-package';

/** 判断对象是否为档案包 */
export function isArchivePackage(value: unknown): value is ArchivePackage {
  if (!value || typeof value !== 'object') return false;
  const pack = value as Partial<ArchivePackage>;
  return pack.kind === ARCHIVE_PACKAGE_KIND && Array.isArray(pack.archives);
}

/** 取计划的结清月份（yyyy-MM，以计划日期为准） */
export function planMonth(plan: Plan): string {
  return plan.planDate.slice(0, 7);
}

/** 月份字符串比较：a < b 返回 -1 */
export function compareMonth(a: string, b: string): number {
  return a.localeCompare(b);
}

/** 判断两个 [from, to] 月份区间是否重叠（端点相接不视为重叠） */
export function monthRangesOverlap(
  a: { monthFrom: string; monthTo: string },
  b: { monthFrom: string; monthTo: string },
): boolean {
  return compareMonth(a.monthFrom, b.monthTo) <= 0 && compareMonth(b.monthFrom, a.monthTo) <= 0;
}

/** 档案摘要文案 */
export function archiveSummary(archive: Pick<Archive, 'archiveNo' | 'monthFrom' | 'monthTo' | 'plans' | 'rectifies'>): string {
  return `${archive.archiveNo}：${archive.monthFrom}~${archive.monthTo} · 计划 ${archive.plans.length} 期 · 整改单 ${archive.rectifies.length} 张`;
}
