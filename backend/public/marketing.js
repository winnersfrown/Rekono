(function () {
  var items = document.querySelectorAll('.reveal');
  if (!items.length) return;

  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    items.forEach(function (el) { el.classList.add('is-visible'); });
    return;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

  items.forEach(function (el) { observer.observe(el); });
})();

(function () {
  var toggleBtns = document.querySelectorAll('.billing-toggle-btn');
  var grid = document.querySelector('.pricing-grid');
  if (!toggleBtns.length || !grid) return;

  toggleBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      toggleBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      grid.classList.toggle('is-annual', btn.dataset.period === 'annual');
    });
  });
})();

(function () {
  var API_BASE = '';
  var modal = document.getElementById('contact-modal');
  var form = document.getElementById('contact-form');
  var statusEl = document.getElementById('contact-status');
  var triggers = document.querySelectorAll('a[href^="mailto:wfrownusa@yahoo.com"]');

  function openModal(e) {
    if (e) e.preventDefault();
    statusEl.hidden = true;
    statusEl.className = 'contact-status';
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('contact-name').focus();
  }

  function closeModal() {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
  }

  triggers.forEach(function (el) { el.addEventListener('click', openModal); });
  modal.querySelectorAll('[data-close-modal]').forEach(function (el) {
    el.addEventListener('click', closeModal);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
  });

  function showStatus(kind, html) {
    statusEl.hidden = false;
    statusEl.className = 'contact-status status-' + kind;
    statusEl.innerHTML = html;
  }

  var MAILTO_FALLBACK = 'mailto:wfrownusa@yahoo.com?subject=Rekono%20contact%20form';

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    var payload = {
      name: document.getElementById('contact-name').value.trim(),
      email: document.getElementById('contact-email').value.trim(),
      message: document.getElementById('contact-message').value.trim(),
      company: document.getElementById('contact-company').value,
    };

    fetch(API_BASE + '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (result) {
        if (result.ok) {
          showStatus('ok', "Message sent \u2014 we'll get back to you within 1 business day.");
          form.reset();
        } else {
          showStatus(
            'error',
            (result.body && result.body.detail ? result.body.detail : 'Something went wrong.') +
              ' <a href="' + MAILTO_FALLBACK + '">Email us directly instead \u2192</a>'
          );
        }
      })
      .catch(function () {
        showStatus(
          'error',
          'Couldn\'t reach the server. <a href="' + MAILTO_FALLBACK + '">Email us directly instead \u2192</a>'
        );
      })
      .finally(function () {
        submitBtn.disabled = false;
      });
  });
})();
