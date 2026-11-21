(function () {
  var root = document.documentElement, btn = document.getElementById('theme'), saved = null;
  try { saved = localStorage.getItem('dmc-legal-theme'); } catch (e) {}
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  function current() {
    return root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function label() { btn.textContent = current() === 'dark' ? 'Light mode' : 'Dark mode'; }
  btn.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('dmc-legal-theme', next); } catch (e) {}
    label();
  });
  label();
})();
