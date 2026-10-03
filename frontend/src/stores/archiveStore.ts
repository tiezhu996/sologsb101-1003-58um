/**
 * 封存档案状态（Pinia）
 * 维护封存候选、已封存档案与待处理区，封装封存 / 导出 / 导入 / 重试编排。
 * 封存只向 archives 表追加副本，现行台账五张表保持不变。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  exportArchivePackage,
  importArchivePackage,
  listArchiveCandidates,
  listArchives,
  listStaging,
  putStaging,
  removeArchive,
  removeStaging,
  retryStaging as retryStagingDb,
  sealArchive,
  updateStagingState,
  type ArchiveRow,
  type ArchiveStagingRow,
  type ImportArchiveOutcome,
} from '../utils/db';
import type { ArchiveCandidate, ArchivePackage } from '../types/archive';
import { emitChange, onChange } from '../utils/events';

export const useArchiveStore = defineStore('archive', () => {
  const archives = ref<ArchiveRow[]>([]);
  const staging = ref<ArchiveStagingRow[]>([]);
  const candidates = ref<ArchiveCandidate[]>([]);
  /** 已封存的「电梯@月份」键集合，用于候选列表去重标记 */
  const sealedKeys = ref<Set<string>>(new Set());
  const loading = ref(false);
  const error = ref('');
  let subscribed = false;

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [archiveRows, stagingRows, candidateResult] = await Promise.all([
        listArchives(),
        listStaging(),
        listArchiveCandidates(),
      ]);
      archives.value = archiveRows;
      staging.value = stagingRows;
      candidates.value = candidateResult.candidates;
      sealedKeys.value = candidateResult.sealedKeys;
      error.value = '';
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '封存档案读取失败';
    } finally {
      loading.value = false;
    }
  }

  async function bootstrap(): Promise<void> {
    if (!subscribed) {
      subscribed = true;
      onChange(() => {
        void load();
      });
    }
    await load();
  }

  /** 尚未封存的候选（已封存的电梯+月份默认不重复装档） */
  const pendingCandidates = computed(() =>
    candidates.value.filter((item) => !sealedKeys.value.has(`${item.elevatorId}@${item.settleMonth}`)),
  );

  /** 待处理区视图（按待核对优先排序） */
  const stagingViews = computed(() =>
    [...staging.value].sort((a, b) => {
      if (a.state === b.state) return b.attempts - a.attempts;
      return a.state === 'pending' ? -1 : 1;
    }),
  );

  const pendingStagingCount = computed(
    () => staging.value.filter((item) => item.state === 'pending').length,
  );

  /** 封存一个候选（已封存则幂等返回原档案） */
  async function seal(elevatorId: string, settleMonth: string, remark = ''): Promise<ArchiveRow> {
    const { archive, duplicated } = await sealArchive({ elevatorId, settleMonth, remark });
    emitChange();
    if (duplicated) return archive;
    return archive;
  }

  async function deleteArchive(id: string): Promise<void> {
    await removeArchive(id);
    emitChange();
  }

  /** 导出全部或指定档案为档案包数据（页面负责触发下载） */
  async function buildExportPackage(ids?: string[]) {
    return exportArchivePackage(ids);
  }

  /** 导入档案包：逐份核对、落库或进待处理区 */
  async function importPack(pack: ArchivePackage): Promise<ImportArchiveOutcome[]> {
    const outcomes = await importArchivePackage(pack);
    emitChange();
    return outcomes;
  }

  /** 重试待处理区条目 */
  async function retry(stagingId: string): Promise<ImportArchiveOutcome> {
    const outcome = await retryStagingDb(stagingId);
    emitChange();
    return outcome;
  }

  async function discardStaging(id: string): Promise<void> {
    await updateStagingState(id, 'discarded');
    emitChange();
  }

  async function deleteStaging(id: string): Promise<void> {
    await removeStaging(id);
    emitChange();
  }

  /** 待处理区原始记录更新（极少直接使用） */
  async function saveStaging(row: ArchiveStagingRow): Promise<void> {
    await putStaging(row);
    emitChange();
  }

  return {
    archives,
    staging,
    candidates,
    sealedKeys,
    loading,
    error,
    load,
    bootstrap,
    pendingCandidates,
    stagingViews,
    pendingStagingCount,
    seal,
    deleteArchive,
    buildExportPackage,
    importPack,
    retry,
    discardStaging,
    deleteStaging,
    saveStaging,
  };
});
