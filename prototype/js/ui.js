/* ============================================================
 * ui.js — 公共渲染组件与工具（"组件化思维"：每个渲染函数 ≈ 一个组件）
 * 企划书对应：§9.1 XSS 防护（esc）、FR-C3/C4（时间线/进度）、Q13
 * 依赖：须先加载 constants.js
 * ============================================================ */
(function (root) {
  'use strict';
  var C = root.APP.CONST;

  /* 所有动态文本必须经 esc 转义后再拼 HTML（XSS 防护） */
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function (n) { return String(n).length < 2 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtDate(iso) {
    return iso ? String(iso).slice(0, 10) : '—';
  }

  function statusBadge(status) {
    var info = C.statusInfo(status);
    return '<span class="badge ' + info.cls + '">' + esc(info.label) + '</span>';
  }

  function progressBar(pct) {
    var v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    var cls = v >= 100 ? ' bar-done' : (v > 0 ? ' bar-doing' : ' bar-zero');
    return '<div class="progress">' +
      '<div class="progress-track"><div class="progress-inner' + cls + '" style="width:' + v + '%"></div></div>' +
      '<span class="progress-num">' + v + '%</span>' +
      '</div>';
  }

  /* 四阶段横向步骤条（FR-C3）：done=绿勾 / blocked=红感叹 / 当前=蓝呼吸 / 未到=灰 */
  function stageStepper(unit) {
    var cur = C.currentStageOf(unit);
    var allDone = C.allStagesDone(unit);
    var html = '<div class="stepper' + (allDone ? ' all-done' : '') + '">';
    for (var i = 0; i < C.STAGES.length; i++) {
      var s = C.STAGES[i];
      var st = unit.stages[s.key] || { status: 'pending' };
      var status = st.status;
      var isCur = s.key === cur && !allDone;
      var cls = 'step ';
      if (status === 'done') cls += 'step-done';
      else if (status === 'blocked') cls += 'step-blocked';
      else if (isCur || status === 'in_progress') cls += 'step-current';
      else cls += 'step-todo';
      var icon = status === 'done' ? '✓' : (status === 'blocked' ? '!' : String(i + 1));
      if (i > 0) html += '<div class="step-line' + (unit.stages[C.STAGES[i - 1].key] && unit.stages[C.STAGES[i - 1].key].status === 'done' ? ' line-done' : '') + '"></div>';
      html += '<div class="' + cls + '" title="' + esc(s.hint + (st.updatedAt ? ' · 更新于 ' + fmtTime(st.updatedAt) : '')) + '">' +
        '<div class="step-dot">' + icon + '</div>' +
        '<div class="step-label">' + esc(s.label) + '</div>' +
        '<div class="step-status">' + esc(C.statusInfo(status).label) + '</div>' +
        '</div>';
    }
    html += '</div>';
    return html;
  }

  /* 七大工段进度栅格（FR-C3）—— 客户端只读；含现场图片缩略图（角标=上传时完成度） */
  function subsystemGrid(unit) {
    var html = '<div class="ss-grid">';
    for (var i = 0; i < unit.subsystems.length; i++) {
      var s = unit.subsystems[i];
      html += '<div class="ss-card">' +
        '<div class="ss-head"><span class="ss-name">' + esc(s.name) + '</span>' + statusBadge(s.status) + '</div>' +
        progressBar(s.progress) +
        (s.note ? '<div class="ss-note" title="' + esc(s.note) + '">' + esc(s.note) + '</div>' : '<div class="ss-note ss-note-empty">—</div>') +
        thumbStrip(unit.id, s.code, s.images, { admin: false }) +
        '</div>';
    }
    html += '</div>';
    return html;
  }

  /* 现场图片缩略条：右下角角标 = 上传时的工段完成度；admin 模式额外带删除按钮 */
  function thumbStrip(unitId, ssCode, images, opts) {
    opts = opts || {};
    if (!images || !images.length) return '';
    var html = '<div class="thumb-strip">';
    for (var i = 0; i < images.length; i++) {
      var im = images[i];
      html += '<div class="thumb">' +
        '<img class="thumb-shot" data-unit="' + esc(unitId) + '" data-ss="' + esc(ssCode) + '" data-img="' + esc(im.id) + '" src="' + im.dataUrl + '" alt="' + esc(im.name || '现场图片') + '">' +
        (opts.admin ? '<button type="button" class="thumb-x" data-del-img="' + esc(im.id) + '" title="删除图片">✕</button>' : '') +
        '<span class="thumb-progress">' + Number(im.progress || 0) + '%</span>' +
        '</div>';
    }
    html += '</div>';
    return html;
  }

  /* 缩略图事件绑定：点击看大图（灯箱）；admin 传入 onDelete 处理删除 */
  function bindThumbs(rootEl, onDelete) {
    if (typeof document === 'undefined' || !rootEl || !rootEl.querySelectorAll) return;
    var STORE = root.APP.STORE;
    function findImg(unitId, ssCode, imgId) {
      var u = STORE.getMachine(unitId);
      if (!u) return null;
      for (var i = 0; i < u.subsystems.length; i++) {
        if (u.subsystems[i].code !== ssCode) continue;
        var arr = u.subsystems[i].images || [];
        for (var j = 0; j < arr.length; j++) {
          if (arr[j].id === imgId) return { img: arr[j], ssName: u.subsystems[i].name };
        }
      }
      return null;
    }
    var shots = rootEl.querySelectorAll('.thumb-shot');
    for (var i = 0; i < shots.length; i++) {
      shots[i].addEventListener('click', function () {
        var f = findImg(this.getAttribute('data-unit'), this.getAttribute('data-ss'), this.getAttribute('data-img'));
        if (!f) return;
        openLightbox(f.img.dataUrl,
          (f.img.name ? f.img.name + ' · ' : '') + f.ssName +
          ' · 完成度 ' + Number(f.img.progress || 0) + '%（' + fmtTime(f.img.time) + '）');
      });
    }
    if (!onDelete) return;
    var xs = rootEl.querySelectorAll('.thumb-x');
    for (var k = 0; k < xs.length; k++) {
      xs[k].addEventListener('click', function (e) {
        e.stopPropagation();
        var shot = this.parentNode.querySelector('.thumb-shot');
        if (!shot) return;
        onDelete(shot.getAttribute('data-unit'), shot.getAttribute('data-ss'), this.getAttribute('data-del-img'));
      });
    }
  }

  /* 灯箱：点击/Esc 关闭 */
  function openLightbox(dataUrl, caption) {
    if (typeof document === 'undefined') return;
    var ov = document.createElement('div');
    ov.className = 'lightbox';
    ov.innerHTML = '<figure>' +
      '<img src="' + dataUrl + '" alt="">' +
      '<figcaption>' + esc(caption || '') + '</figcaption>' +
      '<div class="lightbox-close">点击任意处或按 Esc 关闭</div>' +
      '</figure>';
    function close() {
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
  }

  /* 动态列表（R3 留痕展示） */
  function logList(logs, limit) {
    var arr = (logs || []).slice(0, limit || 20);
    if (!arr.length) return '<div class="empty">暂无动态记录</div>';
    var dotCls = { stage: 'dot-stage', subsystem: 'dot-ss', note: 'dot-note', system: 'dot-system' };
    var html = '<ul class="logs">';
    for (var i = 0; i < arr.length; i++) {
      var l = arr[i];
      html += '<li>' +
        '<span class="log-dot ' + (dotCls[l.kind] || 'dot-note') + '"></span>' +
        '<span class="log-time">' + esc(fmtTime(l.time)) + '</span>' +
        '<span class="log-text">' + esc(l.text) + '</span>' +
        '<span class="log-actor">' + esc(l.actor || '') + '</span>' +
        '</li>';
    }
    html += '</ul>';
    return html;
  }

  /* 订单头卡（FR-C3 + FR-A12）：合同号+客户置顶 → 机型 → 数量+编号chips
   * （data-mid 供调用方绑定"按设备编号查看进度"）→ 交付/创建 → 整体进度 */
  function orderHeadCard(order, progressPct, opts) {
    opts = opts || {};
    var cat = C.categoryInfo(order.category);
    var ids = opts.machineIds || [];
    var idChips = '';
    for (var i = 0; i < ids.length; i++) {
      idChips += '<span class="chip uid-chip' + (opts.activeMachineId === ids[i] ? ' chip-active' : '') +
        '" data-mid="' + esc(ids[i]) + '" title="查看该设备进度">' + esc(ids[i]) + '</span>';
    }
    return '<div class="unit-head">' +
      '<div class="unit-title-row">' +
      '<span class="unit-kv">合同号 <b>' + esc(order.contractNo || '—') + '</b></span>' +
      '<span class="unit-kv">客户 <b>' + esc(order.customer || '—') + '</b></span>' +
      (opts.back ? '<button class="btn btn-ghost btn-back" data-action="back-order">← 返回订单列表</button>' : '') +
      '</div>' +
      '<div class="unit-model">' + esc(order.model) +
      ' <span class="chip">' + esc(cat.label) + '</span></div>' +
      '<div class="unit-ids-row">设备数量 <b>' + Number(order.quantity || ids.length) + '</b> 台' +
      '<span class="sep-dot">·</span>设备编号（点击查看各台进度） ' + idChips + '</div>' +
      '<div class="info-grid">' +
      '<div><span class="info-k">计划交付</span><span class="info-v">' + esc(fmtDate(order.plannedDelivery)) + '</span></div>' +
      '<div><span class="info-k">创建时间</span><span class="info-v">' + esc(fmtTime(order.createdAt)) + '</span></div>' +
      '</div>' +
      (progressPct === null ? '' :
        '<div class="overall"><span class="overall-k">整体完成度（各设备平均，供参考）</span>' + progressBar(progressPct) + '</div>') +
      '</div>';
  }

  /* 设备头卡（订单内上下文）：当前设备编号 + 所属订单行 + 同单切换chips */
  function machineHeadCard(order, machine, opts) {
    opts = opts || {};
    var chip = C.allStagesDone(machine)
      ? '<span class="badge st-done">全部完成</span>'
      : statusBadge(machine.stages[C.currentStageOf(machine)].status);
    var sibs = opts.siblingIds || [];
    var sibChips = '';
    for (var i = 0; i < sibs.length; i++) {
      sibChips += '<span class="chip uid-chip' + (sibs[i] === machine.id ? ' chip-active' : '') +
        '" data-mid="' + esc(sibs[i]) + '" title="查看该设备进度">' + esc(sibs[i]) + '</span>';
    }
    return '<div class="unit-head">' +
      '<div class="unit-title-row">' +
      '<h2 class="unit-id">' + esc(machine.id) + '</h2>' + chip +
      (opts.back ? '<button class="btn btn-ghost btn-back" data-action="back-order">← 返回订单</button>' : '') +
      '</div>' +
      '<div class="unit-model">所属订单：合同号 <b>' + esc(order.contractNo || '—') + '</b> · ' +
      esc(order.customer || '—') + ' · ' + esc(order.model) + '</div>' +
      (sibs.length > 1 ? '<div class="unit-ids-row">同单设备（点击切换） ' + sibChips + '</div>' : '') +
      '</div>';
  }

  /* 轻提示 */
  function toast(msg, type) {
    if (typeof document === 'undefined') return;
    var box = document.getElementById('mcps-toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mcps-toast-box';
      document.body.appendChild(box);
    }
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.classList.add('toast-out'); }, 2200);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
  }

  root.APP = root.APP || {};
  root.APP.UI = {
    esc: esc,
    fmtTime: fmtTime,
    fmtDate: fmtDate,
    statusBadge: statusBadge,
    progressBar: progressBar,
    stageStepper: stageStepper,
    subsystemGrid: subsystemGrid,
    logList: logList,
    orderHeadCard: orderHeadCard,
    machineHeadCard: machineHeadCard,
    thumbStrip: thumbStrip,
    bindThumbs: bindThumbs,
    openLightbox: openLightbox,
    toast: toast
  };
})(typeof window !== 'undefined' ? window : globalThis);
