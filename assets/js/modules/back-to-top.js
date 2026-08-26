/**
 * 返回顶部按钮模块
 * 功能：滚动超过 300px 时显示，点击平滑返回顶部
 */
(function(global) {
  'use strict';

  var backToTop = null;
  var SCROLL_THRESHOLD = 300;
  var pendingScrollUpdate = false;

  /**
   * 按 scrollY 同步显示状态（scrollY >= 300 显示，<300 隐藏）
   * 用 requestAnimationFrame 合并写入，避免滚动期间每秒多次 reflow
   */
  function updateVisibilityByScroll() {
    if (!backToTop) return;
    backToTop.style.display = (window.scrollY >= SCROLL_THRESHOLD) ? 'flex' : 'none';
    pendingScrollUpdate = false;
  }

  /**
   * 滚动回调（passive 不阻塞合成）
   */
  function onScroll() {
    if (pendingScrollUpdate) return;
    pendingScrollUpdate = true;
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(updateVisibilityByScroll);
    } else {
      updateVisibilityByScroll();
    }
  }

  /**
   * 创建返回顶部按钮
   */
  function createButton() {
    backToTop = document.createElement('button');
    backToTop.id = 'back-to-top';
    backToTop.innerHTML = '⬆';
    backToTop.title = '返回顶部';

    Object.assign(backToTop.style, {
      position: 'fixed',
      bottom: '120px',
      right: '20px',
      zIndex: '9999',
      width: '40px',
      height: '40px',
      borderRadius: '50%',
      border: 'none',
      background: 'var(--gray-100)',
      cursor: 'pointer',
      fontSize: '18px',
      color: 'var(--body-font-color)',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.8)',
      transition: 'all 0.2s ease'
    });

    backToTop.onclick = function() {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    // passive: true → 不阻塞滚动合成线程，降低掉帧
    window.addEventListener('scroll', onScroll, { passive: true });

    document.body.appendChild(backToTop);
  }

  /**
   * 根据滚动位置更新返回顶部按钮可见性（对外兼容接口）
   *   scrollY <  300 → 隐藏
   *   scrollY >= 300 → 显示（与主题按钮位置重合、显示状态相反）
   */
  function updateVisibility() {
    updateVisibilityByScroll();
  }

  /**
   * 初始化返回顶部按钮
   */
  function init() {
    createButton();
    updateVisibility();
  }

  // 导出模块
  global.BackToTop = {
    init: init
  };

})(window);
