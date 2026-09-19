/**
 * 模组列表页逻辑（从 shortcode 内嵌 JS 抽离）
 * 通过 DOM 上 #mods-data.dataset 获取数据链接 / 搜索配置
 * 模块化避免每个包含 shortcode 的页面重复序列化 300+ 行脚本
 *
 * 分页渲染：每次只渲染当前页数据，底部提供页码导航；
 * 不再使用“瀑布流”（滚动到哨兵自动追加加载）。
 *
 * 命名约定（重要）：
 *   代码里叫 subs / 订阅数（Steam 的 subscriptions 字段），
 *   但**页面上一律对外显示为「热度」**（图标下方数字、title、排序按钮提示都不写「订阅」），
 *   避免不必要的麻烦。新增文案时请沿用「热度」这个说法。
 */
(function (global) {
  'use strict';

  var PAGE_SIZE = 20;
  var SEARCH_DEBOUNCE_MS = 200;
  var STORAGE_SORT_KEY = 'mods-sort-preference';

  /**
   * 排序方式（localStorage 持久化），联机版只有两种，方向固定、不单独切换：
   *   'name' → 正序 · 名称：就是原来的按 ID 排序（ID 小到大），「名称」只是显示叫法
   *   'subs' → 倒序 · 热度：按 subs 字段（Steam 当前订阅数）从高到低
   * 单按钮点一下在两者之间来回切，按钮上的箭头图标表示正序/倒序。
   * 兼容旧值：'asc' / 'desc' / 'id' 当作 'name'；早期存过的 'downloads' 当作 'subs'。
   */
  var DEFAULT_SORT_MODE = 'name';
  var SORT_MODE_LABEL = { name: '名称', subs: '热度' };
  var SORT_DEFAULT_DIR = { name: 'asc', subs: 'desc' };

  /* ---- 网盘相关常量 ---- */
  var DISK_ORDER = ['baidu', 'xunlei', 'quark'];
  var DISK_LABEL = { baidu: '百度网盘', xunlei: '迅雷网盘', quark: '夸克网盘' };
  /**
   * JSON 里的字段前缀：网盘名缩写成单字母，省数据体积
   *   b=百度  x=迅雷  q=夸克  →  bSlug/bPwd、xSlug/xPwd、qSlug/qPwd
   * 只影响 JSON 字段名；代码里其它地方（开关、域名表、图标、CSS 类）仍用全名 baidu/xunlei/quark。
   */
  var DISK_KEY = { baidu: 'b', xunlei: 'x', quark: 'q' };
  var DISK_ICON = {
    baidu: '/img/icons/pan_baidu.webp',
    xunlei: '/img/icons/pan_xunlei.webp',
    quark: '/img/icons/pan_quark.webp'
  };
  /**
   * 网盘总开关（hugo.yaml → params.panBaiduEnabled/panXunleiEnabled/panQuarkEnabled）
   * false = 整站关闭该网盘：列表按钮不渲染、弹框不提供该选项。
   * 由 loadConfig() 读 #mods-data 的 data-pan-*-enabled 覆盖（缺失时默认全开）。
   */
  var panEnabled = { baidu: true, xunlei: true, quark: true };
  /**
   * 网盘官方域名表（hugo.yaml → params.panHosts，由 shortcode 注入 #mods-data 的 data-pan-hosts）
   * 数据里只存「/s/」之后的分享段（slug/pwd），下载时才用这里的域名拼成完整直链，
   * 因此页面 HTML 和 JSON 里都不会出现带前缀的原始链接，换域名也只改一处配置。
   */
  var panHosts = { baidu: 'pan.baidu.com', xunlei: 'pan.xunlei.com', quark: 'pan.quark.cn' };

  /* ---- 网盘链接规范化（与 layouts/_partials/docs/pan-url.html 同一套规则） ---- */

  /**
   * 只保留「/s/」之后的分享段：
   *   取最后一个 /s/（跳过 /s/ 后可能出现的 /list/ 路径）到 ? # 之间
   *   例：https://jump.example.com/pan.baidu.com/s/1AbC?pwd=x1y2 → { slug:'1AbC', pwd:'x1y2' }
   * 解析不出来返回 null（调用方各自决定退回原值还是当作无链接）。
   */
  function parseShareSeg(raw) {
    if (!raw) return null;
    var text = String(raw).trim();
    var m = /(?:^|\/)s\/([A-Za-z0-9._~%-]+)/g;
    var last = null;
    var hit;
    while ((hit = m.exec(text)) !== null) {
      last = hit[1];
      m.lastIndex = hit.index + hit[0].length;   // 允许 /s/xxx/list/yyy，取最后一个段
    }
    if (!last) return null;
    var pwd = '';
    var q = /[?&]pwd=([^&#]*)/.exec(text);
    if (q && q[1]) pwd = q[1];
    return { slug: last, pwd: pwd };
  }

  /**
   * 从完整链接反推是哪个网盘：在整个原始字符串里找官方域名
   * （前缀域名里内嵌完整官方链接、或域名被 percent 编码后出现在查询串里都能认出来）；
   * 认不出来返回 ''，由调用方决定兜底。
   * 与 layouts/_partials/docs/pan-url.html 的判定口径保持一致。
   */
  function diskOfUrl(raw) {
    var text = String(raw || '').toLowerCase();
    if (!text) return '';
    return DISK_ORDER.filter(function (k) {
      return text.indexOf(String(panHosts[k] || '').toLowerCase()) !== -1;
    })[0] || '';
  }

  /**
   * 用官方域名把 slug（+提取码）拼成完整分享短链；异常输入返回 ''。
   */
  function buildPanUrl(disk, slug, pwd) {
    if (!disk || !slug) return '';
    var host = panHosts[disk] || '';
    if (!host) return '';
    return 'https://' + host + '/s/' + slug + (pwd ? '?pwd=' + pwd : '');
  }

  /**
   * 后端/JSON 给的链接 → 重建后的规范短链：
   * 丢掉「/s/」之前的一切（跳转域名、镜像域名、推广前缀…），拼不出来才退回原值。
   */
  function normalizePanUrl(raw) {
    var seg = parseShareSeg(raw);
    if (!seg) return raw || '';
    // 域名不是三家官方的：只要带 /s/ 段就按百度网盘重建（前缀丢弃，避免放行未知跳转域）
    return buildPanUrl(diskOfUrl(raw) || 'baidu', seg.slug, seg.pwd) || String(raw);
  }

  /**
   * 取某条模组、某个网盘的分享段（shortcode 只写缩写字段：bSlug/bPwd、xSlug/xPwd、qSlug/qPwd）。
   * 兼容旧数据：全名 slug 字段（baiduSlug…）与更早的直链字段（baiduUrl…）。
   * 没有分享段返回 null。
   */
  function shareOf(mod, disk) {
    var key = DISK_KEY[disk] || disk;
    var slug = mod[key + 'Slug'] || mod[disk + 'Slug'] || '';
    var pwd = mod[key + 'Pwd'] || mod[disk + 'Pwd'] || '';
    if (slug) return { slug: slug, pwd: pwd };
    return parseShareSeg(mod[disk + 'Url'] || mod[key + 'Url'] || '');
  }

  /** 某条模组、某个网盘最终要打开的规范短链；无链接返回 '' */
  function panUrlOf(mod, disk) {
    var seg = shareOf(mod, disk);
    return seg ? buildPanUrl(disk, seg.slug, seg.pwd) : '';
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

  /**
   * 读取排序方式：缺失/脏数据一律退回 'name'（正序名称）。
   * 兼容旧值：'asc'/'desc'/'id' → 'name'；'downloads'（旧名字）→ 'subs'；
   * 以及过渡期的 {"mode":..,"dir":..} 对象。
   */
  function loadSortMode() {
    var raw = getStorageItem(STORAGE_SORT_KEY);
    if (!raw) return DEFAULT_SORT_MODE;
    if (raw === 'asc' || raw === 'desc' || raw === 'id') return 'name';
    if (raw === 'downloads') return 'subs';
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (SORT_MODE_LABEL[parsed.mode]) return parsed.mode;
        if (parsed.mode === 'id') return 'name';
        if (parsed.mode === 'downloads') return 'subs';
      }
    } catch (e) { /* 脏数据 → 默认 */ }
    return SORT_MODE_LABEL[raw] ? raw : DEFAULT_SORT_MODE;
  }

  function saveSortMode(mode) {
    setStorageItem(STORAGE_SORT_KEY, mode);
  }

  /**
   * 热度数字格式化：10327254 → 1032.7万；152000000 → 1.52亿
   * 与站内其它位置的「万/亿」记法保持一致，这里只用于展示，排序仍用原始数值。
   * （数据字段是 Steam 的 subscriptions → 代码里叫 subs「订阅数」，页面上一律显示「热度」）
   */
  function formatSubsCount(value) {
    var num = typeof value === 'number' ? value : parseInt(value, 10);
    if (!isFinite(num) || num <= 0) return '';
    if (num >= 100000000) return trimZero((num / 100000000).toFixed(2)) + '亿';
    if (num >= 10000) return trimZero((num / 10000).toFixed(1)) + '万';
    return String(num);
  }

  function trimZero(text) {
    return text.indexOf('.') === -1 ? text : text.replace(/\.?0+$/, '');
  }

  /**
   * 读取 DOM 配置（shortcode 注入）
   * 支持两种数据来源：
   *   a) 旧兼容模式：textContent 内嵌 JSON（用于开发/临时场景）
   *   b) 新模式：dataset.src 提供独立 JSON URL（HTML 从 96KB 砍到 ~12KB，JSON 可被 CDN 缓存）
   */
  function loadConfig() {
    return new Promise(function (resolve, reject) {
      var dataEl = document.getElementById('mods-data');
      if (!dataEl) return reject(new Error('mods-data not found'));

      var dataSrc = dataEl.dataset.src || '';
      var fallbackText = (dataEl.textContent || '').trim();

      function parseAndBuild(rawJson) {
        var allMods;
        try {
          allMods = JSON.parse(rawJson);
        } catch (e) {
          return reject(e);
        }
        resolve({
          allMods: allMods,
          searchOnly: dataEl.dataset.searchOnly === 'true',
          searchKeyword: dataEl.dataset.searchKeyword || '',
          currentDate: dataEl.dataset.currentDate || '',
          // 是否启用订阅数功能（列表展示 +「↓ 下载」排序）：仅联机版 dst-mods 打开，
          // 由 shortcode 的 data-sort-downloads 属性注入
          subs: dataEl.dataset.sortDownloads === 'true',
          imgBase: dataEl.dataset.imgBase || '/img/bm/',
          imgFallback: dataEl.dataset.imgFallback || '/img/bm/none.png',
          // 网盘直链策略：只影响点击下载后的交互（modal=弹框校验邮箱；direct=直接新标签打开）
          // 两种模式的地址都由 slug + panHosts 现拼，JSON 里不含完整链接
          panMode: dataEl.dataset.panMode || 'direct',
          // 网盘官方域名表（shortcode 注入的 JSON；缺失时沿用代码里的默认三家域名）
          panHosts: parsePanHosts(dataEl.dataset.panHosts),
          // 网盘总开关（缺省=启用）；显式 "false" 才关闭
          panEnabled: {
            baidu: dataEl.dataset.panBaiduEnabled !== 'false',
            xunlei: dataEl.dataset.panXunleiEnabled !== 'false',
            quark: dataEl.dataset.panQuarkEnabled !== 'false'
          }
        });
      }

      // 优先尝试 textContent（兜底，避免 fetch 失败时整页白屏）
      if (fallbackText && fallbackText.length > 2) {
        parseAndBuild(fallbackText);
        return;
      }

      if (!dataSrc) {
        return reject(new Error('mods-data has neither src nor inline json'));
      }

      // fetch + XHR 双重降级（fetch 旧 Safari 不支持 cache 参数，或者根本没有 fetch）
      if (window.fetch) {
        try {
          fetch(dataSrc, { credentials: 'same-origin' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(parseAndBuild)
            .catch(function (err) {
              // fetch 失败再用 XHR 试一次
              xhrGet(dataSrc, parseAndBuild, reject);
            });
          return;
        } catch (e) { /* 立即降级 XHR */ }
      }
      xhrGet(dataSrc, parseAndBuild, reject);
    });
  }

  /**
   * 解析 shortcode 注入的网盘域名表（data-pan-hosts）
   * 非法 JSON / 空值 / 非字符串值一律忽略，缺的键沿用默认域名，保证永远是 3 个可用域名。
   */
  function parsePanHosts(raw) {
    var hosts = { baidu: panHosts.baidu, xunlei: panHosts.xunlei, quark: panHosts.quark };
    if (!raw) return hosts;
    try {
      var parsed = JSON.parse(raw);
      DISK_ORDER.forEach(function (k) {
        if (parsed && typeof parsed[k] === 'string' && parsed[k]) hosts[k] = parsed[k];
      });
    } catch (e) { /* 配置坏了就沿用默认域名 */ }
    return hosts;
  }

  /**
   * 简易 XHR GET 封装（fetch 不可用时兜底）
   */
  function xhrGet(url, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        onSuccess(xhr.responseText);
      } else {
        onError(new Error('XHR HTTP ' + xhr.status));
      }
    };
    try { xhr.send(); } catch (e) { onError(e); }
  }

  /**
   * 站点基础 URL（用 location.origin 适配本地/局域网/公网）
   * 旧 Safari 下 origin 可能为空，手动拼接
   */
  function getSiteOrigin() {
    if (window.location.origin) return window.location.origin;
    return window.location.protocol + '//' + window.location.hostname +
      (window.location.port ? ':' + window.location.port : '');
  }

  /**
   * 构造标签 HTML（支持数组或逗号分隔字符串）
   */
  function buildTagsHtml(tags) {
    if (!tags) return '';
    var list;
    if (typeof tags === 'string') {
      list = tags.split(/[,，、]/);
    } else if (Array.isArray(tags)) {
      list = tags;
    } else {
      return '';
    }
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      var t = (list[i] || '').trim();
      if (t) parts.push('<span class="mod-tag">' + t + '</span>');
    }
    return parts.length ? '<span class="mod-tags">' + parts.join('') + '</span>' : '';
  }

  /**
   * 热度数字（数据来自 Steam subscriptions）：0 / 缺失（已下架条目）直接不渲染。
   * 显示成「12.3万」这种缩写，放在模组图标正下方的小字里；完整数字进 title（写成「热度 <数字>」）。
   */
  function buildSubsText(subs) {
    var num = typeof subs === 'number' ? subs : parseInt(subs, 10);
    if (!isFinite(num) || num <= 0) return '';
    return formatSubsCount(num) || String(num);
  }

  /**
   * WS 前缀数字 ID → Steam 创意工坊链接；其余本地 ID（BM…等）原样返回纯文本
   * 例：WS123456 → https://steamcommunity.com/sharedfiles/filedetails/?id=123456
   * （WS000000 之类无有效数字的 ID 不生成链接）
   */
  function buildWorkshopIdLink(id) {
    var raw = id || '';
    var m = /^WS(\d+)$/i.exec(raw);
    var digits = (m && m[1]) ? m[1].replace(/^0+/, '') : '';
    var name = 'workshop-'+ digits;
    if (!digits) return raw;
    return (
      '<a class="workshop-id-link" href="https://steamcommunity.com/sharedfiles/filedetails/?id=' + digits + '"' +
        ' target="_blank" rel="noopener noreferrer"' +
        ' title="在创意工坊中查看 ' + digits + '"' +
        ' onclick="event.stopPropagation()">' + name + '</a>'
    );
  }

  /**
   * 构造某网盘的直链下载 URL（仅 direct 模式使用）
   * 数据里只有 slug/pwd（或旧的完整 url），这里统一用官方域名重建成规范短链；
   * 拼不出来返回 null（按钮渲染成「暂无」）。
   */
  function buildDownloadTarget(mod, disk) {
    return panUrlOf(mod, disk) || null;
  }

  /**
   * 构造单条模组 HTML
   * panMode:
   *   modal  → 下载按钮在当前页打开网盘弹框（不内嵌/不暴露真实直链，后端校验后新标签打开）
   *   direct → 下载按钮直接新标签打开真实直链（旧行为）
   */
  function buildModItem(mod, cfg) {
    var idLower = (mod.id || '').toLowerCase();
    var nameLower = (mod.name || '').toLowerCase();
    var isModal = (cfg.panMode === 'modal' || cfg.panMode === 'jump'); // jump 为旧别名，视同 modal
    // 详情页地址（shortcode 注入的 u 字段）：空 = 这条模组没有详情页，卡片不做跳转
    var pageUrl = mod.u || '';
    var tagsHtml = buildTagsHtml(mod.tags);
    var on = cfg.panEnabled || panEnabled;
    /* 订阅数只在本页开启排序时展示（单机版没有该字段，不渲染空文字）。
       title 里对外统一叫「热度」，不写「订阅」——避免不必要的麻烦（见文件顶部命名约定）。 */
    var subsText = cfg.subs ? buildSubsText(mod.subs) : '';
    var subsTitle = subsText ? '热度 ' + (typeof mod.subs === 'number' ? mod.subs : parseInt(mod.subs, 10)) : '';

    // 逐个网盘生成下载按钮；总开关关闭的网盘整条不渲染（连"暂无"灰按钮也不留）
    // 「有没有链接」直接看分享段：JSON 里有 xxxSlug（或旧数据的 xxxUrl 能解析出 /s/ 段）才算有
    var actions = '';
    for (var i = 0; i < DISK_ORDER.length; i++) {
      var disk = DISK_ORDER[i];
      if (!on[disk]) continue;
      var has = !!shareOf(mod, disk);
      var title = DISK_LABEL[disk] + '下载';
      actions += isModal
        ? buildModalBtn(disk, title, mod.id, has, mod)
        : buildDirectBtn(disk, title, has ? buildDownloadTarget(mod, disk) : null);
    }

    var thumbImg =
      '<img src="' + cfg.imgBase + mod.id + '.png" alt="' + mod.id + '" loading="lazy" onerror="this.onerror=null;this.src=\'' + cfg.imgFallback + '\'">';
    /* 有详情页 → 缩略图是按钮、名字可点击跳转；
       没有详情页（如单机版 BMxxx）→ 渲染成普通元素，不再跳到不存在的 /p/xxx（那是 404） */
    var thumbHtml = pageUrl
      ? '<button class="action-btn" aria-label="' + mod.id + '" onclick="event.stopPropagation();window.location.href=\'' + pageUrl + '\'">' + thumbImg + '</button>'
      : '<span class="action-btn" aria-hidden="true">' + thumbImg + '</span>';
    var nameAttrs = pageUrl
      ? ' role="link" tabindex="0"' +
        ' onclick="event.stopPropagation();window.location.href=\'' + pageUrl + '\'"' +
        ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();window.location.href=\'' + pageUrl + '\'}"'
      : '';

    return (
      '<div class="mod-item' + (pageUrl ? '' : ' is-static') + '" data-id="' + idLower + '" data-name="' + nameLower + '">' +
        '<div class="item-main">' +
          '<div class="item-info">' +
            '<div class="item-thumb">' +
              thumbHtml +
              /* 热度缩写成「12.3万」：浮在图片左下角（绝对定位，不占位，
                 这样图片才能一直顶到卡片的上/左/下三边） */
              (subsText ? '<span class="item-subs" title="' + subsTitle + '">' + subsText + '</span>' : '') +
            '</div>' +
            '<div class="mod-name"' + nameAttrs + '>' +
              '<div class="mod-name-sub">' + mod.name + '</div>' +
              '<div class="mod-name-top">' +
                buildWorkshopIdLink(mod.id) + (mod.size ? ' (' + mod.size + ')' : '') + tagsHtml +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="item-actions">' + actions + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /**
   * direct 模式：新标签打开直链。
   * 不把 URL 写进 onclick（链接里的引号/& 会撑破属性），改为 data-disk + data-slug + data-pwd，
   * 由列表容器上的委托点击统一 window.open —— 地址始终由 JS 用官方域名重建。
   */
  function buildDirectBtn(cls, title, url) {
    if (url) {
      var seg = parseShareSeg(url) || { slug: '', pwd: '' };
      return (
        '<button type="button" class="action-btn ' + cls + '" title="' + title + '：' + url + '"' +
          ' data-pan-direct="1" data-disk="' + cls + '" data-slug="' + seg.slug + '" data-pwd="' + seg.pwd + '">' +
          '<img src="/img/icons/pan_' + cls + '.webp" alt="' + title + '" loading="lazy">' +
        '</button>'
      );
    }
    return (
      '<button class="action-btn ' + cls + '" title="暂无' + title + '" disabled>' +
        '<img src="/img/icons/pan_' + cls + '.webp" alt="' + title + '" loading="lazy">' +
      '</button>'
    );
  }

  /** modal 模式：打开当前页网盘弹框（不暴露直链；分享段一并带上，后端返回的链接也要过同一套规范化） */
  function buildModalBtn(cls, title, fileId, available, mod) {
    if (!available) {
      return (
        '<button class="action-btn ' + cls + '" title="暂无' + title + '" disabled>' +
          '<img src="/img/icons/pan_' + cls + '.webp" alt="' + title + '" loading="lazy">' +
        '</button>'
      );
    }
    var seg = shareOf(mod, cls) || { slug: '', pwd: '' };
    return (
      '<button class="action-btn ' + cls + '" title="' + title + '" ' +
        'onclick="event.stopPropagation();window.ModsList&&window.ModsList.PanDialog&&window.ModsList.PanDialog.open({p:\'' + fileId + '\',disk:\'' + cls + '\',slug:\'' + seg.slug + '\',pwd:\'' + seg.pwd + '\'})">' +
        '<img src="/img/icons/pan_' + cls + '.webp" alt="' + title + '" loading="lazy">' +
      '</button>'
    );
  }

  /* =============================================================
   * 网盘下载弹框（当前页面操作，不开跳转页/不离开本页）
   * 流程：点击下载按钮 → 弹框 → 输入/校验注册邮箱(记 localStorage)
   *      → 通过后新标签页打开真实网盘直链；失败则留在弹框内提示
   * ============================================================= */
  // 网盘 API 地址（可配置）
  // 本地联调：http://127.0.0.1:8787/ds/api/pan
  // 【上线前】请改为线上真实地址：同源 /ds/api/pan 或 https://<域名>/ds/api/pan
  var PAN_API = 'https://d1.225228.xyz/ds/api/pan';
  var PAN_EMAIL_KEY = 'pan-email';
  var PAN_MID_KEY = 'pan-mid';

  function isEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v || '');
  }

  function isMid(v) {
    return /^(?:OU_\d{15,25}|BU_[0-9a-f]{16})$/i.test((v || '').trim());
  }

  /**
   * 后端返回的网盘链接 → 可用于跳转的规范短链。
   * 规则与短代码一致：只认「/s/」之后的分享段，用对应网盘的官方域名重建；
   * 只有 /s/ 段存在才算有效（其它路径/未知跳转域一律丢弃，返回 '' 让弹框按「无链接」处理）。
   * disk 命中时用该网盘域名，否则从后端域名反推，再不行按百度网盘重建。
   */
  function usableDiskUrl(url, disk) {
    if (DISK_ORDER.indexOf(disk) === -1) return normalizePanUrl(url);   // 不知道网盘：从链接域名反推
    var seg = parseShareSeg(url);
    if (!seg) return '';
    return buildPanUrl(disk, seg.slug, seg.pwd);
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var PanDialog = (function () {
    var overlay, body, fileIdEl, fileNameEl;
    var cur = null;   // 当前会话状态
    var busy = false;
    var session = 0;  // 会话代数：关闭/重开后将“在途”的异步回调判为过期

    function esc(v) { return escHtml(v); }

    function ensureBuilt() {
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.className = 'pd-overlay';
      overlay.hidden = true;
      overlay.innerHTML =
        '<div class="pd-card" role="dialog" aria-modal="true" aria-label="网盘下载">' +
          '<div class="pd-head">' +
            '<div class="pd-title">网盘下载</div>' +
            '<button type="button" class="pd-close" data-act="close" aria-label="关闭">×</button>' +
          '</div>' +
          '<div class="pd-file">' +
            '<span class="pd-file-label">文件</span>' +
            '<b class="pd-file-id"></b>' +
            '<span class="pd-file-name"></span>' +
          '</div>' +
          '<div class="pd-body"></div>' + // 内容区：邮箱表单 / 加载中 / 结果 / 错误
          '<div class="pd-foot">From d1.225228.xyz...</div>' +
        '</div>';
      body = overlay.querySelector('.pd-body');
      fileIdEl = overlay.querySelector('.pd-file-id');
      fileNameEl = overlay.querySelector('.pd-file-name');
      document.body.appendChild(overlay);

      // 事件：关闭 / 下载网盘 / 更换邮箱 / 重试
      overlay.addEventListener('click', function (e) {
        var node = e.target;
        while (node && node !== overlay) {
          if (node.getAttribute && node.getAttribute('data-act')) break;
          node = node.parentNode;
        }
        if (!node || node === overlay) return;
        var act = node.getAttribute('data-act');
        if (act === 'close') { close(); return; }
        if (act === 'disk') {
          var k = node.getAttribute('data-disk');
          if (!panEnabled[k]) return;   // 总开关已关闭的网盘一律不打开
          var url = cur && cur.links && cur.links[k];
          if (url) window.open(url, '_blank', 'noopener');
          return;
        }
        if (act === 'change-email') { cur.email = ''; cur.mid = ''; viewEmail(''); return; }
        if (act === 'retry') { openBlankForAuto(); startVerify(); }
      });
      // Esc / 遮罩点击关闭
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
      overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    }

    function setFile(p, name) {
      fileIdEl.textContent = p || '—';
      fileNameEl.textContent = name ? '· ' + name : '';
    }

    function closeWinIfUnused() {
      if (cur && cur.win && !cur.winUsed) {
        try { cur.win.close(); } catch (e) { /* ignore */ }
      }
      if (cur) cur.win = null;
    }

    function openBlankForAuto() {
      // 必须在用户手势（点击下载/提交）同步阶段调用，才能绕过弹窗拦截
      if (!cur || cur.win) return;
      try {
        var w = window.open('about:blank', '_blank');
        if (w) {
          try { w.document.title = '正在打开网盘…'; } catch (e) { /* ignore */ }
          cur.win = w;
        }
      } catch (e) { cur.win = null; }
    }

    function openNewTab(url) {
      // 优先使用手势阶段已开好的空白标签页，其次退回 window.open（可能被拦）
      if (cur && cur.win && !cur.winUsed) {
        try {
          cur.win.location.href = url;
          cur.winUsed = true;
          try { cur.win.focus(); } catch (e) { /* ignore */ }
          return true;
        } catch (e) { /* 跨域等异常，走 fallback */ }
      }
      try {
        var w = window.open(url, '_blank', 'noopener');
        return !!w;
      } catch (e) { return false; }
    }

    /* ---------- 视图渲染 ---------- */
    function render(html) { body.innerHTML = html; }

    function viewLoading(text) {
      render(
        '<div class="pd-center">' +
          '<span class="pd-spinner"></span>' +
          '<p class="pd-hint">' + esc(text || '正在校验邮箱并获取网盘链接…') + '</p>' +
        '</div>'
      );
    }

    function viewEmail(errorMsg) {
      render(
        '<div class="pd-sub"></div>' +
        (errorMsg ? '<div class="pd-msg pd-err">' + esc(errorMsg) + '</div>' : '') +
        '<label class="pd-field" for="pd-email">邮箱</label>' +
        '<input type="email" class="pd-input" id="pd-email" placeholder="you@example.com" autocomplete="email" spellcheck="false">' +
        '<label class="pd-field" for="pd-mid">用户码</label>' +
        '<input type="text" class="pd-input" id="pd-mid" placeholder="OU_... 或 BU_..." autocomplete="off" spellcheck="false">' +
        '<button type="button" class="pd-btn" id="pd-submit">验证并下载</button>'
      );
      var input = document.getElementById('pd-email');
      var midInput = document.getElementById('pd-mid');
      input.value = (cur && cur.email) || '';
      midInput.value = (cur && cur.mid) || '';
      (isEmail(input.value) && !isMid(midInput.value) ? midInput : input).focus();
      document.getElementById('pd-submit').addEventListener('click', submitEmail);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitEmail(); });
      midInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitEmail(); });
    }

    function diskButtonsHtml(links, activeDisk, big) {
      var order = [];
      if (activeDisk && panEnabled[activeDisk]) order.push(activeDisk);
      DISK_ORDER.forEach(function (k) {
        if (k !== activeDisk && panEnabled[k]) order.push(k);
      });
      var out = [];
      order.forEach(function (k) {
        if (!panEnabled[k] || !links[k]) return;
        var active = k === activeDisk ? ' is-active' : '';
        out.push(
          '<button type="button" class="pd-disk' + (big && k === activeDisk ? ' pd-big' : '') + active + '" data-act="disk" data-disk="' + k + '">' +
            '<img src="' + DISK_ICON[k] + '" alt="">' +
            '<span class="pd-disk-label">' + DISK_LABEL[k] + '</span>' +
            '<span class="pd-arrow">↗</span>' +
          '</button>'
        );
      });
      return out.join('');
    }

    function viewResult(data) {
      // 只保留"总开关启用 + 后端确实返回了有效链接"的网盘
      var links = {};
      DISK_ORDER.forEach(function (k) {
        if (panEnabled[k]) links[k] = usableDiskUrl(data[k], k);
      });
      cur.links = links;

      // 点击时选中的网盘若已被总开关关闭 / 无链接，则不自动打开，交给用户从可选网盘中点选
      var autoDisk = (cur.disk && links[cur.disk]) ? cur.disk : '';

      if (autoDisk) {
        var label = DISK_LABEL[autoDisk];
        var opened = openNewTab(links[autoDisk]);
        render(
          (opened
            ? '<p class="pd-hint">已在新标签页打开「' + label + '」；若未弹出请点击下方按钮。</p>'
            : '<p class="pd-hint">浏览器拦截了自动打开，请点击下方按钮手动打开「' + label + '」。</p>') +
          diskButtonsHtml(links, autoDisk, true) +
          '<button type="button" class="pd-linkbtn" data-act="change-email">更换邮箱</button>'
        );
      } else {
        render(
          '<p class="pd-hint">请选择要使用的网盘：</p>' +
          diskButtonsHtml(links, '', false) +
          '<button type="button" class="pd-linkbtn" data-act="change-email">更换邮箱</button>'
        );
      }
    }

    function viewError(msg) {
      render(
        '<div class="pd-msg pd-err">' + esc(msg) + '</div>' +
        '<div class="pd-actions">' +
          '<button type="button" class="pd-btn pd-ghost" data-act="close">关闭</button>' +
          '<button type="button" class="pd-btn" data-act="retry">重试</button>' +
        '</div>'
      );
    }

    /* ---------- API ---------- */
    function apiQuery(email, mid, cb) {
      var url = PAN_API + '?u=' + encodeURIComponent(email) + '&m=' + encodeURIComponent(mid) + '&p=' + encodeURIComponent(cur.p);
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 12000;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        var body = null;
        try { body = JSON.parse(xhr.responseText || '{}'); } catch (e) { body = null; }
        cb({ status: xhr.status, ok: body && body.code === 0, data: body && body.data, msg: (body && body.msg) || '请求失败' });
      };
      xhr.onerror = function () { cb({ status: 0, ok: false, data: null, msg: '网络异常，请稍后重试' }); };
      xhr.ontimeout = function () { cb({ status: 0, ok: false, data: null, msg: '请求超时，请稍后重试' }); };
      xhr.send();
    }

    function startVerify() {
      if (busy || !cur) return;
      busy = true;
      var my = cur.sess;
      viewLoading('正在校验邮箱并获取网盘链接…');
      apiQuery(cur.email, cur.mid, function (res) {
        busy = false;
        // 弹框已关闭或本次会话已过期（用户关闭后重开）→ 丢弃结果
        if (!cur || cur.sess !== my || overlay.hidden) { closeWinIfUnused(); return; }
        if (res.ok) {
          setStorageItem(PAN_EMAIL_KEY, cur.email);
          setStorageItem(PAN_MID_KEY, cur.mid);
          setFile(res.data.id, res.data.name);
          viewResult(res.data);
          return;
        }

        // 依据后端 msg 精确分流：
        //   409 "用户码不匹配"              → 用户码错误（停留表单重新输入）
        //   400 "参数错误：缺少有效的邮箱(u)、用户码(m)或网盘文件id(p)" → 参数无效
        //   404 "用户不存在或未注册"        → 邮箱未注册（停留邮箱表单让用户换邮箱）
        //   400 "参数错误：缺少有效的邮箱(u)或网盘文件id(p)" → 邮箱无效/格式错误
        //   404 "未找到对应的网盘文件"      → 文件不存在（文件 id 有误/已下架）
        var msg = res.msg || '';
        var midIssue = res.status === 409 || /用户码不匹配/.test(msg);
        var userIssue = /用户|未注册/.test(msg);
        var fileIssue = /未找到对应的网盘文件/.test(msg);
        if (midIssue) {
          closeWinIfUnused();
          viewEmail('用户码不匹配，请检查用户码后重试。');
        } else if (userIssue) {
          closeWinIfUnused();
          viewEmail('该邮箱未通过校验（未注册或格式错误），请更换为已注册邮箱后重试。');
        } else if (res.status === 400) {
          closeWinIfUnused();
          viewEmail('该邮箱未通过校验（未注册或格式错误），请检查后重试。');
        } else if (fileIssue || res.status === 404) {
          closeWinIfUnused();
          viewError('未找到文件「' + cur.p + '」对应的网盘记录，可能已下架或 ID 有误。');
        } else {
          closeWinIfUnused();
          viewError(msg || '网络异常，请稍后重试。');
        }
      });
    }

    function submitEmail() {
      var input = document.getElementById('pd-email');
      var midInput = document.getElementById('pd-mid');
      if (busy || !input) return;
      var emailValue = (input.value || '').trim();
      var midValue = (midInput && midInput.value || '').trim();
      if (!isEmail(emailValue)) { viewEmail('请输入正确的邮箱地址。'); return; }
      if (!isMid(midValue)) { viewEmail('请输入正确的用户码（OU_数字或 BU_十六进制）。'); return; }
      cur.email = emailValue;
      cur.mid = midValue;
      openBlankForAuto();
      startVerify();
    }

    /* ---------- 对外 ---------- */
    function open(opts) {
      ensureBuilt();
      closeWinIfUnused();
      session += 1;
      cur = {
        sess: session,
        p: opts.p || '',
        disk: (opts.disk || '').toLowerCase(),
        // 分享段（shortcode 由 slug/pwd 给出）：当前用于兜底/调试，真实链接仍以后端校验结果为准
        slug: opts.slug || '',
        pwd: opts.pwd || '',
        email: getStorageItem(PAN_EMAIL_KEY) || '',
        mid: getStorageItem(PAN_MID_KEY) || '',
        links: null,
        win: null,
        winUsed: false
      };
      setFile(cur.p, '');
      overlay.hidden = false;
      document.documentElement.classList.add('pd-lock');

      var saved = cur.email;
      if (saved && isEmail(saved) && isMid(cur.mid)) {
        // 已记住邮箱：预开空白标签（用户手势内），校验通过后导航过去
        openBlankForAuto();
        startVerify();
      } else {
        viewEmail('');
      }
    }

    function close() {
      if (!overlay) return;
      session += 1;             // 使在途异步回调过期
      closeWinIfUnused();
      cur = null;
      busy = false;
      overlay.hidden = true;
      document.documentElement.classList.remove('pd-lock');
    }

    return { open: open, close: close };
  })();

  /**
   * 初始化列表逻辑（Promise 版：先解析配置，再拉 JSON，再绑定 UI）
   */
  function init() {
    if (!document.getElementById('mods-list')) return;   // 页面没包含 shortcode 就退出

    loadConfig()
      .then(function (cfg) {
        // 网盘总开关：进列表渲染前生效（弹框共用同一份配置）
        if (cfg.panEnabled) panEnabled = cfg.panEnabled;
        // 网盘官方域名表：重建直链用（缺省沿用代码里的默认三家域名）
        if (cfg.panHosts) panHosts = cfg.panHosts;
        bootstrap(cfg);
      })
      .catch(function (err) {
        console.error('[mods-list] init failed', err);
        var list = document.getElementById('mods-list');
        if (list) {
          list.innerHTML = '<div class="mods-empty">模组数据加载失败，请刷新重试</div>';
        }
      });
  }

  function bootstrap(cfg) {
    var modsList = document.getElementById('mods-list');
    var pager = document.getElementById('mods-pager');
    var header = document.getElementById('mods-header');
    var searchInput = document.getElementById('mod-search');
    var showCountEl = document.getElementById('show-count');
    /* 本页条数：showCountEl 是「符合条件总数」，这个才是当前页实际条数 */
    var pageCountEl = document.getElementById('show-count-page');
    /* 计数容器：有搜索词时给它加 .has-query，用于显示「本页」前缀 */
    var countBoxEl = document.querySelector('.sort-count');
    if (!modsList || !pager || !searchInput || !showCountEl) return;

    // 订阅数功能（列表展示 +「↓ 下载」排序）只在数据侧给了 subs 的页面（联机版）提供；
    // 没有该开关时始终按 ID，沿用单机版原来的正序/倒序按钮
    var hasSubs = !!cfg.subs;

    // 排序按钮：两个模组页各有一个，外观统一（.sort-gray-btn 灰框），只是文案与行为不同
    //   #sort-mode   → 联机版：「名称 / 下载」两态切换（有订阅数数据时才有意义）
    //   #sort-toggle → 单机版：「正序 / 倒序」切换（按 ID 排）
    var sortModeBtn = hasSubs ? document.getElementById('sort-mode') : null;
    if (hasSubs && !sortModeBtn) return;

    var sortToggleBtn = hasSubs ? null : document.getElementById('sort-toggle');
    if (!hasSubs && !sortToggleBtn) return;

    var filteredMods = cfg.searchOnly && !cfg.searchKeyword ? [] : cfg.allMods.slice();
    var sortMode = hasSubs ? loadSortMode() : 'id';
    var sortDir = 'asc';   // 仅单机版使用；联机版方向由 sortMode 固定
    var currentPage = 1;   // 1-based

    if (cfg.searchKeyword) searchInput.value = cfg.searchKeyword;

    if (sortModeBtn) updateSortModeButton();
    else updateSortDirButton();
    applyFilter();

    /* ---------- 工具 ---------- */
    function totalPages() {
      if (filteredMods.length === 0) return 0;
      return Math.ceil(filteredMods.length / PAGE_SIZE);
    }

    /**
     * 计数口径（工具栏「本页 N / 共 M 个模组」）：
     *   本页条数 = 当前这一页实际渲染的条数（翻页会变，最后一页可能不足 PAGE_SIZE）
     *   总数     = 符合当前搜索条件的模组数（跨页合计；无搜索时即全部模组数）
     * 两个数字分别由 renderList / applyFilter 驱动写入，元素缺失时静默跳过（兼容旧页面）。
     */
    function updateShowCount() {
      if (showCountEl) showCountEl.textContent = filteredMods.length;
    }

    function updatePageCount(pageCount) {
      if (!pageCountEl) return;
      pageCountEl.textContent = pageCount;
    }

    function clampPage(page) {
      var pages = totalPages();
      if (pages === 0) return 1;
      if (page < 1) return 1;
      if (page > pages) return pages;
      return page;
    }

    /* ---------- 渲染 ---------- */
    function renderList() {
      var pages = totalPages();
      if (pages === 0) {
        modsList.innerHTML = '<div class="mods-empty">未找到匹配的模组，试试其他关键词</div>';
        updatePageCount(0);
        renderPager();
        return;
      }
      currentPage = clampPage(currentPage);

      var start = (currentPage - 1) * PAGE_SIZE;
      var pageMods = filteredMods.slice(start, start + PAGE_SIZE);
      modsList.innerHTML = mapJoin(pageMods, function (m) { return buildModItem(m, cfg); });
      updatePageCount(pageMods.length);
      renderPager();
    }

    function reload() {
      currentPage = 1;
      renderList();
      updateShowCount();
    }

    /* ---------- 分页器 ---------- */
    function pagerItems(current, pages) {
      var items = [];
      var i;
      if (pages <= 7) {
        for (i = 1; i <= pages; i++) items.push(i);
        return items;
      }
      items.push(1);
      var lo = Math.max(2, current - 2);
      var hi = Math.min(pages - 1, current + 2);
      if (lo > 2) items.push('…');
      for (i = lo; i <= hi; i++) items.push(i);
      if (hi < pages - 1) items.push('…');
      items.push(pages);
      return items;
    }

    function pagerButtonHtml(item, isCurrent) {
      var cls = 'pager-btn' + (isCurrent ? ' is-active' : '');
      var currentAttr = isCurrent ? ' aria-current="page"' : '';
      return '<button type="button" class="' + cls + '" data-page="' + item + '"' + currentAttr + '>' + item + '</button>';
    }

    function renderPager() {
      var pages = totalPages();
      if (pages <= 1) {
        pager.innerHTML = '';
        pager.style.display = 'none';
        return;
      }
      var html = '';
      // html += '<span class="pager-info">第 ' + currentPage + ' / ' + pages + ' 页</span>';

      html += '<button type="button" class="pager-btn pager-prev" data-page="' + (currentPage - 1) + '"' +
        ' title="上一页" aria-label="上一页"' + (currentPage <= 1 ? ' disabled' : '') + '>‹</button>';

      var items = pagerItems(currentPage, pages);
      for (var i = 0; i < items.length; i++) {
        if (items[i] === '…') {
          html += '<span class="pager-ellipsis">…</span>';
        } else {
          html += pagerButtonHtml(items[i], items[i] === currentPage);
        }
      }

      html += '<button type="button" class="pager-btn pager-next" data-page="' + (currentPage + 1) + '"' +
        ' title="下一页" aria-label="下一页"' + (currentPage >= pages ? ' disabled' : '') + '>›</button>';

      pager.innerHTML = html;
      pager.style.display = '';
    }

    function goToPage(page) {
      page = clampPage(page);
      if (page === currentPage) return;
      currentPage = page;
      renderList();
      // 切页后回到列表/搜索区顶部，避免停留在长列表中间
      var anchor = header || modsList;
      if (anchor && anchor.scrollIntoView) {
        try { anchor.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        catch (e) { anchor.scrollIntoView(); }
      }
    }

    pager.addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== pager && node.tagName !== 'BUTTON') node = node.parentNode;
      if (!node || node === pager || node.disabled) return;
      var page = parseInt(node.getAttribute('data-page'), 10);
      if (!isNaN(page)) goToPage(page);
    });

    /* ---------- 搜索 & 排序 ---------- */
    function applyFilter() {
      var kw = (searchInput.value || '').trim().toLowerCase();
      /* 有搜索词时计数前缀「本页」才有意义（本页 < 命中总数）；无搜索时只报总数 */
      if (countBoxEl) countBoxEl.classList.toggle('has-query', !!kw);
      if (!kw) {
        filteredMods = cfg.searchOnly ? [] : cfg.allMods.slice();
      } else {
        filteredMods = cfg.allMods.filter(function (m) {
          // 双向子串匹配：字段包含搜索词，或搜索词包含字段
          var idLower = (m.id || '').toLowerCase();
          var nameLower = (m.name || '').toLowerCase();
          if (idLower.indexOf(kw) !== -1 || kw.indexOf(idLower) !== -1) return true;
          if (nameLower.indexOf(kw) !== -1 || kw.indexOf(nameLower) !== -1) return true;
          // 订阅数也参与搜索：完整数字（10327254）和「万/亿」缩写（1032.7万）都能命中
          var subsNum = subsOf(m);
          if (subsNum > 0 &&
              (String(subsNum).indexOf(kw) !== -1 || formatSubsCount(subsNum).toLowerCase().indexOf(kw) !== -1)) return true;
          // 匹配标签（双向子串 + 支持数组或顿号/逗号分隔字符串）
          var tags = m.tags;
          if (tags) {
            var tagList = typeof tags === 'string' ? tags.split(/[,，、]/) : tags;
            for (var ti = 0; ti < tagList.length; ti++) {
              var tagLower = (tagList[ti] || '').trim().toLowerCase();
              if (!tagLower) continue;
              if (tagLower.indexOf(kw) !== -1 || kw.indexOf(tagLower) !== -1) return true;
            }
          }
          return false;
        });
      }
      applySort();
      reload();
    }

    function applySort() {
      filteredMods.sort(function (a, b) {
        var byId = (a.id || '').localeCompare(b.id || '');
        if (hasSubs && sortMode === 'subs') {
          // （倒序）热度：固定热度（订阅数）高到低；数字相同的按 ID 升序兜底，保证分页结果稳定
          var diff = subsOf(b) - subsOf(a);
          if (diff !== 0) return diff;
          return byId;
        }
        // （正序）名称 = 按 ID 从小到大；单机版的倒序仍由正序/倒序按钮控制
        return sortDir === 'desc' && !hasSubs ? -byId : byId;
      });
    }

    function subsOf(mod) {
      var num = typeof mod.subs === 'number' ? mod.subs : parseInt(mod.subs, 10);
      return isFinite(num) ? num : 0;
    }
    /** 每种排序固定的方向：（正序）名称 = asc，（倒序）下载 = desc */
    function dirOfMode(mode) {
      return SORT_DEFAULT_DIR[mode] || 'asc';
    }

    /**
     * 联机版：单个按钮，只有两种排序，点一下来回切：
     *   ↑ 名称（正序，= 按 ID 小到大） ⇄ ↓ 热度（倒序，subs 高到低）
     * 箭头是同一个 SVG，倒序时加 .is-flipped 旋转 180°（见 ds-mods.css），
     * 因此切换时图形与占位完全相同，按钮不会有任何横向抖动。
     */
    function updateSortModeButton() {
      var arrow = sortModeBtn.querySelector('.sort-arrow');
      var modeLabel = sortModeBtn.querySelector('.sort-mode-label');
      var isSubsSort = sortMode === 'subs';
      if (modeLabel) modeLabel.textContent = SORT_MODE_LABEL[sortMode] || SORT_MODE_LABEL.name;
      // 倒序 = 箭头翻过来朝下，正序 = 朝上
      if (arrow) arrow.classList.toggle('is-flipped', isSubsSort);
      sortModeBtn.classList.toggle('is-active', isSubsSort);
      sortModeBtn.setAttribute('data-mode', sortMode);
      sortModeBtn.setAttribute('data-dir', dirOfMode(sortMode));
      sortModeBtn.setAttribute('aria-pressed', isSubsSort ? 'true' : 'false');
      sortModeBtn.setAttribute('title', isSubsSort
        ? '当前：倒序 · 热度（从高到低），点击切换为正序 · 名称'
        : '当前：正序 · 名称（ID 小到大），点击切换为倒序 · 热度（从高到低）');
    }

    /** 单机版：同样只有两态（正序 / 倒序），按钮外观与联机版一致（.sort-gray-btn） */
    function updateSortDirButton() {
      if (!sortToggleBtn) return;
      var arrow = sortToggleBtn.querySelector('.sort-arrow');
      var label = sortToggleBtn.querySelector('.sort-label');
      var isAsc = sortDir === 'asc';
      if (arrow) arrow.classList.toggle('is-flipped', !isAsc);
      if (label) label.textContent = isAsc ? '正序' : '倒序';
      sortToggleBtn.setAttribute('data-sort', sortDir);
      sortToggleBtn.setAttribute('title', isAsc
        ? '当前：正序（ID 小到大），点击切换为倒序'
        : '当前：倒序（ID 大到小），点击切换为正序');
    }

    /* ---------- 事件 ---------- */
    if (sortModeBtn) {
      sortModeBtn.addEventListener('click', function () {
        // 只有两种排序，来回切：名称（正序） ⇄ 热度（倒序）
        sortMode = sortMode === 'subs' ? 'name' : 'subs';
        saveSortMode(sortMode);
        updateSortModeButton();
        applyFilter();
      });
    }

    if (sortToggleBtn) {
      sortToggleBtn.addEventListener('click', function () {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        updateSortDirButton();
        applyFilter();
      });
    }

    var searchTimer = null;
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilter, SEARCH_DEBOUNCE_MS);
    });

    /* ---------- 网盘跳转（委托） ----------
       direct 模式按钮只带 data-disk/data-slug/data-pwd（不再把 URL 塞进 onclick 属性），
       这里统一用官方域名重建成规范短链后 window.open；
       下方 modal 模式的按钮行为不变：走 PanDialog.open（校验邮箱后才由后端给链接）。 */
    modsList.addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== modsList) {
        if (node.getAttribute && node.getAttribute('data-pan-direct')) break;
        node = node.parentNode;
      }
      if (!node || node === modsList) return;
      e.stopPropagation();
      var url = buildPanUrl(node.getAttribute('data-disk'), node.getAttribute('data-slug'), node.getAttribute('data-pwd'));
      if (url) window.open(url, '_blank', 'noopener');
    });
  }

  function mapJoin(arr, fn) {
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(fn(arr[i], i));
    return out.join('');
  }

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(init);

  global.ModsList = {
    init: init,
    PanDialog: PanDialog,
    // 网盘链接工具（/s/ 规范化 + 官方域名重建），供页面其它脚本复用：
    //   ModsList.buildPanUrl('baidu', '1AbC', 'x1y2') → https://pan.baidu.com/s/1AbC?pwd=x1y2
    //   ModsList.panUrlOf(mod, 'quark')              → 按 JSON 里的 slug/pwd 拼直链
    buildPanUrl: buildPanUrl,
    panUrlOf: panUrlOf,
    normalizePanUrl: normalizePanUrl,
    panHosts: function () { return panHosts; }
  };
})(window);
