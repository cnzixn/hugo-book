/**
 * 主题预加载脚本
 * 在页面渲染前设置主题，避免 FOUC 闪烁
 * 支持 auto(按时间) / light / dark 三种模式
 * 注意：此脚本必须在 <head> 中内联执行，不能用 defer
 */
(function() {
  var STORAGE_KEY = 'book-theme-mode';
  var DAY_START = 6;
  var DAY_END = 18;

  /**
   * 根据时间判断应该使用的模式
   */
  function getAutoMode() {
    var hour = new Date().getHours();
    return (hour >= DAY_START && hour < DAY_END) ? 'light' : 'dark';
  }

  var cur = document.documentElement.getAttribute('data-theme');
  if (!cur) return;

  // 获取保存的模式，默认 auto
  var mode = localStorage.getItem(STORAGE_KEY) || 'auto';

  // 解析实际应用的模式
  var effectiveMode = (mode === 'auto') ? getAutoMode() : mode;

  // 应用到 DOM
  var parts = cur.split('-');
  var base = parts.slice(0, -1).join('-');
  var newTheme = base ? base + '-' + effectiveMode : effectiveMode;
  document.documentElement.setAttribute('data-theme', newTheme);
})();
