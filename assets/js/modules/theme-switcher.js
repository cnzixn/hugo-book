/**
 * 主题切换器模块
 * 功能：auto(按时间) / light / dark 三态切换、主题记忆、浮动按钮
 */
(function(global) {
  'use strict';

  var switchTheme = null;
  var THEME_STORAGE_KEY = 'book-theme-mode';
  var DAY_START = 6;   // 白天开始时间（小时）
  var DAY_END = 18;    // 黑夜开始时间（小时）

  /**
   * 根据时间判断应该使用的模式
   */
  function getAutoMode() {
    var hour = new Date().getHours();
    return (hour >= DAY_START && hour < DAY_END) ? 'light' : 'dark';
  }

  /**
   * 获取当前实际应用的模式（解析 auto）
   */
  function getEffectiveMode(mode) {
    if (mode === 'auto') {
      return getAutoMode();
    }
    return mode;
  }

  /**
   * 应用指定模式到 DOM
   */
  function applyMode(mode) {
    var cur = document.documentElement.getAttribute('data-theme');
    if (!cur) return;

    var effectiveMode = getEffectiveMode(mode);
    var parts = cur.split('-');
    var base = parts.slice(0, -1).join('-');
    var newTheme = base ? base + '-' + effectiveMode : effectiveMode;
    document.documentElement.setAttribute('data-theme', newTheme);
  }

  /**
   * 切换主题模式
   */
  function toggleTheme() {
    var currentMode = localStorage.getItem(THEME_STORAGE_KEY) || 'auto';
    var nextMode;

    // 循环：auto → light → dark → auto
    if (currentMode === 'auto') {
      nextMode = 'light';
    } else if (currentMode === 'light') {
      nextMode = 'dark';
    } else {
      nextMode = 'auto';
    }

    localStorage.setItem(THEME_STORAGE_KEY, nextMode);
    applyMode(nextMode);
    updateButton(nextMode);
  }

  /**
   * 更新按钮图标和提示
   */
  function updateButton(mode) {
    if (!switchTheme) return;
    var icons = { 'auto': '🌗', 'light': '☀️', 'dark': '🌙' };
    var titles = { 'auto': '自动切换', 'light': '亮色主题', 'dark': '暗色主题' };
    switchTheme.innerHTML = icons[mode] || '🌗';
    switchTheme.title = titles[mode] || '切换主题';
  }

  /**
   * 获取初始模式
   */
  function getInitialMode() {
    var saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved && ['auto', 'light', 'dark'].indexOf(saved) !== -1) {
      return saved;
    }
    return 'auto'; // 默认 auto
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
      zIndex: '9999',
      width: '40px',
      height: '40px',
      borderRadius: '50%',
      border: '1px solid var(--border)',
      background: 'var(--code-bg)',
      cursor: 'pointer',
      fontSize: '20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
      transition: 'all 0.2s ease'
    });

    switchTheme.onmouseenter = function() { this.style.transform = 'scale(1.1)'; };
    switchTheme.onmouseleave = function() { this.style.transform = 'scale(1)'; };

    // 滚动时隐藏
    window.addEventListener('scroll', function() {
      switchTheme.style.display = (window.scrollY <= 300) ? 'flex' : 'none';
    });

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

    // auto 模式下，每分钟检查一次是否需要切换
    setInterval(function() {
      var currentMode = localStorage.getItem(THEME_STORAGE_KEY);
      if (currentMode === 'auto') {
        applyMode('auto');
      }
    }, 60000); // 60秒检查一次
  }

  // 导出模块
  global.ThemeSwitcher = {
    init: init,
    toggleTheme: toggleTheme,
    getAutoMode: getAutoMode
  };

})(window);
