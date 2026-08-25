/**
 * 返回顶部按钮模块
 * 功能：滚动超过 300px 时显示，点击平滑返回顶部
 */
(function(global) {
  'use strict';

  var backToTop = null;
  var SCROLL_THRESHOLD = 300;

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
      border: '1px solid var(--border)',
      background: 'var(--code-bg)',
      cursor: 'pointer',
      fontSize: '18px',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
      transition: 'all 0.2s ease'
    });

    backToTop.onclick = function() {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    window.addEventListener('scroll', updateVisibility);
    document.body.appendChild(backToTop);
  }

  /**
   * 根据滚动位置更新按钮可见性
   */
  function updateVisibility() {
    if (!backToTop) return;
    backToTop.style.display = (window.scrollY > SCROLL_THRESHOLD) ? 'flex' : 'none';
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
