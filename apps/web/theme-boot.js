// Sets the theme before the first paint, so that a person who chose dark never sees a flash of light. The rule is the one in theme.js (resolveTheme); apps/web/test/theme.test.js runs this file against it.
(function () {
  var choice = 'system', dark = false;
  try { choice = localStorage.getItem('nuvrion.theme') || 'system'; } catch (error) { /* storage may be blocked */ }
  try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (error) { /* no media queries */ }
  document.documentElement.setAttribute('data-theme', choice === 'dark' || (choice !== 'light' && dark) ? 'dark' : 'light');
}());
