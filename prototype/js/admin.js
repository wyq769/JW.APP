/* ============================================================
 * admin.js — 管理端（读写）：FR-A1 登录（账号表校验）/ FR-A2 订单列表 /
 *   FR-A3 阶段管理（软校验）/ FR-A4 工段管理 / FR-A5 追加动态 /
 *   FR-A6 新建订单 / FR-A7 重置演示数据 /
 *   FR-A8 工段增删改与排序 / FR-A9 工段现场图片上传（压缩 + 进度角标）/
 *   FR-A10 操作人管理（有且仅有一个主管：注册/删除操作员，2026-09-19）
 * 依赖：constants.js / store.js / ui.js（页面按此顺序引入）
 * ============================================================ */
(function () {
  'use strict';
  var C = window.APP.CONST;
  var UI = window.APP.UI;
  var STORE = window.APP.STORE;

  var SESSION_KEY = 'mcps_admin_session_v1'; /* 存登录账号名（FR-A10 起） */

  /* 图片压缩参数：localStorage 配额有限（约 5MB），长边压到 1000px、JPEG 68% */
  var IMG_MAX_SIDE = 1000;
  var IMG_QUALITY = 0.68;

  var app = document.getElementById('app');
  var logoutBtn = document.getElementById('btn-logout');

  var view = 'list';          /* list | new | order | machine | ops */
  var orderId = null;         /* 当前查看的订单 */
  var machineId = null;       /* 当前管理的设备 */
  var listFilter = { q: '', stage: '' };

  /* FR-A10：操作人 = 登录账号（动态署名）。会话账号不存在（被删/旧格式）视为未登录 */
  function actor() { return sessionStorage.getItem(SESSION_KEY) || '系统'; }
  function currentOp() {
    var name = sessionStorage.getItem(SESSION_KEY);
    if (!name) return null;
    var ops = STORE.listOperators();
    for (var i = 0; i < ops.length; i++) if (ops[i].name === name) return ops[i];
    return null;
  }
  function isSupervisor() {
    var op = currentOp();
    return !!op && op.role === 'supervisor';
  }

  /* ================= 图片压缩（浏览器 Canvas）：返回 Promise<dataUrl> ================= */
  function compressImage(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          try {
            var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            var w = Math.max(1, Math.round(img.width * scale));
            var h = Math.max(1, Math.round(img.height * scale));
            var cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            cv.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(cv.toDataURL('image/jpeg', quality));
          } catch (e) { reject(e); }
        };
        img.onerror = function () { reject(new Error('无法解析图片：' + file.name)); };
        img.src = reader.result;
      };
      reader.onerror = function () { reject(new Error('文件读取失败：' + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  /* ================= FR-A1 模拟登录 ================= */
  function renderLogin() {
    logoutBtn.style.display = 'none';
    app.innerHTML =
      '<div class="login-wrap card">' +
      '<div class="card-title">管理端登录</div>' +
      '<form id="login-form">' +
      '<div class="field"><label>账号</label><input type="text" id="login-user" autocomplete="username"></div>' +
      '<div class="field"><label>密码</label><input type="password" id="login-pass" autocomplete="current-password"></div>' +
      '<button class="btn" type="submit" style="width:100%">登 录</button>' +
      '</form>' +
      '<div class="login-hint">演示环境（M0 雏形）：主管 <b>王工</b>，操作员 <b>李工</b> / <b>陈工</b>，密码均为 <b>123456</b>。正式版将接入后端鉴权与角色权限（企划书 Q8）。</div>' +
      '</div>';
    document.getElementById('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var user = document.getElementById('login-user').value.trim();
      var pass = document.getElementById('login-pass').value;
      var res = STORE.verifyLogin(user, pass);
      if (res.ok) {
        sessionStorage.setItem(SESSION_KEY, res.operator.name);
        UI.toast('登录成功：' + res.operator.name + '（' + C.ROLES[res.operator.role].label + '）', 'ok');
        render();
      } else {
        UI.toast(res.error + '（演示账号：王工 / 李工 / 陈工，密码均 123456）', 'error');
      }
    });
  }

  /* ================= 外壳：侧边栏 + 主区 ================= */
  function renderShell() {
    logoutBtn.style.display = '';
    var op = currentOp();
    var opsNav = isSupervisor() ? '<button class="nav-btn" data-nav="ops">操作人管理</button>' : '';
    app.innerHTML =
      '<div class="admin-shell">' +
      '<aside class="sidebar">' +
      '<button class="nav-btn" data-nav="list">设备订单</button>' +
      '<button class="nav-btn" data-nav="new">＋ 新建订单</button>' +
      opsNav +
      '<div class="sep"></div>' +
      '<button class="nav-btn" data-action="reset">重置演示数据</button>' +
      '<div class="side-account">当前账号<br><b>' + UI.esc(op.name) + '</b>（' +
      UI.esc(C.ROLES[op.role].label) + '）</div>' +
      '</aside>' +
      '<main class="admin-main" id="view"></main>' +
      '</div>';
    var navs = app.querySelectorAll('[data-nav]');
    for (var i = 0; i < navs.length; i++) {
      navs[i].addEventListener('click', function () {
        view = this.getAttribute('data-nav');
        if (view === 'new') renderNew();
        else if (view === 'ops') renderOperators();
        else renderList();
      });
    }
    app.querySelector('[data-action="reset"]').addEventListener('click', function () {
      if (window.confirm('将清空本机演示数据并恢复初始 5 张订单 / 8 台设备与 3 个账号，确定？')) {
        STORE.resetDemo();
        UI.toast('演示数据已重置', 'ok');
        view = 'list';
        renderList();
      }
    });
    renderView();
  }

  function setNavActive() {
    var navs = app.querySelectorAll('[data-nav]');
    for (var i = 0; i < navs.length; i++) {
      navs[i].classList.toggle('active', navs[i].getAttribute('data-nav') === view ||
        ((view === 'order' || view === 'machine') && navs[i].getAttribute('data-nav') === 'list'));
    }
  }

  function renderView() {
    setNavActive();
    if (view === 'list') renderList();
    else if (view === 'new') renderNew();
    else if (view === 'ops') renderOperators();
    else if (view === 'order') renderOrderDetail(orderId);
    else if (view === 'machine') renderMachineDetail(machineId);
  }

  /* ================= FR-A2 订单列表（FR-A12：订单行 + 按设备编号看进度） ================= */
  function renderList() {
    view = 'list';
    setNavActive();
    var v = document.getElementById('view');
    var orders = STORE.listOrders(listFilter.q);
    if (listFilter.stage) {
      /* 订单内任一台设备处于该阶段即命中 */
      orders = orders.filter(function (o) {
        var ms = STORE.machinesOf(o.id);
        for (var i = 0; i < ms.length; i++) if (C.currentStageOf(ms[i]) === listFilter.stage) return true;
        return false;
      });
    }

    var stageOpts = '<option value="">全部阶段</option>';
    for (var i = 0; i < C.STAGES.length; i++) {
      stageOpts += '<option value="' + C.STAGES[i].key + '"' + (listFilter.stage === C.STAGES[i].key ? ' selected' : '') + '>' +
        UI.esc(C.STAGES[i].label) + '</option>';
    }

    var rows = '';
    if (!orders.length) {
      rows = '<tr><td colspan="8"><div class="empty">没有符合条件的设备订单</div></td></tr>';
    }
    for (var j = 0; j < orders.length; j++) {
      var o = orders[j];
      var sum = STORE.orderSummary(o);
      var idChips = '';
      for (var n = 0; n < sum.machines.length; n++) {
        idChips += '<span class="chip uid-chip" data-open-machine="' + UI.esc(sum.machines[n].id) + '" title="查看该设备进度">' + UI.esc(sum.machines[n].id) + '</span> ';
      }
      rows += '<tr data-oid="' + UI.esc(o.id) + '">' +
        '<td class="uid">' + UI.esc(o.contractNo || '—') + '</td>' +
        '<td>' + UI.esc(o.customer || '—') + '</td>' +
        '<td>' + UI.esc(o.model) + '<br><span class="chip">' + UI.esc(C.categoryInfo(o.category).label) + '</span></td>' +
        '<td>' + Number(o.quantity || sum.machines.length) + ' 台</td>' +
        '<td>' + idChips + '</td>' +
        '<td><span class="mini-progress">' + UI.progressBar(sum.progress) + '</span></td>' +
        '<td>' + UI.esc(UI.fmtDate(o.plannedDelivery)) + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" data-manage="' + UI.esc(o.id) + '">管理</button></td>' +
        '</tr>';
    }

    v.innerHTML =
      '<h1 class="page-title">设备订单</h1>' +
      '<p class="page-sub">共 ' + orders.length + ' 个在制/已交付订单。点击行查看订单详情；点击任一设备编号可直接查看该台进度（同单多台各自推进）。</p>' +
      '<div class="card"><div class="search-row" style="margin-bottom:10px">' +
      '<input type="text" id="list-q" placeholder="搜索任一设备编号 / 机型 / 客户 / 合同号" value="' + UI.esc(listFilter.q) + '">' +
      '<select id="list-stage" style="max-width:140px">' + stageOpts + '</select>' +
      '</div>' +
      '<div class="table-wrap"><table class="tbl">' +
      '<thead><tr><th>合同号</th><th>客户</th><th>机型</th><th>数量</th><th>设备编号（点按看各台进度）</th><th>整体进度</th><th>计划交付</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';

    document.getElementById('list-q').addEventListener('input', function () {
      listFilter.q = this.value;
      renderListKeepFocus();
    });
    document.getElementById('list-stage').addEventListener('change', function () {
      listFilter.stage = this.value;
      renderList();
    });
    var trs = v.querySelectorAll('tbody tr[data-oid]');
    for (var k = 0; k < trs.length; k++) {
      trs[k].addEventListener('click', function (e) {
        if (e.target.closest('[data-manage]') || e.target.closest('[data-open-machine]')) return;
        openOrder(this.getAttribute('data-oid'));
      });
    }
    var mbtns = v.querySelectorAll('[data-manage]');
    for (m = 0; m < mbtns.length; m++) {
      mbtns[m].addEventListener('click', function () { openOrder(this.getAttribute('data-manage')); });
    }
    var chips = v.querySelectorAll('[data-open-machine]');
    for (var c = 0; c < chips.length; c++) {
      chips[c].addEventListener('click', function () { openMachine(this.getAttribute('data-open-machine')); });
    }
  }

  /* 重新渲染列表后保持搜索框焦点（输入即筛场景） */
  function renderListKeepFocus() {
    renderList();
    var q = document.getElementById('list-q');
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
  }

  function openOrder(id) {
    orderId = id;
    view = 'order';
    renderView();
  }

  function openMachine(id) {
    machineId = id;
    view = 'machine';
    renderView();
  }

  /* ================= FR-A3 阶段管理 ================= */
  function stageEditRows(u) {
    var html = '';
    for (var i = 0; i < C.STAGES.length; i++) {
      var s = C.STAGES[i];
      var st = u.stages[s.key] || { status: 'pending', note: '' };
      var opts = '';
      for (var key in C.STATUS) {
        opts += '<option value="' + key + '"' + (st.status === key ? ' selected' : '') + '>' +
          UI.esc(C.STATUS[key].label) + '</option>';
      }
      html += '<div class="stage-edit-row">' +
        '<span class="stage-name" title="' + UI.esc(s.hint) + '">' + UI.esc(s.label) + '</span>' +
        '<select data-stage-status="' + s.key + '">' + opts + '</select>' +
        '<input type="text" class="stage-note" data-stage-note="' + s.key + '" placeholder="备注（将随日志展示给客户）" value="' + UI.esc(st.note) + '">' +
        '<button class="btn btn-sm" data-save-stage="' + s.key + '">保存</button>' +
        '</div>';
    }
    return html;
  }

  function bindStageRows(u) {
    var v = document.getElementById('view');
    var btns = v.querySelectorAll('[data-save-stage]');
    var one = function () {
      var key = this.getAttribute('data-save-stage');
      var sel = v.querySelector('[data-stage-status="' + key + '"]');
      var note = v.querySelector('[data-stage-note="' + key + '"]');
      var nextStatus = sel.value;
      /* 软校验（Q9）：先算警告，保存不阻断 */
      var warns = C.validateStageTransition(u, key, nextStatus);
      var patch = { status: nextStatus, note: note.value };
      var res = STORE.updateStage(u.id, key, patch, actor());
      if (res.error) { UI.toast(res.error, 'error'); return; }
      if (res.unchanged) { UI.toast('内容未变化'); return; }
      if (warns.length) UI.toast('已保存，但请注意：' + warns[0], 'warn');
      else UI.toast('已保存', 'ok');
      renderMachineDetail(u.id, true);
    };
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener('click', one);
  }

  /* ================= FR-A4 / FR-A8 / FR-A9 / FR-A11 工段卡片（三态自动判定 + 进度 + 增删改排序 + 图片） ================= */
  function ssEditCards(u) {
    var html = '<div class="ss-grid">';
    for (var i = 0; i < u.subsystems.length; i++) {
      var s = u.subsystems[i];
      var info = C.statusInfo(C.ssStatusOf(s.progress)); /* FR-A11：状态由完成度派生 */
      html += '<div class="ss-edit-card" data-code="' + UI.esc(s.code) + '">' +
        '<div class="ss-edit-head">' +
        '<span class="ss-name" title="' + UI.esc(s.name) + '">' + UI.esc(s.name) + '</span>' +
        '<span class="ss-tools">' +
        '<button type="button" class="btn-icon" data-rename title="修改名称">✎</button>' +
        '<button type="button" class="btn-icon" data-move-up title="上移（调整流程顺序）">↑</button>' +
        '<button type="button" class="btn-icon" data-move-down title="下移（调整流程顺序）">↓</button>' +
        '<button type="button" class="btn-icon btn-icon-danger" data-del-ss title="删除工段">✕</button>' +
        '</span>' +
        '</div>' +
        '<input type="range" min="0" max="100" step="5" value="' + Number(s.progress || 0) + '" data-ss-range>' +
        '<div class="prog-row"><span class="prog-val" data-ss-val>' + Number(s.progress || 0) + '%</span>' +
        '<span class="badge ' + info.cls + '" data-ss-badge>' + UI.esc(info.label) + '</span>' +
        '<span style="font-size:12px;color:var(--muted)">完成度自动定状态（0% 等待材料 · 100% 生产完成）</span></div>' +
        '<input type="text" data-ss-note placeholder="备注" value="' + UI.esc(s.note) + '">' +
        '<div class="ss-actions">' +
        '<button type="button" class="btn btn-sm" data-save-ss>保存</button>' +
        '<label class="btn btn-ghost btn-sm upload-label">📷 上传图片' +
        '<input type="file" accept="image/*" multiple data-file></label>' +
        '</div>' +
        UI.thumbStrip(u.id, s.code, s.images, { admin: true }) +
        '</div>';
    }
    html += '</div>';
    html += '<div class="add-ss-row">' +
      '<input type="text" id="new-ss-name" placeholder="新工段名称（不同流程可增删工段并排序）" maxlength="20">' +
      '<button type="button" class="btn" id="new-ss-add">＋ 添加工段</button>' +
      '</div>';
    return html;
  }

  function bindSsCards(u) {
    var v = document.getElementById('view');
    var cards = v.querySelectorAll('.ss-edit-card');
    for (var i = 0; i < cards.length; i++) bindSsCard(cards[i], u);

    var addBtn = document.getElementById('new-ss-add');
    addBtn.addEventListener('click', function () {
      var input = document.getElementById('new-ss-name');
      var name = input.value.trim();
      if (!name) { UI.toast('请输入工段名称', 'error'); return; }
      var res = STORE.addSubsystem(u.id, name, actor());
      if (res.error) { UI.toast(res.error, 'error'); return; }
      UI.toast('已添加工段「' + name + '」', 'ok');
      renderMachineDetail(u.id, true);
    });
    document.getElementById('new-ss-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); }
    });
  }

  function bindSsCard(card, u) {
    var code = card.getAttribute('data-code');
    var range = card.querySelector('[data-ss-range]');
    var val = card.querySelector('[data-ss-val]');
    var badge = card.querySelector('[data-ss-badge]');

    /* 拖动滑杆：完成度实时显示，状态徽章自动跟随（FR-A11 三态派生） */
    range.addEventListener('input', function () {
      var info = C.statusInfo(C.ssStatusOf(Number(this.value) || 0));
      val.textContent = this.value + '%';
      badge.textContent = info.label;
      badge.className = 'badge ' + info.cls;
    });

    /* 保存完成度/备注（状态由完成度自动判定，无独立状态选择） */
    card.querySelector('[data-save-ss]').addEventListener('click', function () {
      var progress = Number(range.value) || 0;
      var note = card.querySelector('[data-ss-note]').value;
      var res = STORE.updateSubsystem(u.id, code, { progress: progress, note: note }, actor());
      if (res.error) { UI.toast(res.error, 'error'); return; }
      if (res.unchanged) { UI.toast('内容未变化'); return; }
      UI.toast('已保存', 'ok');
      renderMachineDetail(u.id, true);
    });

    /* 改名（内联编辑） */
    card.querySelector('[data-rename]').addEventListener('click', function () {
      if (card.querySelector('.rename-input')) return;
      var nameSpan = card.querySelector('.ss-name');
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'rename-input';
      input.value = nameSpan.textContent;
      input.maxLength = 20;
      var ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'btn-icon'; ok.textContent = '✓'; ok.title = '确认改名';
      var cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'btn-icon btn-icon-danger'; cancel.textContent = '✕'; cancel.title = '取消';
      nameSpan.style.display = 'none';
      nameSpan.parentNode.insertBefore(input, nameSpan);
      nameSpan.parentNode.insertBefore(ok, nameSpan);
      nameSpan.parentNode.insertBefore(cancel, nameSpan);
      input.focus();
      input.select();
      function done() { renderMachineDetail(u.id, true); }
      ok.addEventListener('click', function () {
        var res = STORE.renameSubsystem(u.id, code, input.value, actor());
        if (res.error) { UI.toast(res.error, 'error'); done(); return; }
        if (res.unchanged) { done(); return; }
        UI.toast('已改名', 'ok');
        done();
      });
      cancel.addEventListener('click', done);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
        if (e.key === 'Escape') { e.preventDefault(); done(); }
      });
    });

    /* 排序 */
    card.querySelector('[data-move-up]').addEventListener('click', function () {
      var res = STORE.moveSubsystem(u.id, code, -1, actor());
      if (res.error) { UI.toast(res.error, 'error'); return; }
      renderMachineDetail(u.id, true);
    });
    card.querySelector('[data-move-down]').addEventListener('click', function () {
      var res = STORE.moveSubsystem(u.id, code, 1, actor());
      if (res.error) { UI.toast(res.error, 'error'); return; }
      renderMachineDetail(u.id, true);
    });

    /* 删除工段 */
    card.querySelector('[data-del-ss]').addEventListener('click', function () {
      var name = card.querySelector('.ss-name').textContent;
      if (!window.confirm('删除工段「' + name + '」？其进度、备注与现场图片将一并移除。')) return;
      var res = STORE.removeSubsystem(u.id, code, actor());
      if (res.error) { UI.toast(res.error, 'error'); return; }
      UI.toast('工段已删除', 'ok');
      renderMachineDetail(u.id, true);
    });

    /* 上传图片：压缩 → 落库（角标记当前滑杆完成度） */
    card.querySelector('[data-file]').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = '';
      if (!files.length) return;
      var cur = STORE.getMachine(u.id);
      var ss = cur ? cur.subsystems.filter(function (x) { return x.code === code; })[0] : null;
      var existing = (ss && ss.images) ? ss.images.length : 0;
      var remaining = STORE.MAX_SS_IMAGES - existing;
      if (remaining <= 0) { UI.toast('该工段图片已达上限 ' + STORE.MAX_SS_IMAGES + ' 张', 'error'); return; }
      if (files.length > remaining) {
        UI.toast('超出上限，仅上传前 ' + remaining + ' 张', 'warn');
        files = files.slice(0, remaining);
      }
      /* 上传即保存（修复"上传后进度归零"）：先捕获卡片当前完成度/备注——落库与
       * 图片角标共用同一变量；压缩成功后先持久化（状态由完成度自动判定），再附图片。
       * 否则整页重渲染后，未保存的滑杆值会被库内旧值覆盖回显。 */
      var cardProgress = Number(range.value) || 0;
      var cardNote = card.querySelector('[data-ss-note]').value;
      UI.toast('正在处理 ' + files.length + ' 张图片…');
      var jobs = files.map(function (f) {
        return compressImage(f, IMG_MAX_SIDE, IMG_QUALITY).then(function (dataUrl) {
          return { dataUrl: dataUrl, progress: cardProgress, name: f.name };
        });
      });
      Promise.all(jobs).then(function (imgs) {
        var resCard = STORE.updateSubsystem(u.id, code, { progress: cardProgress, note: cardNote }, actor());
        if (resCard.error) { UI.toast(resCard.error, 'error'); return; }
        var res = STORE.addSubsystemImages(u.id, code, imgs, actor());
        if (res.error) { UI.toast(res.error, 'error'); return; }
        UI.toast(resCard.unchanged
          ? '已上传 ' + imgs.length + ' 张图片（完成度 ' + cardProgress + '%）'
          : '已上传 ' + imgs.length + ' 张图片，工段完成度已保存为 ' + cardProgress + '%', 'ok');
        renderMachineDetail(u.id, true);
      }).catch(function (err) {
        UI.toast('图片处理失败：' + (err && err.message ? err.message : '未知错误'), 'error');
      });
    });
  }

  /* ================= FR-A12 订单详情：每台设备一张进度卡 ================= */
  function renderOrderDetail(id) {
    view = 'order';
    setNavActive();
    var o = STORE.getOrder(id);
    if (!o) {
      UI.toast('未找到订单：' + id, 'error');
      view = 'list';
      renderList();
      return;
    }
    orderId = id;
    var sum = STORE.orderSummary(o);
    var v = document.getElementById('view');
    var cards = '';
    for (var i = 0; i < sum.machines.length; i++) {
      var m = sum.machines[i];
      var stageKey = C.currentStageOf(m);
      var chip = C.allStagesDone(m)
        ? '<span class="badge st-done">全部完成</span>'
        : UI.statusBadge(m.stages[stageKey].status) +
          ' <span class="chip">' + UI.esc(C.STAGES[C.stageIndex(stageKey)].label) + '</span>';
      cards += '<div class="card machine-card">' +
        '<div class="card-title machine-card-title"><span class="machine-id">' + UI.esc(m.id) + '</span>' + chip +
        '<button class="btn btn-sm" data-mmachine="' + UI.esc(m.id) + '" style="margin-left:auto">管理此设备（阶段 / 工段 / 图片）</button></div>' +
        UI.stageStepper(m) +
        '<div class="overall" style="margin-top:10px"><span class="overall-k">该设备整体完成度</span>' +
        UI.progressBar(C.computeOverallProgress(m)) + '</div>' +
        '</div>';
    }
    v.innerHTML =
      '<div class="card">' +
      UI.orderHeadCard(o, sum.progress, { back: true, machineIds: sum.machines.map(function (mm) { return mm.id; }) }) +
      '</div>' +
      '<h2 class="section-title">各设备进度（' + sum.machines.length + ' 台，按设备编号分别推进）</h2>' +
      cards +
      '<div class="card">' +
      '<div class="card-title">订单动态 <span class="chip">全部设备合并 · 每条已标注设备编号</span></div>' +
      UI.logList(STORE.orderLogs(o.id), 50) +
      '</div>';

    v.querySelector('[data-action="back-order"]').addEventListener('click', function () {
      view = 'list';
      renderList();
    });
    var mbtns = v.querySelectorAll('[data-mmachine]');
    for (var k = 0; k < mbtns.length; k++) {
      mbtns[k].addEventListener('click', function () { openMachine(this.getAttribute('data-mmachine')); });
    }
    var idChips = v.querySelectorAll('.unit-ids-row [data-mid]');
    for (var c = 0; c < idChips.length; c++) {
      idChips[c].addEventListener('click', function () { openMachine(this.getAttribute('data-mid')); });
    }
    window.scrollTo(0, 0);
  }

  /* ================= FR-A5 追加动态 + 设备管理页（订单内单台） ================= */
  function renderMachineDetail(id, keepScroll) {
    view = 'machine';
    setNavActive();
    var u = STORE.getMachine(id);
    if (!u) {
      UI.toast('未找到设备：' + id, 'error');
      view = 'list';
      renderList();
      return;
    }
    machineId = id;
    var o = STORE.getOrderOf(u);
    if (!o) {
      UI.toast('未找到所属订单', 'error');
      view = 'list';
      renderList();
      return;
    }
    var sibs = STORE.machinesOf(o.id).map(function (m) { return m.id; });
    var v = document.getElementById('view');
    var scrollY = window.scrollY;

    /* FR-A15（2026-09-20）：草稿保护——重渲染前暂存各卡未保存的编辑
     * （工段滑杆完成度/备注、阶段状态/备注），渲染绑定后回填，
     * 修复"保存 A 卡导致 B 卡草稿丢失"。上传流程已先落库，不受影响。 */
    var drafts = { ss: [], stages: [] };
    var prevCards = v.querySelectorAll('.ss-edit-card');
    for (var pi = 0; pi < prevCards.length; pi++) {
      var pc = prevCards[pi];
      var pr = pc.querySelector('[data-ss-range]');
      var pn = pc.querySelector('[data-ss-note]');
      drafts.ss.push({
        code: pc.getAttribute('data-code'),
        progress: pr ? pr.value : null,
        note: pn ? pn.value : null
      });
    }
    var prevStages = v.querySelectorAll('[data-stage-status]');
    for (var pj = 0; pj < prevStages.length; pj++) {
      var psel = prevStages[pj];
      var pkey = psel.getAttribute('data-stage-status');
      var pnote = v.querySelector('[data-stage-note="' + pkey + '"]');
      drafts.stages.push({ key: pkey, status: psel.value, note: pnote ? pnote.value : '' });
    }

    v.innerHTML =
      '<div class="card">' + UI.machineHeadCard(o, u, { back: true, siblingIds: sibs }) + UI.stageStepper(u) + '</div>' +

      '<div class="card">' +
      '<div class="card-title">阶段管理 <span class="chip">保存即写入动态，跳序仅提示不阻断</span></div>' +
      stageEditRows(u) +
      '</div>' +

      '<div class="card">' +
      '<div class="card-title">工段进度 <span class="chip">可增删工段 / 改名 / 排序，适配不同流程</span></div>' +
      ssEditCards(u) +
      '</div>' +

      '<div class="card">' +
      '<div class="card-title">追加动态</div>' +
      '<div class="field"><textarea id="log-text" placeholder="例如：客户来访验机 / 计划调整说明…（客户端可见，发布时自动标注设备编号）"></textarea></div>' +
      '<button class="btn" id="log-submit">提交动态</button>' +
      '<div style="margin-top:16px">' + UI.logList(u.logs, 50) + '</div>' +
      '</div>';

    v.querySelector('[data-action="back-order"]').addEventListener('click', function () {
      openOrder(o.id);
    });
    var sibChips = v.querySelectorAll('.unit-ids-row [data-mid]');
    for (var sc = 0; sc < sibChips.length; sc++) {
      sibChips[sc].addEventListener('click', function () { openMachine(this.getAttribute('data-mid')); });
    }

    bindStageRows(STORE.getMachine(id)); /* 绑定用最新数据对象 */
    bindSsCards(STORE.getMachine(id));
    UI.bindThumbs(v, function (unitId, ssCode, imgId) {
      if (!window.confirm('删除这张现场图片？')) return;
      var res = STORE.removeSubsystemImage(unitId, ssCode, imgId, actor());
      if (res.error) { UI.toast(res.error, 'error'); return; }
      UI.toast('图片已删除', 'ok');
      renderMachineDetail(unitId, true);
    });

    document.getElementById('log-submit').addEventListener('click', function () {
      var text = document.getElementById('log-text').value.trim();
      if (!text) { UI.toast('动态内容不能为空', 'error'); return; }
      var res = STORE.addLog(id, text, actor());
      if (res.error) { UI.toast(res.error, 'error'); return; }
      UI.toast('动态已发布', 'ok');
      renderMachineDetail(id, true);
    });

    /* FR-A15：回填未保存草稿（仅当与库内渲染值不同——即用户确有未保存输入） */
    for (var ri = 0; ri < drafts.ss.length; ri++) {
      var d = drafts.ss[ri];
      if (!d.code) continue;
      var rc = v.querySelector('.ss-edit-card[data-code="' + d.code + '"]');
      if (!rc) continue;
      var rr = rc.querySelector('[data-ss-range]');
      if (rr && d.progress !== null && d.progress !== rr.value) {
        rr.value = d.progress;
        var rv = rc.querySelector('[data-ss-val]');
        var rb = rc.querySelector('[data-ss-badge]');
        var rinfo = C.statusInfo(C.ssStatusOf(Number(d.progress) || 0));
        if (rv) rv.textContent = d.progress + '%';
        if (rb) { rb.textContent = rinfo.label; rb.className = 'badge ' + rinfo.cls; }
      }
      var rn = rc.querySelector('[data-ss-note]');
      if (rn && d.note !== null && d.note !== rn.value) rn.value = d.note;
    }
    for (var rk = 0; rk < drafts.stages.length; rk++) {
      var sd = drafts.stages[rk];
      var ssel = v.querySelector('[data-stage-status="' + sd.key + '"]');
      if (ssel && ssel.value !== sd.status) ssel.value = sd.status;
      var snote = v.querySelector('[data-stage-note="' + sd.key + '"]');
      if (snote && snote.value !== sd.note) snote.value = sd.note;
    }

    if (keepScroll) window.scrollTo(0, scrollY);
    else window.scrollTo(0, 0);
  }

  /* ================= FR-A10 操作人管理（仅主管）：注册 / 删除操作员 ================= */
  function renderOperators() {
    if (!isSupervisor()) {
      UI.toast('仅主管可管理操作人', 'error');
      view = 'list';
      renderList();
      return;
    }
    view = 'ops';
    setNavActive();
    var v = document.getElementById('view');
    var ops = STORE.listOperators();
    var rows = '';
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      var isSup = o.role === 'supervisor';
      rows += '<tr>' +
        '<td><b>' + UI.esc(o.name) + '</b>' + (o.name === actor() ? ' <span class="chip">当前登录</span>' : '') + '</td>' +
        '<td>' + UI.esc(C.ROLES[o.role] ? C.ROLES[o.role].label : o.role) + '</td>' +
        '<td>' + UI.esc(UI.fmtTime(o.createdAt)) + '</td>' +
        '<td>' + (isSup
          ? '<span style="color:var(--muted)">—</span>'
          : '<button type="button" class="btn btn-ghost btn-sm" data-del-op="' + UI.esc(o.name) + '">删除</button>') +
        '</td>' +
        '</tr>';
    }
    v.innerHTML =
      '<h1 class="page-title">操作人管理</h1>' +
      '<p class="page-sub">有且仅有一个主管（可增删操作员）；添加操作员即注册登录账号，动态署名使用该账号名。</p>' +
      '<div class="card" style="max-width:640px">' +
      '<div class="card-title">注册操作员</div>' +
      '<div class="form-row">' +
      '<div class="field"><label>账号名（≤20 字）</label><input type="text" id="op-name" maxlength="20" placeholder="如：赵工"></div>' +
      '<div class="field"><label>密码</label><input type="password" id="op-pass" placeholder="非空即可（M0 演示存储）"></div>' +
      '</div>' +
      '<button type="button" class="btn" id="op-add">＋ 注册操作员</button>' +
      '</div>' +
      '<div class="card">' +
      '<div class="card-title">账号列表 <span class="chip">共 ' + ops.length + ' 个账号 · 主管不可删除</span></div>' +
      '<div class="table-wrap"><table class="tbl">' +
      '<thead><tr><th>账号</th><th>角色</th><th>创建时间</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      '</div>';

    document.getElementById('op-add').addEventListener('click', function () {
      var name = document.getElementById('op-name').value;
      var pass = document.getElementById('op-pass').value;
      var res = STORE.addOperator(name, pass, actor());
      if (res.error) { UI.toast(res.error, 'error'); return; }
      UI.toast('已注册操作员「' + res.operator.name + '」，其可直接登录', 'ok');
      renderOperators();
    });
    document.getElementById('op-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('op-add').click(); }
    });
    var dels = v.querySelectorAll('[data-del-op]');
    for (var k = 0; k < dels.length; k++) {
      dels[k].addEventListener('click', function () {
        var name = this.getAttribute('data-del-op');
        if (!window.confirm('删除操作员账号「' + name + '」？删除后其将无法登录（历史动态署名保留）。')) return;
        var res = STORE.removeOperator(name, actor());
        if (res.error) { UI.toast(res.error, 'error'); return; }
        UI.toast('账号「' + name + '」已删除', 'ok');
        renderOperators();
      });
    }
  }

  /* ================= FR-A6 新建订单（FR-A12：数量 + 多设备编号） ================= */
  /* 扫描全部设备编号取最大序号，生成 count 个连续编号（FR-A12） */
  function suggestIds(category, count) {
    var info = C.categoryInfo(category);
    var year = String(new Date().getFullYear());
    var prefix = 'SX-' + info.prefix + '-' + year + '-';
    var max = 0;
    var units = STORE.listMachines();
    for (var i = 0; i < units.length; i++) {
      var id = units[i].id;
      if (id.indexOf(prefix) === 0) {
        var seq = parseInt(id.slice(prefix.length), 10);
        if (!isNaN(seq) && seq > max) max = seq;
      }
    }
    var out = [];
    for (var n = 1; n <= count; n++) {
      var seq2 = max + n;
      var pad = seq2 < 10 ? '00' : (seq2 < 100 ? '0' : '');
      out.push(prefix + pad + seq2);
    }
    return out;
  }

  function renderNew() {
    view = 'new';
    setNavActive();
    var v = document.getElementById('view');
    var catOpts = '';
    for (var i = 0; i < C.CATEGORIES.length; i++) {
      catOpts += '<option value="' + C.CATEGORIES[i].code + '">' + UI.esc(C.CATEGORIES[i].label) + '</option>';
    }
    v.innerHTML =
      '<h1 class="page-title">新建设备订单</h1>' +
      '<p class="page-sub">创建后四个阶段均为"未开始"，各工段为"等待材料"；一张订单可含设备数量与多个设备编号，任一编号均可供客户查询。</p>' +
      '<div class="card" style="max-width:640px">' +
      '<form id="new-form">' +
      '<div class="form-row">' +
      '<div class="field"><label>合同号</label><input type="text" id="new-contract" placeholder="如：HT-2026-060"></div>' +
      '<div class="field"><label>客户名称</label><input type="text" id="new-customer"></div>' +
      '</div>' +
      '<div class="form-row">' +
      '<div class="field"><label>机型</label><input type="text" id="new-model" placeholder="如：PVC板材挤出生产线"></div>' +
      '<div class="field"><label>品类</label><select id="new-cat">' + catOpts + '</select></div>' +
      '</div>' +
      '<div class="form-row">' +
      '<div class="field"><label>设备数量（台，1~99）</label><input type="number" id="new-qty" min="1" max="99" step="1" value="1"></div>' +
      '<div class="field"><label>计划交付日期</label><input type="date" id="new-delivery"></div>' +
      '</div>' +
      '<div class="field"><label>设备编号（可多个：逗号 / 顿号分隔；数量为 N 时可自动生成 N 个）</label>' +
      '<div class="search-row"><input type="text" id="new-ids" placeholder="SX-BC-2026-001, SX-BC-2026-002">' +
      '<button type="button" class="btn btn-ghost" id="new-id-auto" style="white-space:nowrap">自动编号</button></div>' +
      '</div>' +
      '<button class="btn" type="submit">创建订单</button>' +
      '</form></div>';

    var idsInput = document.getElementById('new-ids');
    var qtyInput = document.getElementById('new-qty');
    var autoFill = function (cat) {
      var n = parseInt(qtyInput.value, 10);
      if (isNaN(n) || n < 1) n = 1;
      idsInput.value = suggestIds(cat, n).join(', ');
    };
    idsInput.value = suggestIds('plate', 1).join(', ');
    document.getElementById('new-id-auto').addEventListener('click', function () {
      autoFill(document.getElementById('new-cat').value);
    });
    document.getElementById('new-cat').addEventListener('change', function () {
      autoFill(this.value);
    });
    document.getElementById('new-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var res = STORE.createOrder({
        unitIds: idsInput.value,
        quantity: qtyInput.value,
        model: document.getElementById('new-model').value,
        category: document.getElementById('new-cat').value,
        customer: document.getElementById('new-customer').value,
        contractNo: document.getElementById('new-contract').value,
        plannedDelivery: document.getElementById('new-delivery').value
      }, actor());
      if (res.error) { UI.toast(res.error, 'error'); return; }
      UI.toast('订单已创建：' + res.order.quantity + ' 台设备（' + res.order.id + '）', 'ok');
      openOrder(res.order.id);
    });
  }

  /* ================= 入口 ================= */
  function render() {
    if (currentOp()) { renderShell(); return; }
    sessionStorage.removeItem(SESSION_KEY); /* 清除失效会话（旧格式 / 账号已被删） */
    renderLogin();
  }
  logoutBtn.addEventListener('click', function () {
    sessionStorage.removeItem(SESSION_KEY);
    UI.toast('已退出登录');
    render();
  });

  /* Q10：跨标签页同步 —— 客户端/其他标签页改动时刷新；账号被别处删除则踢回登录 */
  window.addEventListener('storage', function (e) {
    if (e.key !== STORE.storageKey) return;
    STORE.refresh();
    if (!currentOp()) { render(); return; }
    renderView();
  });

  render();
})();
