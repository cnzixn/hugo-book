/* 图片轮播组件（gallery shortcode）：箭头翻页 + 边缘自动隐藏箭头 */
/* 页面可能有多个 gallery（每处都会输出 script 标签），用全局标记保证只初始化一次 */
(function () {
  if (window.__bookGalleryInit) return;
  window.__bookGalleryInit = true;

  /**
   * 平滑滚动到指定位置（Safari 兼容版：原生 smooth 不支持时用定时器模拟）
   * @param {HTMLElement} el - 滚动容器
   * @param {number} targetLeft - 目标 scrollLeft 值
   */
  function smoothScrollLeft(el, targetLeft) {
    // 优先尝试原生 smooth 行为
    try {
      el.scrollTo({ left: targetLeft, behavior: 'smooth' });
      return;
    } catch (e) { /* 旧浏览器抛错，走下面降级 */ }
    // 降级：定时线性滚动（够用的简易版）
    var startLeft = el.scrollLeft;
    var distance = targetLeft - startLeft;
    var duration = 300;
    var startTime = null;
    function step(ts) {
      if (!startTime) startTime = ts;
      var progress = Math.min((ts - startTime) / duration, 1);
      el.scrollLeft = startLeft + distance * progress;
      if (progress < 1) {
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

  /* 点击箭头：滚动一个视口宽度（smooth 平滑滚动） */
  function scrollGallery(btn, dir) {
    var viewport = btn.closest ? btn.closest('.gallery-viewport') : findParent(btn, 'gallery-viewport');
    var track = viewport.querySelector('.gallery-track');
    var target = track.scrollLeft + dir * track.clientWidth * 0.9;
    smoothScrollLeft(track, Math.max(0, Math.min(target, track.scrollWidth - track.clientWidth)));
  }

  /**
   * Element.closest 降级兼容（Safari <9）
   */
  function findParent(el, cls) {
    var cur = el;
    while (cur) {
      if (cur.classList && cur.classList.contains(cls)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  /* 根据滚动位置切换 at-start / at-end 类，用于显隐两侧箭头 */
  function updateNavs(viewport) {
    var track = viewport.querySelector('.gallery-track');
    var max = track.scrollWidth - track.clientWidth;
    // classList.toggle 的第二参数兼容写法
    if (track.scrollLeft <= 2) {
      viewport.classList.add('at-start');
    } else {
      viewport.classList.remove('at-start');
    }
    if (track.scrollLeft >= max - 2) {
      viewport.classList.add('at-end');
    } else {
      viewport.classList.remove('at-end');
    }
  }

  /* 事件委托：一个监听器覆盖页面上所有 gallery 的箭头 */
  document.addEventListener('click', function (e) {
    var prev = (e.target.closest ? e.target.closest('.gallery-prev') : findParent(e.target, 'gallery-prev'));
    var next = (e.target.closest ? e.target.closest('.gallery-next') : findParent(e.target, 'gallery-next'));
    if (prev) scrollGallery(prev, -1);
    if (next) scrollGallery(next, 1);
  });

  /* 滚动监听用 capture 委托，无需逐个绑定 */
  document.addEventListener('scroll', function (e) {
    var viewport = (e.target.closest && e.target.closest('.gallery-viewport')) || findParent(e.target, 'gallery-viewport');
    if (viewport) updateNavs(viewport);
  }, true);

  /* 首次渲染时初始化所有 gallery 的箭头显隐状态 */
  function refreshAll() {
    // NodeList.forEach 兼容：转数组再 for
    var list = document.querySelectorAll('.gallery-viewport');
    for (var i = 0; i < list.length; i++) updateNavs(list[i]);
  }

  /* 图片是 loading="lazy" 且没有 width/height：脚本执行时图片多半还没下载/解码，
     此刻轨道量不到溢出（scrollWidth==clientWidth，max=0），会被同时标成
     at-start + at-end，左右箭头一起被 CSS 隐藏；等图片加载完成、轨道变宽后又
     不会触发 scroll 事件，箭头就再也不出现。所以要在图片 load、窗口 resize、
     页面 load 时重新计算一次箭头状态。 */
  var raf = window.requestAnimationFrame ||
    function (cb) { return setTimeout(cb, 120); };
  var resizePending = null;
  window.addEventListener('resize', function () {
    if (resizePending) return;
    resizePending = raf(function () {
      resizePending = null;
      refreshAll();
    });
  });
  // img 的 load 事件不冒泡，但会经过捕获阶段，用 capture 委托统一监听即可
  document.addEventListener('load', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'IMG') return;
    var viewport = (el.closest && el.closest('.gallery-viewport')) || findParent(el, 'gallery-viewport');
    if (viewport) updateNavs(viewport);
  }, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshAll);
  } else {
    refreshAll();
  }
  if (document.readyState === 'complete') {
    refreshAll();
  } else {
    window.addEventListener('load', refreshAll);
  }
})();
