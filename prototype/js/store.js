/* ============================================================
 * store.js — 数据层（M0：localStorage 模拟库；不可用时降级内存模式）
 * 企划书对应：Q6（单一数据出入口，M1 换 fetch/API）、Q7（客户端字段收口）、
 *           Q13/R3（变更自动留痕）、Q14（编号查重）、Q5（工段为实例数组）
 * FR-A12（2026-09-19）：订单-设备两级模型 —
 *   orders[]：合同号 / 客户 / 机型 / 品类 / 数量 / 计划交付（订单级字段）
 *   units[] ：设备（每台独立 stages / subsystems / logs，orderId 指向订单）
 *   一张订单可含多台设备（数量 = 设备编号个数），按设备编号分别查看进度。
 * 依赖：须先加载 constants.js
 *
 * 会话内缓存说明（重要）：readRaw 结果缓存于 cache，全库只有一份数据图。
 * 这样 getMachine 拿到的引用被修改后 commit(ensure()) 写回的正是同一份图，
 * 避免"两次 JSON.parse 产生两份对象导致改动丢失"。
 * 跨标签页 storage 事件后须调用 refresh() 使缓存失效重读。
 * ============================================================ */
(function (root) {
  'use strict';
  var C = root.APP.CONST;

  var STORAGE_KEY = 'mcps_units_v1';
  var MAX_SS_COUNT = 12;   /* 每台设备工段数上限 */
  var MAX_SS_IMAGES = 12;  /* 每个工段现场图片上限 */
  var MAX_ORDER_UNITS = 20;/* 每张订单设备台数上限 */
  var SAVE_FAIL = '本机存储空间不足，保存失败（可删除部分图片后重试）';

  var cache = null;        /* persistent 模式的会话内缓存（单实例数据图） */
  var memoryStore = null;  /* localStorage 不可用时的会话内容器 */

  function canPersist() {
    try {
      var probe = '__mcps_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch (e) { return false; }
  }
  var persistent = canPersist();

  function readRaw() {
    if (!persistent) return memoryStore;
    if (!cache) {
      try { cache = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
      catch (e) { cache = null; }
    }
    return cache;
  }
  function writeRaw(data) {
    if (!persistent) { memoryStore = data; return true; }
    cache = data;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); return true; }
    catch (e) { return false; } /* 配额满：调用方据返回值提示；缓存作废后重读旧数据 */
  }
  function refreshCache() { cache = null; }

  function now() { return new Date().toISOString(); }

  function blankStage() { return { status: 'pending', note: '', updatedAt: '' }; }
  function blankStages() {
    var o = {};
    for (var i = 0; i < C.STAGES.length; i++) o[C.STAGES[i].key] = blankStage();
    return o;
  }
  function makeSubsystems() {
    /* FR-A11：初始状态=等待材料（完成度 0 的派生值） */
    return C.SUBSYSTEM_TEMPLATES.map(function (t) {
      return { code: t.code, name: t.name, status: 'waiting_material', progress: 0, note: '', updatedAt: '', images: [] };
    });
  }

  /* ---------- 操作人账号（FR-A10，2026-09-19）：有且仅有一个主管 ----------
   * 密码 M0 明文存本机（演示）；正式版接后端鉴权与角色权限（企划书 Q8）。
   * "唯一主管"为结构性保证：addOperator 只创建操作员、removeOperator 拒删主管、
   * 无改角色接口——不存在产生第二个主管的路径。 */
  function seedOperators() {
    return [
      { name: '王工', role: 'supervisor', pass: '123456', createdAt: '2026-09-01T09:00:00', createdBy: '系统' },
      { name: '李工', role: 'operator',   pass: '123456', createdAt: '2026-09-01T09:00:00', createdBy: '系统' },
      { name: '陈工', role: 'operator',   pass: '123456', createdAt: '2026-09-01T09:00:00', createdBy: '系统' }
    ];
  }

  /* ---------- 演示占位图（SVG data URL，体积极小，便于离线演示图片功能） ---------- */
  function escXml(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function ph(title, sub, bg) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">' +
      '<rect width="640" height="420" fill="' + (bg || '#16233b') + '"/>' +
      '<rect x="0" y="330" width="640" height="90" fill="#0d1526"/>' +
      '<circle cx="520" cy="110" r="70" fill="#2563eb" opacity="0.22"/>' +
      '<circle cx="120" cy="70" r="40" fill="#2563eb" opacity="0.12"/>' +
      '<rect x="60" y="118" width="300" height="14" rx="7" fill="#2563eb" opacity="0.7"/>' +
      '<rect x="60" y="148" width="200" height="10" rx="5" fill="#3b5a8f" opacity="0.6"/>' +
      '<rect x="60" y="168" width="240" height="10" rx="5" fill="#3b5a8f" opacity="0.35"/>' +
      '<text x="60" y="252" font-family="sans-serif" font-size="30" font-weight="bold" fill="#ffffff">' + escXml(title) + '</text>' +
      '<text x="60" y="290" font-family="sans-serif" font-size="17" fill="#9fb3d1">' + escXml(sub) + '</text>' +
      '<text x="452" y="382" font-family="sans-serif" font-size="14" fill="#5b6b85">演示占位图（可删除）</text>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /* ---------- 种子数据（2026-09-19 重生成）：5 张订单 / 8 台设备 ----------
   * 覆盖：同单两台进度分化（O1）、试机异常（O2）、现场图片（O3）、
   *       进货⊥加工并行 + 同单一台未开工（O4）、全部完成（O5） */
  function seedOrders() {
    return [
      { id: 'SO-2026-001', contractNo: 'HT-2026-031', customer: '华南塑业', model: 'PVC板材挤出生产线', category: 'plate', quantity: 2, plannedDelivery: '2026-10-30', createdAt: '2026-06-20T09:00:00' },
      { id: 'SO-2026-002', contractNo: 'HT-2026-018', customer: '中亚管业', model: 'PE给水管材挤出生产线', category: 'pipe', quantity: 2, plannedDelivery: '2026-11-15', createdAt: '2026-05-10T09:00:00' },
      { id: 'SO-2026-003', contractNo: 'HT-2026-047', customer: '宏达包装', model: 'PE吹膜机组（三层共挤）', category: 'film', quantity: 1, plannedDelivery: '2026-12-20', createdAt: '2026-07-15T09:00:00' },
      { id: 'SO-2026-004', contractNo: 'HT-2026-052', customer: '恒新片材', model: 'PVC片材挤出生产线', category: 'sheet', quantity: 2, plannedDelivery: '2027-01-15', createdAt: '2026-09-02T09:00:00' },
      { id: 'SO-2025-005', contractNo: 'HT-2025-114', customer: '金源管业', model: 'PP-R管材生产线', category: 'pipe', quantity: 1, plannedDelivery: '2025-12-15', createdAt: '2025-08-01T09:00:00' }
    ];
  }

  function seedMachines() {
    /* O1 华南塑业 ×2 —— 012 试机中 / 013 加工中（同单两台进度分化） */
    var m012 = {
      id: 'SX-BC-2026-012', orderId: 'SO-2026-001', createdAt: '2026-06-20T09:00:00',
      stages: {
        procurement: { status: 'done', note: '主体钢材 / 电机 / 电控到货检验合格', updatedAt: '2026-07-02T14:30:00' },
        processing:  { status: 'done', note: '全部工段装配完成', updatedAt: '2026-09-05T17:00:00' },
        testing:     { status: 'in_progress', note: '空载联动调试进行中', updatedAt: '2026-09-08T09:10:00' },
        shipping:    { status: 'pending', note: '', updatedAt: '' }
      },
      subsystems: [
        { code: 'feeding',   name: '投料设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-07-10T11:00:00' },
        { code: 'melting',   name: '材料熔融设备', status: 'done', progress: 100, note: '螺杆料筒总成完成', updatedAt: '2026-07-28T16:20:00' },
        { code: 'extrusion', name: '塑性挤出设备', status: 'done', progress: 100, note: '模头安装到位', updatedAt: '2026-08-15T14:00:00' },
        { code: 'cooling',   name: '冷却设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-08-20T10:30:00' },
        { code: 'transport', name: '运输设备',     status: 'done', progress: 100, note: '牵引输送联调完成', updatedAt: '2026-08-28T15:40:00' },
        { code: 'cutting',   name: '切割设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-08-30T15:40:00' },
        { code: 'packing',   name: '打包设备',     status: 'done', progress: 100, note: '装配与静态检验完成', updatedAt: '2026-09-05T16:30:00',
          images: [
            { id: 'img-seed-p1', dataUrl: ph('成品包装区 · 装箱完成', 'SX-BC-2026-012 · 打包设备', '#14301f'), progress: 100, time: '2026-09-04T10:00:00', name: '演示图-成品包装.jpg' }
          ] }
      ],
      logs: [
        { time: '2026-09-08T09:10:00', actor: '王工',   kind: 'stage',     text: '「试机」进行中：空载联动调试进行中' },
        { time: '2026-09-05T17:00:00', actor: '李工',   kind: 'stage',     text: '「设备加工」已完成：全部工段装配完成' },
        { time: '2026-08-30T15:40:00', actor: '李工',   kind: 'subsystem', text: '「切割设备」已完成，完成度 100%' },
        { time: '2026-07-02T14:30:00', actor: '采购部', kind: 'stage',     text: '「原材料进货」已完成：主体钢材 / 电机 / 电控到货检验合格' },
        { time: '2026-06-20T09:00:00', actor: '系统',   kind: 'system',    text: '订单创建：PVC板材挤出生产线（板材设备）× 2 台' }
      ]
    };
    var m013 = {
      id: 'SX-BC-2026-013', orderId: 'SO-2026-001', createdAt: '2026-06-20T09:00:00',
      stages: {
        procurement: { status: 'done', note: '与 012 同批到货检验合格', updatedAt: '2026-07-02T14:30:00' },
        processing:  { status: 'in_progress', note: '模头精加工中', updatedAt: '2026-09-16T10:00:00' },
        testing:     { status: 'pending', note: '', updatedAt: '' },
        shipping:    { status: 'pending', note: '', updatedAt: '' }
      },
      subsystems: [
        { code: 'feeding',   name: '投料设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-07-20T10:00:00' },
        { code: 'melting',   name: '材料熔融设备', status: 'done', progress: 100, note: '', updatedAt: '2026-08-10T15:00:00' },
        { code: 'extrusion', name: '塑性挤出设备', status: 'in_progress', progress: 60, note: '模头精加工中', updatedAt: '2026-09-16T10:00:00' },
        { code: 'cooling',   name: '冷却设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' },
        { code: 'transport', name: '运输设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' },
        { code: 'cutting',   name: '切割设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' },
        { code: 'packing',   name: '打包设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' }
      ],
      logs: [
        { time: '2026-09-16T10:00:00', actor: '李工',   kind: 'subsystem', text: '「塑性挤出设备」完成度更新为 60%，模头精加工中' },
        { time: '2026-07-02T14:30:00', actor: '采购部', kind: 'stage',     text: '「原材料进货」已完成：与 012 同批到货检验合格' },
        { time: '2026-06-20T09:00:00', actor: '系统',   kind: 'system',    text: '订单创建：PVC板材挤出生产线（板材设备）× 2 台' }
      ]
    };

    /* O2 中亚管业 ×2 —— 005 试机异常停滞 / 006 试机进行中 */
    var m005 = {
      id: 'SX-GC-2026-005', orderId: 'SO-2026-002', createdAt: '2026-05-10T09:00:00',
      stages: {
        procurement: { status: 'done', note: '不锈钢机架 / 螺杆料筒到货', updatedAt: '2026-06-01T10:00:00' },
        processing:  { status: 'done', note: '', updatedAt: '2026-08-25T17:30:00' },
        testing:     { status: 'blocked', note: '试机不通过：模口温区波动异常，待更换加热圈', updatedAt: '2026-09-12T16:20:00' },
        shipping:    { status: 'pending', note: '', updatedAt: '' }
      },
      subsystems: [
        { code: 'feeding',   name: '投料设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-06-20T09:00:00' },
        { code: 'melting',   name: '材料熔融设备', status: 'done', progress: 100, note: '', updatedAt: '2026-07-10T09:30:00' },
        { code: 'extrusion', name: '塑性挤出设备', status: 'done', progress: 100, note: '试机中发现模口温区波动', updatedAt: '2026-07-25T14:00:00' },
        { code: 'cooling',   name: '冷却设备',     status: 'done', progress: 100, note: '真空定径与喷淋完成', updatedAt: '2026-08-05T11:00:00' },
        { code: 'transport', name: '运输设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-08-12T14:00:00' },
        { code: 'cutting',   name: '切割设备',     status: 'done', progress: 100, note: '行星切割机联调完成', updatedAt: '2026-08-20T15:00:00' },
        { code: 'packing',   name: '打包设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-08-25T16:00:00' }
      ],
      logs: [
        { time: '2026-09-12T16:20:00', actor: '质检部', kind: 'stage',     text: '「试机」异常停滞：试机不通过，模口温区波动异常，待更换加热圈' },
        { time: '2026-09-10T10:00:00', actor: '质检部', kind: 'subsystem', text: '「塑性挤出设备」试机发现模口温区波动，已定位原因' },
        { time: '2026-08-25T17:30:00', actor: '李工',   kind: 'stage',     text: '「设备加工」已完成' },
        { time: '2026-06-01T10:00:00', actor: '采购部', kind: 'stage',     text: '「原材料进货」已完成：不锈钢机架 / 螺杆料筒到货' },
        { time: '2026-05-10T09:00:00', actor: '系统',   kind: 'system',    text: '订单创建：PE给水管材挤出生产线（管材设备）× 2 台' }
      ]
    };
    var m006 = {
      id: 'SX-GC-2026-006', orderId: 'SO-2026-002', createdAt: '2026-05-10T09:00:00',
      stages: {
        procurement: { status: 'done', note: '与 005 同批到货', updatedAt: '2026-06-01T10:00:00' },
        processing:  { status: 'done', note: '', updatedAt: '2026-08-28T17:00:00' },
        testing:     { status: 'in_progress', note: '空载调试进行中', updatedAt: '2026-09-14T09:30:00' },
        shipping:    { status: 'pending', note: '', updatedAt: '' }
      },
      subsystems: [
        { code: 'feeding',   name: '投料设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-06-25T09:00:00' },
        { code: 'melting',   name: '材料熔融设备', status: 'done', progress: 100, note: '', updatedAt: '2026-07-15T09:30:00' },
        { code: 'extrusion', name: '塑性挤出设备', status: 'done', progress: 100, note: '', updatedAt: '2026-07-30T14:00:00' },
        { code: 'cooling',   name: '冷却设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-08-08T11:00:00' },
        { code: 'transport', name: '运输设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-08-16T14:00:00' },
        { code: 'cutting',   name: '切割设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-08-22T15:00:00' },
        { code: 'packing',   name: '打包设备',     status: 'done', progress: 100, note: '', updatedAt: '2026-08-28T16:00:00' }
      ],
      logs: [
        { time: '2026-09-14T09:30:00', actor: '王工',   kind: 'stage',     text: '「试机」进行中：空载调试进行中' },
        { time: '2026-08-28T17:00:00', actor: '李工',   kind: 'stage',     text: '「设备加工」已完成' },
        { time: '2026-05-10T09:00:00', actor: '系统',   kind: 'system',    text: '订单创建：PE给水管材挤出生产线（管材设备）× 2 台' }
      ]
    };

    /* O3 宏达包装 ×1 —— 现场图片演示机（README 快速体验路径引用） */
    var m021 = {
      id: 'SX-BM-2026-021', orderId: 'SO-2026-003', createdAt: '2026-07-15T09:00:00',
      stages: {
        procurement: { status: 'done', note: '模头毛坯 / 风机 / 树脂接触件到货', updatedAt: '2026-08-01T14:00:00' },
        processing:  { status: 'in_progress', note: '三层挤出主机装配中', updatedAt: '2026-09-14T11:00:00' },
        testing:     { status: 'pending', note: '', updatedAt: '' },
        shipping:    { status: 'pending', note: '', updatedAt: '' }
      },
      subsystems: [
        { code: 'feeding',   name: '投料设备',     status: 'done', progress: 100, note: '三斗上料完成', updatedAt: '2026-08-12T10:00:00' },
        { code: 'melting',   name: '材料熔融设备', status: 'done', progress: 100, note: '三台挤出机就位', updatedAt: '2026-08-28T15:00:00' },
        { code: 'extrusion', name: '塑性挤出设备', status: 'in_progress', progress: 60, note: '模头与流道精加工中', updatedAt: '2026-09-14T11:00:00',
          images: [
            { id: 'img-seed-e1', dataUrl: ph('模头流道精加工现场', 'SX-BM-2026-021 · 塑性挤出设备'), progress: 55, time: '2026-09-02T14:00:00', name: '演示图-模头加工.jpg' },
            { id: 'img-seed-e2', dataUrl: ph('模头总装吊装就位', 'SX-BM-2026-021 · 塑性挤出设备', '#1c2a4a'), progress: 60, time: '2026-09-14T11:00:00', name: '演示图-总装就位.jpg' }
          ] },
        { code: 'cooling',   name: '冷却设备',     status: 'in_progress', progress: 40, note: '风环订制件到货后总装', updatedAt: '2026-09-10T09:30:00',
          images: [
            { id: 'img-seed-c1', dataUrl: ph('风环订制件到货验收', 'SX-BM-2026-021 · 冷却设备', '#123047'), progress: 40, time: '2026-09-10T09:30:00', name: '演示图-风环验收.jpg' }
          ] },
        { code: 'transport', name: '运输设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' },
        { code: 'cutting',   name: '切割设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' },
        { code: 'packing',   name: '打包设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' }
      ],
      logs: [
        { time: '2026-09-14T11:00:00', actor: '李工',   kind: 'subsystem', text: '「塑性挤出设备」完成度更新为 60%，模头与流道精加工中' },
        { time: '2026-09-10T09:30:00', actor: '李工',   kind: 'subsystem', text: '「冷却设备」进行中，完成度 40%，风环订制件到货后总装' },
        { time: '2026-08-28T15:00:00', actor: '李工',   kind: 'subsystem', text: '「材料熔融设备」已完成，完成度 100%' },
        { time: '2026-08-01T14:00:00', actor: '采购部', kind: 'stage',     text: '「原材料进货」已完成：模头毛坯 / 风机 / 树脂接触件到货' },
        { time: '2026-07-15T09:00:00', actor: '系统',   kind: 'system',    text: '订单创建：PE吹膜机组（三层共挤）（薄膜设备）× 1 台' }
      ]
    };

    /* O4 恒新片材 ×2 —— 003 进货⊥加工并行演示 / 004 尚在进货、未开工 */
    var m003 = {
      id: 'SX-PC-2026-003', orderId: 'SO-2026-004', createdAt: '2026-09-02T09:00:00',
      stages: {
        procurement: { status: 'in_progress', note: '主体钢材与机架已到货；伺服电机、温控系统在途（可与加工并行）', updatedAt: '2026-09-15T10:30:00' },
        processing:  { status: 'in_progress', note: '先到料工段先行开工', updatedAt: '2026-09-16T09:00:00' },
        testing:     { status: 'pending', note: '', updatedAt: '' },
        shipping:    { status: 'pending', note: '', updatedAt: '' }
      },
      subsystems: [
        { code: 'feeding',   name: '投料设备',     status: 'done', progress: 100, note: '机架到货后先行总装完成', updatedAt: '2026-09-16T15:00:00' },
        { code: 'melting',   name: '材料熔融设备', status: 'in_progress', progress: 45, note: '螺杆料筒粗加工中', updatedAt: '2026-09-17T10:00:00' },
        { code: 'extrusion', name: '塑性挤出设备', status: 'waiting_material', progress: 0, note: '', updatedAt: '' },
        { code: 'cooling',   name: '冷却设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' },
        { code: 'transport', name: '运输设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' },
        { code: 'cutting',   name: '切割设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' },
        { code: 'packing',   name: '打包设备',     status: 'waiting_material', progress: 0, note: '', updatedAt: '' }
      ],
      logs: [
        { time: '2026-09-17T10:00:00', actor: '李工',   kind: 'subsystem', text: '「材料熔融设备」完成度更新为 45%，螺杆料筒粗加工中' },
        { time: '2026-09-16T15:00:00', actor: '李工',   kind: 'subsystem', text: '「投料设备」已完成，完成度 100%' },
        { time: '2026-09-16T09:00:00', actor: '李工',   kind: 'stage',     text: '「设备加工」进行中：先到料工段先行开工（进货未完即开工，两阶段并行）' },
        { time: '2026-09-15T10:30:00', actor: '采购部', kind: 'stage',     text: '「原材料进货」进行中：主体钢材已到货，伺服电机与温控系统在途' },
        { time: '2026-09-02T09:00:00', actor: '系统',   kind: 'system',    text: '订单创建：PVC片材挤出生产线（片材设备）× 2 台' }
      ]
    };
    var m004 = {
      id: 'SX-PC-2026-004', orderId: 'SO-2026-004', createdAt: '2026-09-02T09:00:00',
      stages: {
        procurement: { status: 'in_progress', note: '主体钢材在途，未开班', updatedAt: '2026-09-15T10:30:00' },
        processing:  { status: 'pending', note: '', updatedAt: '' },
        testing:     { status: 'pending', note: '', updatedAt: '' },
        shipping:    { status: 'pending', note: '', updatedAt: '' }
      },
      subsystems: makeSubsystems(),
      logs: [
        { time: '2026-09-15T10:30:00', actor: '采购部', kind: 'stage',  text: '「原材料进货」进行中：主体钢材在途，未开班' },
        { time: '2026-09-02T09:00:00', actor: '系统',   kind: 'system', text: '订单创建：PVC片材挤出生产线（片材设备）× 2 台' }
      ]
    };

    /* O5 金源管业 ×1 —— 全部完成 */
    var m038 = {
      id: 'SX-GC-2025-038', orderId: 'SO-2025-005', createdAt: '2025-08-01T09:00:00',
      stages: {
        procurement: { status: 'done', note: '', updatedAt: '2025-08-20T10:00:00' },
        processing:  { status: 'done', note: '', updatedAt: '2025-11-10T17:00:00' },
        testing:     { status: 'done', note: '连续 72 小时运行达标', updatedAt: '2025-11-28T16:00:00' },
        shipping:    { status: 'done', note: '已发运，随车文件与备件齐全', updatedAt: '2025-12-08T09:30:00' }
      },
      subsystems: [
        { code: 'feeding',   name: '投料设备',     status: 'done', progress: 100, note: '', updatedAt: '2025-09-01T09:00:00' },
        { code: 'melting',   name: '材料熔融设备', status: 'done', progress: 100, note: '', updatedAt: '2025-09-25T14:00:00' },
        { code: 'extrusion', name: '塑性挤出设备', status: 'done', progress: 100, note: '', updatedAt: '2025-10-15T14:00:00' },
        { code: 'cooling',   name: '冷却设备',     status: 'done', progress: 100, note: '', updatedAt: '2025-10-22T10:00:00' },
        { code: 'transport', name: '运输设备',     status: 'done', progress: 100, note: '', updatedAt: '2025-10-30T14:00:00' },
        { code: 'cutting',   name: '切割设备',     status: 'done', progress: 100, note: '', updatedAt: '2025-11-05T14:00:00' },
        { code: 'packing',   name: '打包设备',     status: 'done', progress: 100, note: '', updatedAt: '2025-11-10T16:00:00' }
      ],
      logs: [
        { time: '2025-12-08T09:30:00', actor: '成品库', kind: 'stage',     text: '「出厂发货」已完成：已发运，随车文件与备件齐全' },
        { time: '2025-11-28T16:00:00', actor: '质检部', kind: 'stage',     text: '「试机」已完成：连续 72 小时运行达标' },
        { time: '2025-08-20T10:00:00', actor: '采购部', kind: 'stage',     text: '「原材料进货」已完成' },
        { time: '2025-08-01T09:00:00', actor: '系统',   kind: 'system',    text: '订单创建：PP-R管材生产线（管材设备）× 1 台' }
      ]
    };

    var machines = [m012, m013, m005, m006, m021, m003, m004, m038];
    /* FR-A13：种子动态同样精确到设备编号 */
    for (var si = 0; si < machines.length; si++) {
      for (var sj = 0; sj < machines[si].logs.length; sj++) {
        machines[si].logs[sj].text = tagMachineText(machines[si].id, machines[si].logs[sj].text);
      }
    }
    return machines;
  }

  /* FR-A13（2026-09-20）：动态精确到设备编号——每条留痕自包含。
   * 工段/阶段类文本以「开头 → 编号紧贴（SX-…「塑性挤出设备」…）；
   * 其余（自由动态/订单创建等）→ 编号 + 空格。 */
  function tagMachineText(id, text) {
    text = String(text || '');
    return text.charAt(0) === '「' ? id + text : id + ' ' + text;
  }

  /* ---------- 打开/提交（M0 的"数据库事务"粒度） ---------- */
  /* 设备级迁移：补齐 images；工段旧状态（pending/blocked 等）按完成度归一为三态 */
  function migrateUnit(u) {
    var dirty = false;
    if (!Array.isArray(u.subsystems)) { u.subsystems = []; dirty = true; }
    for (var i = 0; i < u.subsystems.length; i++) {
      var ss = u.subsystems[i];
      if (!Array.isArray(ss.images)) { ss.images = []; dirty = true; }
      var derived = C.ssStatusOf(ss.progress);
      if (ss.status !== derived) { ss.status = derived; dirty = true; }
    }
    return dirty;
  }

  /* v1 → v2 迁移（FR-A12）：旧记录把订单字段内嵌在设备上。
   * 每条旧记录 = 一张订单；其 unitIds（缺省 [id]）按编号拆为多台独立设备
   * （阶段/工段/图片深拷贝），字段各自归位。 */
  function migrateV1(data) {
    var orders = [], units = [];
    var stamp = Date.now().toString(36);
    var old = Array.isArray(data.units) ? data.units : [];
    for (var i = 0; i < old.length; i++) {
      var u = old[i];
      var ids = (Array.isArray(u.unitIds) && u.unitIds.length) ? u.unitIds : [u.id];
      var oid = 'SO-' + stamp + '-' + (i + 1);
      orders.push({
        id: oid,
        contractNo: u.contractNo || '',
        customer: u.customer || '',
        model: u.model || '',
        category: u.category || 'plate',
        quantity: ids.length,
        plannedDelivery: u.plannedDelivery || '',
        createdAt: u.createdAt || now()
      });
      for (var j = 0; j < ids.length; j++) {
        var m = JSON.parse(JSON.stringify(u));
        m.id = ids[j];
        m.orderId = oid;
        delete m.unitIds; delete m.quantity;
        delete m.contractNo; delete m.customer; delete m.model;
        delete m.category; delete m.plannedDelivery;
        units.push(m);
      }
    }
    data.orders = orders;
    data.units = units;
    data.version = 2;
  }

  function ensure() {
    var data = readRaw();
    if (!data || !Array.isArray(data.units)) {
      data = { version: 2, orders: seedOrders(), units: seedMachines(), operators: seedOperators() };
      writeRaw(data);
      return data;
    }
    var dirty = false;
    if (!Array.isArray(data.orders)) { migrateV1(data); dirty = true; }
    for (var i = 0; i < data.units.length; i++) {
      if (migrateUnit(data.units[i])) dirty = true;
    }
    /* 旧结构数据迁移：补齐操作人账号表（FR-A10） */
    if (!Array.isArray(data.operators)) { data.operators = seedOperators(); dirty = true; }
    if (dirty) writeRaw(data);
    return data;
  }
  function commit(data) { return writeRaw(data); }

  /* ---------- 查询 ---------- */
  function machinesOf(orderId) {
    var units = ensure().units, out = [];
    for (var i = 0; i < units.length; i++) if (units[i].orderId === orderId) out.push(units[i]);
    return out;
  }
  function listMachines() { return ensure().units.slice(); }

  function orderLatestTouch(o) {
    var t = o.createdAt || '';
    var ms = machinesOf(o.id);
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      for (var k in m.stages) if (m.stages[k].updatedAt > t) t = m.stages[k].updatedAt;
      for (var j = 0; j < (m.subsystems || []).length; j++) {
        if (m.subsystems[j].updatedAt > t) t = m.subsystems[j].updatedAt;
      }
    }
    return t;
  }
  function listOrders(q) {
    var orders = ensure().orders.slice();
    orders.sort(function (a, b) { return String(orderLatestTouch(b)).localeCompare(String(orderLatestTouch(a))); });
    if (!q) return orders;
    var kw = String(q).trim().toLowerCase();
    if (!kw) return orders;
    return orders.filter(function (o) {
      var vals = [o.contractNo, o.customer, o.model];
      var ms = machinesOf(o.id);
      for (var i = 0; i < ms.length; i++) vals.push(ms[i].id); /* 任一设备编号可检索订单 */
      return vals.some(function (v) {
        return String(v || '').toLowerCase().indexOf(kw) !== -1;
      });
    });
  }
  function getOrder(id) {
    var orders = ensure().orders;
    for (var i = 0; i < orders.length; i++) if (orders[i].id === id) return orders[i];
    return null;
  }
  function getMachine(id) {
    var units = ensure().units;
    for (var i = 0; i < units.length; i++) if (units[i].id === id) return units[i];
    return null;
  }
  function getOrderOf(machine) { return machine ? getOrder(machine.orderId) : null; }

  /* 订单汇总：成员设备 + 整体进度（各设备整体完成度平均，供参考） */
  function orderSummary(order) {
    var ms = machinesOf(order.id);
    var total = 0;
    for (var i = 0; i < ms.length; i++) total += C.computeOverallProgress(ms[i]);
    return { machines: ms, progress: ms.length ? Math.round(total / ms.length) : 0 };
  }

  /* FR-A14（2026-09-20）：订单级合并动态——成员设备日志按时间倒序。
   * 文本已由 FR-A13 统一标注设备编号，混排后每条仍自明"哪台设备发生了什么"。 */
  function orderLogs(orderId) {
    var ms = machinesOf(orderId);
    var out = [];
    for (var i = 0; i < ms.length; i++) {
      var logs = ms[i].logs || [];
      for (var j = 0; j < logs.length; j++) out.push(logs[j]);
    }
    out.sort(function (a, b) { return String(b.time).localeCompare(String(a.time)); });
    return out;
  }

  /* ---------- 留痕（R3：日志只增不改不删；FR-A13：文本自包含设备编号） ---------- */
  function pushLog(machine, kind, text, actor) {
    machine.logs.unshift({ time: now(), actor: actor || '系统', kind: kind || 'note', text: tagMachineText(machine.id, text) });
  }

  /* ---------- 变更：订单（FR-A12：一次创建订单 + N 台设备） ---------- */
  /* 编号归一——数组或逗号/顿号/分号/空白分隔字符串 → 大写去空格去空项 */
  function normalizeIds(v) {
    var arr = Array.isArray(v) ? v : String(v || '').split(/[,，、;；\s]+/);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var s = String(arr[i] || '').trim().toUpperCase();
      if (s) out.push(s);
    }
    return out;
  }

  function createOrder(input, actor) {
    var data = ensure();
    input = input || {};
    var ids = normalizeIds(input.unitIds);
    if (!ids.length) return { error: '设备编号不能为空' };
    if (ids.length > MAX_ORDER_UNITS) return { error: '设备台数过多（每单最多 ' + MAX_ORDER_UNITS + ' 台）' };
    for (var a = 0; a < ids.length; a++) {
      for (var b = a + 1; b < ids.length; b++) {
        if (ids[a] === ids[b]) return { error: '设备编号重复：' + ids[a] };
      }
    }
    /* 每台设备独立建档 → 数量必须与编号个数一致（缺省视为一致） */
    if (input.quantity !== undefined && input.quantity !== null && input.quantity !== '') {
      var q = Math.round(Number(input.quantity));
      if (isNaN(q) || q !== ids.length) {
        return { error: '设备数量（' + input.quantity + '）与设备编号个数（' + ids.length + '）不一致：每台设备都需要独立编号' };
      }
    }
    for (var i = 0; i < data.units.length; i++) {
      if (ids.indexOf(data.units[i].id) !== -1) return { error: '设备编号已存在：' + data.units[i].id };
    }
    if (!String(input.model || '').trim()) return { error: '机型不能为空' };
    var order = {
      id: 'SO-' + Date.now().toString(36),
      contractNo: String(input.contractNo || '').trim(),
      customer: String(input.customer || '').trim(),
      model: String(input.model).trim(),
      category: input.category || 'plate',
      quantity: ids.length,
      plannedDelivery: String(input.plannedDelivery || '').trim(),
      createdAt: now()
    };
    var machines = [];
    for (var j = 0; j < ids.length; j++) {
      var m = {
        id: ids[j],
        orderId: order.id,
        createdAt: now(),
        stages: blankStages(),
        subsystems: makeSubsystems(),
        logs: []
      };
      pushLog(m, 'system', '订单创建：' + order.model + '（' + C.categoryInfo(order.category).label + '）× ' +
        ids.length + ' 台（' + ids.join('、') + '）', actor);
      machines.push(m);
    }
    data.orders.push(order);
    for (var k = 0; k < machines.length; k++) data.units.push(machines[k]);
    if (!commit(data)) return { error: SAVE_FAIL };
    return { order: order, machines: machines };
  }

  /* ---------- 变更：阶段（以设备为单位） ---------- */
  function updateStage(id, stageKey, patch, actor) {
    var machine = getMachine(id);
    if (!machine) return { error: '未找到设备：' + id };
    var stage = machine.stages[stageKey];
    if (!stage) return { error: '未知阶段：' + stageKey };
    patch = patch || {};
    var nextStatus = patch.status || stage.status;
    var nextNote = patch.note !== undefined ? String(patch.note) : stage.note;
    var label = C.STAGES[C.stageIndex(stageKey)].label;
    var changedStatus = nextStatus !== stage.status;
    var changedNote = (nextNote || '') !== (stage.note || '');
    if (!changedStatus && !changedNote) return { unit: machine, unchanged: true };
    stage.status = nextStatus;
    stage.note = nextNote;
    stage.updatedAt = now();
    if (changedStatus) {
      pushLog(machine, 'stage', '「' + label + '」' + C.statusInfo(stage.status).label + (stage.note ? '：' + stage.note : ''), actor);
    } else {
      pushLog(machine, 'stage', '「' + label + '」备注更新：' + stage.note, actor);
    }
    if (!commit(ensure())) return { error: SAVE_FAIL };
    return { unit: machine };
  }

  /* ---------- 变更：工段（Q5：工段为实例数组，支持增删改与排序） ---------- */
  function findSs(machine, code) {
    for (var i = 0; i < machine.subsystems.length; i++) {
      if (machine.subsystems[i].code === code) return machine.subsystems[i];
    }
    return null;
  }
  function nextCustomCode(machine) {
    var n = 1;
    while (findSs(machine, 'custom-' + n)) n++;
    return 'custom-' + n;
  }
  function hasSsName(machine, name, exceptCode) {
    for (var i = 0; i < machine.subsystems.length; i++) {
      var s = machine.subsystems[i];
      if (s.name === name && s.code !== exceptCode) return true;
    }
    return false;
  }

  function addSubsystem(id, name, actor) {
    var machine = getMachine(id);
    if (!machine) return { error: '未找到设备：' + id };
    name = String(name || '').trim();
    if (!name) return { error: '工段名称不能为空' };
    if (machine.subsystems.length >= MAX_SS_COUNT) return { error: '工段数量已达上限（' + MAX_SS_COUNT + ' 个）' };
    if (hasSsName(machine, name)) return { error: '已存在同名工段：' + name };
    var ss = { code: nextCustomCode(machine), name: name, status: 'waiting_material', progress: 0, note: '', updatedAt: '', images: [] };
    machine.subsystems.push(ss);
    pushLog(machine, 'subsystem', '「' + name + '」新增工段（第 ' + machine.subsystems.length + ' 位）', actor);
    if (!commit(ensure())) return { error: SAVE_FAIL };
    return { unit: machine };
  }

  function removeSubsystem(id, code, actor) {
    var machine = getMachine(id);
    if (!machine) return { error: '未找到设备：' + id };
    var idx = -1;
    for (var i = 0; i < machine.subsystems.length; i++) if (machine.subsystems[i].code === code) idx = i;
    if (idx < 0) return { error: '未知工段：' + code };
    var removed = machine.subsystems.splice(idx, 1)[0];
    pushLog(machine, 'subsystem', '「' + removed.name + '」工段已删除' +
      ((removed.images || []).length ? '（含 ' + removed.images.length + ' 张现场图片）' : ''), actor);
    if (!commit(ensure())) return { error: SAVE_FAIL };
    return { unit: machine };
  }

  function renameSubsystem(id, code, newName, actor) {
    var machine = getMachine(id);
    if (!machine) return { error: '未找到设备：' + id };
    var ss = findSs(machine, code);
    if (!ss) return { error: '未知工段：' + code };
    newName = String(newName || '').trim();
    if (!newName) return { error: '工段名称不能为空' };
    if (newName === ss.name) return { unit: machine, unchanged: true };
    if (hasSsName(machine, newName, code)) return { error: '已存在同名工段：' + newName };
    var old = ss.name;
    ss.name = newName;
    ss.updatedAt = now();
    pushLog(machine, 'subsystem', '工段「' + old + '」更名为「' + newName + '」', actor);
    if (!commit(ensure())) return { error: SAVE_FAIL };
    return { unit: machine };
  }

  function moveSubsystem(id, code, dir, actor) {
    var machine = getMachine(id);
    if (!machine) return { error: '未找到设备：' + id };
    var idx = -1;
    for (var i = 0; i < machine.subsystems.length; i++) if (machine.subsystems[i].code === code) idx = i;
    if (idx < 0) return { error: '未知工段：' + code };
    var target = idx + (dir < 0 ? -1 : 1);
    if (target < 0 || target >= machine.subsystems.length) return { unit: machine, moved: false };
    var tmp = machine.subsystems[target];
    machine.subsystems[target] = machine.subsystems[idx];
    machine.subsystems[idx] = tmp;
    pushLog(machine, 'subsystem', '工段顺序调整：「' + machine.subsystems[target].name + '」移至第 ' + (target + 1) + ' 位', actor);
    if (!commit(ensure())) return { error: SAVE_FAIL };
    return { unit: machine, moved: true };
  }

  function updateSubsystem(id, code, patch, actor) {
    var machine = getMachine(id);
    if (!machine) return { error: '未找到设备：' + id };
    var ss = findSs(machine, code);
    if (!ss) return { error: '未知工段：' + code };
    patch = patch || {};
    /* FR-A11（2026-09-19）：状态由完成度自动判定（0% 等待材料 / 有进度 进行中 /
     * 100% 生产完成），patch.status 不再接受——防止状态与完成度脱节 */
    var nextProgress = patch.progress !== undefined ? Math.max(0, Math.min(100, Math.round(Number(patch.progress) || 0))) : (Number(ss.progress) || 0);
    var nextStatus = C.ssStatusOf(nextProgress);
    var nextNote = patch.note !== undefined ? String(patch.note) : ss.note;
    var changedStatus = nextStatus !== ss.status;
    var changedProgress = nextProgress !== ss.progress;
    var changedNote = (nextNote || '') !== (ss.note || '');
    if (!changedStatus && !changedProgress && !changedNote) return { unit: machine, unchanged: true };
    ss.status = nextStatus;
    ss.progress = nextProgress;
    ss.note = nextNote;
    ss.updatedAt = now();
    if (changedStatus) {
      /* 状态变化必由完成度跨越阈值引起，合并为一条留痕 */
      pushLog(machine, 'subsystem', '「' + ss.name + '」' + C.statusInfo(nextStatus).label + '，完成度 ' + nextProgress + '%' + (ss.note ? '：' + ss.note : ''), actor);
    } else if (changedProgress) {
      pushLog(machine, 'subsystem', '「' + ss.name + '」完成度更新为 ' + nextProgress + '%' + (ss.note ? '：' + ss.note : ''), actor);
    } else {
      pushLog(machine, 'subsystem', '「' + ss.name + '」备注更新：' + ss.note, actor);
    }
    if (!commit(ensure())) return { error: SAVE_FAIL };
    return { unit: machine };
  }

  /* ---------- 变更：工段现场图片（右下角记录"上传时完成度"） ---------- */
  function addSubsystemImages(id, code, imgs, actor) {
    var machine = getMachine(id);
    if (!machine) return { error: '未找到设备：' + id };
    var ss = findSs(machine, code);
    if (!ss) return { error: '未知工段：' + code };
    if (!Array.isArray(imgs) || !imgs.length) return { error: '没有可保存的图片' };
    if (!Array.isArray(ss.images)) ss.images = [];
    if (ss.images.length + imgs.length > MAX_SS_IMAGES) {
      return { error: '该工段最多保留 ' + MAX_SS_IMAGES + ' 张图片（当前 ' + ss.images.length + ' 张）' };
    }
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i] || {};
      if (typeof im.dataUrl !== 'string' || im.dataUrl.indexOf('data:image') !== 0) {
        return { error: '第 ' + (i + 1) + ' 张图片数据无效' };
      }
    }
    var stamp = now();
    var base = Date.now().toString(36);
    for (var j = 0; j < imgs.length; j++) {
      ss.images.push({
        id: 'img-' + base + '-' + j,
        dataUrl: imgs[j].dataUrl,
        progress: Math.max(0, Math.min(100, Math.round(Number(imgs[j].progress) || 0))),
        time: stamp,
        name: String(imgs[j].name || '').slice(0, 60)
      });
    }
    var pct = Math.max(0, Math.min(100, Math.round(Number(imgs[0].progress) || 0)));
    pushLog(machine, 'subsystem', '「' + ss.name + '」上传 ' + imgs.length + ' 张现场图片（上传时完成度 ' + pct + '%）', actor);
    if (!commit(ensure())) { refreshCache(); return { error: '本机存储空间不足，图片保存失败（请删除部分旧图片后重试）' }; }
    return { unit: machine };
  }

  function removeSubsystemImage(id, code, imgId, actor) {
    var machine = getMachine(id);
    if (!machine) return { error: '未找到设备：' + id };
    var ss = findSs(machine, code);
    if (!ss) return { error: '未知工段：' + code };
    if (!Array.isArray(ss.images)) ss.images = [];
    var idx = -1;
    for (var i = 0; i < ss.images.length; i++) if (ss.images[i].id === imgId) idx = i;
    if (idx < 0) return { error: '未找到该图片' };
    ss.images.splice(idx, 1);
    pushLog(machine, 'subsystem', '「' + ss.name + '」删除 1 张现场图片', actor);
    if (!commit(ensure())) return { error: SAVE_FAIL };
    return { unit: machine };
  }

  /* ---------- 变更：动态 ---------- */
  function addLog(id, text, actor) {
    var machine = getMachine(id);
    if (!machine) return { error: '未找到设备：' + id };
    text = String(text || '').trim();
    if (!text) return { error: '动态内容不能为空' };
    pushLog(machine, 'note', text, actor);
    if (!commit(ensure())) return { error: SAVE_FAIL };
    return { unit: machine };
  }

  function resetDemo() {
    var data = { version: 2, orders: seedOrders(), units: seedMachines(), operators: seedOperators() };
    writeRaw(data);
    return data;
  }

  /* ---------- 操作人账号：查询 / 登录 / 注册 / 删除（FR-A10） ---------- */
  function findOperator(name) {
    var n = String(name || '').trim();
    var ops = ensure().operators;
    for (var i = 0; i < ops.length; i++) if (ops[i].name === n) return ops[i];
    return null;
  }
  function listOperators() { return ensure().operators.slice(); }

  function verifyLogin(name, pass) {
    var op = findOperator(name);
    if (!op) return { error: '账号不存在' };
    if (String(pass || '') !== op.pass) return { error: '密码错误' };
    return { ok: true, operator: op };
  }

  function addOperator(name, pass, actor) {
    var data = ensure();
    name = String(name || '').trim();
    if (!name) return { error: '账号名不能为空' };
    if (name.length > 20) return { error: '账号名过长（最多 20 字）' };
    if (!String(pass || '')) return { error: '密码不能为空' };
    for (var i = 0; i < data.operators.length; i++) {
      if (data.operators[i].name === name) return { error: '账号已存在：' + name };
    }
    var op = {
      name: name,
      role: 'operator', /* 只能注册操作员 → 主管有且仅有一个 */
      pass: String(pass),
      createdAt: now(),
      createdBy: String(actor || '系统')
    };
    data.operators.push(op);
    if (!commit(data)) return { error: SAVE_FAIL };
    return { operator: op };
  }

  function removeOperator(name, actor) {
    var data = ensure();
    var n = String(name || '').trim();
    var idx = -1;
    for (var i = 0; i < data.operators.length; i++) if (data.operators[i].name === n) idx = i;
    if (idx < 0) return { error: '未知账号：' + n };
    if (data.operators[idx].role === 'supervisor') return { error: '主管账号不可删除（有且仅有一个主管）' };
    var removed = data.operators.splice(idx, 1)[0];
    void actor; /* 参数留作 M1 后端统一审计 */
    if (!commit(data)) return { error: SAVE_FAIL };
    return { ok: true, removed: removed.name };
  }

  /* Q7：客户端字段白名单 —— M0 原样返回，正式版在此收口（隐藏内部备注/成本类字段） */
  function sanitizeUnitForClient(machine) { return machine; }

  root.APP = root.APP || {};
  root.APP.STORE = {
    persistent: function () { return persistent; },
    storageKey: STORAGE_KEY,
    MAX_SS_COUNT: MAX_SS_COUNT,
    MAX_SS_IMAGES: MAX_SS_IMAGES,
    MAX_ORDER_UNITS: MAX_ORDER_UNITS,
    listOrders: listOrders,
    getOrder: getOrder,
    machinesOf: machinesOf,
    listMachines: listMachines,
    getMachine: getMachine,
    getOrderOf: getOrderOf,
    orderSummary: orderSummary,
    orderLogs: orderLogs,
    createOrder: createOrder,
    updateStage: updateStage,
    updateSubsystem: updateSubsystem,
    addSubsystem: addSubsystem,
    removeSubsystem: removeSubsystem,
    renameSubsystem: renameSubsystem,
    moveSubsystem: moveSubsystem,
    addSubsystemImages: addSubsystemImages,
    removeSubsystemImage: removeSubsystemImage,
    addLog: addLog,
    resetDemo: resetDemo,
    listOperators: listOperators,
    verifyLogin: verifyLogin,
    addOperator: addOperator,
    removeOperator: removeOperator,
    refresh: refreshCache,
    sanitizeUnitForClient: sanitizeUnitForClient
  };
})(typeof window !== 'undefined' ? window : globalThis);
