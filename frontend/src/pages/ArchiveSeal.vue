<script setup lang="ts">
/**
 * /archives 电梯档案封存
 * 按电梯 + 结清月份，把已签署保养计划、对应保养项及异常项转出的整改单装成独立档案；
 * 现行台账保留。两个标签页同时封存同一电梯/月份只保留一份（档案号确定性去重）。
 * 档案包粘回空库或已有台账时逐层核对，缺项 / 号段冲突先进待处理区，
 * 导入失败留进度可重试，单份档案单事务落库，不写入半份数据。
 */
import { computed, h, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NInput,
  NModal,
  NSpace,
  NTabPane,
  NTabs,
  NTag,
  NText,
  NUpload,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { useArchiveStore } from '../stores/archiveStore';
import { useElevatorStore } from '../stores/elevatorStore';
import { MAINT_CYCLE_LABEL } from '../types/elevator';
import { PLAN_STATE_LABEL } from '../types/plan';
import { CHECK_RESULT_LABEL } from '../types/checkItem';
import { RECTIFY_STATE_LABEL } from '../types/rectify';
import {
  STAGING_STATE_LABEL,
  type Archive,
  type ArchiveCandidate,
  type ArchivePackage,
  type ArchiveStaging,
} from '../types/archive';
import type { Plan } from '../types/plan';
import type { CheckItem } from '../types/checkItem';
import type { Rectify } from '../types/rectify';
import { isArchivePackage } from '../utils/archive';
import { DB_SCHEMA_VERSION } from '../utils/db';
import { backupFilename, downloadJson, readJsonFile } from '../utils/export';
import StatBadge from '../components/common/StatBadge.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';

const message = useMessage();
const archiveStore = useArchiveStore();
const elevatorStore = useElevatorStore();

const tab = ref<'candidates' | 'archives' | 'staging'>('candidates');
const busy = ref<string>('');
const detailArchive = ref<Archive | null>(null);
const sealTarget = ref<ArchiveCandidate | null>(null);
const sealRemark = ref('');

onMounted(async () => {
  await elevatorStore.bootstrap();
  await archiveStore.bootstrap();
});

/** 电梯周期文案（候选卡片展示） */
function cycleOf(elevatorId: string): string {
  const elevator = elevatorStore.elevators.find((item) => item.id === elevatorId);
  return elevator ? MAINT_CYCLE_LABEL[elevator.maintCycle] : '—';
}

/* ------------------------------ 封存 ------------------------------ */
function openSeal(candidate: ArchiveCandidate): void {
  sealTarget.value = candidate;
  sealRemark.value = '';
}

async function confirmSeal(): Promise<void> {
  if (!sealTarget.value) return;
  const target = sealTarget.value;
  busy.value = target.elevatorId + target.settleMonth;
  try {
    await archiveStore.seal(target.elevatorId, target.settleMonth, sealRemark.value);
    message.success(`已封存：${target.regCode} · 结清月份 ${target.settleMonth}`);
    sealTarget.value = null;
    tab.value = 'archives';
  } catch (error) {
    message.error(`封存失败：${error instanceof Error ? error.message : '未知错误'}`);
  } finally {
    busy.value = '';
  }
}

/* ------------------------------ 导出 / 导入 ------------------------------ */
async function handleExportAll(): Promise<void> {
  if (archiveStore.archives.length === 0) {
    message.warning('还没有已封存档案');
    return;
  }
  const pack = await archiveStore.buildExportPackage();
  downloadJson(backupFilename(`gbelevsvc-archive-v${DB_SCHEMA_VERSION}`), pack);
  message.success(`已导出 ${pack.archives.length} 份档案的档案包`);
}

async function handleExportOne(archive: Archive): Promise<void> {
  const pack = await archiveStore.buildExportPackage([archive.id]);
  downloadJson(`gbelevsvc-archive-${archive.id}.json`, pack);
  message.success(`档案 ${archive.id} 已导出`);
}

async function handleImport(file: File): Promise<void> {
  let pack: ArchivePackage;
  try {
    const parsed = await readJsonFile<unknown>(file);
    if (!isArchivePackage(parsed)) {
      message.error('文件不是封存档案包（缺少档案标识）');
      return;
    }
    pack = parsed;
  } catch {
    message.error('档案包解析失败，请确认文件未损坏');
    return;
  }
  if (pack.archives.length === 0) {
    message.warning('档案包内没有档案');
    return;
  }
  try {
    const outcomes = await archiveStore.importPack(pack);
    const okCount = outcomes.filter((item) => item.ok && !item.duplicated).length;
    const dupCount = outcomes.filter((item) => item.duplicated).length;
    const failCount = outcomes.filter((item) => !item.ok).length;
    if (failCount > 0) {
      tab.value = 'staging';
      message.warning(`导入 ${okCount} 份、重复跳过 ${dupCount} 份、${failCount} 份进入待处理区`);
    } else {
      message.success(`导入完成：${okCount} 份档案${dupCount ? `，重复跳过 ${dupCount} 份` : ''}`);
      tab.value = 'archives';
    }
  } catch (error) {
    message.error(`导入失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
}

async function handleRetry(row: ArchiveStaging): Promise<void> {
  busy.value = row.id;
  try {
    const outcome = await archiveStore.retry(row.id);
    if (outcome.ok) {
      message.success(outcome.duplicated ? '档案已存在，已从待处理区移除' : '重试成功，档案已落库');
    } else {
      message.warning(`仍未通过：${outcome.issues[0] ?? '请核对后再试'}`);
    }
  } catch (error) {
    message.error(`重试失败：${error instanceof Error ? error.message : '未知错误'}`);
  } finally {
    busy.value = '';
  }
}

async function handleDeleteArchive(archive: Archive): Promise<void> {
  await archiveStore.deleteArchive(archive.id);
  message.success('档案已删除（现行台账不受影响）');
  if (detailArchive.value?.id === archive.id) detailArchive.value = null;
}

/* ------------------------------ 表格列 ------------------------------ */
const candidateColumns = computed<DataTableColumns<ArchiveCandidate>>(() => [
  { title: '注册代码', key: 'regCode', minWidth: 190 },
  { title: '使用单位', key: 'owner', minWidth: 180, ellipsis: { tooltip: true } },
  {
    title: '周期',
    key: 'cycle',
    width: 90,
    render: (row) => cycleOf(row.elevatorId),
  },
  { title: '结清月份', key: 'settleMonth', width: 110 },
  {
    title: '已签署计划',
    key: 'planCount',
    width: 100,
    render: (row) => h(NTag, { size: 'small', type: 'success' }, { default: () => `${row.plans.length} 期` }),
  },
  {
    title: '保养项',
    key: 'itemCount',
    width: 90,
    render: (row) => `${row.checkItems.length} 项`,
  },
  {
    title: '随档整改单',
    key: 'rectifyCount',
    width: 100,
    render: (row) =>
      h(NTag, { size: 'small', type: row.rectifies.length > 0 ? 'warning' : 'default' }, {
        default: () => `${row.rectifies.length} 单`,
      }),
  },
  {
    title: '核对提示',
    key: 'warnings',
    minWidth: 200,
    render: (row) =>
      row.warnings.length > 0
        ? h(NText, { type: 'warning', style: 'font-size:12px' }, { default: () => row.warnings.join('；') })
        : h(NText, { depth: 3, style: 'font-size:12px' }, { default: () => '资料齐备' }),
  },
  {
    title: '操作',
    key: 'actions',
    width: 110,
    fixed: 'right',
    render: (row) =>
      h(
        NButton,
        {
          size: 'small',
          type: 'primary',
          loading: busy.value === row.elevatorId + row.settleMonth,
          onClick: () => openSeal(row),
        },
        { default: () => '封存' },
      ),
  },
]);

const archiveColumns = computed<DataTableColumns<Archive>>(() => [
  { title: '档案号', key: 'id', width: 250 },
  { title: '注册代码', key: 'regCode', minWidth: 180 },
  { title: '使用单位', key: 'owner', minWidth: 160, ellipsis: { tooltip: true } },
  { title: '结清月份', key: 'settleMonth', width: 110 },
  {
    title: '计划 / 项 / 单',
    key: 'counts',
    width: 150,
    render: (row) =>
      `${row.counts.plans} / ${row.counts.checkItems} / ${row.counts.rectifies}`,
  },
  { title: '封存时间', key: 'archivedAt', width: 160 },
  {
    title: '操作',
    key: 'actions',
    width: 210,
    fixed: 'right',
    render: (row) =>
      h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'small', text: true, type: 'primary', onClick: () => (detailArchive.value = row) }, {
            default: () => '查看',
          }),
          h(NButton, { size: 'small', text: true, onClick: () => void handleExportOne(row) }, {
            default: () => '导出',
          }),
          h(
            NButton,
            { size: 'small', text: true, type: 'error', onClick: () => void handleDeleteArchive(row) },
            { default: () => '删除' },
          ),
        ],
      }),
  },
]);

const stagingColumns = computed<DataTableColumns<ArchiveStaging>>(() => [
  { title: '档案号', key: 'archiveNo', width: 250 },
  { title: '注册代码', key: 'regCode', minWidth: 170 },
  { title: '结清月份', key: 'settleMonth', width: 110 },
  {
    title: '状态',
    key: 'state',
    width: 100,
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: row.state === 'pending' ? 'error' : row.state === 'imported' ? 'success' : 'default' },
        { default: () => STAGING_STATE_LABEL[row.state] },
      ),
  },
  {
    title: '问题 / 进度',
    key: 'issues',
    minWidth: 260,
    render: (row) =>
      h('div', { style: 'font-size:12px;line-height:1.6' }, [
        ...row.issues.map((issue) => h(NText, { type: 'error' }, { default: () => issue })),
        h(NText, { depth: 3, style: 'display:block' }, {
          default: () => `${row.progress} · 已重试 ${row.attempts} 次${row.lastAttemptAt ? ` · ${row.lastAttemptAt}` : ''}`,
        }),
      ]),
  },
  {
    title: '操作',
    key: 'actions',
    width: 170,
    fixed: 'right',
    render: (row) =>
      h(NSpace, { size: 4 }, {
        default: () => [
          h(
            NButton,
            {
              size: 'small',
              type: 'primary',
              disabled: row.state === 'discarded',
              loading: busy.value === row.id,
              onClick: () => void handleRetry(row),
            },
            { default: () => '重试' },
          ),
          row.state !== 'discarded'
            ? h(
                NButton,
                { size: 'small', text: true, onClick: () => void archiveStore.discardStaging(row.id) },
                { default: () => '放弃' },
              )
            : h(
                NButton,
                { size: 'small', text: true, type: 'error', onClick: () => void archiveStore.deleteStaging(row.id) },
                { default: () => '移除' },
              ),
        ],
      }),
  },
]);

const detailPlans = computed(() => detailArchive.value?.payload.plans ?? []);
const detailItems = computed(() => detailArchive.value?.payload.checkItems ?? []);
const detailRectifies = computed(() => detailArchive.value?.payload.rectifies ?? []);

const detailPlanColumns = computed<DataTableColumns<Plan>>(() => [
  { title: '计划日期', key: 'planDate', width: 120 },
  { title: '周期', key: 'cycleType', width: 90, render: (row) => MAINT_CYCLE_LABEL[row.cycleType] },
  { title: '执行人', key: 'executor', width: 100 },
  {
    title: '状态',
    key: 'state',
    width: 100,
    render: (row) => h(NTag, { size: 'small', type: 'success' }, { default: () => PLAN_STATE_LABEL[row.state] }),
  },
  { title: '签署时间', key: 'signedAt', render: (row) => row.signedAt ?? '—' },
]);

const detailItemColumns = computed<DataTableColumns<CheckItem>>(() => [
  { title: '序号', key: 'seq', width: 60 },
  { title: '项目', key: 'itemName', minWidth: 160 },
  {
    title: '结果',
    key: 'result',
    width: 90,
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: row.result === 'normal' ? 'success' : 'warning' },
        { default: () => (row.result ? CHECK_RESULT_LABEL[row.result] : '—') },
      ),
  },
  { title: '实测值', key: 'value', minWidth: 160 },
  { title: '备注', key: 'remark', minWidth: 140, render: (row) => row.remark || '—' },
]);

const detailRectifyColumns = computed<DataTableColumns<Rectify>>(() => [
  { title: '不合格项', key: 'item', minWidth: 180 },
  { title: '限期', key: 'dueDate', width: 120 },
  {
    title: '状态',
    key: 'state',
    width: 100,
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: row.state === 'reviewed' ? 'success' : 'warning' },
        { default: () => RECTIFY_STATE_LABEL[row.state] },
      ),
  },
  { title: '复核人', key: 'reviewer', width: 100 },
  { title: '复核时间', key: 'reviewedAt', width: 150, render: (row) => row.reviewedAt ?? '—' },
]);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-title">电梯档案封存</h2>
        <div class="page-sub">
          按电梯与结清月份封存已签署保养计划、对应保养项及异常项转出的整改单；现行台账保留，在执行计划与后续救援不受影响。
        </div>
      </div>
      <n-space>
        <n-upload
          :show-file-list="false"
          accept="application/json"
          :default-upload="false"
          @before-upload="
            ({ file }) => {
              if (file.file) void handleImport(file.file);
              return false;
            }
          "
        >
          <n-button>导入档案包</n-button>
        </n-upload>
        <n-button @click="handleExportAll">导出全部档案包</n-button>
      </n-space>
    </div>

    <div class="stat-grid">
      <stat-badge title="可封存候选" :value="archiveStore.pendingCandidates.length" suffix="组" color="#2080f0" />
      <stat-badge title="已封存档案" :value="archiveStore.archives.length" suffix="份" color="#18a058" />
      <stat-badge
        title="待处理区"
        :value="archiveStore.pendingStagingCount"
        suffix="份"
        color="#d03050"
        hint="缺项或号段冲突，核对后可重试"
      />
      <stat-badge
        title="随档整改单"
        :value="archiveStore.archives.reduce((sum, item) => sum + item.counts.rectifies, 0)"
        suffix="单"
        color="#f0a020"
      />
    </div>

    <n-card size="small">
      <n-tabs v-model:value="tab" type="line" animated>
        <!-- 待封存 -->
        <n-tab-pane name="candidates" :tab="`待封存（${archiveStore.pendingCandidates.length}）`">
          <n-alert type="info" :bordered="false" style="margin-bottom: 12px">
            仅列出已签署计划，按签署月份结清；封存时复制一份独立档案，计划、保养项与整改单原件仍保留在现行台账。
          </n-alert>
          <empty-panel
            v-if="archiveStore.pendingCandidates.length === 0"
            title="暂无可封存的已签署计划"
            description="待保养计划逐项填写并签署后，会按电梯与结清月份自动出现在这里。"
          />
          <n-data-table
            v-else
            :columns="candidateColumns"
            :data="archiveStore.pendingCandidates"
            :bordered="false"
            size="small"
            :scroll-x="1180"
            :pagination="{ pageSize: 8 }"
          />
        </n-tab-pane>

        <!-- 已封存 -->
        <n-tab-pane name="archives" :tab="`已封存（${archiveStore.archives.length}）`">
          <empty-panel
            v-if="archiveStore.archives.length === 0"
            title="还没有封存档案"
            description="在「待封存」页签按电梯 + 结清月份封存后在此查看、导出。"
          />
          <n-data-table
            v-else
            :columns="archiveColumns"
            :data="archiveStore.archives"
            :bordered="false"
            size="small"
            :scroll-x="1100"
            :pagination="{ pageSize: 8 }"
          />
        </n-tab-pane>

        <!-- 待处理区 -->
        <n-tab-pane name="staging" :tab="`待处理区（${archiveStore.pendingStagingCount}）`">
          <n-alert type="warning" :bordered="false" style="margin-bottom: 12px">
            档案包逐层核对未通过（缺项、悬挂引用或号段冲突）的档案会留在这里；可按当前台账重新核对重试，失败不写入半份数据。
          </n-alert>
          <empty-panel
            v-if="archiveStore.stagingViews.length === 0"
            title="待处理区为空"
            description="导入核对全部通过，没有需要人工处理的档案。"
          />
          <n-data-table
            v-else
            :columns="stagingColumns"
            :data="archiveStore.stagingViews"
            :bordered="false"
            size="small"
            :scroll-x="1080"
            :pagination="{ pageSize: 8 }"
            :row-class-name="(row: ArchiveStaging) => (row.state === 'pending' ? 'row-marked' : '')"
          />
        </n-tab-pane>
      </n-tabs>
    </n-card>

    <!-- 封存确认 -->
    <n-modal
      :show="sealTarget !== null"
      preset="card"
      title="封存确认"
      style="max-width: 560px"
      @update:show="(value: boolean) => !value && (sealTarget = null)"
    >
      <n-descriptions v-if="sealTarget" :column="1" size="small" label-placement="left" bordered>
        <n-descriptions-item label="电梯">{{ sealTarget.regCode }}（{{ sealTarget.owner }}）</n-descriptions-item>
        <n-descriptions-item label="结清月份">{{ sealTarget.settleMonth }}</n-descriptions-item>
        <n-descriptions-item label="已签署计划">{{ sealTarget.plans.length }} 期</n-descriptions-item>
        <n-descriptions-item label="保养项">{{ sealTarget.checkItems.length }} 项</n-descriptions-item>
        <n-descriptions-item label="随档整改单">{{ sealTarget.rectifies.length }} 单</n-descriptions-item>
      </n-descriptions>
      <n-alert
        v-if="sealTarget && sealTarget.warnings.length > 0"
        type="warning"
        :bordered="false"
        style="margin-top: 10px"
        :title="sealTarget.warnings.join('；')"
      />
      <n-alert type="info" :bordered="false" style="margin-top: 10px">
        封存为复制独立档案，现行台账保留；同一电梯同一月份重复封存只保留一份。
      </n-alert>
      <n-input
        v-model:value="sealRemark"
        type="textarea"
        placeholder="封存说明（可选）"
        :rows="2"
        style="margin-top: 10px"
      />
      <template #footer>
        <n-space justify="end">
          <n-button @click="sealTarget = null">取消</n-button>
          <n-button type="primary" :loading="busy !== ''" @click="confirmSeal">确认封存</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 档案详情 -->
    <n-modal
      :show="detailArchive !== null"
      preset="card"
      title="封存档案明细"
      style="max-width: 860px"
      @update:show="(value: boolean) => !value && (detailArchive = null)"
    >
      <template v-if="detailArchive">
        <n-descriptions :column="2" size="small" label-placement="left" bordered style="margin-bottom: 12px">
          <n-descriptions-item label="档案号">{{ detailArchive.id }}</n-descriptions-item>
          <n-descriptions-item label="结清月份">{{ detailArchive.settleMonth }}</n-descriptions-item>
          <n-descriptions-item label="电梯">
            {{ detailArchive.regCode }}（{{ detailArchive.owner }}）
          </n-descriptions-item>
          <n-descriptions-item label="封存时间">{{ detailArchive.archivedAt }}</n-descriptions-item>
          <n-descriptions-item label="载重 / 层站" :span="2">
            {{ detailArchive.payload.elevator.loadKg }}kg · {{ detailArchive.payload.elevator.stops }} 层站
          </n-descriptions-item>
          <n-descriptions-item v-if="detailArchive.remark" label="封存说明" :span="2">
            {{ detailArchive.remark }}
          </n-descriptions-item>
        </n-descriptions>

        <n-text strong style="font-size: 13px">已签署保养计划（{{ detailPlans.length }} 期）</n-text>
        <n-data-table
          :columns="detailPlanColumns"
          :data="detailPlans"
          :bordered="false"
          size="small"
          style="margin: 6px 0 12px"
        />

        <n-text strong style="font-size: 13px">保养项（{{ detailItems.length }} 项）</n-text>
        <n-data-table
          :columns="detailItemColumns"
          :data="detailItems"
          :bordered="false"
          size="small"
          :max-height="240"
          style="margin: 6px 0 12px"
        />

        <n-text strong style="font-size: 13px">异常项转出的整改单（{{ detailRectifies.length }} 单）</n-text>
        <n-data-table
          :columns="detailRectifyColumns"
          :data="detailRectifies"
          :bordered="false"
          size="small"
          style="margin: 6px 0 0"
        />
      </template>
      <template #footer>
        <n-space justify="end">
          <n-button v-if="detailArchive" @click="detailArchive && void handleExportOne(detailArchive)">
            导出此档案
          </n-button>
          <n-button type="primary" @click="detailArchive = null">关闭</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>
