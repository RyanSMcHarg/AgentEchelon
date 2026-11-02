// Loads the widget the way a host page does: one script tag for embed.js from the widget's origin, then
// AEWidget.mount(). The origin comes from host-config.js, which the publish writes from the Widget stack's
// WidgetDistributionUrl output (backend/scripts/deploy-frontend.mjs --widget-host), so this file names no
// deployment.
(function () {
  var status = document.getElementById('widget-status');
  function say(text) {
    status.textContent = text;
    status.hidden = false;
  }

  var config = window.AE_WIDGET_HOST || {};
  var origin = typeof config.widgetOrigin === 'string' ? config.widgetOrigin.replace(/\/$/, '') : '';
  if (!/^https:\/\/[^/\s]+$/.test(origin) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
    say('The widget is not configured for this page: host-config.js names no widget origin.');
    return;
  }

  var script = document.createElement('script');
  script.src = origin + '/embed.js';
  script.onload = function () {
    if (!window.AEWidget || typeof window.AEWidget.mount !== 'function') {
      say('The widget loader did not start.');
      return;
    }
    window.AEWidget.mount({
      src: origin + '/index.html',
      mode: 'guest',
      lang: navigator.language || document.documentElement.lang,
    });
  };
  script.onerror = function () {
    say('The widget could not be loaded from ' + origin + '.');
  };
  document.head.appendChild(script);
})();
