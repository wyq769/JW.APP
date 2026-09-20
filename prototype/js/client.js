/* ============================================================
 * client.js — 客户端（只读）：FR-C1 查询 / FR-C2 订单列表 / FR-C3 设备详情
 *             （FR-A12：同单多台，按设备编号查看、芯片切换）/ FR-C4 整体进度 /
 *             FR-C5 刷新 / FR-C6 空态兜底
 * 依赖：constants.js / store.js / ui.js（页面按此顺序引入）
 * ============================================================ */
(function () {
  'use strict';
  var C = window.APP.CONST;
  var UI = window.APP.UI;
  var STORE = window.APP.STORE;

  var resultArea = document.getElementById('result-area');
  var searchInput = document.getElementById('search-input');
  var currentId = null;      /* 当前查看的设备编号 */
  var lastKeyword = '';

  /* ---------- FR-C2：订单结果列表（FR-A12：订单行 + 各台编号芯片） ---------- */
  function renderOrderRow(o) {
    var cat = C.categoryInfo(o.category);
    var sum = STORE.orderSummary(o);
    var allDone = true;
    for (var i = 0; i < sum.machines.length; i++) {
      if (!C.allStagesDone(sum.machines[i])) { allDone = false; break; }
    }
    var chips = '';
    for (var j = 0; j < sum.machines.length; j++) {
      chips += '<span class="chip" data-open-machine="' + UI.esc(sum.machines[j].id) + '">' +
        UI.esc(sum.machines[j].id) + '</span> ';
    }
    return '<div class="unit-row" data-oid="' + UI.esc(o.id) + '">' +
      '<div class="head">' +
      '<span class="ucontract">合同号 ' + UI.esc(o.contractNo || '—') + ' · ' + UI.esc(o.customer || '—') + '</span>' +
      (allDone ? '<span class="badge st-done">全部完成</span>'
               : '<span class="badge st-progress">整体 ' + sum.progress + '%</span>') +
      '</div>' +
      '<div class="umodel">' + UI.esc(o.model) + ' <span class="chip">' + UI.esc(cat.label) + '</span></div>' +
      '<div class="meta">' +
      '<span>设备数量：' + Number(o.quantity || sum.machines.length) + ' 台</span>' +
      '<span class="uid-list">设备编号（点击看各台进度）：' + chips + '</span>' +
      '<span>计划交付：' + UI.esc(UI.fmtDate(o.plannedDelivery)) + '</span>' +
      '</div>' +
      UI.progressBar(sum.progress) +
      '</div>';
  }

  function renderResultList(list, keyword) {
    if (!list.length) {
      resultArea.innerHTML = '<div class="card"><div class="empty">未找到与「' + UI.esc(keyword) +
        '」相关的设备订单。<br>请核对设备编号或合同号，也可联系您的业务对接人。</div></div>';
      return;
    }
    var html = '<div class="unit-list">';
    for (var i = 0; i < list.length; i++) html += renderOrderRow(list[i]);
    html += '</div>';
    resultArea.innerHTML = html;
    var rows = resultArea.querySelectorAll('.unit-row');
    for (var r = 0; r < rows.length; r++) {
      rows[r].addEventListener('click', function (e) {
        if (e.target.closest('[data-open-machine]')) return; /* 编号芯片单独绑定 */
        var ms = STORE.machinesOf(this.getAttribute('data-oid'));
        if (ms.length) showMachine(ms[0].id);
      });
    }
    var chips = resultArea.querySelectorAll('[data-open-machine]');
    for (var c = 0; c < chips.length; c++) {
      chips[c].addEventListener('click', function () { showMachine(this.getAttribute('data-open-machine')); });
    }
  }

  /* ---------- FR-C3：设备详情（订单内单台，同单芯片切换） ---------- */
  function renderMachineDetail(m) {
    var o = STORE.getOrderOf(m);
    var sibs = o ? STORE.machinesOf(o.id).map(function (x) { return x.id; }) : [m.id];
    var allDone = C.allStagesDone(m);
    var stageKey = C.currentStageOf(m);
    var stage = C.STAGES[C.stageIndex(stageKey)];
    var hint = allDone
      ? '该设备已完成全部生产阶段并发运。'
      : '该设备当前阶段：' + stage.label + ' — ' + stage.hint;

    resultArea.innerHTML =
      '<div class="card">' +
      UI.machineHeadCard(o, m, { back: true, siblingIds: sibs }) +
      '<div class="page-sub">' + UI.esc(hint) + '</div>' +
      UI.stageStepper(m) +
      '</div>' +

      '<div class="card">' +
      '<div class="card-title">该设备各工段进度 <span class="chip">设备加工阶段细化</span></div>' +
      UI.subsystemGrid(m) +
      '</div>' +

      '<div class="card">' +
      '<div class="card-title">最近动态 <button class="btn btn-ghost btn-sm" id="btn-refresh" style="margin-left:auto">↻ 刷新</button></div>' +
      UI.logList(m.logs, 20) +
      '</div>';

    UI.bindThumbs(resultArea); /* 现场图片：点击放大 */
    var chips = resultArea.querySelectorAll('[data-mid]');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () { showMachine(this.getAttribute('data-mid')); });
    }
    document.getElementById('btn-refresh').addEventListener('click', function () {
      STORE.refresh();
      showMachine(currentId, true);
    });
    var back = resultArea.querySelector('[data-action="back-order"]');
    back.addEventListener('click', function () { currentId = null; doSearch(lastKeyword); });
    window.scrollTo(0, 0);
  }

  function showMachine(id, silent) {
    var m = STORE.sanitizeUnitForClient(STORE.getMachine(id));
    if (!m) {
      if (!silent) UI.toast('未找到设备：' + id, 'error');
      currentId = null;
      doSearch(lastKeyword);
      return;
    }
    currentId = id;
    renderMachineDetail(m);
  }

  /* ---------- FR-C1：查询（任一设备编号 / 合同号 / 客户 / 机型均命中订单） ---------- */
  function doSearch(keyword) {
    STORE.refresh(); /* 每次查询重读数据，取到管理端最新改动 */
    lastKeyword = keyword || '';
    currentId = null;
    var list = STORE.listOrders(lastKeyword);
    /* 无关键词时展示全部订单（M0 演示态；正式版按 Q7 收口为凭据查询） */
    renderResultList(list, lastKeyword || '全部订单（演示）');
  }

  /* ---------- 示例编号（演示便利） ---------- */
  function renderSampleChips() {
    var box = document.getElementById('sample-chips');
    var orders = STORE.listOrders('');
    if (!orders.length) { box.innerHTML = ''; return; }
    var html = '<span class="lbl">试试：</span>';
    for (var i = 0; i < Math.min(orders.length, 5); i++) {
      var ms = STORE.machinesOf(orders[i].id);
      if (!ms.length) continue;
      html += '<button type="button" class="sample-chip" data-id="' + UI.esc(ms[0].id) + '">' + UI.esc(ms[0].id) + '</button>';
    }
    box.innerHTML = html;
    var chips = box.querySelectorAll('.sample-chip');
    for (var j = 0; j < chips.length; j++) {
      chips[j].addEventListener('click', function () {
        searchInput.value = this.getAttribute('data-id');
        doSearch(searchInput.value);
      });
    }
  }

  document.getElementById('search-form').addEventListener('submit', function (e) {
    e.preventDefault();
    doSearch(searchInput.value);
  });

  /* 跨标签页同步：管理端改动后本页自动刷新视图（Q10） */
  window.addEventListener('storage', function (e) {
    if (e.key === STORE.storageKey) {
      STORE.refresh();
      if (currentId) showMachine(currentId, true);
      else doSearch(lastKeyword);
    }
  });

  renderSampleChips();
  doSearch('');
})();
