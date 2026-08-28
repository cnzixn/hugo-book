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
    var currentMode = localStorage.getItem(THEME_STORAGE_KEY) || 'light';
    var nextMode;

    // 循环：light → dark → light
    nextMode = (currentMode === 'light') ? 'dark' : 'light';

    localStorage.setItem(THEME_STORAGE_KEY, nextMode);
    applyMode(nextMode);
    updateButton(nextMode);
  }

  /**
   * 按当前 scrollY 同步显示状态（scrollY<300 显示，>=300 隐藏）
   * 用 requestAnimationFrame 合并写入，避免每秒 120 次 style reflow
   */
  function updateDisplayByScroll() {
    if (!switchTheme) return;
    switchTheme.style.display = (window.scrollY < SCROLL_THRESHOLD) ? 'flex' : 'none';
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
   */
  function updateButton(mode) {
    if (!switchTheme) return;
    var icons = { 'light': '☀️', 'dark': '🌕' };
    var titles = { 'light': '亮色主题', 'dark': '暗色主题' };
    switchTheme.innerHTML = icons[mode] || '☀️';
    switchTheme.title = titles[mode] || '切换主题';
    updateDisplayByScroll();
  }

  /**
   * 获取初始模式（兼容旧用户：auto 视为无效，回退 light）
   */
  function getInitialMode() {
    var saved = localStorage.getItem(THEME_STORAGE_KEY);
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

    Object.assign(switchTheme.style, {
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
      transformOrigin: 'center center'
    });

    /**
     * 仅 transform scale 放大反馈，颜色全由 CSS 固定控制
     * @param {number} sizeLevel - 缩放档位：1（默认） / 1.05（按下） / 1.1（悬停）
     */
    function forceVisualReset(sizeLevel) {
      switchTheme.style.transform = 'scale(' + sizeLevel + ')';
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
    window.addEventListener('scroll', onScroll, { passive: true });

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
