  /**
   * 右下角多功能浮动按钮模块（原：主题切换器 + 返回顶部，现已合并为一个按钮）
   *
   * 一个按钮，两种形态，按滚动位置自动切换（阈值 SCROLL_THRESHOLD = 300px）：
   *   scrollY <  300  → ☀/🌙 主题：点击切换 light / dark（主题记忆在 localStorage）
   *   scrollY >= 300  → ↑ 返回顶部：点击平滑滚回顶部
   * 这样右下角只有一个悬浮按钮，不需要「返回顶部」时它就是切换主题。
   *
   * 判定用「按下瞬间」的滚动位置（touchstart / mousedown 时记录），
   * 避免点击过程中滚动位置变化导致意图被改写（例如点完就回弹到顶部时误切主题）。
   *
   * 可拖动：按住按钮拖到任意位置，松手后位置记进 localStorage
   * （key: float-btn-pos = JSON {"left":n,"top":n}，CSS 像素、相对视口左上角）。
   * 拖动用 left/top 定位，transform 只留给缩放反馈——两者互不干扰（旧 Safari 也一样）。
   *
   * 旧 iOS（15.8.2 等）友好性说明：
   *   * 事件用 touchstart/touchmove/touchend + mousedown/mousemove/mouseup，不用 Pointer Events，
   *     与 assets/js/modules/gesture.js（抽屉拖动）同一条已验证的路线；
   *   * added 用项目里同一套 addSafeListener，老 Safari 不支持 {passive:false} 对象时降级为布尔；
   *   * 只有超过 DRAG_THRESHOLD_TOUCH 的位移才算拖动，否则算点击，手指微抖不会误拖；
   *   * 拖动时才 preventDefault（阻止页面跟着滚）并加 .is-dragging（禁选择/长按呼出），
   *     松手立刻恢复；click 在拖动后会被吞掉，避免拖完还触发切主题/回顶部；
   *   * 没有 framer-motion / pointer capture 这些新 API 依赖，iOS 9+ 都能跑。
   *
   * 依赖：custom.css 里 :root[data-theme*="light"|"dark"] #theme-switcher 的配色规则；
   *      按钮 id 保持 #theme-switcher（主题锁色选择器仍指向它）。
   */
(function(global) {
  'use strict';

  var switchTheme = null;
  var THEME_STORAGE_KEY = 'book-theme-mode';
  var FLOAT_POS_KEY = 'float-btn-pos';
  var SCROLL_THRESHOLD = 300;
  var pendingScrollUpdate = false;
  /* 按下瞬间是否在页面顶部（决定这次点击是切主题还是回顶部） */
  var pressAtTop = true;
  /* 拖动：位移超过阈值才算拖，触摸给一点容差，鼠标严格按 0（任意移动即拖动） */
  var DRAG_THRESHOLD_TOUCH = 8;
  var DRAG_THRESHOLD_MOUSE = 0;
  var dragState = null;
  var suppressClick = false;

  /**
   * 安全设置元素样式（兼容旧 Safari：Object.assign 失败时逐个赋值兜底）
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
   * 添加事件监听（兼容旧 Safari：passive 选项不支持时降级为布尔值）
   * @param {EventTarget} target - 监听目标
   * @param {string} type - 事件名
   * @param {Function} handler - 回调
   * @param {Object|boolean} options - 选项
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

  /**
   * 应用指定模式到 DOM
   */
  function applyMode(mode) {
    var cur = document.documentElement.getAttribute('data-theme');
    if (!cur) return;

    var parsed = parseTheme(cur);
    var newTheme = parsed.base ? parsed.base + '-' + mode : mode;
    document.documentElement.setAttribute('data-theme', newTheme);
  }

  /**
   * 切换主题模式（仅在按钮处于「主题」形态时触发）
   */
  function toggleTheme() {
    var currentMode = getStorageItem(THEME_STORAGE_KEY) || 'light';
    var nextMode = (currentMode === 'light') ? 'dark' : 'light';

    setStorageItem(THEME_STORAGE_KEY, nextMode);
    applyMode(nextMode);
    updateButton(nextMode);
  }

  /**
   * localStorage 安全访问（隐私模式 Safari 会抛 quota exceeded 异常）
   */
  function getStorageItem(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function setStorageItem(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* 忽略存储失败 */ }
  }

  /** 当前是否在页面顶部（决定按钮形态） */
  function isAtTop() {
    return (window.scrollY || window.pageYOffset || 0) < SCROLL_THRESHOLD;
  }

  /* ============================================================
   * 拖动：位置记忆 + 视口内钳制
   * ========================================================== */

  /** 视口尺寸（旧 iOS 用 innerWidth/Height，地址栏伸缩时不会拿到未定义值） */
  function viewportSize() {
    return {
      w: window.innerWidth || document.documentElement.clientWidth || 320,
      h: window.innerHeight || document.documentElement.clientHeight || 480
    };
  }

  /** 取按钮当前尺寸（未初始化时按 CSS 里的 40px） */
  function buttonSize() {
    var w = (switchTheme && switchTheme.offsetWidth) || 40;
    var h = (switchTheme && switchTheme.offsetHeight) || 40;
    return { w: w, h: h };
  }

  /** 把坐标钳进视口（四周留 MARGIN，避免贴边点不到） */
  function clampPos(left, top) {
    var vp = viewportSize();
    var size = buttonSize();
    var margin = 4;
    var maxLeft = Math.max(margin, vp.w - size.w - margin);
    var maxTop = Math.max(margin, vp.h - size.h - margin);
    return {
      left: Math.min(Math.max(left, margin), maxLeft),
      top: Math.min(Math.max(top, margin), maxTop)
    };
  }

  /** 读取记住的位置（脏数据/越界都返回 null，退回默认右下角） */
  function loadSavedPos() {
    var raw = getStorageItem(FLOAT_POS_KEY);
    if (!raw) return null;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return null; }
    if (!parsed || typeof parsed.left !== 'number' || typeof parsed.top !== 'number') return null;
    if (!isFinite(parsed.left) || !isFinite(parsed.top)) return null;
    return clampPos(parsed.left, parsed.top);
  }

  function savePos(left, top) {
    setStorageItem(FLOAT_POS_KEY, JSON.stringify({ left: Math.round(left), top: Math.round(top) }));
  }

  /** 用 left/top 定位（清掉 right/bottom，避免两套定位同时生效） */
  function applyPos(left, top) {
    setStyles(switchTheme, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
  }

  /** 启动时恢复记住的位置；没有记录就保持 CSS/初始的右下角 */
  function restorePos() {
    var pos = loadSavedPos();
    if (!pos) return;
    applyPos(pos.left, pos.top);
  }

  /** 屏幕旋转 / 窗口变化：把按钮重新钳回视口内 */
  function keepInViewport() {
    if (!switchTheme || !getStorageItem(FLOAT_POS_KEY)) return;
    var rect = switchTheme.getBoundingClientRect();
    var pos = clampPos(rect.left, rect.top);
    applyPos(pos.left, pos.top);
    savePos(pos.left, pos.top);
  }

  /**
   * 平滑滚动到页面顶部（Safari 兼容：原生 smooth 不生效时用 rAF 模拟）
   */
  function smoothScrollToTop() {
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
   * 按当前 scrollY 切换按钮形态（主题 ⇄ 返回顶部）
   * 用 requestAnimationFrame 合并写入，避免滚动期间每秒多次 reflow
   */
  function updateDisplayByScroll() {
    pendingScrollUpdate = false;
    if (!switchTheme) return;
    updateButton(getCurrentMode());
  }

  /**
   * 滚动回调（passive，不阻塞浏览器合成线程）
   */
  function onScroll() {
    if (pendingScrollUpdate) return;
    pendingScrollUpdate = true;
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(updateDisplayByScroll);
    } else {
      updateDisplayByScroll();
    }
  }

  /**
   * 更新按钮形态：图标 + 提示文字
   *   scrollY <  300 → 主题图标（亮/暗），title 说明点击切换
   *   scrollY >= 300 → 向上箭头，title「返回顶部」
   * 图标来自 Bootstrap Icons，fill=currentColor 跟随主题色
   */
  var ICON_LIGHT = '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6m0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8M8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0m0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13m8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5M3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8m10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0m-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0m9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707M4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708"/></svg>';
  var ICON_DARK = '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6 .278a.77.77 0 0 1 .08.858 7.2 7.2 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277q.792-.001 1.533-.16a.79.79 0 0 1 .81.316.73.73 0 0 1-.031.893A8.35 8.35 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.75.75 0 0 1 6 .278M4.858 1.311A7.27 7.27 0 0 0 1.025 7.71c0 4.02 3.279 7.276 7.319 7.276a7.32 7.32 0 0 0 5.205-2.162q-.506.063-1.029.063c-4.61 0-8.343-3.714-8.343-8.29 0-1.167.242-2.278.681-3.286"/><path d="M10.794 3.148a.217.217 0 0 1 .412 0l.387 1.162c.173.518.579.924 1.097 1.097l1.162.387a.217.217 0 0 1 0 .412l-1.162.387a1.73 1.73 0 0 0-1.097 1.097l-.387 1.162a.217.217 0 0 1-.412 0l-.387-1.162A1.73 1.73 0 0 0 9.31 6.593l-1.162-.387a.217.217 0 0 1 0-.412l1.162-.387a1.73 1.73 0 0 0 1.097-1.097zM13.863.099a.145.145 0 0 1 .274 0l.258.774c.115.346.386.617.732.732l.774.258a.145.145 0 0 1 0 .274l-.774.258a1.16 1.16 0 0 0-.732.732l-.258.774a.145.145 0 0 1-.274 0l-.258-.774a1.16 1.16 0 0 0-.732-.732l-.774-.258a.145.145 0 0 1 0-.274l.774-.258c.346-.115.617-.386.732-.732z"/></svg>';
  var ICON_TOP = '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8 15a.5.5 0 0 0 .5-.5V2.707l3.146 3.147a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 1 0 .708.708L7.5 2.707V14.5a.5.5 0 0 0 .5.5"/></svg>';

  /**
   * 获取当前模式（兼容旧用户：auto 视为无效，回退 light）
   */
  function getCurrentMode() {
    var saved = getStorageItem(THEME_STORAGE_KEY);
    return (saved === 'light' || saved === 'dark') ? saved : 'light';
  }

  function updateButton(mode) {
    if (!switchTheme) return;
    if (!isAtTop()) {
      /* 滚动后：返回顶部形态 */
      switchTheme.innerHTML = ICON_TOP;
      switchTheme.title = '返回顶部';
      switchTheme.setAttribute('aria-label', '返回顶部');
      switchTheme.setAttribute('data-mode', 'top');
      return;
    }
    /* 顶部：主题切换形态（图标显示当前模式） */
    switchTheme.innerHTML = (mode === 'dark') ? ICON_DARK : ICON_LIGHT;
    switchTheme.title = (mode === 'dark') ? '暗色主题（点击切换）' : '亮色主题（点击切换）';
    switchTheme.setAttribute('aria-label', switchTheme.title);
    switchTheme.setAttribute('data-mode', 'theme');
  }

  /**
   * 创建按钮（右下角唯一悬浮按钮，两种形态共用同一个 DOM）
   */
  function createButton() {
    switchTheme = document.createElement('div');
    switchTheme.id = 'theme-switcher';
    switchTheme.setAttribute('role', 'button');
    switchTheme.setAttribute('tabindex', '0');

    /* 注意：传元素本身而非 switchTheme.style——setStyles 内部会取 el.style，
       误传 style 对象会导致 Object.assign(undefined) 抛错、按钮创建中断 */
    setStyles(switchTheme, {
      position: 'fixed',
      bottom: '120px',
      right: '20px',
      zIndex: '9999',
      width: '40px',
      height: '40px',
      borderRadius: '50%',
      cursor: 'pointer',
      fontSize: '20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transform: 'scale(1)',
      transformOrigin: 'center center',
      /* 旧版 Safari webkit 前缀兜底 */
      webkitTransform: 'scale(1)',
      webkitTransformOrigin: 'center center'
    });

    /**
     * 仅 transform scale 放大反馈，颜色全由 CSS 固定控制
     * @param {number} sizeLevel - 缩放档位：1（默认） / 1.05（按下） / 1.1（悬停）
     */
    function forceVisualReset(sizeLevel) {
      var scale = 'scale(' + sizeLevel + ')';
      switchTheme.style.transform = scale;
      switchTheme.style.webkitTransform = scale;
    }

    /* 仅保留矢量尺寸反馈 */
    switchTheme.onmouseenter = function() { if (!dragState) forceVisualReset(1.1); };
    switchTheme.onmouseleave = function() { if (!dragState) forceVisualReset(1); };
    switchTheme.onmousedown = function() {
      pressAtTop = isAtTop();
      forceVisualReset(1.05);
    };
    switchTheme.onmouseup = function() { if (!dragState) forceVisualReset(1.1); };
    switchTheme.onfocus = function() { forceVisualReset(1); };
    switchTheme.onblur = function() { forceVisualReset(1); };

    /* 触摸：在按下瞬间记下形态（click 之前触发），保证「点的是哪个按钮」不被滚动改写 */
    switchTheme.ontouchstart = function() { pressAtTop = isAtTop(); };

    switchTheme.onclick = function() {
      /* 刚刚是拖动：吞掉这次 click，避免拖完还触发切主题 / 回顶部 */
      if (suppressClick) { suppressClick = false; return; }
      if (pressAtTop) {
        toggleTheme();
      } else {
        smoothScrollToTop();
      }
    };
    switchTheme.onkeydown = function(e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        /* 键盘操作时以当前形态为准 */
        if (isAtTop()) { toggleTheme(); } else { smoothScrollToTop(); }
      }
    };

    /* 拖动：位置从当前 rect 反推，避免依赖 CSS 里默认的 right/bottom 数值 */
    function onDragStart(clientX, clientY) {
      var rect = switchTheme.getBoundingClientRect();
      dragState = {
        ids: [],                       // 本次拖动用过的触摸点 id
        pointerId: null,
        startX: clientX, startY: clientY,
        startLeft: rect.left, startTop: rect.top,
        dragging: false
      };
    }

    function onDragMove(clientX, clientY, threshold, evt) {
      if (!dragState) return;
      var dx = clientX - dragState.startX;
      var dy = clientY - dragState.startY;
      if (!dragState.dragging) {
        if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
        dragState.dragging = true;
        document.body.classList.add('bk-dragging');
        setStyles(switchTheme, { cursor: 'grabbing', transform: 'none', webkitTransform: 'none' });
      }
      /* 拖动期间必须阻止页面跟着滚（iOS 上 touchmove 的 preventDefault 需要 passive:false） */
      if (evt && evt.cancelable) evt.preventDefault();
      var pos = clampPos(dragState.startLeft + dx, dragState.startTop + dy);
      applyPos(pos.left, pos.top);
    }

    function onDragEnd() {
      if (!dragState) return;
      var wasDragging = dragState.dragging;
      var rect = switchTheme.getBoundingClientRect();
      dragState = null;
      document.body.classList.remove('bk-dragging');
      setStyles(switchTheme, { cursor: 'pointer' });
      forceVisualReset(1);
      if (wasDragging) {
        /* 拖动过：记住位置，并吞掉随后到来的 click */
        savePos(rect.left, rect.top);
        suppressClick = true;
        setTimeout(function() { suppressClick = false; }, 60);
      }
    }

    function touchAt(list, id) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].identifier === id) return list[i];
      }
      return null;
    }

    switchTheme.addEventListener('touchstart', function(e) {
      if (e.touches.length !== 1) return;   // 多指（缩放等）不参与拖动
      var t = e.touches[0];
      onDragStart(t.clientX, t.clientY);
      dragState.ids = [t.identifier];
    }, { passive: true });

    switchTheme.addEventListener('touchmove', function(e) {
      if (!dragState) return;
      var t = e.touches && e.touches.length ? e.touches[0] : null;
      if (!t || (dragState.ids.length && dragState.ids.indexOf(t.identifier) === -1)) return;
      onDragMove(t.clientX, t.clientY, DRAG_THRESHOLD_TOUCH, e);
    }, { passive: false });

    switchTheme.addEventListener('touchend', onDragEnd, { passive: true });
    switchTheme.addEventListener('touchcancel', onDragEnd, { passive: true });

    /* 桌面：按住拖动。位移阈值 0——鼠标一旦移动就进入拖动，不再触发 click */
    switchTheme.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;   // 只认左键
      onDragStart(e.clientX, e.clientY);
      dragState.pointerId = 'mouse';
    });

    addSafeListener(document, 'mousemove', function(e) {
      if (!dragState || dragState.pointerId !== 'mouse') return;
      onDragMove(e.clientX, e.clientY, DRAG_THRESHOLD_MOUSE, e);
    }, { passive: false });

    addSafeListener(document, 'mouseup', function() {
      if (!dragState || dragState.pointerId !== 'mouse') return;
      onDragEnd();
    }, false);

    // 滚动时切换形态；passive: true 让滚动合成先跑，JS 异步执行，不阻塞掉帧
    addSafeListener(window, 'scroll', onScroll, { passive: true });
    // 旋转屏幕 / 地址栏伸缩后，把记住的位置重新钳回视口内
    addSafeListener(window, 'resize', keepInViewport, { passive: true });
    addSafeListener(window, 'orientationchange', keepInViewport, false);

    document.body.appendChild(switchTheme);
  }

  /**
   * 初始化：建按钮 → 恢复拖动位置 → 应用主题 → 同步形态
   */
  function init() {
    createButton();
    restorePos();
    var mode = getCurrentMode();
    applyMode(mode);
    updateButton(mode);
  }

  // 导出模块
  global.ThemeSwitcher = {
    init: init,
    toggleTheme: toggleTheme,
    updateButton: updateButton,
    getCurrentMode: getCurrentMode,
    keepInViewport: keepInViewport
  };

})(window);
