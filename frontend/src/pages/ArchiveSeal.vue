<script setup lang="ts">
/**
 * /archives 电梯档案封存
 * 按电梯 + 结清月份把已签署保养计划、对应保养项及异常项转出的整改单装成独立档案；
 * 现行台账保留不动。档案包可导出，并在粘回空库 / 已有台账时逐层核对：
 * 缺项或号段冲突进待处理区，导入失败保留进度并重试，不写入半份数据。
 */
import { computed, h, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDatePicker,
  NDescriptions,
  NDescriptionsItem,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NTabPane,
  NTabs,
  NTag,
  NText,
  useMessage,
  type DataTableColumns,
  type FormInst,
} from 'naive-ui';
import { useArchiveStore } from '../stores/archiveStore';
import { useElevatorStore } from '../stores/elevatorStore';
import { usePlanStore } from '../stores/planStore';
import { useCheckStore } from '../stores/checkStore';
import { useRectifyStore } from '../stores/rectifyStore';
import { MAINT_CYCLE_LABEL } from '../types/elevator';
import type { Archive, PendingArchive } from '../types/archive';
import { archiveSummary } from '../types/archive';
import { resolveSealing } from '../utils/archive';
import { backupFilename, downloadJson, readJsonFile } from '../utils/export';
import type { ArchiveImportJobRow } from '../utils/db';
import StatBadge from '../components/common/StatBadge.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';

const route = useRoute();
const message = useMessage();
const archiveStore = useArchiveStore();
const elevatorStore = useElevatorStore();
const planStore = usePlanStore();
const checkStore = useCheckStore();
const rectifyStore = useRectifyStore();

onMounted(async () => {
  await Promise.all([
    archiveStore.bootstrap(),
    elevatorStore.bootstrap(),
    planStore.bootstrap(),
    checkStore.bootstrap(),
    rectifyStore.bootstrap(),
  ]);
  const queryElevatorId = String(route.query.elevatorId ?? '');
  if (queryElevatorId && elevatorStore.elevators.some((item) => item.id === queryElevatorId)) {
    openSeal(queryElevatorId);
  }
});

/* ------------------------------ 封存弹窗 ------------------------------ */
const sealOpen = ref(false);
const sealFormRef = ref<FormInst | null>(null);
const sealModel = ref<{ elevatorId: string; fromTs: number; toTs: number; note: string }>({
  elevatorId: '',
  fromTs: monthTs(-1),
  toTs: monthTs(0),
  note: '',
});

function monthTs(offsetMonths: number): number {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offsetMonths, 1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function tsToMonth(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

const elevatorOptions = computed(() =>
  elevatorStore.elevators.map((item) => ({
    label: `${item.regCode}（${item.owner}）`,
    value: item.id,
  })),
);

function openSeal(elevatorId?: string): void {
  sealModel.value = {
    elevatorId: elevatorId ?? elevatorStore.activeElevatorId ?? elevatorStore.elevators[0]?.id ?? '',
    fromTs: monthTs(-1),
    toTs: monthTs(0),
    note: '',
  };
  sealOpen.value = true;
}

/** 预检：展示将入档的计划与尚未闭环的异常项，封存前逐层核对 */
const preflight = computed(() => {
  const elevator = elevatorStore.elevators.find((item) => item.id === sealModel.value.elevatorId);
  if (!elevator) return null;
  const monthFrom = tsToMonth(sealModel.value.fromTs);
  const monthTo = tsToMonth(sealModel.value.toTs);
  const resolved = resolveSealing(
    { elevatorId: elevator.id, monthFrom, monthTo },
    {
      elevator,
      plans: planStore.plans,
      checkItems: checkStore.items,
      rectifies: rectifyStore.rectifies,
    },
  );
  const existing = archiveStore.archivesByElevator.get(elevator.id) ?? [];
  const overlapped = existing.some(
    (archive) => monthFrom <= archive.monthTo && archive.monthFrom <= monthTo,
  );
  return { monthFrom, monthTo, resolved, overlapped, existing };
});

async function submitSeal(): Promise<void> {
  try {
    await sealFormRef.value?.validate();
  } catch {
    return;
  }
  if (!preflight.value) return;
  if (preflight.value.overlapped) {
    message.error('该电梯在此结清月份区间内已有封存档案，同一封存只保留一份');
    return;
  }
  if (!preflight.value.resolved.ok) {
    message.error(preflight.value.resolved.errors[0] ?? '封存校验未通过');
    return;
  }
  try {
    const archiveNo = await archiveStore.seal({
      elevatorId: sealModel.value.elevatorId,
      monthFrom: preflight.value.monthFrom,
      monthTo: preflight.value.monthTo,
      note: sealModel.value.note,
    });
    message.success(`已封存为独立档案 ${archiveNo}，现行台账保留不动`);
    sealOpen.value = false;
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '封存失败');
  }
}

/* ------------------------------ 导出 / 导入 ------------------------------ */
async function handleExportAll(): Promise<void> {
  const pack = await archiveStore.exportAll();
  if (pack.archives.length === 0) {
    message.warning('还没有已封存档案');
    return;
  }
  downloadJson(backupFilename('gbelevsvc-archive'), pack);
  message.success(`已导出 ${pack.archives.length} 份封存档案`);
}

async function handleExportOne(archive: Archive): Promise<void> {
  const pack = await archiveStore.exportMany([archive.archiveNo]);
  downloadJson(backupFilename(`gbelevsvc-archive-${archive.archiveNo}`), pack);
}

const importing = ref(false);

/** NUpload before-upload 钩子：拦截默认上传，转走逐层核对导入 */
function onBeforeUpload(options: { file: { file: File | null } }): boolean {
  const file = options.file.file;
  if (file) void handleImport(file);
  return false;
}

async function handleImport(file: File): Promise<void> {
  importing.value = true;
  try {
    const pack = await readJsonFile<unknown>(file);
    const outcome = await archiveStore.importPackage(pack, file.name);
    if (outcome.staged.length > 0) {
      message.warning(`导入完成：${outcome.imported.length} 份落库，${outcome.staged.length} 份缺项 / 冲突已进待处理区`);
    } else if (outcome.job.state === 'error') {
      message.error(`导入在「${outcome.job.pendingNos[0] ?? ''}」处中止，进度已保留，可在导入进度中重试`);
    } else {
      message.success(`导入完成：${outcome.imported.length} 份档案已逐层核对并粘回台账`);
    }
  } catch (cause) {
    message.error(`导入失败：${cause instanceof Error ? cause.message : '文件解析异常'}`);
  } finally {
    importing.value = false;
  }
}

async function handleRetryJob(job: ArchiveImportJobRow): Promise<void> {
  try {
    const outcome = await archiveStore.retryJob(job.id);
    if (outcome.staged.length > 0) {
      message.warning(`重试：${outcome.imported.length} 份落库，${outcome.staged.length} 份进待处理区`);
    } else if (outcome.job.state === 'error') {
      message.error('仍未成功，进度继续保留');
    } else {
      message.success('断点重试完成，剩余档案已全部处理');
    }
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '重试失败');
  }
}

async function handleRetryPending(pending: PendingArchive): Promise<void> {
  const result = await archiveStore.retryPendingItem(pending.id);
  if (result.ok) {
    message.success(`档案 ${pending.archiveNo} 复核通过，已整份粘回台账`);
  } else {
    message.warning(`仍未通过：${result.reasons[0] ?? '存在缺项 / 冲突'}`);
  }
}

/* ------------------------------ 详情弹窗 ------------------------------ */
const detailArchive = ref<Archive | null>(null);

const overview = computed(() => {
  const planTotal = archiveStore.archives.reduce((sum, item) => sum + item.plans.length, 0);
  const errorJobs = archiveStore.jobs.filter((job) => job.state === 'error').length;
  return {
    total: archiveStore.archives.length,
    planTotal,
    pending: archiveStore.pending.length,
    errorJobs,
  };
});

const archiveColumns = computed<DataTableColumns<(typeof archiveStore.archiveViews)[number]>>(() => [
  { title: '档案号', key: 'archiveNo', width: 170, render: (row) => h(NText, { strong: true }, { default: () => row.archiveNo }) },
  { title: '电梯', key: 'elevatorName', minWidth: 220, ellipsis: { tooltip: true } },
  {
    title: '结清月份',
    key: 'monthRange',
    width: 170,
    render: (row) => `${row.monthFrom} ~ ${row.monthTo}`,
  },
  { title: '计划', key: 'planCount', width: 70 },
  { title: '保养项', key: 'itemCount', width: 80 },
  { title: '整改单', key: 'rectifyCount', width: 80 },
  { title: '封存时间', key: 'sealedAt', width: 150 },
  {
    title: '台账状态',
    key: 'inLedger',
    width: 110,
    render: (row) =>
      h(NTag, { size: 'small', type: row.inLedger ? 'success' : 'warning', round: true }, {
        default: () => (row.inLedger ? '电梯在册' : '档案独立'),
      }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 190,
    fixed: 'right',
    render: (row) =>
      h(NSpace, { size: 2 }, {
        default: () => [
          h(
            NButton,
            { size: 'tiny', text: true, type: 'primary', onClick: () => (detailArchive.value = row) },
            { default: () => '查看' },
          ),
          h(
            NButton,
            { size: 'tiny', text: true, onClick: () => void handleExportOne(row) },
            { default: () => '导出' },
          ),
          h(
            NPopconfirm,
            { onPositiveClick: () => archiveStore.deleteArchive(row.archiveNo) },
            {
              trigger: () =>
                h(NButton, { size: 'tiny', text: true, type: 'error' }, { default: () => '删除' }),
              default: () => `仅删除档案登记 ${row.archiveNo}，不影响现行台账，确认？`,
            },
          ),
        ],
      }),
  },
]);

const pendingColumns: DataTableColumns<(typeof archiveStore.pendingViews)[number]> = [
  { title: '档案号', key: 'archiveNo', width: 170 },
  { title: '电梯', key: 'elevatorName', minWidth: 200, ellipsis: { tooltip: true } },
  { title: '来源文件', key: 'sourceFile', width: 200, ellipsis: { tooltip: true } },
  {
    title: '缺项 / 号段冲突',
    key: 'reasons',
    minWidth: 320,
    render: (row) =>
      h(
        NSpace,
        { vertical: true, size: 2 },
        {
          default: () =>
            row.reasons.map((reason) => h(NText, { type: 'error', style: 'font-size:12px' }, { default: () => `· ${reason}` })),
        },
      ),
  },
  {
    title: '操作',
    key: 'actions',
    width: 180,
    render: (row) =>
      h(NSpace, { size: 2 }, {
        default: () => [
          h(
            NButton,
            { size: 'tiny', text: true, type: 'primary', onClick: () => void handleRetryPending(row) },
            { default: () => '重新核对' },
          ),
          h(
            NPopconfirm, { onPositiveClick: () => archiveStore.discardPending(row.id) }, {
              trigger: () =>
                h(NButton, { size: 'tiny', text: true, type: 'error' }, { default: () => '移出待处理区' }),
              default: () => '移出后该份档案需重新导入，确认？',
            },
          ),
        ],
      }),
  },
];

const jobColumns: DataTableColumns<ArchiveImportJobRow> = [
  { title: '任务', key: 'id', width: 190, ellipsis: { tooltip: true } },
  { title: '来源文件', key: 'sourceFile', width: 190, ellipsis: { tooltip: true } },
  {
    title: '状态',
    key: 'state',
    width: 100,
    render: (row) =>
      h(
        NTag,
        { size: 'small', round: true, type: row.state === 'done' ? 'success' : row.state === 'error' ? 'error' : 'info' },
        { default: () => (row.state === 'done' ? '已完成' : row.state === 'error' ? '已中断' : '进行中') },
      ),
  },
  {
    title: '进度',
    key: 'progress',
    width: 220,
    render: (row) =>
      `落库 ${row.importedNos.length} · 待处理 ${row.stagedNos.length} · 未处理 ${row.pendingNos.length}`,
  },
  { title: '更新时间', key: 'updatedAt', width: 150 },
  {
    title: '错误',
    key: 'lastError',
    minWidth: 200,
    render: (row) => row.lastError || '—',
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    render: (row) =>
      h(NSpace, { size: 2 }, {
        default: () => [
          row.state !== 'done'
            ? h(
                NButton,
                { size: 'tiny', text: true, type: 'primary', onClick: () => void handleRetryJob(row) },
                { default: () => '断点重试' },
              )
            : null,
          h(
            NPopconfirm, { onPositiveClick: () => archiveStore.deleteJob(row.id) }, {
              trigger: () => h(NButton, { size: 'tiny', text: true, type: 'error' }, { default: () => '清除' }),
              default: () => '清除任务记录（不影响已落库档案），确认？',
            },
          ),
        ],
      }),
  },
];

function detailPlanRows(archive: Archive) {
  return archive.plans.map((plan) => {
    const items = archive.checkItems.filter((item) => item.planId === plan.id);
    return {
      planDate: plan.planDate,
      cycle: MAINT_CYCLE_LABEL[plan.cycleType],
      executor: plan.executor,
      signedAt: plan.signedAt ?? '—',
      itemCount: items.length,
      abnormal: items.filter((item) => item.result === 'abnormal' || item.result === 'advice').length,
    };
  });
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">电梯档案封存</h2>
        <div class="page-sub">
          按电梯与结清月份，把已签署保养计划、对应保养项及异常项转出的整改单装成独立档案；现行台账保留，在执行计划与后续救援不会被锁死。
        </div>
      </div>
      <n-space>
        <n-upload
          :show-file-list="false"
          accept="application/json"
          :default-upload="false"
          :disabled="importing"
          @before-upload="onBeforeUpload"
        >
          <n-button :loading="importing">导入档案包</n-button>
        </n-upload>
        <n-button @click="handleExportAll">导出档案包</n-button>
        <n-button type="primary" @click="openSeal()">办理封存</n-button>
      </n-space>
    </div>

    <n-alert type="info" :show-icon="false" style="margin-bottom: 14px">
      档案包粘回空库或已有台账时按「档案号 → 电梯 → 计划 → 保养项 → 异常项整改单」逐层核对；缺项或号段冲突先进待处理区，导入失败保留进度、支持断点重试，任何一份都不会写入半份数据。
    </n-alert>

    <div class="stat-grid">
      <stat-badge title="已封存档案" :value="overview.total" suffix="份" color="#18a058" />
      <stat-badge title="入档已签署计划" :value="overview.planTotal" suffix="期" color="#2080f0" />
      <stat-badge
        title="待处理区"
        :value="overview.pending"
        suffix="份"
        color="#f0a020"
        :hint="overview.pending > 0 ? '存在缺项或号段冲突，处理后方可落库' : '暂无待处理档案'"
      />
      <stat-badge
        title="中断导入任务"
        :value="overview.errorJobs"
        suffix="个"
        color="#d03050"
        :hint="overview.errorJobs > 0 ? '可在导入进度页签断点重试' : '全部导入任务正常'"
      />
    </div>

    <n-tabs type="line" animated class="section-gap">
      <n-tab-pane name="archives" :tab="`封存档案（${archiveStore.archiveViews.length}）`">
        <n-card size="small">
          <empty-panel
            v-if="archiveStore.archiveViews.length === 0"
            title="还没有封存档案"
            description="选择电梯与结清月份办理封存；仅已签署计划且异常项已转出整改单的区间可以入档。"
            create-label="办理封存"
            @create="openSeal()"
          />
          <n-data-table
            v-else
            :columns="archiveColumns"
            :data="archiveStore.archiveViews"
            :bordered="false"
            size="small"
            :scroll-x="1280"
            :pagination="{ pageSize: 10 }"
          />
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="pending" :tab="`待处理区（${archiveStore.pendingViews.length}）`">
        <n-card size="small">
          <empty-panel
            v-if="archiveStore.pendingViews.length === 0"
            title="待处理区为空"
            description="导入逐层核对不通过（缺项 / 号段冲突）的档案会暂存在这里，处理后可重新核对落库。"
          />
          <n-data-table
            v-else
            :columns="pendingColumns"
            :data="archiveStore.pendingViews"
            :bordered="false"
            size="small"
            :scroll-x="1200"
            :pagination="{ pageSize: 8 }"
          />
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="jobs" :tab="`导入进度（${archiveStore.jobViews.length}）`">
        <n-card size="small">
          <empty-panel
            v-if="archiveStore.jobViews.length === 0"
            title="暂无导入任务"
            description="导入档案包后这里会记录逐份进度；中断的任务保留现场，可断点重试。"
          />
          <n-data-table
            v-else
            :columns="jobColumns"
            :data="archiveStore.jobViews"
            :bordered="false"
            size="small"
            :scroll-x="1180"
            :pagination="{ pageSize: 8 }"
          />
        </n-card>
      </n-tab-pane>
    </n-tabs>

    <!-- 办理封存 -->
    <n-modal v-model:show="sealOpen" preset="card" title="办理档案封存" style="max-width: 640px">
      <n-form ref="sealFormRef" :model="sealModel" label-placement="top">
        <n-form-item
          label="电梯"
          path="elevatorId"
          :rule="{ required: true, message: '请选择电梯', trigger: 'change' }"
        >
          <n-select v-model:value="sealModel.elevatorId" filterable :options="elevatorOptions" />
        </n-form-item>
        <n-space :size="12" :wrap="false">
          <n-form-item label="结清月份起（含）" style="flex: 1">
            <n-date-picker v-model:value="sealModel.fromTs" type="month" style="width: 100%" />
          </n-form-item>
          <n-form-item label="结清月份止（含）" style="flex: 1">
            <n-date-picker v-model:value="sealModel.toTs" type="month" style="width: 100%" />
          </n-form-item>
        </n-space>
        <n-form-item label="备注">
          <n-input v-model:value="sealModel.note" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="选填" />
        </n-form-item>
      </n-form>

      <n-card v-if="preflight" size="small" title="封存前逐层核对" style="margin-bottom: 12px">
        <n-space vertical :size="6">
          <n-text style="font-size: 13px">
            结清区间 {{ preflight.monthFrom }} ~ {{ preflight.monthTo }} · 已签署计划
            {{ preflight.resolved.plans.length }} 期 · 保养项 {{ preflight.resolved.checkItems.length }} 项 ·
            转出整改单 {{ preflight.resolved.rectifies.length }} 张
          </n-text>
          <n-alert v-if="preflight.resolved.ok" type="success" :show-icon="false">
            核对通过，封存后现行台账保留，不影响在执行计划与后续救援。
          </n-alert>
          <n-alert v-else type="error" :show-icon="false">
            <div v-for="(reason, index) in preflight.resolved.errors" :key="index">· {{ reason }}</div>
          </n-alert>
          <n-alert v-if="preflight.overlapped" type="warning" :show-icon="false">
            该电梯在此月份区间已有封存档案，同一封存只保留一份。
          </n-alert>
          <n-text v-if="preflight.existing.length > 0" depth="3" style="font-size: 12px">
            已封存：{{ preflight.existing.map((item) => `${item.monthFrom}~${item.monthTo}（${item.archiveNo}）`).join('；') }}
          </n-text>
        </n-space>
      </n-card>

      <template #footer>
        <n-space justify="end">
          <n-button @click="sealOpen = false">取消</n-button>
          <n-button
            type="primary"
            :disabled="!preflight?.resolved.ok || preflight.overlapped"
            @click="submitSeal"
          >
            确认封存
          </n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 档案详情 -->
    <n-modal
      :show="detailArchive !== null"
      preset="card"
      :title="detailArchive ? `封存档案 · ${detailArchive.archiveNo}` : '封存档案'"
      style="max-width: 860px"
      @update:show="(value: boolean) => (!value ? (detailArchive = null) : undefined)"
    >
      <template v-if="detailArchive">
        <n-descriptions :column="2" size="small" label-placement="left" bordered style="margin-bottom: 12px">
          <n-descriptions-item label="电梯">
            {{ detailArchive.elevator.regCode }}（{{ detailArchive.elevator.owner }}）
          </n-descriptions-item>
          <n-descriptions-item label="结清月份">
            {{ detailArchive.monthFrom }} ~ {{ detailArchive.monthTo }}
          </n-descriptions-item>
          <n-descriptions-item label="封存时间">{{ detailArchive.sealedAt }}</n-descriptions-item>
          <n-descriptions-item label="周期">{{ MAINT_CYCLE_LABEL[detailArchive.elevator.maintCycle] }}</n-descriptions-item>
          <n-descriptions-item label="档案内容" :span="2">
            {{ archiveSummary(detailArchive) }}
          </n-descriptions-item>
          <n-descriptions-item v-if="detailArchive.note" label="备注" :span="2">{{ detailArchive.note }}</n-descriptions-item>
        </n-descriptions>

        <n-card size="small" title="已签署计划与保养项" style="margin-bottom: 12px">
          <n-data-table
            :columns="[
              { title: '计划日期', key: 'planDate', width: 120 },
              { title: '周期', key: 'cycle', width: 90 },
              { title: '执行人', key: 'executor', width: 100 },
              { title: '签署时间', key: 'signedAt', width: 150 },
              { title: '保养项', key: 'itemCount', width: 80 },
              { title: '异常/建议', key: 'abnormal', width: 90 },
            ]"
            :data="detailPlanRows(detailArchive)"
            :bordered="false"
            size="small"
            :pagination="false"
          />
        </n-card>

        <n-card size="small" title="异常项转出的整改单">
          <n-data-table
            :columns="[
              { title: '不合格项', key: 'item', minWidth: 200 },
              { title: '限期', key: 'dueDate', width: 120 },
              { title: '复核人', key: 'reviewer', width: 100 },
              { title: '状态', key: 'state', width: 100 },
            ]"
            :data="detailArchive.rectifies"
            :bordered="false"
            size="small"
            :pagination="false"
          />
        </n-card>
      </template>
    </n-modal>
  </div>
</template>
