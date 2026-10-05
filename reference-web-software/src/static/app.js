// Progressive enhancement for the HR admin UI. Every page works without JavaScript.
(function () {
  'use strict';

  // Render UTC timestamps in the viewer's local time zone.
  var fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  document.querySelectorAll('time[data-local]').forEach(function (el) {
    var d = new Date(el.getAttribute('datetime'));
    if (!isNaN(d.getTime())) {
      el.title = el.textContent;
      el.textContent = fmt.format(d);
    }
  });

  // Mobile navigation toggle.
  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.getElementById('mainnav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function copy(text, button) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () {
      var label = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = label; }, 1500);
    });
  }

  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () { copy(b.getAttribute('data-copy'), b); });
  });

  // API key reveal: fetched on demand (CSRF-protected) so it is not embedded in the page.
  var reveal = document.querySelector('[data-reveal]');
  var target = document.querySelector('[data-secret-target]');
  var copySecret = document.querySelector('[data-copy-secret]');
  var secret = null;
  if (reveal && target) {
    reveal.addEventListener('click', function () {
      if (secret !== null && reveal.getAttribute('aria-pressed') === 'true') {
        target.textContent = reveal.getAttribute('data-masked');
        reveal.textContent = 'Reveal';
        reveal.setAttribute('aria-pressed', 'false');
        if (copySecret) copySecret.hidden = true;
        return;
      }
      var show = function () {
        target.textContent = secret;
        reveal.textContent = 'Hide';
        reveal.setAttribute('aria-pressed', 'true');
        if (copySecret) copySecret.hidden = false;
      };
      if (secret !== null) return show();
      reveal.disabled = true;
      fetch('/integration/reveal-key', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': reveal.getAttribute('data-csrf'), accept: 'application/json' }
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (j) {
          secret = j.apiKey;
          show();
        })
        .catch(function () {
          target.textContent = 'Could not load the key — reload the page and sign in again.';
        })
        .finally(function () { reveal.disabled = false; });
    });
    if (copySecret) copySecret.addEventListener('click', function () { if (secret) copy(secret, copySecret); });
  }

  // Confirm status changes that remove an employee from attendance capture.
  var statusForm = document.querySelector('[data-status-form]');
  if (statusForm) {
    var select = statusForm.querySelector('[data-status-select]');
    var submit = statusForm.querySelector('[data-status-submit]');
    var sync = function () {
      if (!select || !submit) return;
      var v = select.value;
      submit.textContent = v === 'terminated' ? 'Terminate employee' : 'Change status to ' + select.options[select.selectedIndex].text;
      submit.classList.toggle('btn-danger', v === 'terminated');
      submit.classList.toggle('btn-danger-outline', v !== 'terminated');
    };
    if (select) select.addEventListener('change', sync);
    sync();
    statusForm.addEventListener('submit', function (e) {
      var v = select ? select.value : '';
      if (v === 'terminated' || v === 'inactive') {
        var msg = v === 'terminated'
          ? 'Terminate this employee? BAMP will remove them from all branch devices and refuse attendance from the effective time.'
          : 'Mark this employee inactive? BAMP will remove them from branch devices.';
        if (!window.confirm(msg)) e.preventDefault();
      }
    });
  }
})();
