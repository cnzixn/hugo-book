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
    /**
     * 带 try-catch 的安全初始化：一个模块挂了不影响其他，旧设备上报错不中断
     * 旧 iOS Safari 上 API 缺失时，单个模块可能抛 TypeError，
     * 用 wrapInit 每个独立保护，确保所有按钮都能创建出来
     */
    function wrapInit(name, fn) {
      try {
        if (fn && typeof fn.init === 'function') {
          fn.init();
        } else {
          console.warn('[init] ' + name + ' 不存在或无 init 方法');
        }
      } catch (err) {
        console.error('[init] ' + name + ' 初始化失败:', err && err.message ? err.message : err);
      }
    }

    wrapInit('Gesture', window.Gesture);
    wrapInit('ThemeSwitcher', window.ThemeSwitcher);
    wrapInit('BackToTop', window.BackToTop);

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
