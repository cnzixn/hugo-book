/**
 * 主入口文件
 * 初始化所有模块
 */
(function() {
  'use strict';

  // 等待 DOM 就绪后初始化
  function ready(fn) {
    if (document.readyState !== 'loading') {
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn);
    }
  }

  ready(function() {
    // 初始化各模块
    if (window.Gesture) {
      window.Gesture.init();
    }
    if (window.ThemeSwitcher) {
      window.ThemeSwitcher.init();
    }
    if (window.BackToTop) {
      window.BackToTop.init();
    }

    // 按钮悬停样式（通过 JS 添加类，避免依赖 custom.css 中的选择器）
    var style = document.createElement('style');
    style.textContent = [
      '#theme-switcher:hover,',
      '#back-to-top:hover {',
      '  border-color: var(--primary) !important;',
      '  background: var(--entry) !important;',
      '}'
    ].join('');
    document.head.appendChild(style);
  });

})();
