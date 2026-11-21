(function () {
  var root = document.documentElement;
  var btn = document.getElementById('theme');
  var KEY = 'dmc-legal-theme';
  function read() {
    try { return localStorage.getItem(KEY); } catch { return null; }
  }
  function write(v) {
    try { localStorage.setItem(KEY, v); } catch { return; }
  }
  var saved = read();
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  function current() {
    return root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function label() { btn.textContent = current() === 'dark' ? 'Light mode' : 'Dark mode'; }
  btn.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    write(next);
    label();
  });
  label();
})();
