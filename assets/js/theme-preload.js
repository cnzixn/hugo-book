/**
 * 主题预加载脚本
 * 在页面渲染前设置主题，避免 FOUC 闪烁
 * 支持 light / dark 两种模式
 * 注意：此脚本必须在 <head> 中内联执行，不能用 defer
 */
(function() {
  var STORAGE_KEY = 'book-theme-mode';

  var cur = document.documentElement.getAttribute('data-theme');
  if (!cur) return;

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

  // 获取保存的模式（兼容旧用户：auto 视为无效，回退 light）
  var savedMode = localStorage.getItem(STORAGE_KEY);
  var parsed = parseTheme(cur);
  // 优先级：localStorage > data-theme 自带后缀 > light
  var mode = (savedMode === 'light' || savedMode === 'dark')
    ? savedMode
    : (parsed.mode || 'light');

  // 应用到 DOM
  var newTheme = parsed.base ? parsed.base + '-' + mode : mode;
  document.documentElement.setAttribute('data-theme', newTheme);
})();
