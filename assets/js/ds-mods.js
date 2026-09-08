/**
 * 模组列表页逻辑（从 shortcode 内嵌 JS 抽离）
 * 通过 DOM 上 #mods-data.dataset 获取数据链接 / 搜索配置
 * 模块化避免每个包含 shortcode 的页面重复序列化 300+ 行脚本
 *
 * 分页渲染：每次只渲染当前页数据，底部提供页码导航；
 * 不再使用“瀑布流”（滚动到哨兵自动追加加载）。
 */
(function (global) {
  'use strict';

  var PAGE_SIZE = 20;
  var SEARCH_DEBOUNCE_MS = 200;
  var STORAGE_SORT_KEY = 'mods-sort-preference';

  /**
   * localStorage 安全访问（隐私模式 Safari 会抛 quota exceeded 异常）
   */
  function getStorageItem(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function setStorageItem(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* 忽略存储失败 */ }
  }

  /**
   * 读取 DOM 配置（shortcode 注入）
   * 支持两种数据来源：
   *   a) 旧兼容模式：textContent 内嵌 JSON（用于开发/临时场景）
   *   b) 新模式：dataset.src 提供独立 JSON URL（HTML 从 96KB 砍到 ~12KB，JSON 可被 CDN 缓存）
   */
  function loadConfig() {
    return new Promise(function (resolve, reject) {
      var dataEl = document.getElementById('mods-data');
      if (!dataEl) return reject(new Error('mods-data not found'));

      var dataSrc = dataEl.dataset.src || '';
      var fallbackText = (dataEl.textContent || '').trim();

      function parseAndBuild(rawJson) {
        var allMods;
        try {
          allMods = JSON.parse(rawJson);
        } catch (e) {
          return reject(e);
        }
        resolve({
          allMods: allMods,
          searchOnly: dataEl.dataset.searchOnly === 'true',
          searchKeyword: dataEl.dataset.searchKeyword || '',
          currentDate: dataEl.dataset.currentDate || '',
          imgBase: dataEl.dataset.imgBase || '/img/bm/',
          imgFallback: dataEl.dataset.imgFallback || '/img/bm/none.png',
          // 网盘直链策略：modal=点击在当前页弹框校验邮箱后新标签打开（页面不内嵌直链）；direct=直接输出直链
          panMode: dataEl.dataset.panMode || 'direct'
        });
      }

      // 优先尝试 textContent（兜底，避免 fetch 失败时整页白屏）
      if (fallbackText && fallbackText.length > 2) {
        parseAndBuild(fallbackText);
        return;
      }

      if (!dataSrc) {
        return reject(new Error('mods-data has neither src nor inline json'));
      }

      // fetch + XHR 双重降级（fetch 旧 Safari 不支持 cache 参数，或者根本没有 fetch）
      if (window.fetch) {
        try {
          fetch(dataSrc, { credentials: 'same-origin' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(parseAndBuild)
            .catch(function (err) {
              // fetch 失败再用 XHR 试一次
              xhrGet(dataSrc, parseAndBuild, reject);
            });
          return;
        } catch (e) { /* 立即降级 XHR */ }
      }
      xhrGet(dataSrc, parseAndBuild, reject);
    });
  }

  /**
   * 简易 XHR GET 封装（fetch 不可用时兜底）
   */
  function xhrGet(url, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        onSuccess(xhr.responseText);
      } else {
        onError(new Error('XHR HTTP ' + xhr.status));
      }
    };
    try { xhr.send(); } catch (e) { onError(e); }
  }

  /**
   * 站点基础 URL（用 location.origin 适配本地/局域网/公网）
   * 旧 Safari 下 origin 可能为空，手动拼接
   */
  function getSiteOrigin() {
    if (window.location.origin) return window.location.origin;
    return window.location.protocol + '//' + window.location.hostname +
      (window.location.port ? ':' + window.location.port : '');
  }

  /**
   * 构造标签 HTML（支持数组或逗号分隔字符串）
   */
  function buildTagsHtml(tags) {
    if (!tags) return '';
    var list;
    if (typeof tags === 'string') {
      list = tags.split(/[,，、]/);
    } else if (Array.isArray(tags)) {
      list = tags;
    } else {
      return '';
    }
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      var t = (list[i] || '').trim();
      if (t) parts.push('<span class="mod-tag">' + t + '</span>');
    }
    return parts.length ? '<span class="mod-tags">' + parts.join('') + '</span>' : '';
  }

  /**
   * WS 前缀数字 ID → Steam 创意工坊链接；其余本地 ID（BM…等）原样返回纯文本
   * 例：WS123456 → https://steamcommunity.com/sharedfiles/filedetails/?id=123456
   * （WS000000 之类无有效数字的 ID 不生成链接）
   */
  function buildWorkshopIdLink(id) {
    var raw = id || '';
    var m = /^WS(\d+)$/i.exec(raw);
    var digits = (m && m[1]) ? m[1].replace(/^0+/, '') : '';
    if (!digits) return raw;
    return (
      '<a class="workshop-id-link" href="https://steamcommunity.com/sharedfiles/filedetails/?id=' + digits + '"' +
        ' target="_blank" rel="noopener noreferrer"' +
        ' title="在 Steam 创意工坊中查看 ' + digits + '"' +
        ' onclick="event.stopPropagation()">' + raw + '</a>'
    );
  }

  /**
   * 构造某网盘的直链下载 URL（仅 direct 模式使用）
   * 返回真实直链（旧行为，带 &t= 时间戳防缓存）
   */
  function buildDownloadTarget(mod, cfg, disk) {
    var url = disk === 'baidu' ? mod.baiduUrl : mod.quarkUrl;
    return url ? url + '&t=' + cfg.currentDate : null;
  }

  /**
   * 构造单条模组 HTML
   * panMode:
   *   modal  → 下载按钮在当前页打开网盘弹框（不内嵌/不暴露真实直链，后端校验后新标签打开）
   *   direct → 下载按钮直接新标签打开真实直链（旧行为）
   */
  function buildModItem(mod, cfg) {
    var idLower = (mod.id || '').toLowerCase();
    var nameLower = (mod.name || '').toLowerCase();
    var isModal = (cfg.panMode === 'modal' || cfg.panMode === 'jump'); // jump 为旧别名，视同 modal
    var site = getSiteOrigin();
    var tagsHtml = buildTagsHtml(mod.tags);

    return (
      '<div class="mod-item" data-id="' + idLower + '" data-name="' + nameLower + '" ' +
        'onclick="window.location.href=\'' + site + '/p/' + mod.id + '\'">' +
        '<div class="item-main">' +
          '<div class="item-info">' +
            '<button class="action-btn" data-href="/p/' + mod.id + '" aria-label="' + mod.id + '">' +
              '<img src="' + cfg.imgBase + mod.id + '.png" alt="' + mod.id + '" loading="lazy" onerror="this.onerror=null;this.src=\'' + cfg.imgFallback + '\'">' +
            '</button>' +
            '<div class="mod-name">' +
              '<div class="mod-name-sub">' + mod.name + '</div>' +
              '<div class="mod-name-top">' +
                buildWorkshopIdLink(mod.id) + (mod.size ? ' (' + mod.size + ')' : '') + tagsHtml +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="item-actions">' +
            (isModal
              ? buildModalBtn('baidu', '百度网盘下载', mod.id) +
                buildModalBtn('quark', '夸克网盘下载', mod.id)
              : buildDirectBtn('baidu', '百度网盘下载', buildDownloadTarget(mod, cfg, 'baidu')) +
                buildDirectBtn('quark', '夸克网盘下载', buildDownloadTarget(mod, cfg, 'quark'))) +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /** direct 模式：新标签打开直链 */
  function buildDirectBtn(cls, title, url) {
    if (url) {
      return (
        '<button onclick="event.stopPropagation();window.open(\'' + url + '\',\'_blank\')" class="action-btn ' + cls + '" title="' + title + '">' +
          '<img src="/img/icons/pan_' + cls + '.webp" alt="' + title + '" loading="lazy">' +
        '</button>'
      );
    }
    return (
      '<button class="action-btn ' + cls + '" title="暂无' + title + '" disabled>' +
        '<img src="/img/icons/pan_' + cls + '.webp" alt="' + title + '" loading="lazy">' +
      '</button>'
    );
  }

  /** modal 模式：打开当前页网盘弹框（不暴露直链） */
  function buildModalBtn(cls, title, fileId) {
    return (
      '<button class="action-btn ' + cls + '" title="' + title + '" ' +
        'onclick="event.stopPropagation();window.ModsList&&window.ModsList.PanDialog&&window.ModsList.PanDialog.open({p:\'' + fileId + '\',disk:\'' + cls + '\'})">' +
        '<img src="/img/icons/pan_' + cls + '.webp" alt="' + title + '" loading="lazy">' +
      '</button>'
    );
  }

  /* =============================================================
   * 网盘下载弹框（当前页面操作，不开跳转页/不离开本页）
   * 流程：点击下载按钮 → 弹框 → 输入/校验注册邮箱(记 localStorage)
   *      → 通过后新标签页打开真实网盘直链；失败则留在弹框内提示
   * ============================================================= */
  // 网盘 API 地址（可配置）
  // 本地联调：http://127.0.0.1:8787/ds/api/pan
  // 【上线前】请改为线上真实地址：同源 /ds/api/pan 或 https://<域名>/ds/api/pan
  var PAN_API = 'https://d1.225228.xyz/ds/api/pan';
  var PAN_EMAIL_KEY = 'pan-email';
  var DISK_LABEL = { baidu: '百度网盘', xunlei: '迅雷网盘', quark: '夸克网盘' };
  var DISK_ICON = {
    baidu: '/img/icons/pan_baidu.webp',
    xunlei: '/img/icons/pan_xunlei.webp',
    quark: '/img/icons/pan_quark.webp'
  };

  function isEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '');
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var PanDialog = (function () {
    var overlay, body, fileIdEl, fileNameEl;
    var cur = null;   // 当前会话状态
    var busy = false;
    var session = 0;  // 会话代数：关闭/重开后将“在途”的异步回调判为过期

    function esc(v) { return escHtml(v); }

    function ensureBuilt() {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.className = 'pd-overlay';
      overlay.hidden = true;
      overlay.innerHTML =
        '<div class="pd-card" role="dialog" aria-modal="true" aria-label="网盘下载">' +
          '<div class="pd-head">' +
            '<div class="pd-title">网盘下载</div>' +
            '<button type="button" class="pd-close" data-act="close" aria-label="关闭">×</button>' +
          '</div>' +
          '<div class="pd-file">' +
            '<span class="pd-file-label">文件</span>' +
            '<b class="pd-file-id"></b>' +
            '<span class="pd-file-name"></span>' +
          '</div>' +
          '<div class="pd-body"></div>' +
          '<div class="pd-foot">From ' + escHtml(PAN_API) + ' ...</div>' +
        '</div>';
      body = overlay.querySelector('.pd-body');
      fileIdEl = overlay.querySelector('.pd-file-id');
      fileNameEl = overlay.querySelector('.pd-file-name');
      document.body.appendChild(overlay);

      // 事件：关闭 / 下载网盘 / 更换邮箱 / 重试
      overlay.addEventListener('click', function (e) {
        var node = e.target;
        while (node && node !== overlay) {
          if (node.getAttribute && node.getAttribute('data-act')) break;
          node = node.parentNode;
        }
        if (!node || node === overlay) return;
        var act = node.getAttribute('data-act');
        if (act === 'close') { close(); return; }
        if (act === 'disk') {
          var k = node.getAttribute('data-disk');
          var url = cur && cur.links && cur.links[k];
          if (url) window.open(url, '_blank', 'noopener');
          return;
        }
        if (act === 'change-email') { cur.email = ''; viewEmail(''); return; }
        if (act === 'retry') { openBlankForAuto(); startVerify(); }
      });
      // Esc / 遮罩点击关闭
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    }

    function setFile(p, name) {
      fileIdEl.textContent = p || '—';
      fileNameEl.textContent = name ? '· ' + name : '';
    }

    function closeWinIfUnused() {
      if (cur && cur.win && !cur.winUsed) {
        try { cur.win.close(); } catch (e) { /* ignore */ }
      }
      if (cur) cur.win = null;
    }

    function openBlankForAuto() {
      // 必须在用户手势（点击下载/提交）同步阶段调用，才能绕过弹窗拦截
      if (!cur || cur.win) return;
      try {
        var w = window.open('about:blank', '_blank');
        if (w) {
          try { w.document.title = '正在打开网盘…'; } catch (e) { /* ignore */ }
          cur.win = w;
        }
      } catch (e) { cur.win = null; }
    }

    function openNewTab(url) {
      // 优先使用手势阶段已开好的空白标签页，其次退回 window.open（可能被拦）
      if (cur && cur.win && !cur.winUsed) {
        try {
          cur.win.location.href = url;
          cur.winUsed = true;
          try { cur.win.focus(); } catch (e) { /* ignore */ }
          return true;
        } catch (e) { /* 跨域等异常，走 fallback */ }
      }
      try {
        var w = window.open(url, '_blank', 'noopener');
        return !!w;
      } catch (e) { return false; }
    }

    /* ---------- 视图渲染 ---------- */
    function render(html) { body.innerHTML = html; }

    function viewLoading(text) {
      render(
        '<div class="pd-center">' +
          '<span class="pd-spinner"></span>' +
          '<p class="pd-hint">' + esc(text || '正在校验邮箱并获取网盘链接…') + '</p>' +
        '</div>'
      );
    }

    function viewEmail(errorMsg) {
      render(
        '<div class="pd-sub"></div>' +
        (errorMsg ? '<div class="pd-msg pd-err">' + esc(errorMsg) + '</div>' : '') +
        '<label class="pd-field" for="pd-email">邮箱</label>' +
        '<input type="email" class="pd-input" id="pd-email" placeholder="you@example.com" autocomplete="email" spellcheck="false">' +
        '<button type="button" class="pd-btn" id="pd-submit">验证并下载</button>'
      );
      var input = document.getElementById('pd-email');
      input.value = (cur && cur.email) || '';
      input.focus();
      document.getElementById('pd-submit').addEventListener('click', submitEmail);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitEmail(); });
    }

    function diskButtonsHtml(links, activeDisk, big) {
      var order = [];
      if (activeDisk) order.push(activeDisk);
      ['baidu', 'xunlei', 'quark'].forEach(function (k) {
        if (k !== activeDisk) order.push(k);
      });
      var out = [];
      order.forEach(function (k) {
        if (!links[k]) return;
        var active = k === activeDisk ? ' is-active' : '';
        out.push(
          '<button type="button" class="pd-disk' + (big && k === activeDisk ? ' pd-big' : '') + active + '" data-act="disk" data-disk="' + k + '">' +
            '<img src="' + DISK_ICON[k] + '" alt="">' +
            '<span class="pd-disk-label">' + DISK_LABEL[k] + '</span>' +
            '<span class="pd-arrow">↗</span>' +
          '</button>'
        );
      });
      return out.join('');
    }

    function viewResult(data) {
      cur.links = {
        baidu: data.baidu || '',
        xunlei: data.xunlei || '',
        quark: data.quark || ''
      };

      if (cur.disk && cur.links[cur.disk]) {
        var label = DISK_LABEL[cur.disk];
        var opened = openNewTab(cur.links[cur.disk]);
        render(
          (opened
            ? '<p class="pd-hint">已在新标签页打开「' + label + '」；若未弹出请点击下方按钮。</p>'
            : '<p class="pd-hint">浏览器拦截了自动打开，请点击下方按钮手动打开「' + label + '」。</p>') +
          diskButtonsHtml(cur.links, cur.disk, true) +
          '<button type="button" class="pd-linkbtn" data-act="change-email">更换邮箱</button>'
        );
      } else {
        render(
          '<p class="pd-hint">请选择要使用的网盘：</p>' +
          diskButtonsHtml(cur.links, '', false) +
          '<button type="button" class="pd-linkbtn" data-act="change-email">更换邮箱</button>'
        );
      }
    }

    function viewError(msg) {
      render(
        '<div class="pd-msg pd-err">' + esc(msg) + '</div>' +
        '<div class="pd-actions">' +
          '<button type="button" class="pd-btn pd-ghost" data-act="close">关闭</button>' +
          '<button type="button" class="pd-btn" data-act="retry">重试</button>' +
        '</div>'
      );
    }

    /* ---------- API ---------- */
    function apiQuery(email, cb) {
      var url = PAN_API + '?u=' + encodeURIComponent(email) + '&p=' + encodeURIComponent(cur.p);
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 12000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        var body = null;
        try { body = JSON.parse(xhr.responseText || '{}'); } catch (e) { body = null; }
        cb({ status: xhr.status, ok: body && body.code === 0, data: body && body.data, msg: (body && body.msg) || '请求失败' });
      };
      xhr.onerror = function () { cb({ status: 0, ok: false, data: null, msg: '网络异常，请稍后重试' }); };
      xhr.ontimeout = function () { cb({ status: 0, ok: false, data: null, msg: '请求超时，请稍后重试' }); };
      xhr.send();
    }

    function startVerify() {
      if (busy || !cur) return;
      busy = true;
      var my = cur.sess;
      viewLoading('正在校验邮箱并获取网盘链接…');
      apiQuery(cur.email, function (res) {
        busy = false;
        // 弹框已关闭或本次会话已过期（用户关闭后重开）→ 丢弃结果
        if (!cur || cur.sess !== my || overlay.hidden) { closeWinIfUnused(); return; }
        if (res.ok) {
          setStorageItem(PAN_EMAIL_KEY, cur.email);
          setFile(res.data.id, res.data.name);
          viewResult(res.data);
          return;
        }

        // 依据后端 msg 精确分流：
        //   404 "用户不存在或未注册"        → 邮箱未注册（停留邮箱表单让用户换邮箱）
        //   400 "参数错误：缺少有效的邮箱(u)或网盘文件id(p)" → 邮箱无效/格式错误
        //   404 "未找到对应的网盘文件"      → 文件不存在（文件 id 有误/已下架）
        var msg = res.msg || '';
        var userIssue = /用户|未注册/.test(msg);
        var fileIssue = /未找到对应的网盘文件/.test(msg);
        if (userIssue) {
          closeWinIfUnused();
          viewEmail('该邮箱未通过校验。');
        } else if (res.status === 400) {
          closeWinIfUnused();
          viewEmail('该邮箱未通过校验。');
        } else if (fileIssue || res.status === 404) {
          closeWinIfUnused();
          viewError('未找到文件「' + cur.p + '」对应的网盘记录，可能已下架或 ID 有误。');
        } else {
          closeWinIfUnused();
          viewError(msg || '网络异常，请稍后重试。');
        }
      });
    }

    function submitEmail() {
      var input = document.getElementById('pd-email');
      if (busy || !input) return;
      var v = (input.value || '').trim();
      if (!isEmail(v)) { viewEmail('请输入正确的邮箱地址。'); return; }
      cur.email = v;
      openBlankForAuto();
      startVerify();
    }

    /* ---------- 对外 ---------- */
    function open(opts) {
      ensureBuilt();
      closeWinIfUnused();
      session += 1;
      cur = {
        sess: session,
        p: opts.p || '',
        disk: (opts.disk || '').toLowerCase(),
        email: getStorageItem(PAN_EMAIL_KEY) || '',
        links: null,
        win: null,
        winUsed: false
      };
      setFile(cur.p, '');
      overlay.hidden = false;
      document.documentElement.classList.add('pd-lock');

      var saved = cur.email;
      if (saved && isEmail(saved)) {
        // 已记住邮箱：预开空白标签（用户手势内），校验通过后导航过去
        openBlankForAuto();
        startVerify();
      } else {
        viewEmail('');
      }
    }

    function close() {
      if (!overlay) return;
      session += 1;             // 使在途异步回调过期
      closeWinIfUnused();
      cur = null;
      busy = false;
      overlay.hidden = true;
      document.documentElement.classList.remove('pd-lock');
    }

    return { open: open, close: close };
  })();

  /**
   * 初始化列表逻辑（Promise 版：先解析配置，再拉 JSON，再绑定 UI）
   */
  function init() {
    if (!document.getElementById('mods-list')) return;   // 页面没包含 shortcode 就退出

    loadConfig()
      .then(function (cfg) { bootstrap(cfg); })
      .catch(function (err) {
        console.error('[mods-list] init failed', err);
        var list = document.getElementById('mods-list');
        if (list) {
          list.innerHTML = '<div class="mods-empty">模组数据加载失败，请刷新重试</div>';
        }
      });
  }

  function bootstrap(cfg) {
    var modsList = document.getElementById('mods-list');
    var pager = document.getElementById('mods-pager');
    var header = document.getElementById('mods-header');
    var searchInput = document.getElementById('mod-search');
    var showCountEl = document.getElementById('show-count');
    var sortToggleBtn = document.getElementById('sort-toggle');
    if (!modsList || !pager || !searchInput || !showCountEl || !sortToggleBtn) return;

    var filteredMods = cfg.searchOnly && !cfg.searchKeyword ? [] : cfg.allMods.slice();
    var currentSort = getStorageItem(STORAGE_SORT_KEY) || 'asc';
    var currentPage = 1;   // 1-based

    if (cfg.searchKeyword) searchInput.value = cfg.searchKeyword;

    updateSortButtons();
    applyFilter();

    /* ---------- 工具 ---------- */
    function totalPages() {
      if (filteredMods.length === 0) return 0;
      return Math.ceil(filteredMods.length / PAGE_SIZE);
    }

    function updateShowCount() {
      showCountEl.textContent = filteredMods.length;
    }

    function clampPage(page) {
      var pages = totalPages();
      if (pages === 0) return 1;
      if (page < 1) return 1;
      if (page > pages) return pages;
      return page;
    }

    /* ---------- 渲染 ---------- */
    function renderList() {
      var pages = totalPages();
      if (pages === 0) {
        modsList.innerHTML = '<div class="mods-empty">未找到匹配的模组，试试其他关键词</div>';
        renderPager();
        return;
      }
      currentPage = clampPage(currentPage);

      var start = (currentPage - 1) * PAGE_SIZE;
      var pageMods = filteredMods.slice(start, start + PAGE_SIZE);
      modsList.innerHTML = mapJoin(pageMods, function (m) { return buildModItem(m, cfg); });
      renderPager();
    }

    function reload() {
      currentPage = 1;
      renderList();
      updateShowCount();
    }

    /* ---------- 分页器 ---------- */
    function pagerItems(current, pages) {
      var items = [];
      var i;
      if (pages <= 7) {
        for (i = 1; i <= pages; i++) items.push(i);
        return items;
      }
      items.push(1);
      var lo = Math.max(2, current - 2);
      var hi = Math.min(pages - 1, current + 2);
      if (lo > 2) items.push('…');
      for (i = lo; i <= hi; i++) items.push(i);
      if (hi < pages - 1) items.push('…');
      items.push(pages);
      return items;
    }

    function pagerButtonHtml(item, isCurrent) {
      var cls = 'pager-btn' + (isCurrent ? ' is-active' : '');
      var currentAttr = isCurrent ? ' aria-current="page"' : '';
      return '<button type="button" class="' + cls + '" data-page="' + item + '"' + currentAttr + '>' + item + '</button>';
    }

    function renderPager() {
      var pages = totalPages();
      if (pages <= 1) {
        pager.innerHTML = '';
        pager.style.display = 'none';
        return;
      }
      var html = '<span class="pager-info">第 ' + currentPage + ' / ' + pages + ' 页</span>';

      html += '<button type="button" class="pager-btn pager-prev" data-page="' + (currentPage - 1) + '"' +
        (currentPage <= 1 ? ' disabled' : '') + '>‹ 上一页</button>';

      var items = pagerItems(currentPage, pages);
      for (var i = 0; i < items.length; i++) {
        if (items[i] === '…') {
          html += '<span class="pager-ellipsis">…</span>';
        } else {
          html += pagerButtonHtml(items[i], items[i] === currentPage);
        }
      }

      html += '<button type="button" class="pager-btn pager-next" data-page="' + (currentPage + 1) + '"' +
        (currentPage >= pages ? ' disabled' : '') + '>下一页 ›</button>';

      pager.innerHTML = html;
      pager.style.display = '';
    }

    function goToPage(page) {
      page = clampPage(page);
      if (page === currentPage) return;
      currentPage = page;
      renderList();
      // 切页后回到列表/搜索区顶部，避免停留在长列表中间
      var anchor = header || modsList;
      if (anchor && anchor.scrollIntoView) {
        try { anchor.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        catch (e) { anchor.scrollIntoView(); }
      }
    }

    pager.addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== pager && node.tagName !== 'BUTTON') node = node.parentNode;
      if (!node || node === pager || node.disabled) return;
      var page = parseInt(node.getAttribute('data-page'), 10);
      if (!isNaN(page)) goToPage(page);
    });

    /* ---------- 搜索 & 排序 ---------- */
    function applyFilter() {
      var kw = (searchInput.value || '').trim().toLowerCase();
      if (!kw) {
        filteredMods = cfg.searchOnly ? [] : cfg.allMods.slice();
      } else {
        filteredMods = cfg.allMods.filter(function (m) {
          // 双向子串匹配：字段包含搜索词，或搜索词包含字段
          var idLower = (m.id || '').toLowerCase();
          var nameLower = (m.name || '').toLowerCase();
          if (idLower.indexOf(kw) !== -1 || kw.indexOf(idLower) !== -1) return true;
          if (nameLower.indexOf(kw) !== -1 || kw.indexOf(nameLower) !== -1) return true;
          // 匹配标签（双向子串 + 支持数组或顿号/逗号分隔字符串）
          var tags = m.tags;
          if (tags) {
            var tagList = typeof tags === 'string' ? tags.split(/[,，、]/) : tags;
            for (var ti = 0; ti < tagList.length; ti++) {
              var tagLower = (tagList[ti] || '').trim().toLowerCase();
              if (!tagLower) continue;
              if (tagLower.indexOf(kw) !== -1 || kw.indexOf(tagLower) !== -1) return true;
            }
          }
          return false;
        });
      }
      applySort();
      reload();
    }

    function applySort() {
      filteredMods.sort(function (a, b) {
        return currentSort === 'asc'
          ? (a.id || '').localeCompare(b.id || '')
          : (b.id || '').localeCompare(a.id || '');
      });
    }

    function updateSortButtons() {
      var iconAsc = sortToggleBtn.querySelector('.icon-asc');
      var iconDesc = sortToggleBtn.querySelector('.icon-desc');
      var label = sortToggleBtn.querySelector('.sort-label');
      if (currentSort === 'asc') {
        if (iconAsc) iconAsc.style.display = 'inline-block';
        if (iconDesc) iconDesc.style.display = 'none';
        if (label) label.textContent = '正序';
      } else {
        if (iconAsc) iconAsc.style.display = 'none';
        if (iconDesc) iconDesc.style.display = 'inline-block';
        if (label) label.textContent = '倒序';
      }
    }

    /* ---------- 事件 ---------- */
    sortToggleBtn.addEventListener('click', function () {
      currentSort = currentSort === 'asc' ? 'desc' : 'asc';
      setStorageItem(STORAGE_SORT_KEY, currentSort);
      updateSortButtons();
      applyFilter();
    });

    var searchTimer = null;
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilter, SEARCH_DEBOUNCE_MS);
    });
  }

  function mapJoin(arr, fn) {
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(fn(arr[i], i));
    return out.join('');
  }

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(init);

  global.ModsList = { init: init, PanDialog: PanDialog };
})(window);
