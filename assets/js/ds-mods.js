/**
 * 模组列表页逻辑（从 shortcode 内嵌 JS 抽离）
 * 通过 DOM 上 #mods-data.dataset 获取数据链接 / 搜索配置
 * 模块化避免每个包含 shortcode 的页面重复序列化 300+ 行脚本
 */
(function (global) {
  'use strict';

  var PAGE_SIZE = 50;
  var PRELOAD_ROOT = '200px';
  var SEARCH_DEBOUNCE_MS = 200;
  var STORAGE_SORT_KEY = 'mods-sort-preference';

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
          imgFallback: dataEl.dataset.imgFallback || '/img/bm/BM000.png'
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

      fetch(dataSrc, { credentials: 'same-origin', cache: 'force-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(parseAndBuild)
        .catch(function (err) { reject(err); });
    });
  }

  /**
   * 站点基础 URL（用 location.origin 适配本地/局域网/公网）
   */
  function getSiteOrigin() {
    return window.location.origin;
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

    return (
      '<div class="mod-item" data-id="' + idLower + '" data-name="' + nameLower + '">' +
        '<div class="item-main">' +
          '<div class="item-info">' +
            '<button onclick="window.location.href=\'' + site + '/p/' + mod.id + '\'" class="action-btn" data-href="/p/' + mod.id + '">' +
              '<img src="' + cfg.imgBase + mod.id + '.png" alt="' + mod.id + '" loading="lazy" onerror="this.onerror=null;this.src=\'' + cfg.imgFallback + '\'">' +
            '</button>' +
            '<span class="mod-name">' +
              mod.id + ' ' + mod.name + (mod.size ? '(' + mod.size + ')' : '') +
            '</span>' +
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
        '<button onclick="window.open(\'' + url + '\',\'_blank\')" class="action-btn ' + cls + '" title="' + title + '">' +
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
        var sentinel = document.getElementById('scroll-sentinel');
        if (sentinel) sentinel.textContent = '模组数据加载失败，请刷新重试';
      });
  }

  function bootstrap(cfg) {
    var modsList = document.getElementById('mods-list');
    var sentinel = document.getElementById('scroll-sentinel');
    var searchInput = document.getElementById('mod-search');
    var showCountEl = document.getElementById('show-count');
    var sortToggleBtn = document.getElementById('sort-toggle');
    if (!modsList || !sentinel || !searchInput || !sortToggleBtn) return;

    var filteredMods = cfg.searchOnly && !cfg.searchKeyword ? [] : cfg.allMods.slice();
    var currentSort = localStorage.getItem(STORAGE_SORT_KEY) || 'asc';
    var currentPage = 0;
    var isLoading = false;

    if (cfg.searchKeyword) searchInput.value = cfg.searchKeyword;

    updateSortButtons();
    applyFilter();

    /* ---------- 渲染 ---------- */
    function renderPage(pageIndex) {
      var start = pageIndex * PAGE_SIZE;
      var end = Math.min(start + PAGE_SIZE, filteredMods.length);
      var pageMods = filteredMods.slice(start, end);

      if (pageMods.length === 0 && start >= filteredMods.length) {
        sentinel.style.display = 'none';
        return;
      }
      sentinel.style.display = 'block';

      if (pageIndex === 0) {
        modsList.innerHTML = mapJoin(pageMods, function (m) { return buildModItem(m, cfg); });
      } else {
        var tempDiv = document.createElement('div');
        tempDiv.innerHTML = mapJoin(pageMods, function (m) { return buildModItem(m, cfg); });
        while (tempDiv.firstChild) modsList.appendChild(tempDiv.firstChild);
      }
      currentPage = pageIndex + 1;
    }

    function reload() {
      currentPage = 0;
      modsList.innerHTML = '';
      renderPage(0);
      showCountEl.textContent = filteredMods.length;
    }

    /* ---------- 搜索 & 排序 ---------- */
    function applyFilter() {
      var kw = (searchInput.value || '').trim().toLowerCase();
      if (!kw) {
        filteredMods = cfg.searchOnly ? [] : cfg.allMods.slice();
      } else {
        filteredMods = cfg.allMods.filter(function (m) {
          return (m.id || '').toLowerCase().indexOf(kw) !== -1 ||
                 (m.name || '').toLowerCase().indexOf(kw) !== -1;
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

    /* ---------- 无限滚动 ---------- */
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !isLoading) {
          var totalPages = Math.ceil(filteredMods.length / PAGE_SIZE);
          if (currentPage < totalPages) {
            isLoading = true;
            sentinel.textContent = '加载中...';
            setTimeout(function () {
              renderPage(currentPage);
              isLoading = false;
              sentinel.textContent = currentPage >= totalPages ? '已加载全部' : '加载更多...';
            }, 50);
          }
        }
      });
    }, { rootMargin: PRELOAD_ROOT, threshold: 0 });

    observer.observe(sentinel);

    /* ---------- 事件 ---------- */
    sortToggleBtn.addEventListener('click', function () {
      currentSort = currentSort === 'asc' ? 'desc' : 'asc';
      localStorage.setItem(STORAGE_SORT_KEY, currentSort);
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
