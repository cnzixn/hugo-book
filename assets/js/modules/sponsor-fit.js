/**
 * 顶栏「赞助支持」入口：按实际可用宽度自动收成只留 ♥ 的紧凑形态
 *
 * 背景：移动端顶栏一行里有 菜单按钮 / 站点标题 / 赞助入口 / 目录按钮。
 * 站点标题比较长（如"饥荒模组手册"），窄屏（约 ≤430px，Android 多数机型）时
 * 四个元素塞不下 —— 赞助入口的文字会被压成 0 宽（看起来"隐身"，但点得到），
 * 甚至会盖到目录按钮上，导致目录图标被挡住、只有边缘能点到。
 *
 * 做法：不用 CSS 媒体查询硬编码断点（实际空间受字体/缩放影响），
 * 而是在运行时量一次真实宽度：把文字设为 hidden 再测（用 scrollWidth vs clientWidth，
 * 不受 title 的 ellipsis 影响），超出可用宽度就给按钮加 .is-compact，
 * 由 custom.css 收成「只有 ♥」的形态（仍保留 44×44 点击区）。
 *
 * 依赖：custom.css 里 .book-header-sponsor / .book-header-actions / .book-header-site-title
 *      的布局规则；本脚本跑在 DOMContentLoaded（defer）之后，页面首帧尚未绘制。
 */
(function (global) {
  'use strict';

  var COMPACT_CLASS = 'is-compact';
  var pending = false;

  /**
   * 量一次可用宽度并决定是否进入紧凑形态
   *
   * 前提（由 custom.css 保证）：.book-header-actions 不收缩、标题 flex:1 1 0，
   * 所以 actions.clientWidth 就是这一行真正能留给按钮组的宽度，
   * 不会被 flex 压缩或 ellipsis 裁剪影响测量。
   */
  function sync() {
    var actions = document.querySelector('.book-header-actions');
    var sponsor = document.querySelector('.book-header-sponsor');
    var label = sponsor ? sponsor.querySelector('span:not(.book-sponsor-icon)') : null;
    pending = false;

    if (!actions || !sponsor) return;

    var available = actions.clientWidth;
    // 兜底：容器宽度为 0（元素未布局）时不做判断，避免误收
    if (!available) {
      sponsor.classList.remove(COMPACT_CLASS);
      actions.classList.remove('is-hidden');
      return;
    }

    // 量文字实际渲染宽度：临时设为 hidden（无渲染、不闪烁）再读 clientWidth，
    // 此时布局已完成，拿到的是它真正占的宽度。
    var labelWidth = 0;
    if (label) {
      label.style.visibility = 'hidden';
      labelWidth = label.clientWidth;
      label.style.visibility = '';
    }

    // 除 ♥ 之外的所有固定占用（心形图标、间距、内边距、目录按钮），由浏览器量出
    var fixedWidth = sponsor.clientWidth - labelWidth;

    // 4px 余量，避免字体亚像素舍入导致的临界抖动
    if (fixedWidth + labelWidth > available + 4) {
      sponsor.classList.add(COMPACT_CLASS);
    } else {
      sponsor.classList.remove(COMPACT_CLASS);
    }

    // 极窄屏（<340px 左右）：菜单/目录按钮各自就要 44px，收成 ♥ 后仍可能顶住标题，
    // 这时整组隐藏 —— 该尺寸下顶栏本来就靠汉堡菜单，赞助入口走菜单里的同款入口。
    if (sponsor.classList.contains(COMPACT_CLASS) && actions.scrollWidth > available) {
      actions.classList.add('is-hidden');
    } else {
      actions.classList.remove('is-hidden');
    }
  }

  function schedule() {
    if (pending) return;
    pending = true;
    if (global.requestAnimationFrame) {
      global.requestAnimationFrame(sync);
    } else {
      setTimeout(sync, 16);
    }
  }

  function init() {
    sync();
    // 旋转屏幕 / 输入法弹出 / 浏览器 UI 收缩都会改变可用宽度
    global.addEventListener('resize', schedule, false);
    global.addEventListener('orientationchange', schedule, false);
    // 字体晚于脚本加载时（部分中文 webfont / 字体替换）宽度会变，补量几次
    setTimeout(sync, 300);
    setTimeout(sync, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.BookSponsorFit = {
    sync: sync
  };

})(window);
