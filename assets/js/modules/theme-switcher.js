  /**
   * 主题切换器模块
   * 功能：light / dark 双态切换、主题记忆、浮动按钮
   */
(function(global) {
  'use strict';

  var switchTheme = null;
  var THEME_STORAGE_KEY = 'book-theme-mode';
  var SCROLL_THRESHOLD = 300;
  var pendingScrollUpdate = false;

  /**
   * 安全设置元素样式（兼容旧 Safari：Object.assign 失败时逐个赋值兜底）
   * @param {HTMLElement} el - 目标元素
   * @param {Object} styles - 样式键值对
   */
  function setStyles(el, styles) {
    if (Object.assign) {
      try { Object.assign(el.style, styles); return; } catch (e) { /* 降级 */ }
    }
    for (var key in styles) {
      if (styles.hasOwnProperty(key)) {
        el.style[key] = styles[key];
      }
    }
  }

  /**
   * 添加事件监听（兼容旧 Safari：passive 选项不支持时降级为布尔值）
   * @param {EventTarget} target - 监听目标
   * @param {string} type - 事件名
   * @param {Function} handler - 回调
   * @param {Object|boolean} options - 选项
   */
  function addSafeListener(target, type, handler, options) {
    var opts = options;
    var supportsPassive = false;
    try {
      var optsTest = Object.defineProperty({}, 'passive', {
        get: function () { supportsPassive = true; return true; }
      });
      window.addEventListener('testPassive', null, optsTest);
      window.removeEventListener('testPassive', null, optsTest);
    } catch (e) { supportsPassive = false; }
    if (!supportsPassive) {
      opts = (typeof options === 'object') ? (options.capture || false) : options;
    }
    target.addEventListener(type, handler, opts);
  }

  /**
   * 解析 data-theme，分离基础主题名和当前模式
   * 规则：最后一段是 light/dark 才视为模式，否则整体为基础主题名
   */
  function parseTheme(themeStr) {
    var parts = themeStr.split('-');
    var last = parts[parts.length - 1];
    if (last === 'light' || last === 'dark') {
      return {
        base: parts.slice(0, -1).join('-'),
        mode: last
      };
    }
    return { base: themeStr, mode: null };
  }

  /**
   * 应用指定模式到 DOM
   */
  function applyMode(mode) {
    var cur = document.documentElement.getAttribute('data-theme');
    if (!cur) return;

    var parsed = parseTheme(cur);
    var newTheme = parsed.base ? parsed.base + '-' + mode : mode;
    document.documentElement.setAttribute('data-theme', newTheme);
  }

  /**
   * 切换主题模式
   */
  function toggleTheme() {
    var currentMode = getStorageItem(THEME_STORAGE_KEY) || 'light';
    var nextMode;

    // 循环：light → dark → light
    nextMode = (currentMode === 'light') ? 'dark' : 'light';

    setStorageItem(THEME_STORAGE_KEY, nextMode);
    applyMode(nextMode);
    updateButton(nextMode);
  }

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
   * 按当前 scrollY 同步显示状态（scrollY<300 显示，>=300 隐藏）
   * 用 requestAnimationFrame 合并写入，避免每秒 120 次 style reflow
   */
  function updateDisplayByScroll() {
    if (!switchTheme) return;
    var scrollY = window.scrollY || window.pageYOffset || 0;
    switchTheme.style.display = (scrollY < SCROLL_THRESHOLD) ? 'flex' : 'none';
    pendingScrollUpdate = false;
  }

  /**
   * 滚动回调（passive，不阻塞浏览器合成线程）
   */
  function onScroll() {
    if (pendingScrollUpdate) return;
    pendingScrollUpdate = true;
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(updateDisplayByScroll);
    } else {
      updateDisplayByScroll();
    }
  }

  /**
   * 更新按钮图标、提示和显示隐藏
   * 图标来自 assets/bs 的 Bootstrap Icons（sun / moon-stars），fill=currentColor 跟随主题色
   */
  var ICON_LIGHT = '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6m0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8M8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0m0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13m8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5M3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8m10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0m-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0m9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707M4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708"/></svg>';
  var ICON_DARK = '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6 .278a.77.77 0 0 1 .08.858 7.2 7.2 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277q.792-.001 1.533-.16a.79.79 0 0 1 .81.316.73.73 0 0 1-.031.893A8.35 8.35 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.75.75 0 0 1 6 .278M4.858 1.311A7.27 7.27 0 0 0 1.025 7.71c0 4.02 3.279 7.276 7.319 7.276a7.32 7.32 0 0 0 5.205-2.162q-.506.063-1.029.063c-4.61 0-8.343-3.714-8.343-8.29 0-1.167.242-2.278.681-3.286"/><path d="M10.794 3.148a.217.217 0 0 1 .412 0l.387 1.162c.173.518.579.924 1.097 1.097l1.162.387a.217.217 0 0 1 0 .412l-1.162.387a1.73 1.73 0 0 0-1.097 1.097l-.387 1.162a.217.217 0 0 1-.412 0l-.387-1.162A1.73 1.73 0 0 0 9.31 6.593l-1.162-.387a.217.217 0 0 1 0-.412l1.162-.387a1.73 1.73 0 0 0 1.097-1.097zM13.863.099a.145.145 0 0 1 .274 0l.258.774c.115.346.386.617.732.732l.774.258a.145.145 0 0 1 0 .274l-.774.258a1.16 1.16 0 0 0-.732.732l-.258.774a.145.145 0 0 1-.274 0l-.258-.774a1.16 1.16 0 0 0-.732-.732l-.774-.258a.145.145 0 0 1 0-.274l.774-.258c.346-.115.617-.386.732-.732z"/></svg>';

  function updateButton(mode) {
    if (!switchTheme) return;
    var icons = { 'light': ICON_LIGHT, 'dark': ICON_DARK };
    var titles = { 'light': '亮色主题', 'dark': '暗色主题' };
    switchTheme.innerHTML = icons[mode] || ICON_LIGHT;
    switchTheme.title = titles[mode] || '切换主题';
    updateDisplayByScroll();
  }

  /**
   * 获取初始模式（兼容旧用户：auto 视为无效，回退 light）
   */
  function getInitialMode() {
    var saved = getStorageItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') {
      return saved;
    }
    return 'light'; // 默认 light
  }

  /**
   * 创建切换按钮
   */
  function createButton() {
    switchTheme = document.createElement('button');
    switchTheme.id = 'theme-switcher';
    switchTheme.onclick = toggleTheme;

    /* 注意：传元素本身而非 switchTheme.style——setStyles 内部会取 el.style，
       误传 style 对象会导致 Object.assign(undefined) 抛错、按钮创建中断 */
    setStyles(switchTheme, {
      position: 'fixed',
      bottom: '120px',
      right: '20px',
      zIndex: '9998',
      width: '40px',
      height: '40px',
      borderRadius: '50%',
      cursor: 'pointer',
      fontSize: '20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transform: 'scale(1)',
      transformOrigin: 'center center',
      /* 旧版 Safari webkit 前缀兜底 */
      webkitTransform: 'scale(1)',
      webkitTransformOrigin: 'center center'
    });

    /**
     * 仅 transform scale 放大反馈，颜色全由 CSS 固定控制
     * @param {number} sizeLevel - 缩放档位：1（默认） / 1.05（按下） / 1.1（悬停）
     */
    function forceVisualReset(sizeLevel) {
      var scale = 'scale(' + sizeLevel + ')';
      switchTheme.style.transform = scale;
      switchTheme.style.webkitTransform = scale;
    }

    /* 仅保留矢量尺寸反馈 */
    switchTheme.onmouseenter = function() { forceVisualReset(1.1); };
    switchTheme.onmouseleave = function() { forceVisualReset(1); };
    switchTheme.onmousedown = function() { forceVisualReset(1.05); };
    switchTheme.onmouseup = function() { forceVisualReset(1.1); };
    switchTheme.onfocus = function() { forceVisualReset(1); };
    switchTheme.onblur = function() { forceVisualReset(1); };

    // 滚动时显示/隐藏（与返回顶部按钮使用同一阈值 300px，保证位置重合时严格互斥）
    // passive: true 让滚动合成先跑，JS 异步执行，不阻塞掉帧
    addSafeListener(window, 'scroll', onScroll, { passive: true });

    document.body.appendChild(switchTheme);
  }

  /**
   * 初始化主题切换器
   */
  function init() {
    createButton();
    var mode = getInitialMode();
    applyMode(mode);
    updateButton(mode);
  }

  // 导出模块
  global.ThemeSwitcher = {
    init: init,
    toggleTheme: toggleTheme
  };

})(window);
