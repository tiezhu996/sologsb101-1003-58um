/**
 * 封存档案模型：按「电梯 + 结清月份」把已签署保养计划、对应保养项及异常项转出的整改单
 * 装成独立档案。现行台账（elevators/plans/checkItems/rectifies）保留不动，
 * 仅把封存副本写入 archives 表；导入失败的档案包进入 archiveStaging 待处理区。
 */
import type { Revisioned } from './persistence';
import type { Elevator } from './elevator';
import type { Plan } from './plan';
import type { CheckItem } from './checkItem';
import type { Rectify } from './rectify';

/** 档案导入状态：待核对 / 可导入 / 已导入 / 已放弃 */
export type StagingState = 'pending' | 'ready' | 'imported' | 'discarded';

export const STAGING_STATE_LABEL: Record<StagingState, string> = {
  pending: '待核对',
  ready: '可导入',
  imported: '已导入',
  discarded: '已放弃',
};

/** 档案包格式版本 */
export const ARCHIVE_PACKAGE_KIND = 'gbelevsvc-archive';
export const ARCHIVE_PACKAGE_VERSION = 1;

/** 档案号前缀 */
export const ARCHIVE_NO_PREFIX = 'ARC';

/**
 * 一份独立封存档案：
 * payload 为封存时的完整快照副本（电梯主数据 + 当期已签署计划 + 全部保养项 + 异常项转出的整改单）。
 */
export interface Archive extends Revisioned {
  /** 档案号，如 ARC-202610-elev-1-003 */
  id: string;
  /** 被封存电梯 ID（冗余，便于按电梯索引） */
  elevatorId: string;
  /** 电梯注册代码（冗余展示） */
  regCode: string;
  /** 使用单位（冗余展示） */
  owner: string;
  /** 结清月份 yyyy-MM */
  settleMonth: string;
  /** 封存说明 */
  remark: string;
  /** 封存时间 yyyy-MM-dd HH:mm */
  archivedAt: string;
  /** 包内实体计数，导入时逐层核对 */
  counts: ArchiveCounts;
  payload: ArchivePayload;
  createdAt: string;
}

export interface ArchiveCounts {
  elevators: number;
  plans: number;
  checkItems: number;
  rectifies: number;
}

export interface ArchivePayload {
  elevator: Elevator;
  plans: Plan[];
  checkItems: CheckItem[];
  rectifies: Rectify[];
}

/** 档案包（导出文件结构）：支持单档案与多档案两种载体 */
export interface ArchivePackage {
  kind: typeof ARCHIVE_PACKAGE_KIND;
  packageVersion: number;
  schemaVersion: number;
  exportedAt: string;
  archives: ArchivePayloadEnvelope[];
}

/** 包内档案信封：档案号 + 结清月份 + 计数 + 实体 */
export interface ArchivePayloadEnvelope {
  archiveNo: string;
  elevatorId: string;
  regCode: string;
  owner: string;
  settleMonth: string;
  remark: string;
  archivedAt: string;
  counts: ArchiveCounts;
  payload: ArchivePayload;
}

/** 待处理区：导入失败 / 待核对的档案包条目 */
export interface ArchiveStaging extends Revisioned {
  id: string;
  /** 来源档案号 */
  archiveNo: string;
  elevatorId: string;
  regCode: string;
  owner: string;
  settleMonth: string;
  state: StagingState;
  /** 失败 / 待处理原因（缺项、号段冲突等，逐条列出） */
  issues: string[];
  /** 已重试次数 */
  attempts: number;
  /** 最近一次尝试时间 */
  lastAttemptAt: string | null;
  /** 进度描述：已核对到哪一层 */
  progress: string;
  /** 原始档案信封（重试时直接复用，不要求用户重新选文件） */
  envelope: ArchivePayloadEnvelope;
  createdAt: string;
}

/** 封存候选：按电梯 + 结清月份聚合的可封存计划组 */
export interface ArchiveCandidate {
  elevatorId: string;
  regCode: string;
  owner: string;
  settleMonth: string;
  plans: Plan[];
  checkItems: CheckItem[];
  rectifies: Rectify[];
  /** 未结清原因（存在异常项尚未转出整改单等），非空表示不可封存 */
  warnings: string[];
}

/** 取计划的结清月份（按签署时间，兜底计划日期） */
export function settleMonthOf(plan: Plan): string {
  const source = plan.signedAt ?? plan.planDate;
  return source.slice(0, 7);
}

/** 档案号生成：ARC-yyyyMM-<电梯序号段>-<同电梯同月份序号> */
export function buildArchiveNo(settleMonth: string, elevatorId: string, seq: number): string {
  const month = settleMonth.replace('-', '');
  const elevatorPart = elevatorId.replace(/[^a-zA-Z0-9]/g, '') || 'elev';
  return `${ARCHIVE_NO_PREFIX}-${month}-${elevatorPart}-${String(seq).padStart(3, '0')}`;
}
