/**
 * 移动端手势模块
 * 功能：
 *   1) 侧栏抽屉跟手拖动：正文任意位置右滑拉出、打开态任意位置左滑收回（正文同步位移）
 *   2) 松手判定：先看"快滑速度"（抬手前 100ms 的平均速度），再看"拉出进度"
 *   3) 点击菜单外区域 / 遮罩关闭菜单
 *
 * 与 CSS 的契约（assets/styles/custom.css「移动端左侧菜单：抽屉式」）：
 *   main.container.flex 上的两个变量驱动全部位移：
 *     --bk-drawer          开合位移(px)  → .book-menu 与 .book-page 的 transform
 *     --bk-drawer-progress 开合进度(0~1) → 遮罩透明度
 *   静止值由 #menu-control:checked 决定（关 0 / 开 var(--menu-width)）。
 *   拖动期间这里在 main 上写内联变量覆盖它们，并给 body 加 .bk-dragging
 *   （关掉过渡、强制面板可见、压低右下角悬浮按钮的层级）；
 *   松手时删掉内联变量把控制权交回 CSS ——
 *   于是「拉出不足会回弹」由 transform 的过渡曲线自然完成，不需要 JS 逐帧动画。
 */
(function(global) {
  'use strict';

  var MOBILE_BREAKPOINT = 896;  // 56rem，与 CSS 断点一致
  var AXIS_LOCK = 12;           // 方向锁定阈值(px)：超过才判定横向还是纵向，兼作防误触余量
  var OPEN_THRESHOLD = 0.4;     // 松手时的位移进度：≥ 此值展开，否则回弹（慢速拖动走这条）
  // —— 快滑（甩）相关 ——
  // 快速滑一下往往拉不到 40%（≈102px），必须靠速度判定放行，否则"快滑没反应"。
  var FLING_VELOCITY = 0.3;     // 甩动判定(px/ms)：≈300px/s，超过就按方向立即开/关
  var FLING_WINDOW = 100;       // 速度统计窗口(ms)：只取抬手前这段时间的采样
  var FLING_MIN_DISTANCE = 24;  // 该窗口内至少要有这么多位移，否则算抖动不算甩
  var FLING_MAX_SAMPLES = 8;    // 窗口内最多保留的采样点数
  var CLICK_SUPPRESS_MS = 350;  // 拖动后屏蔽紧随其后的 click，避免误触正文链接

  var mainEl = null;
  var menuControl = null;

  var dragging = false;
  var axis = null;              // null=未定向 / 'x'=横向拖动中 / 'y'=交还纵向滚动
  var startX = 0;
  var startY = 0;
  var startTime = 0;
  var startOffset = 0;
  var currentOffset = 0;
  var menuWidth = 0;
  var lastX = 0;
  var lastTime = 0;
  var sampleX = [];             // 最近 FLING_WINDOW 内的触摸采样（算速度用）
  var sampleT = [];
  var moved = false;
  var suppressClickUntil = 0;

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
   * 检测是否为移动端（与 CSS 断点一致）
   */
  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  /**
   * main.container.flex —— 抽屉位移变量的挂载点
   */
  function getMain() {
    if (!mainEl || !mainEl.parentNode) {
      mainEl = document.querySelector('main.container');
    }
    return mainEl;
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
   * 此时右滑手势不应尝试打开一个不存在的菜单（否则只会把正文推走）
   * @returns {boolean} 存在左侧菜单返回 true
   */
  function hasMenu() {
    return !!document.querySelector('.book-menu');
  }

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

  /**
   * 判断触摸目标是否位于可横向滑动的区域内
   * 用途：图片轮播、横向滚动表格等区域自身需要消费横向手势，
   *       在这些区域内右滑不应拉出菜单
   * @param {EventTarget} target - 触摸起点元素
   * @returns {boolean} 位于可横向滑动区域内返回 true
   */
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
      // preventScroll：checkbox 是 0 尺寸绝对定位元素，旧 Safari 忽略该参数也不会更糟
      ctrl.focus({ preventScroll: true });
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
   * 量抽屉宽度（= CSS 的 --menu-width，正文要右移同样的距离）
   * @returns {number} 像素宽度
   */
  function measureMenuWidth() {
    var menu = document.querySelector('.book-menu');
    var width = (menu && menu.offsetWidth) || 0;
    if (width > 0) return width;
    // 兜底：解析 --menu-width（形如 "16rem"）+ 根字号
    try {
      var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      var raw = getComputedStyle(document.body).getPropertyValue('--menu-width');
      var num = parseFloat(raw);
      if (num > 0) width = /rem/.test(raw) ? num * rem : num;
    } catch (e) { /* 读不到就用下面的默认值 */ }
    return width > 0 ? width : 256;
  }

  /**
   * 读取正文当前实际的横向位移
   * getComputedStyle 在过渡进行中返回的是插值后的矩阵，所以这里拿到的是"眼睛看到的位置"
   * @returns {number} 位移 px；读不到时返回 -1
   */
  function readCurrentOffset() {
    var page = document.querySelector('.book-page');
    if (!page) return -1;
    var matrix;
    try { matrix = getComputedStyle(page).transform; } catch (e) { return -1; }
    if (!matrix || matrix === 'none') return 0;
    var nums = matrix.match(/-?[\d.]+(?:e[-+]?\d+)?/gi);
    if (!nums) return 0;
    // matrix(a, b, c, d, tx, ty) → tx 是第 5 个；matrix3d(...) → tx 是第 13 个
    if (nums.length >= 16) return parseFloat(nums[12]) || 0;
    if (nums.length >= 6) return parseFloat(nums[4]) || 0;
    return 0;
  }

  /**
   * 把当前位移写进 CSS 变量（拖动期间的内联值，优先于 :checked 的静止值）
   * @param {number} px - 0 ~ menuWidth
   */
  function setOffset(px) {
    var main = getMain();
    if (!main) return;
    currentOffset = px;
    main.style.setProperty('--bk-drawer', px + 'px');
    main.style.setProperty('--bk-drawer-progress', String(menuWidth > 0 ? px / menuWidth : 0));
  }

  /**
   * 记一个触摸采样点，并丢掉滑出统计窗口的旧点
   * @param {number} x - clientX
   * @param {number} t - 事件时间戳(ms)
   */
  function pushSample(x, t) {
    sampleX.push(x);
    sampleT.push(t);
    while (sampleT.length > 1 &&
           (t - sampleT[0] > FLING_WINDOW || sampleT.length > FLING_MAX_SAMPLES)) {
      sampleX.shift();
      sampleT.shift();
    }
  }

  /**
   * 用「抬手前 FLING_WINDOW 内的采样」算甩动速度
   *
   * 关键：绝不能用「最后一次 touchmove → touchend」这一段算 ——
   * 手指抬起时的坐标和最后一次 move 基本完全一样，那一段位移恒为 0，
   * 于是"快速滑一下"永远算不出速度，只能退化成 40% 位移阈值，
   * 短促的快滑就被弹回去了（这就是"快滑打不开"的根因）。
   * 改成取窗口内首尾两点求平均速度：快滑 100~200px 落在 100ms 里 → 1~2px/ms，稳过阈值。
   *
   * @param {number} endX - 抬手坐标
   * @param {number} endT - 抬手时间戳
   * @returns {number} px/ms（正=往右，负=往左）
   */
  function flingVelocity(endX, endT) {
    pushSample(endX, endT);
    if (sampleT.length < 2) return 0;
    var dt = endT - sampleT[0];
    var dx = endX - sampleX[0];
    if (dt <= 0) return 0;
    // 窗口内几乎没动 → 只是手指抖了一下，不算甩，交回位移阈值判定
    if (Math.abs(dx) < FLING_MIN_DISTANCE) return 0;
    return dx / dt;
  }

  /**
   * 删掉拖动期间的内联变量，把位移交回 :checked 决定的静止值
   * （CSS 的 transform 过渡会从这里平滑滑向静止值 —— 也就是「回弹」）
   */
  function clearOffset() {
    var main = getMain();
    if (!main) return;
    main.style.removeProperty('--bk-drawer');
    main.style.removeProperty('--bk-drawer-progress');
  }

  /**
   * 按拖动结果写最终开合状态
   * 注意：syncCheckbox 内部有强制重排，所以必须在 endDrag() 之前调用 ——
   *       此时 .bk-dragging 与内联变量都还在，重排不会让画面从手指位置跳一下
   * @param {boolean} open
   */
  function applyOpen(open) {
    var ctrl = getMenuControl();
    if (!ctrl || ctrl.checked === open) return;
    syncCheckbox(ctrl, open);
  }

  /**
   * 结束拖动：摘掉 .bk-dragging（恢复过渡）并清掉内联位移变量
   */
  function endDrag() {
    dragging = false;
    axis = null;
    if (document.body) document.body.classList.remove('bk-dragging');
    clearOffset();
  }

  /**
   * 点遮罩关闭抽屉后，把焦点从 #menu-control / 遮罩上摘掉
   *
   * 为什么需要：遮罩是 <label for="menu-control">，点它 = 激活 checkbox。
   * Safari（含 iOS）把 label 视为可聚焦元素，点完会把焦点留在它/checkbox 上，
   * 于是留下系统默认的蓝色 focus ring —— 表现就是「点菜单外面有个蓝色 hover 效果」。
   * CSS 里已经抹掉 outline / tap-highlight（custom.css），这里再把焦点挪走做双保险。
   */
  function blurMenuControl() {
    var ctrl = getMenuControl();
    try { if (ctrl && ctrl.blur) ctrl.blur(); } catch (e) { /* 忽略 */ }
    var active = document.activeElement;
    if (active && active.classList && active.classList.contains('book-menu-overlay') && active.blur) {
      try { active.blur(); } catch (e) { /* 忽略 */ }
    }
  }

  /**
   * 打开菜单（对外 API，保留旧接口）
   */
  function openMenu() {
    if (!hasMenu()) return; // 页面无左菜单（如主页 landing 布局），不尝试打开
    applyOpen(true);
  }

  /**
   * 关闭菜单（对外 API，保留旧接口）
   */
  function closeMenu() {
    applyOpen(false);
  }

  /**
   * 触摸起点是否落在 label[for=menu-control] / #menu-control 上
   * 命中就交还给浏览器原生的 label 激活行为，JS 不再插手（否则会和原生开关互相抵消）
   */
  function isMenuToggle(target) {
    var walkEl = ensureElement(target);
    while (walkEl && walkEl !== document) {
      if (walkEl.getAttribute && walkEl.getAttribute('for') === 'menu-control') return true;
      if (walkEl.id === 'menu-control') return true;
      walkEl = walkEl.parentNode;
    }
    return false;
  }

  /**
   * 触摸是否发生在「右下角浮动按钮」上（#theme-switcher：主题切换 / 返回顶部，且可拖动）
   *
   * 为什么必须排除：这个按钮自己消费横向手势（按住往右拖是挪位置），
   * 而抽屉手势是「正文任意位置起手、按方向判定」——不排除的话，
   * 在按钮上往右拖会同时被判成抽屉手势，一拖就把菜单拉出来（2026-09 实测问题）。
   * 只认这一个元素，其余区域（包括菜单里的按钮）照旧。
   */
  function isInsideFloatingButton(node) {
    var el = node;
    while (el && el !== document) {
      if (el.id === 'theme-switcher') return true;
      el = el.parentNode;
    }
    return false;
  }

  /**
   * 触摸开始：正文任意位置都能起手拉抽屉（和主题老行为一致，只按方向判定，
   * 不限定左边缘）；打开态同样是任意位置都能拖动收回
   */
  function onTouchStart(e) {
    if (!isMobile() || !hasMenu()) return;
    if (!e.touches || e.touches.length !== 1) return;

    var touch = e.touches[0];
    var ctrl = getMenuControl();
    var isOpen = !!(ctrl && ctrl.checked);

    // 唯一不参与的区域：自身要消费横向手势的横向滚动容器（图片轮播 / 横向表格 / 代码块）
    if (isInsideHorizontalScroller(e.target)) return;
    // 右下角浮动按钮同样不参与：它自己处理横向拖动（见 isInsideFloatingButton 注释）
    if (isInsideFloatingButton(e.target)) return;

    menuWidth = measureMenuWidth();
    if (!menuWidth) return;

    startX = lastX = touch.clientX;
    startY = touch.clientY;
    startTime = lastTime = e.timeStamp || Date.now();
    sampleX.length = 0;
    sampleT.length = 0;
    pushSample(touch.clientX, startTime);
    // 起点取「眼睛看到的位置」：上一次开合过渡还没跑完就再次按住时，
    // 若直接按状态对应的 0 / 满宽起手，画面会跳一下
    var live = readCurrentOffset();
    if (live < 0) live = isOpen ? menuWidth : 0;
    if (live < 0) live = 0;
    if (live > menuWidth) live = menuWidth;
    startOffset = live;
    currentOffset = live;
    axis = null;
    moved = false;
    dragging = true;
    // 清掉上一次拖动残留的内联值：无障碍/无 JS 场景下起点必须是 CSS 静止值
    clearOffset();
  }

  /**
   * 触摸移动：先锁方向，锁定横向后进入跟手模式
   */
  function onTouchMove(e) {
    if (!dragging) return;
    if (!e.touches || e.touches.length !== 1) return;

    var touch = e.touches[0];
    var dx = touch.clientX - startX;
    var dy = touch.clientY - startY;

    if (!axis) {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y') {
        // 纵向手势：交还给页面滚动，本次拖动作废（回弹到原位）
        endDrag();
        return;
      }
      // 拖动状态挂在 body 上：CSS 里既要管 .book-page/.book-menu，
      // 也要管 body 直接子元素 #theme-switcher（主题/返回顶部二合一按钮）的层级
      document.body.classList.add('bk-dragging');
    }
    if (axis !== 'x') return;

    // 拦掉浏览器自己的横向滚动与左边缘回退手势；纵向完全不受影响
    if (e.cancelable) e.preventDefault();

    moved = true;
    var offset = startOffset + dx;
    if (offset < 0) offset = 0;
    else if (offset > menuWidth) offset = menuWidth;
    setOffset(offset);

    lastX = touch.clientX;
    lastTime = e.timeStamp || Date.now();
    pushSample(lastX, lastTime);   // 供抬手时按窗口算甩动速度
  }

  /**
   * 拖动收尾：按甩动速度 / 位移进度决定展开还是回弹
   * 判定顺序（先看甩，再看拉了多远）：
   *   ① 抬手速度超过 FLING_VELOCITY → 按方向直接开/关（"快滑一下"走这条，不看拉了多少）
   *   ② 否则看拉出进度是否 ≥ OPEN_THRESHOLD
   * touchend 与 touchcancel 共用 —— 系统中途打断（来电、通知、浏览器夺权）时，
   * 拖出去的那半截也应该按同样的规则收尾，而不是无视手指位置硬弹回去
   */
  function finishDrag(e) {
    if (!dragging) return;

    var touch = (e.changedTouches && e.changedTouches[0]) || null;
    var endX = touch ? touch.clientX : lastX;
    var endY = touch ? touch.clientY : startY;
    var endT = e.timeStamp || Date.now();

    var horizontal = (axis === 'x');
    var offset = currentOffset;
    var velocity = 0;

    if (horizontal) {
      velocity = flingVelocity(endX, endT);
    } else if (axis === null) {
      // 极快的一滑可能一个 touchmove 都没来得及派发（整段手势被合成成 start + end），
      // 此时方向还没锁定。用「起点 → 终点」的整段位移补判一次，否则快滑等于没反应。
      // 门槛取 FLING_MIN_DISTANCE(24px) 而不是 AXIS_LOCK(12px)：12px 级别的手抖不该被当成滑动手势
      //（否则会误吞正文点击 —— 轻点链接时手指抖一下是很常见的）。
      var totalDx = endX - startX;
      var totalDy = endY - startY;
      if (Math.abs(totalDx) >= FLING_MIN_DISTANCE && Math.abs(totalDx) > Math.abs(totalDy)) {
        horizontal = true;
        var totalDt = endT - startTime;
        velocity = totalDt > 0 ? totalDx / totalDt : 0;
        offset = startOffset + totalDx;
        if (offset < 0) offset = 0;
        else if (offset > menuWidth) offset = menuWidth;
        moved = true;   // 这是一次真实横滑，抬手后的 click 要吞掉
      }
    }

    if (horizontal) {
      var progress = menuWidth > 0 ? (offset / menuWidth) : 0;
      var shouldOpen;
      if (velocity > FLING_VELOCITY) shouldOpen = true;
      else if (velocity < -FLING_VELOCITY) shouldOpen = false;
      else shouldOpen = progress >= OPEN_THRESHOLD;
      applyOpen(shouldOpen); // 先定终态（保持不变的内联位移让重排无视觉变化）
    }
    endDrag();               // 再恢复过渡并清内联值 → 从这里滑向终态

    // 拖动过就吞掉紧随其后的 click：既避免误触正文链接，也避免刚拉开的菜单被点回去
    if (moved) suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
  }

  /**
   * 点击：拖动后的 click 吞掉；其余情况点击菜单外区域关闭菜单
   * （用捕获阶段，保证"吞 click"先于正文里的其它点击逻辑生效）
   */
  function onDocumentClick(e) {
    if (suppressClickUntil && Date.now() < suppressClickUntil) {
      suppressClickUntil = 0;
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (!isMobile()) return;

    var ctrl = getMenuControl();
    if (!ctrl || !ctrl.checked) return;

    // 汉堡按钮 / 遮罩本身就是 label[for=menu-control]，交还原生行为，JS 不插手
    if (isMenuToggle(e.target)) return;

    // 点击菜单内部不关闭
    var target = ensureElement(e.target);
    var menuContent = document.querySelector('.book-menu .book-menu-content');
    if (target && menuContent && menuContent.contains(target)) return;

    closeMenu();
  }

  /**
   * 初始化手势事件
   */
  function init() {
    addSafeListener(document, 'touchstart', onTouchStart, { passive: true });
    // 必须非 passive：锁定横向后要 preventDefault 才能压住页面横向滚动
    addSafeListener(document, 'touchmove', onTouchMove, { passive: false });
    addSafeListener(document, 'touchend', finishDrag, { passive: true });
    // 被系统打断时也按手指当前位置收尾（见 finishDrag 注释）
    addSafeListener(document, 'touchcancel', finishDrag, { passive: true });
    addSafeListener(document, 'click', onDocumentClick, { capture: true, passive: false });

    // 通过 label 等其它途径开合时，清掉可能残留的拖动内联值，让 CSS 决定静止值
    var ctrl = getMenuControl();
    if (ctrl) {
      addSafeListener(ctrl, 'change', function () {
        if (!dragging) clearOffset();
        /* 抽屉被关掉（点遮罩 / 点菜单按钮）时把焦点摘掉，避免残留蓝色 focus ring */
        if (!ctrl.checked) blurMenuControl();
      });
    }

    /* 遮罩：鼠标按下时不抢焦点（focus ring 就不会出现）。
       不 preventDefault 的话，点击的默认行为会先给 label/checkbox 聚焦；
       touch 端由上面的 change 回调兜底。 */
    var overlay = document.querySelector ? document.querySelector('.book-menu-overlay') : null;
    if (overlay) {
      addSafeListener(overlay, 'mousedown', function (e) {
        if (e.cancelable !== false) e.preventDefault();
      }, { passive: false });
    }

    // 视口变化（横竖屏切换 / 键盘弹出）后残留的 px 位移会和新宽度对不上，直接清掉
    addSafeListener(window, 'resize', function () {
      if (dragging) endDrag();
      else clearOffset();
    }, { passive: true });

    // 从 bfcache 返回时清掉上一次留下的内联位移
    addSafeListener(window, 'pageshow', function () {
      endDrag();
    });
  }

  // 导出模块
  global.Gesture = {
    init: init,
    isMobile: isMobile,
    openMenu: openMenu,
    closeMenu: closeMenu,
    blurMenuControl: blurMenuControl
  };

})(window);
