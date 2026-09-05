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
          imgFallback: dataEl.dataset.imgFallback || '/img/bm/none.png'
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
   * 构造单条模组 HTML
   */
  function buildModItem(mod, cfg) {
    var idLower = (mod.id || '').toLowerCase();
    var nameLower = (mod.name || '').toLowerCase();
    var baiduUrl = mod.baiduUrl ? mod.baiduUrl + '&t=' + cfg.currentDate : null;
    var quarkUrl = mod.quarkUrl ? mod.quarkUrl + '&t=' + cfg.currentDate : null;
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
            buildActionBtn('baidu', '百度网盘下载', baiduUrl) +
            buildActionBtn('quark', '夸克网盘下载', quarkUrl) +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function buildActionBtn(cls, title, url) {
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

  global.ModsList = { init: init };
})(window);
