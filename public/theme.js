// Wunderlost — Copyright (C) 2026 Matt Hornish. AGPL-3.0-or-later; see LICENSE.
// Applies the saved theme before first paint so there's no light/dark flash.
// Loaded as a blocking script from index.html (kept in a file so the CSP can forbid inline scripts).
(function () {
  var t = 'auto';
  try { t = JSON.parse(localStorage.getItem('wl_theme')) || 'auto'; } catch (e) {}
  if (t === 'auto') t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
})();
