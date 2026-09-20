/* ============================================================
 * smoke.test.js — node 冒烟测试（无框架，直接断言）
 * 运行：node test/smoke.test.js
 * 覆盖：状态机纯函数（R1/R2/R5/Q13）、数据层增改查与留痕（R3/Q14）
 * 说明：node 环境无 localStorage 时 store 自动降级为内存模式（Q6）；
 *       若存在全局 localStorage（新版本 node），先清理演示键再测。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* 以 globalThis 为挂载点加载脚本（脚本内部 typeof window === 'undefined' → globalThis） */
function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function(src)();
}
load('prototype/js/constants.js');
load('prototype/js/store.js');

/* 新版 node 可能内置 localStorage：清理演示键，保证种子数据从零注入 */
if (typeof localStorage !== 'undefined' && localStorage) {
  try { localStorage.removeItem('mcps_units_v1'); } catch (e) { /* 忽略 */ }
}

const C = globalThis.APP.CONST;
const STORE = globalThis.APP.STORE;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'eq') + '：期望 ' + b + '，实际 ' + a); }
function near(a, lo, hi, msg) { if (!(a >= lo && a <= hi)) throw new Error((msg || 'range') + '：实际 ' + a + '，应在 [' + lo + ',' + hi + ']'); }

console.log('— 常量与状态机（constants.js）');

t('阶段定义 4 个、工段模板 7 个', function () {
  eq(C.STAGES.length, 4, 'STAGES');
  eq(C.SUBSYSTEM_TEMPLATES.length, 7, 'SUBSYSTEM_TEMPLATES');
});

t('R5（并行修订）：currentStageOf = 最深进行中/停滞阶段，否则第一个未完成', function () {
  const u = STORE.getMachine('SX-BC-2026-012');
  eq(C.currentStageOf(u), 'testing', 'u1 当前阶段');
  const full = STORE.getMachine('SX-GC-2025-038');
  eq(C.currentStageOf(full), 'shipping', '全 done 停在最后阶段');
  const par = STORE.getMachine('SX-PC-2026-003'); /* 种子演示：进货与加工同时进行中 */
  eq(C.currentStageOf(par), 'processing', '并行推进时取最深活跃阶段');
  /* 纯函数语义补充验证（构造对象直接测） */
  const mk = function (s) {
    return { subsystems: [], stages: {
      procurement: { status: s[0] }, processing: { status: s[1] },
      testing: { status: s[2] }, shipping: { status: s[3] }
    } };
  };
  eq(C.currentStageOf(mk(['pending', 'pending', 'pending', 'pending'])), 'procurement', '全未开始取第一阶段');
  eq(C.currentStageOf(mk(['done', 'pending', 'pending', 'pending'])), 'processing', '前置完成取下一阶段');
  eq(C.currentStageOf(mk(['in_progress', 'pending', 'pending', 'pending'])), 'procurement', '仅进货活跃取进货');
  eq(C.currentStageOf(mk(['done', 'done', 'blocked', 'pending'])), 'testing', '异常停滞也算活跃');
});

t('Q13：整体进度推算（u1 ≈ 62~63%，u4 并行演示 ≈ 15~20%，u5 = 100%）', function () {
  const u1 = STORE.getMachine('SX-BC-2026-012');
  near(C.computeOverallProgress(u1), 60, 65, 'u1 整体进度');
  const u4 = STORE.getMachine('SX-PC-2026-003');
  near(C.computeOverallProgress(u4), 15, 20, 'u4 整体进度');
  const u5 = STORE.getMachine('SX-GC-2025-038');
  eq(C.computeOverallProgress(u5), 100, 'u5 整体进度');
});

t('R1：跳序推进给出软警告（试机仍要求前置完成）', function () {
  const u = STORE.getMachine('SX-PC-2026-003'); /* 进货与加工并行进行中 */
  const warns = C.validateStageTransition(u, 'testing', 'in_progress');
  assert(warns.length >= 1 && warns[0].indexOf('原材料进货') !== -1, '应提示前一阶段未完成，实际：' + warns.join('|'));
});

t('并行规则（2026-09-19 修订）：进货未完成时开始/完成加工不再警告', function () {
  const mk = function (proc) {
    return { stages: { procurement: { status: proc }, processing: { status: 'pending' },
      testing: { status: 'pending' }, shipping: { status: 'pending' } },
      subsystems: [
        { name: '投料设备', progress: 100 }, { name: '材料熔融设备', progress: 100 },
        { name: '塑性挤出设备', progress: 100 }, { name: '冷却设备', progress: 100 },
        { name: '运输设备', progress: 100 }, { name: '切割设备', progress: 100 },
        { name: '打包设备', progress: 100 }
      ] };
  };
  eq(C.validateStageTransition(mk('in_progress'), 'processing', 'in_progress').length, 0, '进货进行中可开工');
  eq(C.validateStageTransition(mk('pending'), 'processing', 'in_progress').length, 0, '进货未开始也可先开工');
  eq(C.validateStageTransition(mk('in_progress'), 'processing', 'done').length, 0, '工段齐全时完成加工无前置警告');
});

t('FR-A11：ssStatusOf 三态派生（0% 等待材料 / 1~99% 进行中 / 100% 生产完成）', function () {
  eq(C.ssStatusOf(0), 'waiting_material', '0%');
  eq(C.ssStatusOf(5), 'in_progress', '5%');
  eq(C.ssStatusOf(45), 'in_progress', '45%');
  eq(C.ssStatusOf(99), 'in_progress', '99%');
  eq(C.ssStatusOf(100), 'done', '100%');
});

t('并行不越界：试机/发货的顺序软警告保留', function () {
  const u = { stages: { procurement: { status: 'done' }, processing: { status: 'in_progress' },
    testing: { status: 'pending' }, shipping: { status: 'pending' } }, subsystems: [] };
  const warns = C.validateStageTransition(u, 'testing', 'in_progress');
  assert(warns.length >= 1 && warns[0].indexOf('设备加工') !== -1, '试机应提示加工未完成，实际：' + warns.join('|'));
});

t('R2：工段未全部完成时，加工阶段标 done 给警告（按完成度判定）', function () {
  const u = STORE.getMachine('SX-BM-2026-021'); /* 部分工段未完成 */
  const warns = C.validateStageTransition(u, 'processing', 'done');
  assert(warns.some(w => w.indexOf('工段未完成') !== -1), '应提示工段未完成，实际：' + warns.join('|'));
  /* 全部工段完成后不再给该警告 */
  for (const s of u.subsystems) { s.progress = 100; }
  const warns2 = C.validateStageTransition(u, 'processing', 'done');
  assert(!warns2.some(w => w.indexOf('工段未完成') !== -1), '工段齐了不应再提示');
});

console.log('— 数据层（store.js）');

t('首次访问注入 5 张订单 / 8 台设备（2026-09-19 重生成案例）', function () {
  eq(STORE.listOrders('').length, 5, '订单数');
  eq(STORE.listMachines().length, 8, '设备数');
});

t('按编号（含同单任一编号）/合同号/机型关键词查询', function () {
  eq(STORE.listOrders('SX-BC-2026-012').length, 1, '按编号');
  eq(STORE.listOrders('SX-GC-2026-006').length, 1, '按同单另一台编号');
  assert(STORE.listOrders('PE').length >= 2, '按机型关键词');
  eq(STORE.listOrders('HT-2026-018')[0].customer, '中亚管业', '按合同号');
});

t('R3：阶段变更自动留痕', function () {
  const before = STORE.getMachine('SX-PC-2026-003').logs.length;
  const res = STORE.updateStage('SX-PC-2026-003', 'procurement', { status: 'done', note: '全部到货' }, '测试员');
  assert(!res.error, '更新不应报错');
  const u = STORE.getMachine('SX-PC-2026-003');
  eq(u.stages.procurement.status, 'done', '状态已更新');
  eq(u.logs.length, before + 1, '日志 +1');
  eq(u.logs[0].kind, 'stage', '日志类型');
  assert(u.logs[0].text.indexOf('原材料进货') !== -1, '日志含阶段名');
  eq(u.logs[0].actor, '测试员', '操作人');
});

t('工段更新：进度越界钳制到 0~100', function () {
  const res = STORE.updateSubsystem('SX-BM-2026-021', 'extrusion', { progress: 150 }, '测试员');
  assert(!res.error, '更新不应报错');
  eq(STORE.getMachine('SX-BM-2026-021').subsystems.find(s => s.code === 'extrusion').progress, 100, '钳制到 100');
});

t('FR-A6：新建订单（数量=编号个数，每台独立建档）+ 编号查重', function () {
  const dup = STORE.createOrder({ unitIds: ['SX-BC-2026-012'], model: 'X' }, '测试员');
  assert(dup.error && dup.error.indexOf('已存在') !== -1, '编号重复应报错');
  const ok = STORE.createOrder({ unitIds: ['SX-BC-2026-099', 'SX-BC-2026-100'], contractNo: 'HT-T-1', model: '测试机型', category: 'plate' }, '测试员');
  assert(!ok.error, '合法创建应成功：' + (ok.error || ''));
  eq(ok.order.quantity, 2, '数量=编号个数');
  eq(STORE.machinesOf(ok.order.id).length, 2, '两台设备独立建档');
  const m = STORE.getMachine('SX-BC-2026-099');
  eq(m.subsystems.length, 7, '工段按模板初始化');
  eq(m.subsystems[0].status, 'waiting_material', '工段初始为等待材料');
  const res = STORE.updateStage('SX-BC-2026-099', 'procurement', { status: 'in_progress' }, '测试员');
  assert(!res.error && res.unit.stages.procurement.status === 'in_progress', '新设备可正常更新');
  assert(STORE.createOrder({ unitIds: ['SX-BC-2026-099', 'SX-BC-2026-101'], model: 'X' }, '测试员').error, '与他单编号冲突应报错');
  assert(STORE.createOrder({ unitIds: ['SX-BC-2026-102'], quantity: 3, model: 'X' }, '测试员').error, '数量与编号个数不一致应报错');
});

t('FR-A5：追加动态留痕', function () {
  const before = STORE.getMachine('SX-BC-2026-012').logs.length;
  const res = STORE.addLog('SX-BC-2026-012', '客户来访验机', '测试员');
  assert(!res.error, '追加不应报错');
  const u = STORE.getMachine('SX-BC-2026-012');
  eq(u.logs.length, before + 1, '日志 +1');
  eq(u.logs[0].kind, 'note', '动态类型');
  assert(STORE.addLog('SX-BC-2026-012', '   ', '测试员').error, '空内容应报错');
});

console.log('— 工段管理与现场图片（FR-A8 / FR-A9）');

t('FR-A8：新增工段（含重名/空名校验）', function () {
  const before = STORE.getMachine('SX-PC-2026-003').subsystems.length;
  const res = STORE.addSubsystem('SX-PC-2026-003', '在线测厚装置', '测试员');
  assert(!res.error, '新增失败：' + (res.error || ''));
  const u = STORE.getMachine('SX-PC-2026-003');
  eq(u.subsystems.length, before + 1, '工段数');
  eq(u.subsystems[u.subsystems.length - 1].code, 'custom-1', '自动编码');
  assert(STORE.addSubsystem('SX-PC-2026-003', '在线测厚装置', '测试员').error, '重名应报错');
  assert(STORE.addSubsystem('SX-PC-2026-003', '   ', '测试员').error, '空名应报错');
});

t('FR-A8：工段改名（留痕 + 重名校验）', function () {
  const res = STORE.renameSubsystem('SX-PC-2026-003', 'custom-1', '在线测厚仪', '测试员');
  assert(!res.error, '改名失败：' + (res.error || ''));
  const u = STORE.getMachine('SX-PC-2026-003');
  eq(u.subsystems[u.subsystems.length - 1].name, '在线测厚仪', '新名称');
  assert(u.logs[0].text.indexOf('更名为') !== -1, '应留痕改名');
  assert(STORE.renameSubsystem('SX-PC-2026-003', 'custom-1', '投料设备', '测试员').error, '改成已有名称应报错');
});

t('FR-A8：工段排序（上移/边界）', function () {
  const unit = STORE.getMachine('SX-PC-2026-003');
  const last = unit.subsystems[unit.subsystems.length - 1];
  const res = STORE.moveSubsystem('SX-PC-2026-003', last.code, -1, '测试员');
  assert(!res.error && res.moved, '应可上移');
  const u2 = STORE.getMachine('SX-PC-2026-003');
  eq(u2.subsystems[u2.subsystems.length - 2].code, last.code, '已上移一位');
  const first = u2.subsystems[0];
  const res2 = STORE.moveSubsystem('SX-PC-2026-003', first.code, -1, '测试员');
  assert(!res2.error && !res2.moved, '首位再上移应不动');
});

t('FR-A8：删除工段', function () {
  const before = STORE.getMachine('SX-PC-2026-003').subsystems.length;
  const res = STORE.removeSubsystem('SX-PC-2026-003', 'custom-1', '测试员');
  assert(!res.error, '删除失败：' + (res.error || ''));
  eq(STORE.getMachine('SX-PC-2026-003').subsystems.length, before - 1, '工段数 -1');
  assert(STORE.removeSubsystem('SX-PC-2026-003', 'custom-1', '测试员').error, '再删应报未知工段');
});

t('FR-A9：图片上传记录"上传时完成度"角标数据', function () {
  const imgs = [
    { dataUrl: 'data:image/png;base64,AAAA', progress: 42, name: 'a.jpg' },
    { dataUrl: 'data:image/jpeg;base64,BBBB', progress: 42, name: 'b.jpg' }
  ];
  const res = STORE.addSubsystemImages('SX-BM-2026-021', 'extrusion', imgs, '测试员');
  assert(!res.error, '上传失败：' + (res.error || ''));
  const ss = STORE.getMachine('SX-BM-2026-021').subsystems.find(s => s.code === 'extrusion');
  eq(ss.images.length, 4, '种子2张 + 新传2张');
  eq(ss.images[2].progress, 42, '角标=上传时进度');
  assert(ss.images[2].id.indexOf('img-') === 0, '图片 id 格式');
  assert(STORE.getMachine('SX-BM-2026-021').logs[0].text.indexOf('上传 2 张现场图片') !== -1, '应留痕');
  assert(STORE.addSubsystemImages('SX-BM-2026-021', 'extrusion', [{ dataUrl: 'oops', progress: 1 }], '测试员').error, '非法图片数据应报错');
});

t('FR-A9：图片数量上限与删除', function () {
  const batch = [];
  for (let i = 0; i < 9; i++) batch.push({ dataUrl: 'data:image/png;base64,X' + i, progress: 60, name: 'x' + i + '.jpg' });
  const res = STORE.addSubsystemImages('SX-BM-2026-021', 'extrusion', batch, '测试员');
  assert(res.error && res.error.indexOf('最多保留') !== -1, '4+9=13 超上限应报错：' + (res.error || '没有报错'));
  const ss = STORE.getMachine('SX-BM-2026-021').subsystems.find(s => s.code === 'extrusion');
  const imgId = ss.images[2].id;
  const del = STORE.removeSubsystemImage('SX-BM-2026-021', 'extrusion', imgId, '测试员');
  assert(!del.error, '删除失败：' + (del.error || ''));
  eq(ss.images.length, 3, '删除后 -1');
});

t('FR-A9 回归契约：上传流程先持久化工段进度，角标与进度一致（防"上传后进度归零"复发）', function () {
  STORE.resetDemo();
  const save = STORE.updateSubsystem('SX-BM-2026-021', 'cooling',
    { progress: 70, note: '先存进度再传图' }, '测试员');
  assert(!save.error, '保存进度失败：' + (save.error || ''));
  const up = STORE.addSubsystemImages('SX-BM-2026-021', 'cooling',
    [{ dataUrl: 'data:image/png;base64,Q', progress: 70, name: 'p.jpg' }], '测试员');
  assert(!up.error, '上传失败：' + (up.error || ''));
  const ss = STORE.getMachine('SX-BM-2026-021').subsystems.find(s => s.code === 'cooling');
  eq(ss.progress, 70, '工段进度已持久化');
  eq(ss.images[ss.images.length - 1].progress, 70, '角标与工段进度一致');
});

console.log('— 操作人账号（FR-A10，2026-09-19）');

t('默认三个账号：王工（主管）+ 李工 / 陈工（操作员），有且仅有一个主管', function () {
  STORE.resetDemo();
  const ops = STORE.listOperators();
  eq(ops.length, 3, '账号数');
  const sup = ops.filter(o => o.role === 'supervisor');
  eq(sup.length, 1, '主管数');
  eq(sup[0].name, '王工', '主管为王工');
  assert(ops.some(o => o.name === '李工' && o.role === 'operator'), '李工为操作员');
  assert(ops.some(o => o.name === '陈工' && o.role === 'operator'), '陈工为操作员');
});

t('登录校验：正确密码通过，错误密码 / 未知账号拒绝（账号名去空格）', function () {
  const ok = STORE.verifyLogin('王工', '123456');
  assert(ok.ok && ok.operator.role === 'supervisor', '主管可登录');
  const ok2 = STORE.verifyLogin(' 李工 ', '123456');
  assert(ok2.ok && ok2.operator.role === 'operator', '操作员可登录');
  assert(STORE.verifyLogin('李工', 'wrong').error, '错误密码应拒绝');
  assert(STORE.verifyLogin('赵工', '123456').error, '未知账号应拒绝');
  assert(STORE.verifyLogin('', '123456').error, '空账号应拒绝');
});

t('注册操作员：添加即可登录；重名 / 空名 / 空密码报错；新账号只能是操作员', function () {
  const r = STORE.addOperator('赵工', 'abcd1234', '王工');
  assert(!r.error, '注册失败：' + (r.error || ''));
  eq(r.operator.role, 'operator', '新账号角色');
  assert(STORE.verifyLogin('赵工', 'abcd1234').ok, '注册后可登录');
  assert(STORE.addOperator('赵工', 'x', '王工').error, '重名应报错');
  assert(STORE.addOperator('   ', 'x', '王工').error, '空名应报错');
  assert(STORE.addOperator('钱工', '', '王工').error, '空密码应报错');
});

t('唯一主管不变式：无接口产生第二个主管；主管不可被删除', function () {
  STORE.resetDemo();
  const r = STORE.removeOperator('王工', '王工');
  assert(r.error && r.error.indexOf('主管') !== -1, '删除主管应报错：' + (r.error || '没有报错'));
  eq(STORE.listOperators().filter(o => o.role === 'supervisor').length, 1, '主管仍唯一');
});

t('删除操作员：删除后不可再登录；未知账号报错', function () {
  STORE.resetDemo();
  const r = STORE.removeOperator('陈工', '王工');
  assert(!r.error, '删除失败：' + (r.error || ''));
  assert(STORE.verifyLogin('陈工', '123456').error, '删除后应不可登录');
  assert(STORE.removeOperator('陈工', '王工').error, '再删应报未知账号');
});

console.log('— 工段三态自动判定（FR-A11，2026-09-19）');

t('FR-A11：工段状态随完成度自动流转，无法强行指定不符状态', function () {
  STORE.resetDemo();
  eq(STORE.getMachine('SX-BM-2026-021').subsystems.find(s => s.code === 'transport').status,
    'waiting_material', '0% 工段为等待材料');
  STORE.updateSubsystem('SX-BM-2026-021', 'transport', { progress: 60, note: '装配中' }, '测试员');
  let ss = STORE.getMachine('SX-BM-2026-021').subsystems.find(s => s.code === 'transport');
  eq(ss.status, 'in_progress', '60% → 进行中');
  STORE.updateSubsystem('SX-BM-2026-021', 'transport', { status: 'done', progress: 60, note: '' }, '测试员');
  ss = STORE.getMachine('SX-BM-2026-021').subsystems.find(s => s.code === 'transport');
  eq(ss.status, 'in_progress', '强行指定 done 不生效（状态由完成度判定）');
  STORE.updateSubsystem('SX-BM-2026-021', 'transport', { progress: 100 }, '测试员');
  ss = STORE.getMachine('SX-BM-2026-021').subsystems.find(s => s.code === 'transport');
  eq(ss.status, 'done', '100% → 生产完成');
  assert(STORE.getMachine('SX-BM-2026-021').logs[0].text.indexOf('生产完成') !== -1, '日志使用新状态名');
  STORE.updateSubsystem('SX-BM-2026-021', 'transport', { progress: 0, note: '料未到' }, '测试员');
  ss = STORE.getMachine('SX-BM-2026-021').subsystems.find(s => s.code === 'transport');
  eq(ss.status, 'waiting_material', '归 0 → 等待材料');
});

console.log('— 订单与设备两级模型（FR-A12，2026-09-19）');

t('FR-A12：同单多台设备各自独立进度，按设备编号分别查看', function () {
  STORE.resetDemo();
  const o1 = STORE.listOrders('HT-2026-031')[0];
  eq(o1.quantity, 2, 'O1 数量 2');
  const ms = STORE.machinesOf(o1.id);
  eq(ms.length, 2, 'O1 两台设备');
  eq(C.currentStageOf(STORE.getMachine('SX-BC-2026-012')), 'testing', '012 已进入试机');
  eq(C.currentStageOf(STORE.getMachine('SX-BC-2026-013')), 'processing', '013 仍在加工（两台进度独立）');
  near(STORE.orderSummary(o1).progress, 30, 55, '订单整体进度=各设备平均');
});

t('FR-A12：创建订单 → 每台独立建档 + 反查订单 + 校验', function () {
  STORE.resetDemo();
  const r = STORE.createOrder({
    contractNo: 'HT-2026-060', customer: '测试客户', model: '测试机型', category: 'plate',
    unitIds: ['sx-bc-2026-201 ', 'SX-BC-2026-202'], plannedDelivery: '2026-12-01'
  }, '测试员');
  assert(!r.error, '创建失败：' + (r.error || ''));
  eq(r.order.quantity, 2, '数量=编号个数');
  eq(r.machines.length, 2, '两台设备');
  eq(STORE.getMachine('SX-BC-2026-202').orderId, r.order.id, '任一编号定位到设备（大写归一）');
  eq(STORE.getOrderOf(STORE.getMachine('SX-BC-2026-202')).contractNo, 'HT-2026-060', '设备反查订单');
  assert(STORE.createOrder({ unitIds: ['SX-BC-2026-202'], model: 'X' }, '测试员').error, '编号冲突应报错');
  assert(STORE.createOrder({ unitIds: ['SX-BC-2026-301', 'SX-BC-2026-301'], model: 'X' }, '测试员').error, '同单重复编号应报错');
  assert(STORE.createOrder({ unitIds: [' ', ''], model: 'X' }, '测试员').error, '至少一个有效编号');
  assert(STORE.createOrder({ unitIds: ['SX-BC-2026-303'], quantity: 3, model: 'X' }, '测试员').error, '数量与编号个数不一致应报错');
  const ok2 = STORE.createOrder({ unitIds: ['SX-BC-2026-304', 'SX-BC-2026-305'], model: 'X' }, '测试员');
  assert(!ok2.error, '不传数量默认=编号个数：' + (ok2.error || ''));
});

console.log('— 动态精确到设备编号（FR-A13，2026-09-20）');

t('FR-A13：工段动态自包含——设备编号 + 工段 + 状态 + 完成度', function () {
  STORE.resetDemo();
  const r = STORE.updateSubsystem('SX-PC-2026-004', 'extrusion', { progress: 25 }, '测试员');
  assert(!r.error, '更新失败：' + (r.error || ''));
  const m = STORE.getMachine('SX-PC-2026-004');
  eq(m.logs[0].text, 'SX-PC-2026-004「塑性挤出设备」进行中，完成度 25%', '动态格式精确到设备编号与工段');
  eq(m.logs[0].kind, 'subsystem', '动态类型');
});

t('FR-A13：自由动态与阶段动态同样带设备编号前缀；种子动态已归一', function () {
  STORE.resetDemo();
  const r = STORE.addLog('SX-PC-2026-004', '客户来访验机', '测试员');
  assert(!r.error, '追加失败：' + (r.error || ''));
  const m = STORE.getMachine('SX-PC-2026-004');
  eq(m.logs[0].text, 'SX-PC-2026-004 客户来访验机', '自由动态带设备编号');
  assert(m.logs[m.logs.length - 1].text.indexOf('SX-PC-2026-004') === 0, '种子动态也已带编号前缀');
  const rs = STORE.updateStage('SX-PC-2026-004', 'processing', { status: 'in_progress', note: '开工' }, '测试员');
  assert(!rs.error, '阶段更新失败：' + (rs.error || ''));
  eq(STORE.getMachine('SX-PC-2026-004').logs[0].text, 'SX-PC-2026-004「设备加工」进行中：开工', '阶段动态带设备编号');
});

console.log('— 订单级合并动态（FR-A14，2026-09-20）');

t('FR-A14：订单动态合并全部成员设备并按时间倒序，编号前缀保留', function () {
  STORE.resetDemo();
  const o1 = STORE.listOrders('HT-2026-031')[0];
  const logs = STORE.orderLogs(o1.id);
  eq(logs.length,
    STORE.getMachine('SX-BC-2026-012').logs.length + STORE.getMachine('SX-BC-2026-013').logs.length,
    '合并条数 = 两台设备动态之和');
  for (let i = 1; i < logs.length; i++) {
    assert(String(logs[i - 1].time) >= String(logs[i].time), '按时间倒序');
  }
  const has012 = logs.some(l => l.text.indexOf('SX-BC-2026-012') === 0);
  const has013 = logs.some(l => l.text.indexOf('SX-BC-2026-013') === 0);
  assert(has012 && has013, '两台设备的动态都在且带编号前缀');
  const after = STORE.addLog('SX-BC-2026-013', '插队动态', '测试员');
  assert(!after.error, '追加失败：' + (after.error || ''));
  eq(STORE.orderLogs(o1.id)[0].text, 'SX-BC-2026-013 插队动态', '新动态排最前');
});

t('FR-A7：重置演示数据恢复初始 5 张订单 / 8 台设备 / 3 个账号', function () {
  STORE.resetDemo();
  eq(STORE.listOrders('').length, 5, '订单数');
  eq(STORE.listMachines().length, 8, '设备数');
  eq(STORE.getMachine('SX-PC-2026-003').stages.procurement.status, 'in_progress', 'u4 状态回到种子值');
});

t('Q7：sanitizeUnitForClient 出口存在', function () {
  const u = STORE.sanitizeUnitForClient(STORE.getMachine('SX-BC-2026-012'));
  assert(u && u.id === 'SX-BC-2026-012', '应返回设备对象');
});

console.log('');
console.log('结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
