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
   * 安全设置元素样式（兼容旧 Safari：Object.assign 可能失效时，逐个赋值兜底）
   * @param {HTMLElement} el - 目标元素
   * @param {Object} styles - 样式键值对
   */
  function setStyles(el, styles) {
    if (Object.assign) {
      try { Object.assign(el.style, styles); return; } catch (e) { /* 降级 */ }
    }
    for (var key in styles) {
      if (styles.hasOwnProperty(key)) {
        el.style[key] = styles[key];
      }
    }
  }

  /**
   * 平滑滚动到页面顶部（Safari 兼容版：原生 smooth 不支持时用定时器模拟）
   */
  function smoothScrollToTop() {
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      // Safari 15.4+ 原生 smooth 已经支持
      // 但为了保险，检测 80ms 后是否真的开始滚动，没动则走降级
      var startY = window.scrollY || window.pageYOffset;
      setTimeout(function () {
        if ((window.scrollY || window.pageYOffset) === startY && startY > 0) {
          fallbackScrollToTop();
        }
      }, 100);
      return;
    } catch (e) { /* 降级 */ }
    fallbackScrollToTop();
  }

  /**
   * 手动实现平滑返回顶部（基于 requestAnimationFrame）
   */
  function fallbackScrollToTop() {
    var currentY = window.scrollY || window.pageYOffset;
    var duration = 400;
    var startTime = null;
    function step(ts) {
      if (!startTime) startTime = ts;
      var progress = Math.min((ts - startTime) / duration, 1);
      // easeOutCubic 缓动：看起来更自然
      var eased = 1 - Math.pow(1 - progress, 3);
      var targetY = currentY * (1 - eased);
      window.scrollTo(0, targetY);
      if (progress < 1 && (window.scrollY || window.pageYOffset) > 0) {
        if (window.requestAnimationFrame) {
          window.requestAnimationFrame(step);
        } else {
          setTimeout(function () { step(ts + 16); }, 16);
        }
      }
    }
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(step);
    } else {
      step(0);
    }
  }

  /**
   * 按 scrollY 同步显示状态（scrollY >= 300 显示，<300 隐藏）
   * 用 requestAnimationFrame 合并写入，避免滚动期间每秒多次 reflow
   */
  function updateVisibilityByScroll() {
    if (!backToTop) return;
    var scrollY = window.scrollY || window.pageYOffset || 0;
    backToTop.style.display = (scrollY >= SCROLL_THRESHOLD) ? 'flex' : 'none';
    pendingScrollUpdate = false;
  }

  /**
   * 添加事件监听（兼容旧 Safari：addEventListener 第三个参数不支持对象时降级为 false）
   * @param {EventTarget} target - 监听目标
   * @param {string} type - 事件名
   * @param {Function} handler - 回调
   * @param {Object|boolean} options - 选项
   */
  function addSafeListener(target, type, handler, options) {
    var opts = options;
    // 检测是否支持 passive 选项
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
    backToTop = document.createElement('div');
    backToTop.id = 'back-to-top';
    backToTop.setAttribute('role', 'button');
    backToTop.setAttribute('tabindex', '0');
    /* 图标来自 assets/bi-arrow-up.svg（Bootstrap Icons），fill=currentColor 跟随主题色 */
    backToTop.innerHTML = '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8 15a.5.5 0 0 0 .5-.5V2.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 1 0 .708.708L7.5 2.707V14.5a.5.5 0 0 0 .5.5"/></svg>';
    backToTop.title = '返回顶部';

    setStyles(backToTop, {
      position: 'fixed',
      bottom: '120px',
      right: '20px',
      zIndex: '9999',
      width: '40px',
      height: '40px',
      borderRadius: '50%',
      cursor: 'pointer',
      fontSize: '18px',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      transform: 'scale(1)',
      transformOrigin: 'center center',
      /* 旧版 Safari 的 webkit 前缀兜底 */
      webkitTransform: 'scale(1)',
      webkitTransformOrigin: 'center center'
    });

    /**
     * 仅 transform scale 放大反馈，颜色全由 CSS 固定控制
     * @param {HTMLElement} btn - 按钮 DOM 元素
     * @param {number} sizeLevel - 缩放档位：1（默认） / 1.05（按下） / 1.1（悬停）
     */
    function forceVisualReset(btn, sizeLevel) {
      var scale = 'scale(' + sizeLevel + ')';
      btn.style.transform = scale;
      btn.style.webkitTransform = scale;
    }

    /* 仅保留矢量尺寸反馈 */
    backToTop.onmouseenter = function() { forceVisualReset(backToTop, 1.1); };
    backToTop.onmouseleave = function() { forceVisualReset(backToTop, 1); };
    backToTop.onmousedown = function() { forceVisualReset(backToTop, 1.05); };
    backToTop.onmouseup = function() { forceVisualReset(backToTop, 1.1); };
    backToTop.onfocus = function() { forceVisualReset(backToTop, 1); };
    backToTop.onblur = function() { forceVisualReset(backToTop, 1); };

    backToTop.onclick = function() {
      smoothScrollToTop();
    };

    // passive: true → 不阻塞滚动合成线程，降低掉帧
    addSafeListener(window, 'scroll', onScroll, { passive: true });

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
