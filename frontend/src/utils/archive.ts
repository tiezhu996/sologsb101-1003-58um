/**
 * 封存档案业务逻辑（纯函数，不触碰 IndexedDB）：
 * - 按电梯 + 结清月份聚合已签署计划为封存候选
 * - 异常项与整改单的匹配（异常项转出的整改单才随档转出）
 * - 档案包装包 / 拆包
 * - 粘回空库或已有台账时逐层核对：缺项、悬挂引用、号段冲突
 */
import type { CheckItem } from '../types/checkItem';
import type { Elevator } from '../types/elevator';
import type { Plan } from '../types/plan';
import type { Rectify } from '../types/rectify';
import {
  ARCHIVE_PACKAGE_KIND,
  ARCHIVE_PACKAGE_VERSION,
  type ArchiveCandidate,
  type ArchiveCounts,
  type ArchivePackage,
  type ArchivePayload,
  type ArchivePayloadEnvelope,
  settleMonthOf,
} from '../types/archive';

/** 某条异常 / 建议保养项是否已有对应整改单（同电梯 + 同项目名） */
export function isAbnormalItemCovered(
  item: CheckItem,
  elevatorId: string,
  rectifies: Rectify[],
): boolean {
  return rectifies.some(
    (rectify) => rectify.elevatorId === elevatorId && rectify.item === item.itemName,
  );
}

/**
 * 计算封存候选：仅取「已签署」计划，按 电梯 + 结清月份（签署月份）分组。
 * 每组挂载该组计划的全部保养项，以及组内异常项转出的整改单。
 * 异常项尚无对应整改单时给出警告（缺整改闭环，仍允许封存但需提示）。
 */
export function buildArchiveCandidates(input: {
  elevators: Elevator[];
  plans: Plan[];
  checkItems: CheckItem[];
  rectifies: Rectify[];
}): ArchiveCandidate[] {
  const groups = new Map<string, ArchiveCandidate>();
  for (const plan of input.plans) {
    if (plan.state !== 'signed') continue;
    const elevator = input.elevators.find((item) => item.id === plan.elevatorId);
    if (!elevator) continue;
    const settleMonth = settleMonthOf(plan);
    const key = `${elevator.id}@${settleMonth}`;
    const group =
      groups.get(key) ??
      ({
        elevatorId: elevator.id,
        regCode: elevator.regCode,
        owner: elevator.owner,
        settleMonth,
        plans: [],
        checkItems: [],
        rectifies: [],
        warnings: [],
      } satisfies ArchiveCandidate);
    group.plans.push(plan);
    groups.set(key, group);
  }

  const candidates: ArchiveCandidate[] = [];
  for (const group of groups.values()) {
    const planIds = new Set(group.plans.map((plan) => plan.id));
    const items = input.checkItems.filter((item) => planIds.has(item.planId));
    group.checkItems = items.sort((a, b) => {
      const planOrder = a.planId.localeCompare(b.planId);
      return planOrder !== 0 ? planOrder : a.seq - b.seq;
    });

    // 异常项（abnormal / advice）→ 同电梯同项目名的整改单随档转出
    const linkedRectifies = new Map<string, Rectify>();
    const uncovered: string[] = [];
    for (const item of group.checkItems) {
      if (item.result !== 'abnormal' && item.result !== 'advice') continue;
      const matched = input.rectifies.filter(
        (rectify) => rectify.elevatorId === group.elevatorId && rectify.item === item.itemName,
      );
      if (matched.length === 0) {
        uncovered.push(item.itemName);
      } else {
        for (const rectify of matched) linkedRectifies.set(rectify.id, rectify);
      }
    }
    group.rectifies = [...linkedRectifies.values()].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    if (uncovered.length > 0) {
      group.warnings.push(`异常项尚未转出整改单：${[...new Set(uncovered)].join('、')}`);
    }
    group.plans.sort((a, b) => a.planDate.localeCompare(b.planDate));
    candidates.push(group);
  }

  return candidates.sort((a, b) =>
    a.regCode === b.regCode
      ? a.settleMonth.localeCompare(b.settleMonth)
      : a.regCode.localeCompare(b.regCode),
  );
}

/** 统计包内实体计数（装包与核对共用同一口径） */
export function countPayload(payload: ArchivePayload): ArchiveCounts {
  return {
    elevators: payload.elevator ? 1 : 0,
    plans: payload.plans.length,
    checkItems: payload.checkItems.length,
    rectifies: payload.rectifies.length,
  };
}

/** 由电梯主数据与候选组装封存载荷（深拷贝快照，封存后台账继续变动不影响档案） */
export function buildPayloadWithElevator(
  elevator: Elevator,
  candidate: ArchiveCandidate,
): ArchivePayload {
  return {
    elevator: structuredCloneSafe(elevator),
    plans: candidate.plans.map((item) => structuredCloneSafe(item)),
    checkItems: candidate.checkItems.map((item) => structuredCloneSafe(item)),
    rectifies: candidate.rectifies.map((item) => structuredCloneSafe(item)),
  };
}

/** 组装档案信封（不含档案号序号，档案号由持久层按已存序号分配） */
export function buildEnvelope(input: {
  archiveNo: string;
  elevator: Elevator;
  candidate: ArchiveCandidate;
  payload: ArchivePayload;
  remark: string;
  archivedAt: string;
}): ArchivePayloadEnvelope {
  return {
    archiveNo: input.archiveNo,
    elevatorId: input.elevator.id,
    regCode: input.elevator.regCode,
    owner: input.elevator.owner,
    settleMonth: input.candidate.settleMonth,
    remark: input.remark,
    archivedAt: input.archivedAt,
    counts: countPayload(input.payload),
    payload: input.payload,
  };
}

/** 打成档案包（多份档案共用一个导出文件） */
export function packArchives(
  envelopes: ArchivePayloadEnvelope[],
  schemaVersion: number,
  exportedAt: string,
): ArchivePackage {
  return {
    kind: ARCHIVE_PACKAGE_KIND,
    packageVersion: ARCHIVE_PACKAGE_VERSION,
    schemaVersion,
    exportedAt,
    archives: envelopes,
  };
}

/** 判断未知 JSON 是否为档案包 */
export function isArchivePackage(value: unknown): value is ArchivePackage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ArchivePackage>;
  return candidate.kind === ARCHIVE_PACKAGE_KIND && Array.isArray(candidate.archives);
}

/* ============================== 逐层核对 ============================== */

export interface VerifyContext {
  /** 现行台账电梯 ID 集合 */
  existingElevatorIds: Set<string>;
  /** 现行台账计划 ID 集合（号段冲突判定） */
  existingPlanIds: Set<string>;
  /** 现行台账保养项 ID 集合 */
  existingCheckItemIds: Set<string>;
  /** 现行台账整改单 ID 集合 */
  existingRectifyIds: Set<string>;
  /** 已在本库的档案号集合（重复封存 / 重复导入去重） */
  existingArchiveNos: Set<string>;
}

export interface VerifyResult {
  ok: boolean;
  /** 阻断问题：缺项 / 悬挂引用 / 号段冲突，命中即进待处理区，禁止写入 */
  issues: string[];
  /** 提示信息（不阻断） */
  warnings: string[];
  /** 实际将写入的实体（深拷贝，调用方可直接落库） */
  envelope: ArchivePayloadEnvelope;
}

/** 基本字段完整性核对（缺项） */
function checkShape(envelope: ArchivePayloadEnvelope, issues: string[], warnings: string[]): void {
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object') {
    issues.push('档案缺少 payload 数据体');
    return;
  }
  if (!payload.elevator || typeof payload.elevator.id !== 'string') {
    issues.push('缺少电梯主数据');
  }
  for (const table of ['plans', 'checkItems', 'rectifies'] as const) {
    if (!Array.isArray(payload[table])) {
      issues.push(`缺少 ${table} 数组`);
    }
  }
  if (!envelope.settleMonth) issues.push('缺少结清月份');
  if (envelope.counts) {
    const actual = countPayload(payload);
    const mismatch = (Object.keys(actual) as Array<keyof ArchiveCounts>).filter(
      (key) => actual[key] !== envelope.counts[key],
    );
    for (const key of mismatch) {
      issues.push(`计数不符：${key} 声明 ${envelope.counts[key]} 份、实际 ${actual[key]} 份`);
    }
  } else {
    warnings.push('档案未携带计数，已按实际实体核对');
  }
}

/**
 * 逐层核对一份档案信封：
 * 1. 结构缺项；2. 父子引用完整性（计划→电梯、保养项→计划、整改单→电梯）；
 * 3. 号段冲突（实体 ID 在现行台账已被占用）；4. 档案号重复。
 * 任一层失败都不写入，返回 issues 供待处理区展示。
 */
export function verifyEnvelope(envelope: ArchivePayloadEnvelope, context: VerifyContext): VerifyResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const cloned = structuredCloneSafe(envelope);
  const payload = cloned.payload;

  checkShape(cloned, issues, warnings);

  if (payload?.elevator && context.existingArchiveNos.has(cloned.archiveNo)) {
    issues.push(`档案号 ${cloned.archiveNo} 在本库已存在（两个标签页封存同一电梯只保留一份）`);
  }

  if (payload?.elevator) {
    if (payload.elevator.id !== cloned.elevatorId) {
      issues.push(`信封电梯 ${cloned.elevatorId} 与载荷电梯 ${payload.elevator.id} 不一致`);
    }
    // 粘回已有台账：电梯主数据应一致；粘回空库则直接补入
    if (context.existingElevatorIds.has(payload.elevator.id)) {
      warnings.push(`电梯 ${payload.elevator.regCode} 已在现行台账，档案数据按档案号去重后合并`);
    }
  }

  if (payload && Array.isArray(payload.plans)) {
    const planIds = new Set<string>();
    for (const plan of payload.plans) {
      if (!plan || typeof plan.id !== 'string') {
        issues.push('存在缺少 id 的计划');
        continue;
      }
      if (planIds.has(plan.id)) issues.push(`计划号段重复：${plan.id}`);
      planIds.add(plan.id);
      if (plan.elevatorId !== payload.elevator?.id) {
        issues.push(`计划 ${plan.id} 悬挂：所属电梯 ${plan.elevatorId} 与档案电梯不一致`);
      }
      if (plan.state !== 'signed') {
        issues.push(`计划 ${plan.id} 状态为「${plan.state}」，非已签署计划不得封存`);
      }
      if (context.existingPlanIds.has(plan.id)) {
        issues.push(`计划号段冲突：${plan.id} 在现行台账已存在`);
      }
    }

    if (Array.isArray(payload.checkItems)) {
      const itemIds = new Set<string>();
      for (const item of payload.checkItems) {
        if (!item || typeof item.id !== 'string') {
          issues.push('存在缺少 id 的保养项');
          continue;
        }
        if (itemIds.has(item.id)) issues.push(`保养项号段重复：${item.id}`);
        itemIds.add(item.id);
        if (!planIds.has(item.planId)) {
          issues.push(`保养项 ${item.id} 悬挂：所属计划 ${item.planId} 不在本档案内`);
        }
        if (context.existingCheckItemIds.has(item.id)) {
          issues.push(`保养项号段冲突：${item.id} 在现行台账已存在`);
        }
      }
      // 反向缺项：每个计划至少应有一个保养项
      for (const planId of planIds) {
        if (!payload.checkItems.some((item) => item.planId === planId)) {
          issues.push(`计划 ${planId} 缺少对应保养项`);
        }
      }
    }
  }

  if (payload && Array.isArray(payload.rectifies)) {
    const rectifyIds = new Set<string>();
    const abnormalPairs = new Set(
      (Array.isArray(payload.checkItems) ? payload.checkItems : [])
        .filter((item) => item.result === 'abnormal' || item.result === 'advice')
        .map((item) => item.itemName),
    );
    for (const rectify of payload.rectifies) {
      if (!rectify || typeof rectify.id !== 'string') {
        issues.push('存在缺少 id 的整改单');
        continue;
      }
      if (rectifyIds.has(rectify.id)) issues.push(`整改单号段重复：${rectify.id}`);
      rectifyIds.add(rectify.id);
      if (rectify.elevatorId !== payload.elevator?.id) {
        issues.push(`整改单 ${rectify.id} 悬挂：所属电梯与档案电梯不一致`);
      }
      if (!abnormalPairs.has(rectify.item)) {
        warnings.push(`整改单 ${rectify.id}（${rectify.item}）无对应异常项，按档案原样保留`);
      }
      if (context.existingRectifyIds.has(rectify.id)) {
        issues.push(`整改单号段冲突：${rectify.id} 在现行台账已存在`);
      }
    }
  }

  return { ok: issues.length === 0, issues, warnings, envelope: cloned };
}

/** structuredClone 在极旧环境下的兜底（JSON 深拷贝，行数据均为可序列化结构） */
function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
