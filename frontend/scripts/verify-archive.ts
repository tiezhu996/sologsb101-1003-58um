/**
 * 封存归档端到端核对脚本（Node + fake-indexeddb）：
 * 1. 打开 v3 库并播种演示数据
 * 2. 按电梯 + 结清月份封存已签署计划；重复封存只保留一份
 * 3. 现行台账保留（计划 / 保养项 / 整改单不删）
 * 4. 导出档案包 → 重置为空库 → 粘回：核对通过且逐层落库
 * 5. 已有台账且号段冲突：档案进待处理区，台账不出现半份写入；重试仍失败
 * 6. 待处理区信封修复号段后可成功落库
 */
import 'fake-indexeddb/auto';
import {
  DB_SCHEMA_VERSION,
  countAll,
  exportArchivePackage,
  importArchivePackage,
  initDatabase,
  listArchiveCandidates,
  listArchives,
  listCheckItems,
  listPlans,
  listRectifies,
  listStaging,
  removeStaging,
  resetDatabase,
  retryStaging,
  sealArchive,
  listElevators,
  putRectify,
  ROW_REVISION,
} from '../src/utils/db';
import type { ArchivePackage } from '../src/types/archive';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`✗ ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`✓ ${message}`);
}

async function main(): Promise<void> {
  assert(DB_SCHEMA_VERSION === 3, '结构版本升级为 v3');

  // ---- 播种 ----
  await initDatabase();
  const seeded = await countAll();
  assert(seeded.elevators === 3, `播种 3 台电梯（实际 ${seeded.elevators}）`);
  assert(seeded.archives === 0 && seeded.archiveStaging === 0, '空库无封存档案与待处理条目');

  // ---- 候选 ----
  const { candidates, sealedKeys } = await listArchiveCandidates();
  assert(candidates.length > 0, `聚合出封存候选 ${candidates.length} 组`);
  assert(sealedKeys.size === 0, '初始无已封存键');
  for (const candidate of candidates) {
    assert(candidate.plans.every((plan) => plan.state === 'signed'), `${candidate.regCode} ${candidate.settleMonth} 候选全部已签署`);
    const planIds = new Set(candidate.plans.map((plan) => plan.id));
    assert(
      candidate.checkItems.every((item) => planIds.has(item.planId)),
      `${candidate.regCode} 保养项全部归属组内计划`,
    );
  }

  // ---- 封存第一组 ----
  // 先模拟「异常项一键转整改」：elev-1 2026-09 那期有异常项「层门锁紧装置」
  const abnormalGroup = candidates.find(
    (candidate) =>
      candidate.checkItems.some((item) => item.result === 'abnormal') && candidate.elevatorId === 'elev-1',
  );
  assert(Boolean(abnormalGroup), '演示数据存在含异常项的已签署候选组');
  if (abnormalGroup) {
    const abnormalItem = abnormalGroup.checkItems.find((item) => item.result === 'abnormal');
    await putRectify({
      id: 'rect-test-linked-1',
      elevatorId: abnormalGroup.elevatorId,
      item: abnormalItem!.itemName,
      dueDate: abnormalGroup.settleMonth === '2026-09' ? '2026-10-15' : '2026-11-15',
      state: 'pending',
      reviewer: '王敏',
      reviewedAt: null,
      createdAt: '2026-10-01 09:00',
      revision: ROW_REVISION,
    });
  }

  const first = candidates[0];
  const beforePlans = await listPlans();
  const { archive, duplicated } = await sealArchive({
    elevatorId: first.elevatorId,
    settleMonth: first.settleMonth,
  });
  assert(!duplicated, '首次封存非重复');
  assert(archive.counts.plans === first.plans.length, '档案计划计数正确');
  assert(archive.counts.checkItems === first.checkItems.length, '档案保养项计数正确');
  assert(archive.counts.elevators === 1, '档案含 1 份电梯主数据');
  assert(archive.id.startsWith('ARC-'), `档案号以 ARC- 开头：${archive.id}`);

  // 现行台账保留
  const afterPlans = await listPlans();
  assert(afterPlans.length === beforePlans.length, '封存后现行计划数量不变');
  assert((await listRectifies()).length > 0, '整改单保留在现行台账');

  // ---- 重复封存只保留一份（模拟两个标签页） ----
  const secondSeal = await sealArchive({
    elevatorId: first.elevatorId,
    settleMonth: first.settleMonth,
  });
  assert(secondSeal.duplicated, '同电梯同月份再次封存判定为重复');
  assert(secondSeal.archive.id === archive.id, '重复封存返回同一档案号');
  assert((await listArchives()).length === 1, 'archives 表仍只有一份');

  // ---- 封存全部候选 ----
  for (const candidate of candidates) {
    await sealArchive({ elevatorId: candidate.elevatorId, settleMonth: candidate.settleMonth });
  }
  const sealedAll = await listArchives();
  const uniqueKeys = new Set(sealedAll.map((item) => `${item.elevatorId}@${item.settleMonth}`));
  assert(uniqueKeys.size === sealedAll.length, '全部封存后无重复电梯+月份');

  // ---- 异常项 → 整改单随档：找一组含异常的已签署计划 ----
  const withRectify = sealedAll.find((item) => item.counts.rectifies > 0);
  assert(Boolean(withRectify), '存在携带异常转出整改单的档案');
  if (withRectify) {
    const abnormalNames = new Set(
      withRectify.payload.checkItems
        .filter((item) => item.result === 'abnormal' || item.result === 'advice')
        .map((item) => item.itemName),
    );
    assert(
      withRectify.payload.rectifies.every((rectify) => abnormalNames.has(rectify.item)),
      '随档整改单均由组内异常项转出',
    );
  }

  // ---- 导出 ----
  const pack: ArchivePackage = await exportArchivePackage();
  assert(pack.archives.length === sealedAll.length, `档案包含 ${sealedAll.length} 份档案`);
  assert(pack.kind === 'gbelevsvc-archive', '档案包标识正确');

  // ---- 粘回空库 ----
  await resetDatabase();
  // resetDatabase 会重新播种；再清掉五张台账表模拟「空库」（archives 已被 reset 清空）
  const { db } = await import('../src/utils/db');
  await db.transaction(
    'rw',
    [db.elevators, db.plans, db.checkItems, db.rescues, db.rectifies],
    async () => {
      await Promise.all([
        db.elevators.clear(),
        db.plans.clear(),
        db.checkItems.clear(),
        db.rescues.clear(),
        db.rectifies.clear(),
      ]);
    },
  );
  assert((await listArchives()).length === 0, '重置后档案清空');
  const emptyOutcomes = await importArchivePackage(pack);
  assert(emptyOutcomes.every((item) => item.ok), '粘回空库：全部逐层核对通过');
  assert((await listArchives()).length === pack.archives.length, '空库落库档案数一致');
  assert((await listStaging()).length === 0, '空库落库无待处理条目');
  const restoredPlans = await listPlans();
  const expectedPlans = pack.archives.reduce((sum, item) => sum + item.payload.plans.length, 0);
  assert(restoredPlans.length === expectedPlans, `空库恢复计划 ${expectedPlans} 期（实际 ${restoredPlans.length}）`);

  // 再次导入整包：档案号全部重复，台账不重复追加
  const dupOutcomes = await importArchivePackage(pack);
  assert(dupOutcomes.every((item) => item.ok && item.duplicated), '重复导入整包：逐份幂等跳过');
  assert((await listPlans()).length === expectedPlans, '重复导入后计划不翻倍');

  // ---- 号段冲突：构造同档案号但实体 ID 已被台账占用的包 ----
  const conflictPack: ArchivePackage = structuredClone(pack);
  conflictPack.archives[0].archiveNo = `ARC-CONFLICT-${Date.now()}`;
  // 该档案里的计划 / 保养项 / 整改单 ID 与现行台账完全相同 → 号段冲突
  const outcomesConflict = await importArchivePackage(conflictPack);
  const conflict = outcomesConflict[0];
  assert(!conflict.ok, '号段冲突档案核对失败');
  assert(Boolean(conflict.stagingId), '冲突档案进入待处理区并返回条目 ID');
  const stagingAfterConflict = await listStaging();
  assert(stagingAfterConflict.length === 1, '待处理区 1 条');
  assert(stagingAfterConflict[0].issues.some((issue) => issue.includes('号段冲突')), '问题清单含号段冲突说明');
  assert(stagingAfterConflict[0].attempts === 1, '首次进区尝试次数为 1');

  // 台账计划数不变（没写半份数据）
  assert((await listPlans()).length === expectedPlans, '冲突时不写入半份数据：计划数不变');
  assert((await listCheckItems()).length === pack.archives.reduce((s, a) => s + a.payload.checkItems.length, 0), '保养项数不变');
  assert((await listRectifies()).length === pack.archives.reduce((s, a) => s + a.payload.rectifies.length, 0), '整改单数不变');
  assert((await listElevators()).length === 3, '电梯主数据不被冲突档案污染');

  // 直接重试：冲突仍在 → 留在待处理区，attempts 增加
  const retryOutcome = await retryStaging(stagingAfterConflict[0].id);
  assert(!retryOutcome.ok, '冲突未解除前重试仍失败');
  const stagingAfterRetry = await listStaging();
  assert(stagingAfterRetry.length === 1 && stagingAfterRetry[0].attempts === 2, '失败重试留进度：attempts=2');

  // ---- 修复信封（重映射全部实体 ID 与引用）后重试成功 ----
  const fixed = structuredClone(stagingAfterRetry[0]);
  const suffix = `fix${Date.now()}`;
  const oldElevatorId = fixed.envelope.elevatorId;
  fixed.envelope.archiveNo = `${fixed.envelope.archiveNo}FIX`;
  fixed.envelope.payload.elevator = {
    ...fixed.envelope.payload.elevator,
    id: `elev-${suffix}`,
  };
  fixed.envelope.elevatorId = fixed.envelope.payload.elevator.id;
  const planIdMap = new Map<string, string>();
  for (const plan of fixed.envelope.payload.plans) {
    planIdMap.set(plan.id, `${plan.id}-${suffix}`);
    plan.id = planIdMap.get(plan.id)!;
    plan.elevatorId = fixed.envelope.payload.elevator.id;
  }
  for (const item of fixed.envelope.payload.checkItems) {
    item.id = `${item.id}-${suffix}`;
    item.planId = planIdMap.get(item.planId) ?? item.planId;
  }
  for (const rectify of fixed.envelope.payload.rectifies) {
    rectify.id = `${rectify.id}-${suffix}`;
    rectify.elevatorId = fixed.envelope.payload.elevator.id;
  }
  void oldElevatorId;
  // 先把修复后的信封放回待处理区（模拟在待处理区修正）
  const { putStaging } = await import('../src/utils/db');
  await putStaging(fixed);
  const fixedOutcome = await retryStaging(fixed.id);
  assert(fixedOutcome.ok, '修复号段后重试成功落库');
  assert((await listStaging()).length === 0, '成功后自动移出待处理区');
  assert((await listArchives()).length === pack.archives.length + 1, '档案总数 +1（含修复档案）');
  assert((await listElevators()).length === 4, '粘回新增电梯主数据（空库场景补入）');

  // ---- 缺项包裹 → 待处理区 ----
  const broken: ArchivePackage = structuredClone(pack);
  broken.archives[0].archiveNo = 'ARC-BROKEN-1';
  broken.archives[0].payload.checkItems = []; // 计划还在但保养项缺失
  // 清出唯一冲突：改实体 id 制造悬挂/缺项场景（计划保留、无保养项）
  for (const plan of broken.archives[0].payload.plans) plan.id = `${plan.id}-brk`;
  const elevator2 = broken.archives[0].payload.elevator;
  elevator2.id = 'elev-broken';
  broken.archives[0].elevatorId = 'elev-broken';
  for (const plan of broken.archives[0].payload.plans) plan.elevatorId = 'elev-broken';
  const brokenOutcomes = await importArchivePackage(broken);
  assert(!brokenOutcomes[0].ok, '缺项档案核对失败');
  assert(
    brokenOutcomes[0].issues.some((issue) => issue.includes('缺少对应保养项')),
    '缺项原因：计划缺少对应保养项',
  );

  await removeStaging((await listStaging()).find((item) => item.archiveNo === 'ARC-BROKEN-1')!.id);

  console.log('\n全部核对通过 ✔');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
