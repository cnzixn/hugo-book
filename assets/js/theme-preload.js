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

  /**
   * 解析 data-theme，分离基础主题名和当前模式
   * 规则：最后一段是 light/dark 才视为模式，否则整体为基础主题名
   */
  function parseTheme(themeStr) {
    var parts = themeStr.split('-');
    var last = parts[parts.length - 1];
    if (last === 'light' || last === 'dark' || last === 'auto') {
      return {
        base: parts.slice(0, -1).join('-'),
        mode: last
      };
    }
    return { base: themeStr, mode: null };
  }

  // 获取保存的模式，默认 auto
  var savedMode = localStorage.getItem(STORAGE_KEY);
  var parsed = parseTheme(cur);
  // 优先级：localStorage > data-theme 自带后缀 > auto
  var mode = savedMode || parsed.mode || 'auto';

  // 解析实际应用的模式
  var effectiveMode = (mode === 'auto') ? getAutoMode() : mode;

  // 应用到 DOM
  var newTheme = parsed.base ? parsed.base + '-' + effectiveMode : effectiveMode;
  document.documentElement.setAttribute('data-theme', newTheme);
})();
