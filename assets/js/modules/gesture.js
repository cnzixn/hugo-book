/**
 * 移动端手势模块
 * 功能：右滑打开菜单、左滑关闭菜单、点击外部关闭
 */
(function(global) {
  'use strict';

  var MOBILE_BREAKPOINT = 896; // 56rem
  var EDGE_THRESHOLD = 50; // 边缘触发区域(px)
  var SWIPE_THRESHOLD = 40; // 滑动距离阈值(px)
  var VERTICAL_THRESHOLD = 30; // 垂直方向阈值(px)

  var touchStartX = 0;
  var touchStartY = 0;
  var touchCurrentX = 0;
  var isSwiping = false;
  var isEdgeSwipe = false;
  var menuControl = null;

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
   * 打开菜单
   */
  function openMenu() {
    var ctrl = getMenuControl();
    if (ctrl && !ctrl.checked) {
      ctrl.checked = true;
      ctrl.dispatchEvent(new Event('change'));
    }
  }

  /**
   * 关闭菜单
   */
  function closeMenu() {
    var ctrl = getMenuControl();
    if (ctrl && ctrl.checked) {
      ctrl.checked = false;
      ctrl.dispatchEvent(new Event('change'));
    }
  }

  /**
   * 初始化手势事件
   */
  function init() {
    // 触摸开始
    document.addEventListener('touchstart', function(e) {
      if (!isMobile()) return;

      var touch = e.touches[0];
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchCurrentX = touchStartX;
      isSwiping = true;
      isEdgeSwipe = (touchStartX <= EDGE_THRESHOLD);
    }, { passive: true });

    // 触摸移动
    document.addEventListener('touchmove', function(e) {
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
    document.addEventListener('touchend', function(e) {
      if (!isSwiping || !isMobile()) {
        isSwiping = false;
        isEdgeSwipe = false;
        return;
      }

      var deltaX = touchCurrentX - touchStartX;
      var ctrl = getMenuControl();
      var isMenuOpen = ctrl && ctrl.checked;

      // 打开菜单：右滑超过阈值
      if (deltaX >= SWIPE_THRESHOLD) {
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
    }, { passive: true });

    // 点击菜单外部区域关闭菜单
    document.addEventListener('click', function(e) {
      if (!isMobile()) return;

      var ctrl = getMenuControl();
      if (!ctrl || !ctrl.checked) return;

      // 检查是否点击了菜单按钮或其内部元素
      var target = e.target;
      var isMenuToggle = false;
      while (target && target !== document) {
        if (target.getAttribute && target.getAttribute('for') === 'menu-control') {
          isMenuToggle = true;
          break;
        }
        if (target.id === 'menu-control') {
          isMenuToggle = true;
          break;
        }
        target = target.parentNode;
      }
      if (isMenuToggle) return;

      // 点击菜单内部不关闭
      var menuContent = document.querySelector('.book-menu .book-menu-content');
      if (menuContent && menuContent.contains(e.target)) return;

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
