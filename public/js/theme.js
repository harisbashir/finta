// Runs before first paint (a classic script in <head>) so a chosen Light/Dark appearance never flashes.
(function () {
  try {
    var t = localStorage.getItem('finta-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage unavailable: follow the device */ }
})();
