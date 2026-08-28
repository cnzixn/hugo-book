/* 图片轮播组件（gallery shortcode）：箭头翻页 + 边缘自动隐藏箭头 */
/* 页面可能有多个 gallery（每处都会输出 script 标签），用全局标记保证只初始化一次 */
(function () {
  if (window.__bookGalleryInit) return;
  window.__bookGalleryInit = true;

  /* 点击箭头：滚动一个视口宽度（smooth 平滑滚动） */
  function scrollGallery(btn, dir) {
    var track = btn.closest('.gallery-viewport').querySelector('.gallery-track');
    track.scrollBy({ left: dir * track.clientWidth * 0.9, behavior: 'smooth' });
  }

  /* 根据滚动位置切换 at-start / at-end 类，用于显隐两侧箭头 */
  function updateNavs(viewport) {
    var track = viewport.querySelector('.gallery-track');
    var max = track.scrollWidth - track.clientWidth;
    viewport.classList.toggle('at-start', track.scrollLeft <= 2);
    viewport.classList.toggle('at-end', track.scrollLeft >= max - 2);
  }

  /* 事件委托：一个监听器覆盖页面上所有 gallery 的箭头 */
  document.addEventListener('click', function (e) {
    var prev = e.target.closest('.gallery-prev');
    var next = e.target.closest('.gallery-next');
    if (prev) scrollGallery(prev, -1);
    if (next) scrollGallery(next, 1);
  });

  /* 滚动监听用 capture 委托，无需逐个绑定 */
  document.addEventListener('scroll', function (e) {
    var viewport = e.target.closest && e.target.closest('.gallery-viewport');
    if (viewport) updateNavs(viewport);
  }, true);

  /* 首次渲染时初始化所有 gallery 的箭头显隐状态 */
  function initAll() {
    document.querySelectorAll('.gallery-viewport').forEach(updateNavs);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
