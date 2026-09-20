/* ============================================================
 * constants.js — 品类 / 阶段 / 状态 / 工段 常量 + 状态机纯函数
 * 企划书对应：§5 领域模型（R1~R5）、Q3/Q5/Q9/Q13、§8 选型 A
 * UMD 式挂载：浏览器挂 window.APP，node 冒烟测试挂 globalThis.APP
 * ============================================================ */
(function (root) {
  'use strict';

  /* 品类（Q14：编号前缀 PC 片 / BC 板 / GC 管 / BM 薄膜） */
  var CATEGORIES = [
    { code: 'sheet', label: '片材设备', prefix: 'PC' },
    { code: 'plate', label: '板材设备', prefix: 'BC' },
    { code: 'pipe',  label: '管材设备', prefix: 'GC' },
    { code: 'film',  label: '薄膜设备', prefix: 'BM' }
  ];

  /* 大阶段（订单骨干时间线）。正式版如需"客户验收"，在此追加即可（Q3）
   * 2026-09-19 修订：原材料来自不同进货商，先到料的零件可先开工——
   * "原材料进货"与"设备加工"为并行阶段（见 PARALLEL_WITH）。 */
  var STAGES = [
    { key: 'procurement', label: '原材料进货', hint: '钢材 / 电机 / 电控等物料采购与到货检验（可与设备加工并行：先到料先开工）' },
    { key: 'processing',  label: '设备加工',   hint: '七大工段并行制造与装配' },
    { key: 'testing',     label: '试机',       hint: '空载 / 负载联动调试' },
    { key: 'shipping',    label: '出厂发货',   hint: '包装发运与随车文件' }
  ];

  /* 并行规则（2026-09-19）：键 = 目标阶段，值 = 允许与其并行（不要求已完成）的前置阶段。
   * 加工可跨过进货直接开工（进货持续到货、持续输出给加工）；试机 / 发货仍按序。 */
  var PARALLEL_WITH = {
    processing: ['procurement']
  };

  /* 大阶段状态（R4：blocked 可退回 in_progress）——仅四大阶段使用 */
  var STATUS = {
    pending:     { label: '未开始',  cls: 'st-pending' },
    in_progress: { label: '进行中',  cls: 'st-progress' },
    blocked:     { label: '异常停滞', cls: 'st-blocked' },
    done:        { label: '已完成',  cls: 'st-done' }
  };

  /* FR-A11（2026-09-19）：工段三态——由完成度自动派生（ssStatusOf），
   * 取消"未开始/异常停滞"（等待材料统一覆盖；有进度即进行中）。 */
  var SS_STATUS = {
    waiting_material: { label: '等待材料', cls: 'st-pending' },
    in_progress:      { label: '进行中',   cls: 'st-progress' },
    done:             { label: '生产完成', cls: 'st-done' }
  };

  /* 操作人角色（FR-A10，2026-09-19）：主管有且仅有一个（可增删操作员），操作员只读写动态 */
  var ROLES = {
    supervisor: { label: '主管' },
    operator:   { label: '操作员' }
  };

  /* M0 统一七大工段模板（Q5：正式版按机型模板实例化，subsystems 为实例数组） */
  var SUBSYSTEM_TEMPLATES = [
    { code: 'feeding',   name: '投料设备' },
    { code: 'melting',   name: '材料熔融设备' },
    { code: 'extrusion', name: '塑性挤出设备' },
    { code: 'cooling',   name: '冷却设备' },
    { code: 'transport', name: '运输设备' },
    { code: 'cutting',   name: '切割设备' },
    { code: 'packing',   name: '打包设备' }
  ];

  function stageIndex(key) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i].key === key) return i;
    return -1;
  }
  function statusInfo(code) {
    /* 工段三态优先（SS_STATUS），大阶段四态兜底 */
    return SS_STATUS[code] || STATUS[code] || { label: String(code), cls: 'st-pending' };
  }

  /* FR-A11：工段状态 = 完成度的派生值（唯一事实来源是完成度）：
   * 0% → 等待材料；1~99%（有进度）→ 进行中；100% → 生产完成 */
  function ssStatusOf(progress) {
    var p = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
    if (p >= 100) return 'done';
    if (p > 0) return 'in_progress';
    return 'waiting_material';
  }
  function categoryInfo(code) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].code === code) return CATEGORIES[i];
    return { code: code, label: String(code), prefix: 'XX' };
  }

  /* R5（2026-09-19 并行修订）：当前阶段 = 最深的进行中/异常停滞阶段
   * （并行推进时取更深者，如实反映"加工已开工"）；无活跃阶段时取
   * 第一个非 done 阶段；全部完成停在最后一个。派生值，不落库。 */
  function currentStageOf(unit) {
    var active = null, firstOpen = null;
    for (var i = 0; i < STAGES.length; i++) {
      var st = unit.stages[STAGES[i].key];
      var status = st ? st.status : 'pending';
      if (status !== 'done' && firstOpen === null) firstOpen = STAGES[i].key;
      if (status === 'in_progress' || status === 'blocked') active = STAGES[i].key;
    }
    return active || firstOpen || STAGES[STAGES.length - 1].key;
  }
  function allStagesDone(unit) {
    for (var i = 0; i < STAGES.length; i++) {
      var st = unit.stages[STAGES[i].key];
      if (!st || st.status !== 'done') return false;
    }
    return true;
  }

  function subsystemAvg(unit) {
    if (!unit.subsystems || !unit.subsystems.length) return 0;
    var sum = 0;
    for (var i = 0; i < unit.subsystems.length; i++) sum += Number(unit.subsystems[i].progress) || 0;
    return sum / unit.subsystems.length;
  }

  /* Q13：四阶段等权；"设备加工"按工段平均完成度折算；in_progress / blocked 按 50% 计 */
  function stagePercent(unit, key) {
    var st = unit.stages[key] ? unit.stages[key].status : 'pending';
    if (key === 'processing') return Math.round(subsystemAvg(unit));
    if (st === 'done') return 100;
    if (st === 'in_progress' || st === 'blocked') return 50;
    return 0;
  }

  function computeOverallProgress(unit) {
    var total = 0;
    for (var i = 0; i < STAGES.length; i++) total += stagePercent(unit, STAGES[i].key);
    return Math.round(total / STAGES.length);
  }

  /* Q9/R1/R2：软校验 —— 返回警告数组（空数组 = 无警告），不阻断保存。
   * 2026-09-19 并行修订：PARALLEL_WITH 中列出的前置阶段不参与顺序检查。 */
  function validateStageTransition(unit, stageKey, nextStatus) {
    var warns = [];
    if (!STATUS[nextStatus]) { warns.push('未知状态：' + nextStatus); return warns; }
    var idx = stageIndex(stageKey);
    var par = PARALLEL_WITH[stageKey] || null;
    if ((nextStatus === 'in_progress' || nextStatus === 'done') && idx > 0) {
      for (var i = 0; i < idx; i++) {
        var pk = STAGES[i].key;
        if (par && par.indexOf(pk) !== -1) continue; /* 并行阶段：不要求已完成 */
        var ps = unit.stages[pk];
        if (!ps || ps.status !== 'done') {
          warns.push('「' + STAGES[i].label + '」尚未完成，建议先完成前一阶段');
          break;
        }
      }
    }
    if (stageKey === 'processing' && nextStatus === 'done') {
      var notDone = [];
      for (var j = 0; j < unit.subsystems.length; j++) {
        /* FR-A11：工段是否完成按完成度派生（100% = 生产完成） */
        if (ssStatusOf(unit.subsystems[j].progress) !== 'done') notDone.push(unit.subsystems[j].name);
      }
      if (notDone.length) warns.push('仍有 ' + notDone.length + ' 个工段未完成（' + notDone.join('、') + '）');
    }
    return warns;
  }

  root.APP = root.APP || {};
  root.APP.CONST = {
    CATEGORIES: CATEGORIES,
    STAGES: STAGES,
    PARALLEL_WITH: PARALLEL_WITH,
    STATUS: STATUS,
    SS_STATUS: SS_STATUS,
    ssStatusOf: ssStatusOf,
    ROLES: ROLES,
    SUBSYSTEM_TEMPLATES: SUBSYSTEM_TEMPLATES,
    stageIndex: stageIndex,
    statusInfo: statusInfo,
    categoryInfo: categoryInfo,
    currentStageOf: currentStageOf,
    allStagesDone: allStagesDone,
    subsystemAvg: subsystemAvg,
    stagePercent: stagePercent,
    computeOverallProgress: computeOverallProgress,
    validateStageTransition: validateStageTransition
  };
})(typeof window !== 'undefined' ? window : globalThis);
