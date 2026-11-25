/*
 * neat.link: the tracking pixels a page's owner added in its settings. The
 * page names them on this script's tag (data-google, data-meta, data-tiktok);
 * each is the vendor's own loader, as the vendor publishes it. Pages without
 * pixels never load this file.
 */
(function () {
  var tag = document.currentScript;
  var ids = (tag && tag.dataset) || {};

  function load(src) {
    var script = document.createElement("script");
    script.async = true;
    script.src = src;
    document.head.appendChild(script);
  }

  if (ids.google) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };
    window.gtag("js", new Date());
    window.gtag("config", ids.google);
    load("https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(ids.google));
  }

  if (ids.meta && !window.fbq) {
    var fbq = (window.fbq = function () {
      if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments);
      else fbq.queue.push(arguments);
    });
    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = "2.0";
    fbq.queue = [];
    fbq("init", ids.meta);
    fbq("track", "PageView");
    load("https://connect.facebook.net/en_US/fbevents.js");
  }

  if (ids.tiktok) {
    var name = "ttq";
    window.TiktokAnalyticsObject = name;
    var ttq = (window[name] = window[name] || []);
    ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie", "holdConsent", "revokeConsent", "grantConsent"];
    ttq.setAndDefer = function (target, method) {
      target[method] = function () {
        target.push([method].concat(Array.prototype.slice.call(arguments, 0)));
      };
    };
    for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
    ttq.instance = function (id) {
      var instance = ttq._i[id] || [];
      for (var n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(instance, ttq.methods[n]);
      return instance;
    };
    ttq.load = function (id, options) {
      var src = "https://analytics.tiktok.com/i18n/pixel/events.js";
      ttq._i = ttq._i || {};
      ttq._i[id] = [];
      ttq._i[id]._u = src;
      ttq._t = ttq._t || {};
      ttq._t[id] = +new Date();
      ttq._o = ttq._o || {};
      ttq._o[id] = options || {};
      load(src + "?sdkid=" + encodeURIComponent(id) + "&lib=" + name);
    };
    ttq.load(ids.tiktok);
    ttq.page();
  }
})();
