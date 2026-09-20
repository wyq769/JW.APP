/* ============================================================
 * persistence.test.js — 持久化分支回归测试
 * 运行：node test/persistence.test.js
 *
 * 背景：浏览器里 store.js 走 localStorage 持久化分支。曾存在一个
 * "两次 JSON.parse 产生两份数据图导致改动丢失"的缺陷（内存模式下
 * 不会暴露）。本测试注入 localStorage 模拟对象，强制走持久化分支，
 * 验证"更新 → 缓存失效重读 → 仍能读到新值"的完整链路。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ---- 在加载 store.js 之前注入 localStorage 模拟（触发持久化分支） ---- */
const mem = {};
globalThis.localStorage = {
  setItem(k, v) { mem[k] = String(v); },
  getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
  removeItem(k) { delete mem[k]; }
};

function load(rel) {
  new Function(fs.readFileSync(path.join(ROOT, rel), 'utf8'))();
}
load('prototype/js/constants.js');
load('prototype/js/store.js');

const STORE = globalThis.APP.STORE;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

t('种子数据写入模拟存储并可读回', function () {
  const n = STORE.listOrders('').length;
  if (n !== 5) throw new Error('期望 5 张订单，实际 ' + n);
  if (STORE.listMachines().length !== 8) throw new Error('期望 8 台设备');
  if (!mem['mcps_units_v1']) throw new Error('localStorage 中没有数据');
});

t('阶段更新 → 缓存失效重读 → 新值可见（回归：双解析丢改）', function () {
  const r = STORE.updateStage('SX-PC-2026-003', 'procurement', { status: 'done', note: '全部到货' }, '测试员');
  if (r.error) throw new Error(r.error);
  STORE.refresh(); /* 模拟跨标签页通知后缓存失效，强制重新 JSON.parse */
  const u = STORE.getMachine('SX-PC-2026-003');
  if (u.stages.procurement.status !== 'done') throw new Error('状态未持久化');
  if (u.logs[0].text.indexOf('原材料进货') === -1) throw new Error('日志未持久化');
});

t('新增工段 + 上传图片 → 重读可见（含角标进度）', function () {
  const r = STORE.addSubsystem('SX-PC-2026-003', '定制检测工位', '测试员');
  if (r.error) throw new Error(r.error);
  const code = r.unit.subsystems[r.unit.subsystems.length - 1].code;
  const ri = STORE.addSubsystemImages('SX-PC-2026-003', code,
    [{ dataUrl: 'data:image/png;base64,AAA', progress: 30, name: 'x.jpg' }], '测试员');
  if (ri.error) throw new Error(ri.error);
  STORE.refresh();
  const u = STORE.getMachine('SX-PC-2026-003');
  const ss = u.subsystems.find(s => s.code === code);
  if (!ss) throw new Error('工段未持久化');
  if (!ss.images || ss.images.length !== 1) throw new Error('图片未持久化');
  if (ss.images[0].progress !== 30) throw new Error('角标进度未持久化');
});

t('旧结构数据自动迁移：v1 设备记录 → 订单 + 设备（images 补齐）', function () {
  const old = {
    version: 1,
    units: [{
      id: 'OLD-1', model: '旧机型', category: 'plate', customer: '', contractNo: '',
      plannedDelivery: '', createdAt: '2026-01-01T00:00:00',
      stages: { procurement: { status: 'pending', note: '', updatedAt: '' } },
      subsystems: [{ code: 'feeding', name: '投料设备', status: 'pending', progress: 0, note: '', updatedAt: '' }],
      logs: []
    }]
  };
  globalThis.localStorage.setItem('mcps_units_v1', JSON.stringify(old));
  STORE.refresh();
  const u = STORE.getMachine('OLD-1');
  if (!u) throw new Error('旧数据读不回（应拆为设备）');
  if (!Array.isArray(u.subsystems[0].images)) throw new Error('迁移失败：images 未补齐');
  const o = STORE.getOrderOf(u);
  if (!o || o.model !== '旧机型' || o.quantity !== 1) throw new Error('应同时迁移出订单');
});

t('操作人账号：注册后跨重读可见（持久化分支）', function () {
  const r = STORE.addOperator('孙工', 'p1234', '王工');
  if (r.error) throw new Error(r.error);
  STORE.refresh();
  const found = STORE.listOperators().find(o => o.name === '孙工');
  if (!found || found.role !== 'operator') throw new Error('注册账号未持久化');
  if (!STORE.verifyLogin('孙工', 'p1234').ok) throw new Error('持久化后登录失败');
});

t('旧结构数据（无 operators 字段）自动迁移补齐默认三账号', function () {
  const raw = JSON.parse(globalThis.localStorage.getItem('mcps_units_v1'));
  delete raw.operators;
  globalThis.localStorage.setItem('mcps_units_v1', JSON.stringify(raw));
  STORE.refresh();
  const ops = STORE.listOperators();
  if (ops.length !== 3) throw new Error('期望迁移补齐 3 个账号，实际 ' + ops.length);
  if (ops.filter(o => o.role === 'supervisor').length !== 1) throw new Error('主管数不为 1');
});

t('旧工段状态（pending/blocked）按完成度自动归一为三态模型', function () {
  STORE.resetDemo();
  const raw = JSON.parse(globalThis.localStorage.getItem('mcps_units_v1'));
  const u = raw.units.find(x => x.id === 'SX-BM-2026-021');
  u.subsystems.find(s => s.code === 'transport').status = 'blocked'; /* 进度 0 */
  u.subsystems.find(s => s.code === 'cooling').status = 'pending';   /* 进度 40 */
  globalThis.localStorage.setItem('mcps_units_v1', JSON.stringify(raw));
  STORE.refresh();
  const cur = STORE.getMachine('SX-BM-2026-021');
  if (cur.subsystems.find(s => s.code === 'transport').status !== 'waiting_material') {
    throw new Error('0% 停滞工段应归一为等待材料');
  }
  if (cur.subsystems.find(s => s.code === 'cooling').status !== 'in_progress') {
    throw new Error('40% 未开始工段应归一为进行中');
  }
});

t('v1 旧数据（订单字段内嵌于设备 + unitIds 多编号）自动迁移为 订单+多台设备', function () {
  const old = { version: 1, units: [{
    id: 'OLD-A', unitIds: ['OLD-A', 'OLD-B'], quantity: 2, model: '旧机型', category: 'plate',
    customer: '旧客户', contractNo: 'HT-OLD', plannedDelivery: '', createdAt: '2026-01-01T00:00:00',
    stages: { procurement: { status: 'pending', note: '', updatedAt: '' } },
    subsystems: [{ code: 'feeding', name: '投料设备', status: 'pending', progress: 0, note: '', updatedAt: '' }],
    logs: []
  }] };
  globalThis.localStorage.setItem('mcps_units_v1', JSON.stringify(old));
  STORE.refresh();
  const orders = STORE.listOrders('HT-OLD');
  if (orders.length !== 1) throw new Error('旧数据应迁移出 1 张订单');
  const o = orders[0];
  if (o.quantity !== 2 || o.customer !== '旧客户') throw new Error('订单字段未归位');
  const ms = STORE.machinesOf(o.id);
  if (ms.length !== 2) throw new Error('应按编号拆出 2 台设备');
  if (!ms.find(m => m.id === 'OLD-A') || !ms.find(m => m.id === 'OLD-B')) throw new Error('拆分编号不符');
  if (!STORE.getMachine('OLD-B').stages || !STORE.getMachine('OLD-B').subsystems) throw new Error('每台设备应有独立阶段/工段数据');
});

console.log(failed ? '\n结果：存在失败项' : '\n结果：持久化分支全部通过');
process.exit(failed ? 1 : 0);
