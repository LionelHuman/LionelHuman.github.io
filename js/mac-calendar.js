/**
 * mac-calendar.js —— 仿 macOS「日历」渲染器
 *
 * 数据来自构建期生成的 window.__MAC_CAL__：
 *   years   覆盖的年份
 *   days    'YYYY-MM-DD' → [农历, 节气, 节日…]
 *   byDay   'YYYY-MM-DD' → [{t:标题, u:链接, c:分类序号}]
 *   cats    分类名数组（决定事件条颜色）
 *
 * 两个视图：
 *   年  4×3 十二个月迷你月历，有文章的日期带小圆点
 *   月  大月历，文章以彩色事件条显示，点日期看当天文章
 * 纯原生 JS，无依赖。
 */
(function () {
  'use strict';

  var D = window.__MAC_CAL__;
  if (!D || !D.days) return;

  // 打卡模式（{% mac_calendar mode:checkin %}）：点日期点亮成红色。
  // 记录存两份：
  //   本机  localStorage —— 离线也能看、打开就是红的
  //   远端  GitHub Gist —— 手机 / iPad / 电脑之间同步
  //
  // 同步冲突用一个日期一个数解决：数值 = 修改时间戳，正数表示"打了卡"，
  // 负数表示"取消了打卡"。合并时谁的 |时间戳| 大谁赢。
  // （不能用 0 当墓碑 —— 0 永远比真实时间戳小，取消就永远同步不过去。）
  var CHECKIN = !!D.checkin;
  var STORE_KEY = 'mac-cal-checkin:' + location.pathname;
  var SYNC_KEY = 'mac-cal-sync';
  var GIST_FILE = 'checkin.json';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var marks = loadMarks();
  var syncCfg = loadCfg();          // {id, user, token}，只有本机有 token
  var syncStatus = { state: 'off', msg: '', at: '' };
  var panelOpen = false;
  var pushTimer = null;
  var didInitialSync = false;

  // 无痕模式 / 禁用本地存储时 setItem 会抛错。探测一次，探测失败就在页面上明说，
  // 免得访客点了半天、刷新一下全没了还以为是网站坏了。
  var STORAGE_OK = (function () {
    try {
      localStorage.setItem('mac-cal-probe', '1');
      localStorage.removeItem('mac-cal-probe');
      return true;
    } catch (e) {
      return false;
    }
  })();

  function loadMarks() {
    var out = {};
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (Array.isArray(raw)) {
        // 老格式：["2026-10-12", ...] → 升级成带时间戳的写法
        raw.forEach(function (d) { if (DATE_RE.test(d)) out[d] = 1; });
      } else if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach(function (d) {
          if (DATE_RE.test(d)) out[d] = +raw[d] || 0;
        });
      }
    } catch (e) { /* 隐私模式 / 数据损坏：当成空记录 */ }
    return out;
  }

  function saveMarks() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(marks));
    } catch (e) { /* 存不进去也不影响本次浏览 */ }
  }

  /** 真正"打过卡"的日期（>0；0 是取消打卡留下的墓碑） */
  function activeKeys() {
    return Object.keys(marks).filter(function (d) { return marks[d] > 0; }).sort();
  }

  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveCfg() {
    try {
      if (syncCfg && (syncCfg.id || syncCfg.token)) localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));
      else localStorage.removeItem(SYNC_KEY);
    } catch (e) { /* 忽略 */ }
  }

  /** 页面里写死的 Gist（来自 {% mac_calendar gist:... %}）+ 本机配置，合并成实际使用的配置 */
  function pageGist() {
    var el = document.getElementById('mac-cal');
    var raw = (el && el.getAttribute('data-gist')) || D.gist || '';
    return parseGistInput(raw);
  }
  function effectiveCfg() {
    var p = pageGist() || {};
    var c = syncCfg || {};
    return {
      id: c.id || p.id || '',
      user: c.user || p.user || '',
      token: c.token || '',
    };
  }
  function parseGistInput(v) {
    v = String(v || '').trim();
    if (!v) return null;
    // 完整地址：https://gist.github.com/用户名/ID
    var m = v.match(/gist\.github(?:usercontent)?\.com\/(?:([^\/]+)\/)?([0-9a-f]{6,})/i);
    if (m) return { user: m[1] || '', id: m[2] };
    // 简写：用户名/ID
    m = v.match(/^([A-Za-z0-9-]+)\/([0-9a-f]{6,})$/);
    if (m) return { user: m[1], id: m[2] };
    // 只有 ID
    if (/^[0-9a-f]{6,}$/i.test(v)) return { user: '', id: v };
    return null;
  }

  // ── GitHub API / 读取远端 ──────────────────────────────
  function api(method, path, body, cb) {
    var cfg = effectiveCfg();
    if (!cfg.token) return cb(new Error('没有 token，无法写入'));
    var opt = {
      method: method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + cfg.token,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };
    if (body) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    fetch('https://api.github.com' + path, opt).then(function (r) {
      return r.text().then(function (t) {
        var json = null;
        try { json = JSON.parse(t); } catch (e) { /* 非 JSON */ }
        if (!r.ok) return cb(new Error((json && json.message) || ('HTTP ' + r.status)));
        cb(null, json);
      });
    }).catch(function (e) { cb(e); });
  }

  function parseGistFile(data) {
    try {
      var f = data && data.files && data.files[GIST_FILE];
      if (!f || !f.content) return null;
      return JSON.parse(f.content);
    } catch (e) { return null; }
  }

  /** 读远端。有 token 走 API（最新）；访客没 token 走 raw（公开 Gist，CDN 可能滞后几分钟） */
  function readRemote(cb) {
    var cfg = effectiveCfg();
    if (!cfg.id) return cb(null, null);
    if (cfg.token) {
      return api('GET', '/gists/' + cfg.id, null, function (err, data) {
        if (err) return cb(err);
        cb(null, parseGistFile(data));
      });
    }
    var tryApi = function () {
      fetch('https://api.github.com/gists/' + cfg.id, { headers: { Accept: 'application/vnd.github+json' } })
        .then(function (r) { return r.json(); })
        .then(function (d) { cb(null, parseGistFile(d)); })
        .catch(function (e) { cb(e); });
    };
    if (!cfg.user) return tryApi();
    var url = 'https://gist.githubusercontent.com/' + cfg.user + '/' + cfg.id + '/raw/' + GIST_FILE +
      '?t=' + Date.now();
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) { cb(null, d); }).catch(tryApi);
  }

  /** 远端某页的记录合并进本机：逐条取 |时间戳| 更大的那个 */
  function mergeMarks(remote) {
    if (!remote) return false;
    var changed = false;
    Object.keys(remote).forEach(function (d) {
      if (!DATE_RE.test(d)) return;
      var rv = +remote[d] || 0;
      if (Math.abs(rv) > Math.abs(marks[d] || 0)) { marks[d] = rv; changed = true; }
    });
    return changed;
  }

  function setStatus(state, msg) {
    syncStatus.state = state;
    syncStatus.msg = msg || '';
    if (state === 'ok' || state === 'readonly') {
      var d = new Date();
      syncStatus.at = pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
  }

  /** 拉远端 → 合并 → （有 token 就）推回本机较新的记录 */
  function syncNow() {
    var cfg = effectiveCfg();
    if (!cfg.id) { setStatus('off'); render(); return; }
    setStatus('syncing');
    render();
    readRemote(function (err, remote) {
      if (err) { setStatus('error', err.message); render(); return; }
      var pages = (remote && remote.pages) || {};
      mergeMarks(pages[location.pathname]);
      saveMarks();
      if (!cfg.token) { setStatus('readonly'); render(); return; }
      pushRemote(pages, function (err2) {
        if (err2) setStatus('error', err2.message); else setStatus('ok');
        render();
      });
    });
  }

  function pushRemote(pages, cb) {
    var mine = pages[location.pathname] || {};
    var merged = {};
    Object.keys(mine).forEach(function (d) { if (DATE_RE.test(d)) merged[d] = +mine[d] || 0; });
    Object.keys(marks).forEach(function (d) {
      if (Math.abs(marks[d] || 0) > Math.abs(merged[d] || 0)) merged[d] = marks[d];
    });
    marks = merged;               // 合并结果就是新的本机状态（幂等）
    saveMarks();

    pages[location.pathname] = merged;
    var payload = { v: 1, updated: new Date().toISOString(), pages: pages };
    var files = {};
    files[GIST_FILE] = { content: JSON.stringify(payload, null, 2) };
    api('PATCH', '/gists/' + effectiveCfg().id, { files: files }, function (err) {
      cb(err);
    });
  }

  /** 打卡后延迟推送，避免连点几下打一串请求 */
  function schedulePush() {
    var cfg = effectiveCfg();
    if (!cfg.id || !cfg.token) { render(); return; }
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushTimer = null; syncNow(); }, 800);
  }

  function panelValues() {
    var g = document.getElementById('mac-sync-gist');
    var t = document.getElementById('mac-sync-token');
    return {
      raw: g ? g.value.trim() : '',
      parsed: g ? parseGistInput(g.value) : null,
      token: t ? t.value.trim() : '',
    };
  }

  /** 手动填 Gist 这条路：先把地址填对，再落地配置 */
  function savePanel() {
    var v = panelValues();
    if (!v.parsed) { setStatus('error', v.raw ? '这个 Gist 地址看不懂' : '请先点开下面填 Gist 地址'); render(); return; }
    if (!v.token) { setStatus('error', '还没填 Token'); render(); return; }
    syncCfg = { id: v.parsed.id, user: v.parsed.user || '', token: v.token };
    saveCfg();
    syncNow();
  }

  function createGist() {
    var v = panelValues();
    var token = v.token || (syncCfg && syncCfg.token) || '';
    if (!token) { setStatus('error', '请先填 Token，再点这个按钮'); render(); return; }
    syncCfg = { id: '', user: '', token: token };
    saveCfg();
    setStatus('syncing', '正在创建 Gist…');
    render();
    var pages = {};
    pages[location.pathname] = marks;
    var payload = { v: 1, updated: new Date().toISOString(), pages: pages };
    var files = {};
    files[GIST_FILE] = { content: JSON.stringify(payload, null, 2) };
    api('POST', '/gists', {
      description: '博客打卡数据（mac-calendar）',
      public: true,
      files: files,
    }, function (err, data) {
      if (err) { setStatus('error', err.message); render(); return; }
      syncCfg = {
        id: data.id,
        user: (data.owner && data.owner.login) || '',
        token: token,
      };
      saveCfg();
      setStatus('ok');
      panelOpen = true;
      render();
    });
  }

  var PALETTE = [
    '#e5484d', '#f5a623', '#f7d154', '#34c759', '#32ade6',
    '#3b82f6', '#af52de', '#ff2d55', '#a2845e', '#8e8e93',
  ];
  var MONTH_CN = ['一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月'];
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  var WEEK_LONG = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var JIEQI = /^(立春|雨水|惊蛰|春分|清明|谷雨|立夏|小满|芒种|夏至|小暑|大暑|立秋|处暑|白露|秋分|寒露|霜降|立冬|小雪|大雪|冬至|小寒|大寒)$/;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function key(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function closest(el, sel) {
    while (el && el.nodeType === 1) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentNode;
    }
    return null;
  }
  function colorOf(i) { return PALETTE[(i || 0) % PALETTE.length]; }
  /** 浅色事件条（黄/绿）用深色文字，保证对比度 */
  function fgOf(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#4a3b00' : '#ffffff';
  }
  function infoOf(k) { return D.days[k] || []; }
  function eventsOf(k) { return D.byDay[k] || []; }
  /** 打卡模式不显示文章事件，画面留给红色打卡格 */
  function evsOf(k) { return CHECKIN ? [] : eventsOf(k); }
  function hasYear(y) { return D.years.indexOf(y) >= 0; }

  var NOW = new Date();
  var TODAY = key(NOW.getFullYear(), NOW.getMonth() + 1, NOW.getDate());

  var state = { view: 'month', y: NOW.getFullYear(), m: NOW.getMonth() + 1, sel: TODAY };
  if (!hasYear(state.y)) {
    var last = D.events.length ? D.events[D.events.length - 1].d : null;
    var ly = last ? +last.slice(0, 4) : D.years[D.years.length - 1];
    state.y = hasYear(ly) ? ly : D.years[D.years.length - 1];
    state.m = last ? +last.slice(5, 7) : 1;
    state.sel = last;
  }

  /** 某月按周日起始补齐成 6×7 的日期格 */
  function monthCells(y, m) {
    var lead = new Date(y, m - 1, 1).getDay();
    var last = new Date(y, m, 0).getDate();
    var cells = [];
    var i, d;
    for (i = lead; i > 0; i--) {
      d = new Date(y, m - 1, 1 - i);
      cells.push({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), out: true });
    }
    for (d = 1; d <= last; d++) cells.push({ y: y, m: m, d: d, out: false });
    while (cells.length < 42) {
      var t = cells[cells.length - 1];
      var n = new Date(t.y, t.m - 1, t.d + 1);
      cells.push({ y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate(), out: true });
    }
    return cells;
  }

  // ── 年视图 ────────────────────────────────────────────
  function yearHTML() {
    var h = '<div class="mac-cal__year">';
    for (var m = 1; m <= 12; m++) {
      h += '<section class="mac-cal__mcard" data-month="' + m + '">';
      h += '<h4 class="mac-cal__mname">' + MONTH_CN[m - 1] + '</h4>';
      h += '<div class="mac-cal__mgrid">';
      for (var w = 0; w < 7; w++) {
        h += '<span class="mac-cal__mdow' + (w === 0 || w === 6 ? ' is-weekend' : '') + '">' + WEEK[w] + '</span>';
      }
      monthCells(state.y, m).forEach(function (c) {
        var k = key(c.y, c.m, c.d);
        var cls = 'mac-cal__mcell';
        if (c.out) cls += ' is-out';
        if (k === TODAY) cls += ' is-today';
        if (evsOf(k).length) cls += ' has-ev';
        if (marks[k] > 0) cls += ' is-mark';
        h += '<span class="' + cls + '" data-date="' + k + '">' + c.d + '</span>';
      });
      h += '</div></section>';
    }
    return h + '</div>';
  }

  // ── 月视图 ────────────────────────────────────────────
  function cellHTML(c) {
    var k = key(c.y, c.m, c.d);
    var info = infoOf(k);
    var evs = evsOf(k);
    var cls = 'mac-cal__cell';
    if (k === TODAY) cls += ' is-today';
    if (k === state.sel) cls += ' is-sel';
    if (marks[k] > 0) cls += ' is-mark';

    var h = '<div class="' + cls + '" data-date="' + k + '">';
    h += '<div class="mac-cal__ctop">';
    h += '<span class="mac-cal__clunar">' + esc(info[0] || '') + '</span>';
    h += '<span class="mac-cal__cnum">' + c.d + '</span>';
    h += '</div>';

    var tags = info.slice(1);
    if (tags.length) {
      h += '<div class="mac-cal__ctags">' + tags.map(function (t) {
        var c2 = 'mac-cal__tag';
        if (t === '休') c2 += ' is-off';
        else if (t === '班') c2 += ' is-work';
        else if (JIEQI.test(t)) c2 += ' is-jieqi';
        else c2 += ' is-fest';
        return '<span class="' + c2 + '">' + esc(t) + '</span>';
      }).join('') + '</div>';
    }

    if (evs.length) {
      h += '<div class="mac-cal__cevs">' + evs.map(function (e) {
        var col = colorOf(e.c);
        return '<a class="mac-cal__ev" style="--ev:' + col + ';--ev-fg:' + fgOf(col) + '" href="' + esc(e.u) +
          '" title="' + esc(e.t) + '">' + esc(e.t) + '</a>';
      }).join('') + '</div>';
    }
    return h + '</div>';
  }

  function detailHTML() {
    if (!state.sel) return '';
    var p = state.sel.split('-');
    var evs = eventsOf(state.sel);
    var info = infoOf(state.sel);
    var date = new Date(+p[0], +p[1] - 1, +p[2]);

    var h = '<div class="mac-cal__detail">';
    h += '<div class="mac-cal__dh"><strong>' + (+p[1]) + ' 月 ' + (+p[2]) + ' 日 ' + WEEK_LONG[date.getDay()] + '</strong>';
    if (info.length) h += '<span class="mac-cal__dinfo">' + esc(info.join(' · ')) + '</span>';
    h += '</div>';
    if (evs.length) {
      h += '<ul class="mac-cal__dlist">' + evs.map(function (e) {
        return '<li><i class="mac-cal__dot" style="--ev:' + colorOf(e.c) + '"></i>' +
          '<a href="' + esc(e.u) + '">' + esc(e.t) + '</a>' +
          '<span class="mac-cal__dcat">' + esc(D.cats[e.c] || '') + '</span></li>';
      }).join('') + '</ul>';
    } else {
      h += '<div class="mac-cal__dempty">这天没有文章</div>';
    }
    return h + '</div>';
  }

  // ── 打卡模式的底部统计条 ──────────────────────────────
  function checkinStats() {
    var keys = activeKeys();
    var prefix = state.y + '-' + pad(state.m);
    var yearPrefix = state.y + '-';
    var inMonth = 0;
    var inYear = 0;
    keys.forEach(function (k) {
      if (k.slice(0, 7) === prefix) inMonth++;
      if (k.slice(0, 5) === yearPrefix) inYear++;
    });

    // 当前连续天数：从今天往前数；今天还没打卡不算断，从昨天起算
    var streak = 0;
    var cur = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
    if (!(marks[key(cur.getFullYear(), cur.getMonth() + 1, cur.getDate())] > 0)) {
      cur.setDate(cur.getDate() - 1);
    }
    while (marks[key(cur.getFullYear(), cur.getMonth() + 1, cur.getDate())] > 0) {
      streak++;
      cur.setDate(cur.getDate() - 1);
    }
    return { inMonth: inMonth, inYear: inYear, total: keys.length, streak: streak };
  }

  /** 同步状态小标签：点一下打开设置面板 */
  function syncBadgeHTML() {
    var cfg = effectiveCfg();
    var cls = 'mac-cal__sync';
    var label;
    // 出错优先于一切 —— 否则"没配 Gist"会把错误信息盖掉，看起来像什么都没发生
    if (syncStatus.state === 'error') { label = '同步失败'; cls += ' is-error'; }
    else if (!cfg.id) label = '仅本机';
    else if (syncStatus.state === 'syncing') label = '同步中…';
    else if (syncStatus.state === 'ok') label = '已同步 ' + syncStatus.at;
    else if (!cfg.token) label = '已同步（只读）';
    else label = '已同步';

    var dotCls = syncStatus.state === 'error' ? 'is-error' : (!cfg.id ? 'is-off' : 'is-on');
    return '<button type="button" class="' + cls + '" data-sync="panel" title="' +
      esc(syncStatus.msg || (cfg.id ? '点这里修改同步设置' : '数据现在只在这台设备上；点这里配置 Gist 同步')) + '">' +
      '<i class="' + dotCls + '"></i>' + esc(label) + '</button>';
  }

  function syncPanelHTML() {
    var cfg = effectiveCfg();
    var shown = cfg.id ? (cfg.user ? cfg.user + '/' + cfg.id : cfg.id) : '';
    var has = !!cfg.id;

    var h = '<div class="mac-cal__syncbox">';

    // ① Token —— 唯一必须先准备的东西
    h += '<div class="mac-cal__syncstep"><b>①</b> 先去 ' +
      '<a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=blog-checkin" ' +
      'target="_blank" rel="noopener">建一个 token</a>（只勾 <code>gist</code>，别的都不用勾），' +
      '生成后复制，粘到下面：</div>';
    h += '<div class="mac-cal__syncrow"><span class="k">Token</span>' +
      '<input class="mac-cal__input" id="mac-sync-token" type="password" ' +
      'placeholder="ghp_… 或 github_pat_…" value="' + esc(cfg.token || '') + '"></div>';

    // ② Gist —— 没有的话不用管，按钮替你建
    if (!has) {
      h += '<div class="mac-cal__syncstep"><b>②</b> ' +
        '<b>Gist 你不用自己建</b>，点这个按钮我帮你建一个：</div>';
      h += '<div class="mac-cal__syncbtns">' +
        '<button type="button" class="mac-cal__btn mac-cal__btn--primary" data-sync="create">' +
        '帮我建一个 Gist</button></div>';
    } else {
      h += '<div class="mac-cal__syncstep"><b>②</b> 已连接到 Gist <code>' + esc(shown) + '</code></div>';
      h += '<div class="mac-cal__syncbtns">' +
        '<button type="button" class="mac-cal__btn mac-cal__btn--primary" data-sync="save">保存并同步</button>' +
        '<button type="button" class="mac-cal__btn" data-sync="pull">立即拉取</button>' +
        '<button type="button" class="mac-cal__btn" data-sync="disconnect">断开同步</button>' +
        '</div>';
    }

    // 已经有了 / 想换一个，才需要手填
    h += '<details class="mac-cal__syncdetails">' +
      '<summary>' + (has ? '换成别的 Gist' : '我已经有 Gist 了') + '</summary>' +
      '<div class="mac-cal__syncrow"><span class="k">Gist</span>' +
      '<input class="mac-cal__input" id="mac-sync-gist" ' +
      'placeholder="https://gist.github.com/用户名/xxxxxxx 或只填 ID" value="' + esc(shown) + '"></div>' +
      '<div class="mac-cal__syncbtns">' +
      '<button type="button" class="mac-cal__btn" data-sync="save">保存并同步</button>' +
      '</div></details>';

    h += '<p class="mac-cal__synctip">Token 只保存在<b>这台设备</b>的浏览器里 —— 不上传、不出现在网页源码里，别人拿不到。' +
      (has ? '<br>想让访客也看到你的进度：把这串 <code>gist:' + esc(shown) +
        '</code> 加进文章里的 <code>{% mac_calendar mode:checkin %}</code>，重新发布。' : '') +
      '</p></div>';
    return h;
  }

  function checkinHTML() {
    var s = checkinStats();
    var thisMonth = state.y === NOW.getFullYear() && state.m === NOW.getMonth() + 1;
    var monthLabel = thisMonth ? '本月' : '该月';
    var h = '<div class="mac-cal__checkin">';
    h += '<div class="mac-cal__stats">';
    h += '<span class="mac-cal__stat" title="当前查看的 ' + state.m + ' 月里，打卡的天数">' +
      monthLabel + ' <b>' + s.inMonth + '</b> 天</span>';
    h += '<span class="mac-cal__stat" title="从开始打卡到今天，一共打了多少天">累计 <b>' + s.total + '</b> 天</span>';
    h += '<span class="mac-cal__stat" title="从今天往前连着打卡的天数；今天还没打卡不算断，从昨天算起">当前连续 <b>' +
      s.streak + '</b> 天</span>';
    h += '</div>';
    h += '<div class="mac-cal__acts">';
    h += syncBadgeHTML();
    h += '<button type="button" class="mac-cal__btn mac-cal__btn--primary" data-act="png" title="把当前视图导出成 PNG 图片">导出图片</button>';
    h += '<button type="button" class="mac-cal__btn" data-act="json" title="导出 JSON 数据，用于恢复 / 迁移">备份数据</button>';
    h += '<button type="button" class="mac-cal__btn" data-act="clear" title="删除这个页面的全部打卡记录">清空记录</button>';
    h += '</div></div>';

    if (syncStatus.state === 'error' && syncStatus.msg) {
      h += '<div class="mac-cal__warn">⚠️ 同步失败：' + esc(syncStatus.msg) + '</div>';
    }
    if (!effectiveCfg().id) {
      h += '<div class="mac-cal__note">数据现在只存在这台设备上（点日期就能打卡）。' +
        '想手机 / iPad / 电脑同步，点上面的「仅本机」配置 Gist。</div>';
    }
    if (panelOpen) h += syncPanelHTML();
    if (!STORAGE_OK) {
      h += '<div class="mac-cal__warn">⚠️ 当前浏览器不允许本地存储（无痕模式，或隐私设置里禁用了），' +
        '打卡只在这次浏览里有效，刷新就没了。</div>';
    }
    return h;
  }

  function monthHTML() {
    var cells = monthCells(state.y, state.m);
    var h = '<div class="mac-cal__month">';
    h += '<div class="mac-cal__whead">';
    for (var w = 0; w < 7; w++) {
      h += '<span' + (w === 0 || w === 6 ? ' class="is-weekend"' : '') + '>' + WEEK_LONG[w] + '</span>';
    }
    h += '</div><div class="mac-cal__weeks">';
    for (var r = 0; r < 6; r++) {
      h += '<div class="mac-cal__week">';
      for (var i = 0; i < 7; i++) h += cellHTML(cells[r * 7 + i]);
      h += '</div>';
    }
    h += '</div></div>';
    return h + (CHECKIN ? '' : detailHTML());
  }

  function legendHTML() {
    return '<div class="mac-cal__legend">' + D.cats.map(function (n, i) {
      return '<span class="mac-cal__lg"><i style="--ev:' + colorOf(i) + '"></i>' + esc(n) + '</span>';
    }).join('') + '</div>';
  }

  // ── URL 深链：#year-2026 / #2026-10 / #2026-10-12 ─────
  function applyHash() {
    if (CHECKIN) return; // 嵌在文章里，文章 URL 上的 # 锚点不能被当成视图参数
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return;
    var mYear = h.match(/^year-(\d{4})$/);
    if (mYear) { state.view = 'year'; state.y = +mYear[1]; return; }
    var mDay = h.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (mDay) { state.view = 'month'; state.y = +mDay[1]; state.m = +mDay[2]; state.sel = h; return; }
    var mMon = h.match(/^(\d{4})-(\d{2})$/);
    if (mMon) { state.view = 'month'; state.y = +mMon[1]; state.m = +mMon[2]; state.sel = null; }
  }

  function syncHash() {
    // 打卡模式嵌在文章里，改 URL 会污染文章地址，直接不动
    if (CHECKIN) return;
    var h = state.view === 'year' ? ('year-' + state.y) : (state.y + '-' + pad(state.m));
    if (location.hash !== '#' + h && window.history && history.replaceState) {
      history.replaceState(null, '', '#' + h);
    }
  }

  // ── 渲染 ──────────────────────────────────────────────
  function render() {
    var root = document.getElementById('mac-cal');
    if (!root) return;
    var title = state.view === 'year' ? state.y + ' 年' : state.y + ' 年 ' + state.m + ' 月';

    var h = '<div class="mac-cal__bar">';
    h += '<div class="mac-cal__title">' + title + '</div>';
    h += '<div class="mac-cal__ctrl">';
    h += '<div class="mac-cal__seg">';
    h += '<button type="button" data-view="month" class="' + (state.view === 'month' ? 'is-on' : '') + '">月</button>';
    h += '<button type="button" data-view="year" class="' + (state.view === 'year' ? 'is-on' : '') + '">年</button>';
    h += '</div>';
    h += '<button type="button" class="mac-cal__btn" data-nav="prev" aria-label="上一个">‹</button>';
    h += '<button type="button" class="mac-cal__btn mac-cal__btn--today" data-nav="today">今天</button>';
    h += '<button type="button" class="mac-cal__btn" data-nav="next" aria-label="下一个">›</button>';
    h += '</div></div>';

    h += '<div class="mac-cal__body">' + (state.view === 'year' ? yearHTML() : monthHTML()) + '</div>';
    // 打卡模式的统计条在年/月视图下都要有（不然年视图里没法导出）
    if (CHECKIN) h += checkinHTML();
    else if (D.cats.length > 1) h += legendHTML();

    root.innerHTML = h;
    syncHash();
  }

  function shift(delta) {
    if (state.view === 'year') {
      state.y += delta;
    } else {
      state.m += delta;
      if (state.m < 1) { state.m = 12; state.y -= 1; }
      if (state.m > 12) { state.m = 1; state.y += 1; }
      state.sel = null;
    }
  }

  function goToday() {
    // 「今天」= 回到今天所在的月视图（年视图下也切过去）
    state.view = 'month';
    state.y = NOW.getFullYear();
    state.m = NOW.getMonth() + 1;
    state.sel = TODAY;
  }

  // ── 导出打卡图（纯 canvas 手绘，不依赖任何库）─────────
  // 导出的就是当前正在看的视图：月视图出月卡，年视图出年卡。
  /** 图上的统计文案，口径写清楚，避免"本月/累计"看着像重复 */
  function scopeText(st) {
    if (state.view === 'year') {
      var isThisYear = state.y === NOW.getFullYear();
      return (isThisYear ? '今年' : state.y + ' 年') + ' ' + st.inYear + ' 天 · 累计 ' + st.total +
        ' 天 · 当前连续 ' + st.streak + ' 天';
    }
    var isThisMonth = state.y === NOW.getFullYear() && state.m === NOW.getMonth() + 1;
    return (isThisMonth ? '本月' : state.m + ' 月') + ' ' + st.inMonth + ' 天 · 累计 ' + st.total +
      ' 天 · 当前连续 ' + st.streak + ' 天';
  }

  function buildCard() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var P = dark
      ? { bg: '#121212', fg: '#eaeaea', muted: 'rgba(255,255,255,.55)', line: 'rgba(255,255,255,.15)',
          red: '#ff453a', tint: 'rgba(255,69,58,.18)' }
      : { bg: '#ffffff', fg: '#1f2d3d', muted: '#8a9199', line: '#e6eaf0',
          red: '#e5484d', tint: 'rgba(229,72,77,.09)' };
    var F = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,sans-serif';
    var W = 1080;
    var PAD = 56;
    var S = 2; // 2 倍图，手机上看着不糊
    var isYear = state.view === 'year';
    var H = isYear ? 960 : 1250;

    var cv = document.createElement('canvas');
    cv.width = W * S;
    cv.height = H * S;
    var g = cv.getContext('2d');
    g.scale(S, S);
    g.fillStyle = P.bg;
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'middle';

    function roundRect(x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }
    function line(x1, y1, x2, y2) {
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }

    // 页头
    var st = checkinStats();
    g.textAlign = 'left';
    g.fillStyle = P.fg;
    g.font = '700 46px ' + F;
    g.fillText(isYear ? state.y + ' 年' : state.y + ' 年 ' + state.m + ' 月', PAD, PAD + 30);
    g.textAlign = 'right';
    g.fillStyle = P.muted;
    g.font = '400 24px ' + F;
    g.fillText(scopeText(st), W - PAD, PAD + 30);

    if (isYear) {
      // 年卡：4 × 3 十二个月
      var cols = 4;
      var colGap = 28;
      var cw = (W - PAD * 2 - colGap * (cols - 1)) / cols;
      var dw = cw / 7;
      var cellH = 23;
      var blockH = 52 + cellH * 6 + 46;
      var top = PAD + 104;

      for (var m = 1; m <= 12; m++) {
        var cx = PAD + (m - 1) % cols * (cw + colGap);
        var cy = top + Math.floor((m - 1) / cols) * blockH;

        g.textAlign = 'left';
        g.fillStyle = P.red;
        g.font = '700 22px ' + F;
        g.fillText(MONTH_CN[m - 1], cx, cy);

        g.fillStyle = P.muted;
        g.font = '400 15px ' + F;
        g.textAlign = 'center';
        for (var w = 0; w < 7; w++) g.fillText(WEEK[w], cx + dw * w + dw / 2, cy + 28);

        monthCells(state.y, m).forEach(function (cell, idx) {
          var x = cx + dw * (idx % 7) + dw / 2;
          var y = cy + 50 + Math.floor(idx / 7) * cellH;
          var k = key(cell.y, cell.m, cell.d);
          if (marks[k] > 0) {
            g.fillStyle = P.red;
            roundRect(cx + dw * (idx % 7) + 1, y - cellH / 2 + 1, dw - 2, cellH - 2, 4);
            g.fill();
            g.fillStyle = '#ffffff';
            g.font = '700 15px ' + F;
          } else {
            g.fillStyle = cell.out ? P.muted : P.fg;
            g.globalAlpha = cell.out ? .45 : 1;
            g.font = '400 15px ' + F;
          }
          g.textAlign = 'center';
          g.fillText(String(cell.d), x, y);
          g.globalAlpha = 1;
        });
      }
    } else {
      // 月卡：大月历 + 农历
      var gx = PAD;
      var cw2 = (W - PAD * 2) / 7;
      var rh = 150;
      var headY = PAD + 106;
      var bodyTop = headY + 46;

      g.textAlign = 'center';
      g.fillStyle = P.muted;
      g.font = '600 22px ' + F;
      for (var i = 0; i < 7; i++) g.fillText(WEEK_LONG[i], gx + cw2 * i + cw2 / 2, headY + 10);

      g.strokeStyle = P.line;
      g.lineWidth = 1;
      for (var r = 0; r <= 6; r++) line(gx, bodyTop + rh * r, gx + cw2 * 7, bodyTop + rh * r);
      for (var c = 0; c <= 7; c++) line(gx + cw2 * c, bodyTop, gx + cw2 * c, bodyTop + rh * 6);

      monthCells(state.y, state.m).forEach(function (cell, idx) {
        var col = idx % 7;
        var row = Math.floor(idx / 7);
        var x = gx + cw2 * col;
        var y = bodyTop + rh * row;
        var k = key(cell.y, cell.m, cell.d);
        var info = infoOf(k);
        var marked = marks[k] > 0;

        if (marked) {
          g.fillStyle = P.tint;
          g.fillRect(x, y, cw2, rh);
        }

        g.textAlign = 'left';
        g.fillStyle = P.muted;
        g.font = '400 19px ' + F;
        g.fillText(info[0] || '', x + 14, y + 26);

        var tag = info.slice(1).filter(function (t) { return t !== '休' && t !== '班'; })[0];
        if (tag) {
          g.fillStyle = P.red;
          g.font = '400 18px ' + F;
          g.fillText(tag, x + 14, y + 52);
        }

        var bx = x + cw2 - 36;
        var by = y + 32;
        var bs = 44;
        if (marked) {
          g.fillStyle = P.red;
          roundRect(bx - bs / 2, by - bs / 2, bs, bs, 10);
          g.fill();
          g.fillStyle = '#ffffff';
          g.font = '700 24px ' + F;
        } else if (k === TODAY) {
          g.strokeStyle = P.red;
          g.lineWidth = 2;
          roundRect(bx - bs / 2, by - bs / 2, bs, bs, 10);
          g.stroke();
          g.fillStyle = P.red;
          g.font = '700 24px ' + F;
        } else {
          g.fillStyle = cell.out ? P.muted : P.fg;
          g.globalAlpha = cell.out ? .45 : 1;
          g.font = '600 24px ' + F;
        }
        g.textAlign = 'center';
        g.fillText(String(cell.d), bx, by + 1);
        g.globalAlpha = 1;
      });
    }

    // 页脚
    var pageTitle = (document.title || '').split(/[|｜]/)[0].trim();
    g.textAlign = 'left';
    g.fillStyle = P.muted;
    g.font = '400 21px ' + F;
    g.fillText(pageTitle || '打卡记录', PAD, H - PAD);
    g.textAlign = 'right';
    g.fillText(key(NOW.getFullYear(), NOW.getMonth() + 1, NOW.getDate()), W - PAD, H - PAD);

    return cv;
  }

  function exportPNG() {
    var isYear = state.view === 'year';
    var name = 'checkin-' + (isYear ? state.y : state.y + '-' + pad(state.m)) + '.png';
    buildCard().toBlob(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }, 'image/png');
  }

  /** 备份用的 JSON：原始时间戳一起导出，恢复时才不会丢掉"谁更新"的信息 */
  function exportMarks() {
    var payload = JSON.stringify({
      v: 1,
      page: location.pathname,
      exported: new Date().toISOString(),
      marks: marks,
    }, null, 2);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    a.download = 'checkin' + location.pathname.replace(/[^\w]+/g, '-').replace(/-+$/, '') + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function bind() {
    var root = document.getElementById('mac-cal');
    if (!root || root.__macBound) return;
    root.__macBound = true;

    root.addEventListener('click', function (ev) {
      if (closest(ev.target, '.mac-cal__ev')) return; // 事件条：走链接

      // 同步设置面板
      var syn = closest(ev.target, '[data-sync]');
      if (syn) {
        var s = syn.getAttribute('data-sync');
        if (s === 'panel') { panelOpen = !panelOpen; render(); return; }
        if (s === 'save') { savePanel(); return; }
        if (s === 'create') { createGist(); return; }
        if (s === 'pull') { syncNow(); return; }
        if (s === 'disconnect') {
          syncCfg = null;
          saveCfg();
          setStatus('off');
          panelOpen = false;
          render();
          return;
        }
      }

      var act = closest(ev.target, '[data-act]');
      if (act) {
        var what = act.getAttribute('data-act');
        if (what === 'png') exportPNG();
        if (what === 'json') exportMarks();
        if (what === 'clear' && window.confirm('清空这个页面的全部打卡记录？此操作不可撤销，建议先「备份数据」。')) {
          marks = {};
          saveMarks();
          render();
        }
        return;
      }

      var seg = closest(ev.target, '[data-view]');
      if (seg) {
        state.view = seg.getAttribute('data-view');
        render();
        return;
      }

      var nav = closest(ev.target, '[data-nav]');
      if (nav) {
        var n = nav.getAttribute('data-nav');
        if (n === 'today') goToday(); else shift(n === 'prev' ? -1 : 1);
        render();
        return;
      }

      var name = closest(ev.target, '.mac-cal__mname');
      if (name) {
        state.m = +closest(ev.target, '.mac-cal__mcard').getAttribute('data-month');
        state.view = 'month';
        render();
        return;
      }

      var cell = closest(ev.target, '[data-date]');
      if (cell) {
        var k = cell.getAttribute('data-date');

        // 打卡模式：点一下点亮成红色，再点取消；不切视图
        if (CHECKIN) {
          // 取消打卡写负数时间戳，而不是删掉 —— 另一台设备才知道"这天被取消了"，
          // 而且这个取消动作必须带时间，否则永远比不过旧的打卡记录
          if (marks[k] > 0) marks[k] = -Date.now(); else marks[k] = Date.now();
          state.sel = k;
          saveMarks();
          render();
          schedulePush();
          return;
        }

        if (state.view === 'year') state.view = 'month';
        state.y = +k.slice(0, 4);
        state.m = +k.slice(5, 7);
        state.sel = k;
        render();
      }
    });
  }

  function init() {
    var root = document.getElementById('mac-cal');
    if (!root) return;
    if (!root.__macBound) applyHash();
    render();
    bind();
    // 打开页面时跟远端对一次账（配了 Gist 才做），这样手机上打的卡 iPad 上能看到
    if (CHECKIN && !didInitialSync && effectiveCfg().id) {
      didInitialSync = true;
      syncNow();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Butterfly 若开启 pjax，切页后重新渲染
  document.addEventListener('pjax:complete', init);
  // 浏览器前进/后退
  window.addEventListener('hashchange', function () {
    applyHash();
    render();
  });
  window.macCalendarInit = init;
  window.macCalendarCard = buildCard; // 供测试/二次开发直接拿到画布
  // 供测试使用：看内部状态、单测合并逻辑
  window.macCalendarSync = {
    marks: function () { return marks; },
    stats: checkinStats,
    merge: mergeMarks,
    parseGist: parseGistInput,
    status: function () { return syncStatus; },
  };
})();
