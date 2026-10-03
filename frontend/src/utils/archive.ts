/**
 * 封存档案的组装与逐层核对（纯函数，不触碰 IndexedDB）。
 * 五层核对：档案号 → 电梯 → 计划 → 保养项 → 异常项转出的整改单。
 * 封存前的资格判定与导入空库 / 已有台账时的冲突判定共用同一套规则，
 * 保证「装档案」与「粘回档案」口径一致。
 */
import type { Elevator } from '../types/elevator';
import type { Plan } from '../types/plan';
import type { CheckItem } from '../types/checkItem';
import type { Rectify } from '../types/rectify';
import type { Archive } from '../types/archive';
import { planMonth } from '../types/archive';
import { isAbnormal } from '../types/checkItem';

/** 档案号前缀（DA = 档案），格式 DA-yyyyMM-#### */
export const ARCHIVE_NO_PREFIX = 'DA';

export interface SealingSelection {
  elevatorId: string;
  /** 结清月份起（含，yyyy-MM） */
  monthFrom: string;
  /** 结清月份止（含，yyyy-MM） */
  monthTo: string;
}

export interface SealingDataSet {
  elevator: Elevator;
  plans: Plan[];
  checkItems: CheckItem[];
  rectifies: Rectify[];
}

/** 判定整改单是否由某异常 / 建议保养项转出：优先 sourceItemId，旧数据按同电梯同项目名匹配 */
export function isRectifyFromItem(rectify: Rectify, item: CheckItem): boolean {
  if (rectify.sourceItemId) return rectify.sourceItemId === item.id;
  return rectify.item === item.itemName;
}

/** 找到异常 / 建议项对应的整改单（可能尚未转出，返回 undefined） */
export function findRectifyOfItem(item: CheckItem, rectifies: Rectify[]): Rectify | undefined {
  const linked = rectifies.find((rectify) => rectify.sourceItemId && rectify.sourceItemId === item.id);
  if (linked) return linked;
  return rectifies.find((rectify) => !rectify.sourceItemId && rectify.item === item.itemName);
}

/**
 * 封存资格判定：在给定月份区间内，哪些已签署计划可以入档，哪些异常项还没转整改单。
 * 已签署之外的计划（待执行 / 执行中）一律不纳入——在执行计划不能被封存锁死。
 */
export function resolveSealing(
  selection: SealingSelection,
  data: SealingDataSet,
): {
  ok: boolean;
  plans: Plan[];
  checkItems: CheckItem[];
  rectifies: Rectify[];
  errors: string[];
} {
  const errors: string[] = [];
  if (data.elevator.id !== selection.elevatorId) {
    errors.push('电梯数据与封存选择不一致');
  }
  if (selection.monthFrom.localeCompare(selection.monthTo) > 0) {
    errors.push('结清月份起始不能晚于截止');
  }

  const inRangeSigned = data.plans
    .filter((plan) => plan.elevatorId === selection.elevatorId)
    .filter((plan) => {
      const month = planMonth(plan);
      return month >= selection.monthFrom && month <= selection.monthTo;
    })
    .filter((plan) => plan.state === 'signed')
    .sort((a, b) => a.planDate.localeCompare(b.planDate));

  if (inRangeSigned.length === 0) {
    errors.push(`结清月份 ${selection.monthFrom} ~ ${selection.monthTo} 内没有已签署计划，无法封存`);
  }

  const planIds = new Set(inRangeSigned.map((plan) => plan.id));
  const scopedItems = data.checkItems.filter((item) => planIds.has(item.planId));

  // 逐层核对：每期已签署计划必须有保养项
  for (const plan of inRangeSigned) {
    const items = scopedItems.filter((item) => item.planId === plan.id);
    if (items.length === 0) {
      errors.push(`计划 ${plan.planDate}（${plan.id}）缺少保养项`);
      continue;
    }
    const unfilled = items.filter((item) => item.result === null);
    if (unfilled.length > 0) {
      errors.push(`计划 ${plan.planDate} 有 ${unfilled.length} 项未填写结果，与已签署状态矛盾`);
    }
  }

  // 异常项 / 建议项必须已转出整改单，否则不允许装档案
  const linkedRectifyIds = new Set<string>();
  for (const item of scopedItems) {
    if (!isAbnormal(item.result)) continue;
    const rectify = findRectifyOfItem(item, data.rectifies);
    if (!rectify) {
      errors.push(`保养项「${item.itemName}」（计划 ${item.planId} 第 ${item.seq} 项）为异常 / 建议项，尚未转出整改单`);
      continue;
    }
    linkedRectifyIds.add(rectify.id);
  }
  const scopedRectifies = data.rectifies.filter((rectify) => linkedRectifyIds.has(rectify.id));

  return {
    ok: errors.length === 0,
    plans: inRangeSigned,
    checkItems: scopedItems,
    rectifies: scopedRectifies,
    errors,
  };
}

/** 档案内部五层核对（导入 / 落库前调用） */
export function validateArchive(archive: Archive): string[] {
  const errors: string[] = [];

  // L0 档案号
  if (!archive.archiveNo || typeof archive.archiveNo !== 'string') {
    errors.push('缺少档案号');
  }

  // L1 电梯
  if (!archive.elevator?.id) {
    errors.push('缺少电梯档案快照');
  } else if (archive.elevator.id !== archive.elevatorId) {
    errors.push(`档案电梯引用不一致：elevatorId=${archive.elevatorId}，快照 id=${archive.elevator.id}`);
  }

  // L2 计划：必须全部已签署、月份在结清区间内、归属本电梯
  if (!Array.isArray(archive.plans) || archive.plans.length === 0) {
    errors.push('档案内没有已签署保养计划');
  } else {
    for (const plan of archive.plans) {
      if (plan.elevatorId !== archive.elevatorId) {
        errors.push(`计划 ${plan.id} 不属于档案电梯`);
      }
      if (plan.state !== 'signed') {
        errors.push(`计划 ${plan.planDate}（${plan.id}）不是已签署状态`);
      }
      const month = planMonth(plan);
      if (month < archive.monthFrom || month > archive.monthTo) {
        errors.push(`计划 ${plan.planDate} 的月份 ${month} 超出结清区间 ${archive.monthFrom} ~ ${archive.monthTo}`);
      }
    }
  }

  // L3 保养项：planId 必须命中档案计划，且每期计划至少有一项
  const planIds = new Set(archive.plans.map((plan) => plan.id));
  for (const item of archive.checkItems ?? []) {
    if (!planIds.has(item.planId)) {
      errors.push(`保养项 ${item.id} 找不到所属计划（planId=${item.planId}）`);
    }
  }
  for (const plan of archive.plans) {
    if (!(archive.checkItems ?? []).some((item) => item.planId === plan.id)) {
      errors.push(`计划 ${plan.planDate}（${plan.id}）缺少保养项，档案不完整`);
    }
  }

  // L4 整改单：归属本电梯；每个异常 / 建议项必须能找到转出的整改单
  for (const rectify of archive.rectifies ?? []) {
    if (rectify.elevatorId !== archive.elevatorId) {
      errors.push(`整改单 ${rectify.id} 不属于档案电梯`);
    }
  }
  for (const item of archive.checkItems ?? []) {
    if (!isAbnormal(item.result)) continue;
    const hit = (archive.rectifies ?? []).some((rectify) => isRectifyFromItem(rectify, item));
    if (!hit) {
      errors.push(`异常 / 建议项「${item.itemName}」（${item.id}）缺少转出的整改单`);
    }
  }

  return errors;
}

/** 生成档案号：DA-yyyyMM-####，序号在同号段已占用号中顺延 */
export function generateArchiveNo(monthFrom: string, occupied: Iterable<string>): string {
  const segment = monthFrom.slice(0, 7).replace('-', '');
  const prefix = `${ARCHIVE_NO_PREFIX}-${segment}-`;
  let maxSeq = 0;
  for (const no of occupied) {
    if (!no.startsWith(prefix)) continue;
    const seq = Number.parseInt(no.slice(prefix.length), 10);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, '0')}`;
}

/** 封存去重键：同一电梯同一结清月份区间只保留一份 */
export function archiveDedupKey(elevatorId: string, monthFrom: string, monthTo: string): string {
  return `${elevatorId}|${monthFrom}|${monthTo}`;
}

/** 两份同电梯的月份区间是否重叠（分次封存不允许交叉） */
export function rangesOverlap(
  a: { monthFrom: string; monthTo: string },
  b: { monthFrom: string; monthTo: string },
): boolean {
  return a.monthFrom.localeCompare(b.monthTo) <= 0 && b.monthFrom.localeCompare(a.monthTo) <= 0;
}

/** 简易行内容比对（导入时判断同 id 行是完全一致还是已被改动） */
export function sameRow(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
