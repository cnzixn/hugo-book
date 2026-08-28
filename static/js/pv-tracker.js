/**
 * bxq PV 追踪器 - 页面浏览计数客户端（非压缩源码版）
 * 配合 Cloudflare Worker PV 计数服务使用
 *
 * 使用方式：
 *   1) 引入 <script src="/js/pv-tracker.min.js" defer></script>，
 *      页面有 <span data-pv> / <span data-pv="site"> / <span data-uv="site"> 即自动填
 *   2) 手动模式：window.PVTracker.init({ autoTrack:false })
 *
 * 优化历史（相对初版）：
 *   2026-08-29  FingerprintJS 改为 Cloudflare (unpkg) 节点；
 *               FingerprintJS 加载超时 5s → 1.5s；
 *               fetch 加 1.5s AbortController 超时；
 *               去掉 load 事件后 500ms 硬延迟，改成 DOMContentLoaded + requestIdleCallback；
 *               localStorage 读取加 try/catch（兼容 Safari 无痕）
 */
(function (root) {
  "use strict";

  /** 构造函数（单例） */
  function PVTracker() {
    this.config = {
      apiBase: "https://pv.bxq.me",        // PV 服务端（Cloudflare Worker）
      site: "",                             // 站点标识，默认 hostname
      autoTrack: true,
      useHash: true,
      fingerprint: true,
      debug: false,
      scriptTimeoutMs: 1500,                // FingerprintJS 动态加载超时（毫秒）
      fetchTimeoutMs: 1500,                 // fetch 请求超时（毫秒）
    };
    this._initialized = false;
    this._visitorId = null;
  }

  /** 取单例（用于 log / 调试） */
  var singleton = null;

  /** 调试日志 */
  function debug(msg) {
    var t = singleton;
    if (t && t.config && t.config.debug) {
      console.log("[PVTracker]", msg);
    }
  }

  /** 安全读 localStorage */
  function safeGetItem(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  /** 安全写 localStorage */
  function safeSetItem(k, v) {
    try { localStorage.setItem(k, v); return true; } catch (e) { return false; }
  }

  /**
   * 调 PV 接口
   * @param {"GET"|"POST"} method
   * @param {Record<string,string|number|undefined>} params
   * @param {Record<string,string>} [extraHeaders]
   */
  function request(method, params, extraHeaders) {
    var t = singleton;
    if (!t) return Promise.reject(new Error("PVTracker 未初始化"));

    var qs = t.config.apiBase + "?";
    var pairs = [];
    for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k) && params[k] !== undefined) {
        pairs.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      }
    }
    var url = qs + pairs.join("&");
    debug("请求: " + method + " " + url);

    var init = {
      method: method,
      headers: Object.assign({ Accept: "application/json" }, extraHeaders || {}),
    };

    // AbortController 超时（浏览器越旧越需要；不支持就跳过，退化为默认超时）
    var ctrl = null;
    if ("AbortController" in root || typeof AbortController !== "undefined") {
      try {
        ctrl = new AbortController();
        init.signal = ctrl.signal;
        setTimeout(function () { ctrl && ctrl.abort(); }, t.config.fetchTimeoutMs);
      } catch (_) { ctrl = null; }
    }

    return fetch(url, init)
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + resp.statusText);
        return resp.json();
      })
      .then(function (data) {
        debug("响应: " + JSON.stringify(data));
        return data;
      })
      .catch(function (err) {
        debug("错误: " + err.message);
        throw err;
      });
  }

  /** 生成 UUID（用于无法用 fingerprint 的回退） */
  function genUUID() {
    if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (16 * Math.random()) | 0;
      var v = c === "x" ? r : (3 & r) | 8;
      return v.toString(16);
    });
  }

  /**
   * 初始化
   * @param {Partial<PVTracker["config"]>} [opts]
   */
  PVTracker.prototype.init = function (opts) {
    var self = this;

    if (self._initialized) {
      // 已初始化：只允许改配置 + 重新填标签
      if (opts) {
        for (var k in opts) {
          if (Object.prototype.hasOwnProperty.call(opts, k) &&
              Object.prototype.hasOwnProperty.call(self.config, k)) {
            self.config[k] = opts[k];
          }
        }
        self._lastResult = null;
        debug("配置已合并，重新填充标签");
        self.fill();
      }
      return self;
    }

    if (opts) {
      for (var k2 in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k2) &&
            Object.prototype.hasOwnProperty.call(self.config, k2)) {
          self.config[k2] = opts[k2];
        }
      }
    }

    // site 默认 hostname
    if (!self.config.site) {
      if (typeof window !== "undefined" && window.location) {
        self.config.site = window.location.hostname;
      } else {
        self.config.site = "localhost";
      }
    }

    self._initialized = true;
    singleton = self;
    PVTracker._instance = self;
    debug("初始化完成，站点: " + self.config.site + "，自动上报: " + self.config.autoTrack);

    // 自动模式：DOMContentLoaded 后 requestIdleCallback 跑（等不到就用 setTimeout 0）
    if (self.config.autoTrack && typeof window !== "undefined") {
      function run() {
        self.track().then(function () { self.fill(); }).catch(function () { self.fill(); });
      }
      function scheduleRun() {
        if (typeof requestIdleCallback === "function") {
          try {
            requestIdleCallback(run, { timeout: 800 });
            return;
          } catch (_) { /* noop */ }
        }
        setTimeout(run, 0);
      }
      if (document.readyState === "complete" || document.readyState === "interactive") {
        scheduleRun();
      } else {
        document.addEventListener("DOMContentLoaded", scheduleRun, { once: true });
      }
    }

    return self;
  };

  /** 更新配置 */
  PVTracker.prototype.setConfig = function (opts) {
    if (opts) {
      for (var k in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k) &&
            Object.prototype.hasOwnProperty.call(this.config, k)) {
          this.config[k] = opts[k];
        }
      }
    }
    debug("配置已更新");
    return this;
  };

  /**
   * 获取访客 ID（优先 FingerprintJS，失败 UUID 回退）
   * @returns {Promise<string>}
   */
  PVTracker.prototype.getVisitorId = function () {
    var self = this;
    if (self._visitorId) return Promise.resolve(self._visitorId);

    var cached = safeGetItem("_pv_visitor");
    if (cached) {
      self._visitorId = cached;
      debug("访客标识（缓存）: " + cached);
      return Promise.resolve(cached);
    }

    // 不走 Fingerprint：直接 UUID
    if (!self.config.fingerprint || typeof window === "undefined") {
      var uid1 = "uuid_" + genUUID();
      safeSetItem("_pv_visitor", uid1);
      self._visitorId = uid1;
      debug("访客标识（UUID）: " + uid1);
      return Promise.resolve(uid1);
    }

    // Cloudflare (unpkg) 上的 FingerprintJS v3
    var cdnURL = "https://unpkg.com/@fingerprintjs/fingerprintjs@3/dist/fp.min.js";
    var timeoutMs = self.config.scriptTimeoutMs || 1500;

    return loadScript(cdnURL, timeoutMs)
      .then(function () {
        if (typeof FingerprintJS === "undefined") throw new Error("FingerprintJS loaded but FingerprintJS 全局不存在");
        return FingerprintJS.load();
      })
      .then(function (agent) { return agent.get(); })
      .then(function (res) {
        var fp = "fp_" + res.visitorId;
        safeSetItem("_pv_visitor", fp);
        self._visitorId = fp;
        debug("访客标识（FingerprintJS）: " + fp);
        return fp;
      })
      .catch(function (err) {
        debug("FingerprintJS 失败: " + err.message + "，回退 UUID");
        var uid2 = "uuid_" + genUUID();
        safeSetItem("_pv_visitor", uid2);
        self._visitorId = uid2;
        debug("访客标识（UUID）: " + uid2);
        return uid2;
      });
  };

  /** 动态加载外部 JS（带超时），返回 Promise */
  function loadScript(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.async = true;
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        s.onload = s.onerror = null;
        if (s.parentNode) s.parentNode.removeChild(s);
        reject(new Error("Script timeout: " + url));
      }, timeoutMs);
      s.onload = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (s.parentNode) s.parentNode.removeChild(s);
        resolve();
      };
      s.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (s.parentNode) s.parentNode.removeChild(s);
        reject(new Error("Script load failed: " + url));
      };
      (document.head || document.getElementsByTagName("head")[0]).appendChild(s);
    });
  }

  /** 页面 hash（用于 page 字段压缩） */
  PVTracker.prototype.getPageHash = function () {
    var self = this;
    if (self.config.useHash) {
      var url = (typeof window !== "undefined" && window.location) ? window.location.href : ("page_" + Date.now());
      var h = 0;
      for (var i = 0; i < url.length; i++) {
        h = (h << 5) - h + url.charCodeAt(i);
        h |= 0;
      }
      var hex = Math.abs(h).toString(16).slice(0, 5);
      while (hex.length < 5) hex = "0" + hex;
      return self.config.site + "_" + hex;
    }
    return self.config.site + ((window && window.location) ? window.location.pathname : "");
  };

  /**
   * 上报一次 PV（同页会话内去重）
   */
  PVTracker.prototype.track = function () {
    var self = this;
    if (!self._initialized) {
      debug("未初始化，请先调用 init()");
      return Promise.reject(new Error("PVTracker 未初始化"));
    }
    var key = self.getPageHash();
    try {
      var markKey = "_pv_tracked_" + key;
      if (sessionStorage.getItem(markKey)) {
        debug("本页已上报过，跳过");
        return Promise.resolve({ views: null, skipped: true });
      }
      sessionStorage.setItem(markKey, "1");
    } catch (_) { /* 隐私模式下 sessionStorage 可能挂 */ }

    return self.getVisitorId()
      .then(function (vid) {
        return request("GET", {
          site: self.config.site,
          page: key,
          visitor: vid,
          raw: self.config.useHash ? undefined : "1",
        });
      })
      .then(function (data) {
        self._lastResult = data;
        return data;
      });
  };

  /** 强制上报（跳过会话去重） */
  PVTracker.prototype.trackForce = function () {
    var self = this;
    if (!self._initialized) return Promise.reject(new Error("PVTracker 未初始化"));
    return self.getVisitorId()
      .then(function (vid) {
        return request("GET", {
          site: self.config.site,
          page: self.getPageHash(),
          visitor: vid,
          raw: self.config.useHash ? undefined : "1",
        });
      })
      .then(function (d) { self._lastResult = d; return d; });
  };

  /** 查本页数据（不上报） */
  PVTracker.prototype._queryAll = function () {
    var self = this;
    return request("GET", {
      site: self.config.site,
      page: self.getPageHash(),
      mode: "query",
      raw: self.config.useHash ? undefined : "1",
    });
  };

  PVTracker.prototype.queryPage = function (pageKey) {
    if (!this._initialized) return Promise.reject(new Error("PVTracker 未初始化"));
    return request("GET", {
      site: this.config.site,
      page: pageKey || this.getPageHash(),
      mode: "query",
      raw: this.config.useHash ? undefined : "1",
    });
  };

  PVTracker.prototype.querySite = function () {
    if (!this._initialized) return Promise.reject(new Error("PVTracker 未初始化"));
    return request("GET", { site: this.config.site });
  };

  PVTracker.prototype.querySiteBySite = function (site) {
    if (!this._initialized) return Promise.reject(new Error("PVTracker 未初始化"));
    return request("GET", { site: site });
  };

  PVTracker.prototype.clearSite = function () {
    if (!this._initialized) return Promise.reject(new Error("PVTracker 未初始化"));
    return request("POST", { site: this.config.site });
  };

  /** 填充页面所有 data-pv / data-uv 标签 */
  PVTracker.prototype.fill = function () {
    var self = this;
    if (!self._initialized) { debug("未初始化，跳过填充"); return; }

    var count = 0;
    try {
      count += document.querySelectorAll
        ? document.querySelectorAll("[data-pv], [data-uv]").length
        : 0;
    } catch (_) { /* ignore */ }
    if (count === 0) return;

    function apply(data) {
      var list;
      list = document.querySelectorAll('[data-pv]:not([data-pv="site"])');
      for (var i = 0; i < list.length; i++) setContent(list[i], data.views);
      if (list.length) debug("已填充 " + list.length + ' 个 data-pv="page" 标签: ' + data.views);

      list = document.querySelectorAll('[data-pv="site"]');
      for (var j = 0; j < list.length; j++) setContent(list[j], data.site_views);
      if (list.length) debug("已填充 " + list.length + ' 个 data-pv="site" 标签: ' + data.site_views);

      list = document.querySelectorAll('[data-uv]:not([data-uv="site"])');
      for (var a = 0; a < list.length; a++) setContent(list[a], data.unique_visitors);
      if (list.length) debug("已填充 " + list.length + " 个 data-uv 标签: " + data.unique_visitors);

      list = document.querySelectorAll('[data-uv="site"]');
      for (var b = 0; b < list.length; b++) setContent(list[b], data.site_visitors);
      if (list.length) debug("已填充 " + list.length + ' 个 data-uv="site" 标签: ' + data.site_visitors);
    }

    function setContent(el, value) {
      var fmt = el.getAttribute("data-format") || el.getAttribute("data-pv-format");
      el.textContent = fmt ? fmt.replace("{count}", value) : value;
    }

    if (self._lastResult) {
      apply(self._lastResult);
      return;
    }
    self._queryAll()
      .then(function (d) { self._lastResult = d; apply(d); })
      .catch(function (err) { debug("填充标签失败: " + err.message); });
  };

  // 保持和原 min.js 兼容的几个属性挂法
  PVTracker._instance = null;

  // 导出：CommonJS / AMD / 全局
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PVTracker;
  } else if (typeof define === "function" && define.amd) {
    define(function () { return PVTracker; });
  } else {
    root.PVTracker = PVTracker;
    root.pvTracker = new PVTracker();
    root.pvTracker.init();
  }
})(typeof window !== "undefined" ? window : (typeof global !== "undefined" ? global : this));
