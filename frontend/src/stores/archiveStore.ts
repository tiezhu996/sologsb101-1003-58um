/**
 * 封存档案状态（Pinia）
 * 维护已封存档案、待处理区与导入进度；现行台账只读展示，封存 / 导入落库走 db 事务。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  exportArchivePackage,
  importArchivePackage,
  listArchives,
  listElevators,
  listImportJobs,
  listPendingArchives,
  processArchiveImport,
  removeArchive,
  removeImportJob,
  removePendingArchive,
  retryPendingArchive,
  sealArchive,
  type ArchiveImportJobRow,
  type ArchiveRow,
  type ElevatorRow,
  type PendingArchiveRow,
  type SealInput,
} from '../utils/db';
import { emitChange, onChange } from '../utils/events';

export const useArchiveStore = defineStore('archive', () => {
  const archives = ref<ArchiveRow[]>([]);
  const pending = ref<PendingArchiveRow[]>([]);
  const jobs = ref<ArchiveImportJobRow[]>([]);
  const elevators = ref<ElevatorRow[]>([]);
  const loading = ref(false);
  const error = ref('');
  const initialized = ref(false);
  let subscribed = false;

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const [archiveRows, pendingRows, jobRows, elevatorRows] = await Promise.all([
        listArchives(),
        listPendingArchives(),
        listImportJobs(),
        listElevators(),
      ]);
      archives.value = archiveRows;
      pending.value = pendingRows;
      jobs.value = jobRows;
      elevators.value = elevatorRows;
      error.value = '';
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '封存档案读取失败';
    } finally {
      loading.value = false;
    }
  }

  async function bootstrap(): Promise<void> {
    if (!initialized.value) initialized.value = true;
    if (!subscribed) {
      subscribed = true;
      onChange(() => {
        void load();
      });
    }
    await load();
  }

  /** 封存：返回档案号；校验未过由调用方展示错误 */
  async function seal(input: SealInput): Promise<string> {
    const archive = await sealArchive(input);
    emitChange();
    return archive.archiveNo;
  }

  async function deleteArchive(archiveNo: string): Promise<void> {
    await removeArchive(archiveNo);
    emitChange();
  }

  async function exportAll(): Promise<ReturnType<typeof exportArchivePackage>> {
    return exportArchivePackage();
  }

  async function exportMany(nos: string[]): Promise<ReturnType<typeof exportArchivePackage>> {
    return exportArchivePackage(nos);
  }

  /** 接收档案包文件并逐份核对导入（失败保留进度） */
  async function importPackage(pack: unknown, sourceFile: string) {
    const outcome = await importArchivePackage(pack, sourceFile);
    emitChange();
    return outcome;
  }

  /** 失败任务从断点重试 */
  async function retryJob(jobId: string) {
    const outcome = await processArchiveImport(jobId);
    emitChange();
    return outcome;
  }

  async function retryPendingItem(pendingId: string) {
    const result = await retryPendingArchive(pendingId);
    emitChange();
    return result;
  }

  async function discardPending(pendingId: string): Promise<void> {
    await removePendingArchive(pendingId);
    emitChange();
  }

  async function deleteJob(jobId: string): Promise<void> {
    await removeImportJob(jobId);
    emitChange();
  }

  /** 档案视图：补充电梯在台账中的在册状态与名称 */
  const archiveViews = computed(() =>
    archives.value.map((archive) => {
      const inLedger = elevators.value.some((item) => item.id === archive.elevatorId);
      return {
        ...archive,
        elevatorName: `${archive.elevator.regCode}（${archive.elevator.owner}）`,
        inLedger,
        planCount: archive.plans.length,
        itemCount: archive.checkItems.length,
        rectifyCount: archive.rectifies.length,
      };
    }),
  );

  const pendingViews = computed(() =>
    pending.value.map((row) => ({
      ...row,
      elevatorName: `${row.payload.elevator.regCode}（${row.payload.elevator.owner}）`,
    })),
  );

  const jobViews = computed(() => jobs.value);

  /** 每台电梯已封存的档案（供封存入口去重与提示） */
  const archivesByElevator = computed(() => {
    const map = new Map<string, ArchiveRow[]>();
    for (const archive of archives.value) {
      const list = map.get(archive.elevatorId) ?? [];
      list.push(archive);
      map.set(archive.elevatorId, list);
    }
    return map;
  });

  return {
    archives,
    pending,
    jobs,
    elevators,
    loading,
    error,
    initialized,
    load,
    bootstrap,
    seal,
    deleteArchive,
    exportAll,
    exportMany,
    importPackage,
    retryJob,
    retryPendingItem,
    discardPending,
    deleteJob,
    archiveViews,
    pendingViews,
    jobViews,
    archivesByElevator,
  };
});
