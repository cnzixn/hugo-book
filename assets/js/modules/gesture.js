/**
 * 移动端手势模块
 * 功能：右滑打开菜单、左滑关闭菜单、点击外部关闭
 */
(function(global) {
  'use strict';

  var MOBILE_BREAKPOINT = 896; // 56rem
  var EDGE_THRESHOLD = 120; // 边缘触发区域(px) — 旧 iOS 边缘识别不准，放大到 120
  var SWIPE_THRESHOLD = 25; // 滑动距离阈值(px) — 降低门槛，避免滑了白划
  var VERTICAL_THRESHOLD = 30; // 垂直方向阈值(px)

  var touchStartX = 0;
  var touchStartY = 0;
  var touchCurrentX = 0;
  var isSwiping = false;
  var isEdgeSwipe = false;
  var inScroller = false; // 触摸起点是否位于可横向滑动区域（轮播/横向滚动表格等）
  var menuControl = null;

  /**
   * 添加事件监听（兼容旧 Safari：passive 选项不支持时降级为布尔值）
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
   * 检测是否为移动端
   */
  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  /**
   * 获取菜单控制复选框
   */
  function getMenuControl() {
    if (!menuControl) {
      menuControl = document.getElementById('menu-control');
    }
    return menuControl;
  }

  /**
   * 判断当前页面是否存在左侧菜单
   * 主页使用 landing 布局，其 menu-container 被覆盖为空，不会渲染 aside.book-menu，
   * 此时右滑手势不应尝试打开一个不存在的菜单（否则只会弹出遮罩层）
   * @returns {boolean} 存在左侧菜单返回 true
   */
  function hasMenu() {
    return !!document.querySelector('.book-menu');
  }

  /**
   * 判断触摸目标是否位于可横向滑动的区域内
   * 用途：图片轮播、横向滚动表格等区域自身需要消费横向手势，
   *       在这些区域内右滑不应拉出菜单
   * @param {EventTarget} target - 触摸起点元素
   * @returns {boolean} 位于可横向滑动区域内返回 true
   */
  /**
   * 将事件目标统一为 Element
   * 旧 iOS Safari 的 touchstart / click 事件 target 可能是 Text 节点或非 Element 节点，
   * 直接 instanceof Element 会失败，这里向上找到最近的 Element 父节点再返回
   * @param {EventTarget} target
   * @returns {Element|null}
   */
  function ensureElement(target) {
    var el = target;
    while (el && !(el instanceof Element) && el.parentNode) {
      el = el.parentNode;
    }
    return (el instanceof Element) ? el : null;
  }

  function isInsideHorizontalScroller(target) {
    var el = ensureElement(target);
    while (el && el !== document.body) {
      // 存在横向溢出且 overflow-x 允许滚动，视为横向滑动区域
      if (el.scrollWidth > el.clientWidth + 1) {
        var overflowX;
        try {
          overflowX = getComputedStyle(el).overflowX;
        } catch (e) { overflowX = ''; }
        if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') {
          return true;
        }
      }
      el = el.parentElement;
    }
    return false;
  }

  /**
   * 创建原生 Event（兼容旧浏览器：new Event() 抛错时用 createEvent）
   */
  function createNativeEvent(type) {
    try {
      return new Event(type, { bubbles: true, cancelable: true });
    } catch (e) {
      var evt = document.createEvent('Event');
      evt.initEvent(type, true, true);
      return evt;
    }
  }

  /**
   * 同步 checkbox 的勾选状态（三路径强制生效）
   * 旧 iOS WebKit 的 3 个已知坑：
   *   ① 只改 .checked 有时不会触发 :checked ~ main CSS 兄弟选择器重绘
   *   ② off-screen (display:none + width/height:0) 的 checkbox 改 defaultChecked 可稳定关联 label[for]
   *   ③ 必须触发一次 reflow（读 body.offsetWidth）让旧 WebKit 重新匹配选择器
   * @param {HTMLInputElement} ctrl - menu-control 或 toc-control 的 checkbox
   * @param {boolean} checked - 目标状态
   */
  function syncCheckbox(ctrl, checked) {
    if (!ctrl) return;
    ctrl.checked = checked;
    ctrl.defaultChecked = checked;
    // 旧 iOS label[for] 关联失效兜底：手动模拟一次 focus + click
    try {
      ctrl.focus();
      ctrl.click();
      // click() 可能会反向改 .checked，再强制同步一次
      if (ctrl.checked !== checked) {
        ctrl.checked = checked;
        ctrl.defaultChecked = checked;
      }
    } catch (e) { /* 旧浏览器不支持 click() 时静默 */ }
    // 强制 reflow，触发旧 WebKit 重新计算 :checked ~ main 的兄弟选择器
    try { void document.body.offsetWidth; } catch (e) {}
    ctrl.dispatchEvent(createNativeEvent('change'));
  }

  /**
   * 打开菜单（三路径同步：.checked / .defaultChecked / force reflow）
   */
  function openMenu() {
    if (!hasMenu()) return; // 页面无左菜单（如主页 landing 布局），右滑不尝试打开
    var ctrl = getMenuControl();
    if (ctrl && !ctrl.checked) {
      syncCheckbox(ctrl, true);
    }
  }

  /**
   * 关闭菜单（三路径同步：.checked / .defaultChecked / force reflow）
   */
  function closeMenu() {
    var ctrl = getMenuControl();
    if (ctrl && ctrl.checked) {
      syncCheckbox(ctrl, false);
    }
  }

  /**
   * 初始化手势事件
   */
  function init() {
    // 触摸开始
    addSafeListener(document, 'touchstart', function(e) {
      if (!isMobile()) return;

      var touch = e.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchCurrentX = touchStartX;
      isSwiping = true;
      isEdgeSwipe = (touchStartX <= EDGE_THRESHOLD);
      // 记录触摸起点是否在可横向滑动区域（轮播/横向表格等）
      // ensureElement 兜底：旧 iOS touchstart 的 e.target 可能返回 Text 节点
      inScroller = isInsideHorizontalScroller(ensureElement(e.target));
    }, { passive: true });

    // 触摸移动
    addSafeListener(document, 'touchmove', function(e) {
      if (!isSwiping || !isMobile()) return;

      var touch = e.touches[0];
      touchCurrentX = touch.clientX;
      var deltaX = touchCurrentX - touchStartX;
      var deltaY = Math.abs(touch.clientY - touchStartY);

      // 如果垂直移动为主，取消滑动判断
      if (deltaY > VERTICAL_THRESHOLD && Math.abs(deltaX) < deltaY) {
        isSwiping = false;
        isEdgeSwipe = false;
      }
    }, { passive: true });

    // 触摸结束
    addSafeListener(document, 'touchend', function(e) {
      if (!isSwiping || !isMobile()) {
        isSwiping = false;
        isEdgeSwipe = false;
        inScroller = false;
        return;
      }

      var deltaX = touchCurrentX - touchStartX;
      var ctrl = getMenuControl();
      var isMenuOpen = ctrl && ctrl.checked;

      // 打开菜单：右滑超过阈值，且起点不在可横向滑动区域内（轮播等区域不触发）
      if (deltaX >= SWIPE_THRESHOLD && !inScroller) {
        if (!isMenuOpen) {
          openMenu();
        }
      }
      // 关闭菜单：左滑超过阈值且菜单已打开
      else if (deltaX <= -SWIPE_THRESHOLD && isMenuOpen) {
        closeMenu();
      }

      isSwiping = false;
      isEdgeSwipe = false;
      inScroller = false;
    }, { passive: true });

    // 点击菜单外部区域关闭菜单
    document.addEventListener('click', function(e) {
      if (!isMobile()) return;

      var ctrl = getMenuControl();
      if (!ctrl || !ctrl.checked) return;

      // ensureElement 兜底：旧 iOS click 的 e.target 可能返回 Text 节点
      // 同时用于 getAttribute 遍历与 menuContent.contains 判断
      var target = ensureElement(e.target);
      var isMenuToggle = false;
      var walkEl = target;
      while (walkEl && walkEl !== document) {
        if (walkEl.getAttribute && walkEl.getAttribute('for') === 'menu-control') {
          isMenuToggle = true;
          break;
        }
        if (walkEl.id === 'menu-control') {
          isMenuToggle = true;
          break;
        }
        walkEl = walkEl.parentNode;
      }
      if (isMenuToggle) return;

      // 点击菜单内部不关闭（target 已是 ensureElement 后的 Element）
      var menuContent = document.querySelector('.book-menu .book-menu-content');
      if (target && menuContent && menuContent.contains(target)) return;

      // 点击菜单外部关闭
      closeMenu();
    });
  }

  // 导出模块
  global.Gesture = {
    init: init,
    isMobile: isMobile,
    openMenu: openMenu,
    closeMenu: closeMenu
  };

})(window);
