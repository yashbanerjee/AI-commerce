(function () {
  'use strict';

  function postPhase(phase, extra) {
    var cfg = window.aiEbotKnowledgePages || {};
    var body = new URLSearchParams();
    body.set('action', 'ai_ebot_knowledge_pages_index');
    body.set('nonce', cfg.nonce || '');
    body.set('phase', phase);
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        body.set(k, extra[k]);
      });
    }
    return fetch(cfg.ajaxUrl || '', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, status: r.status, data: j };
      });
    });
  }

  function setStatus(wrap, text, showProgress, determinate, pct) {
    var box = document.getElementById('ai-ebot-knowledge-index-status');
    var msg = document.getElementById('ai-ebot-knowledge-index-status-text');
    var prog = document.getElementById('ai-ebot-knowledge-index-progress');
    var fill = prog ? prog.querySelector('.ai-ebot-knowledge-index-progress__fill') : null;
    if (!box || !msg) return;
    box.hidden = !text && !showProgress;
    if (box.hidden) {
      if (prog) prog.hidden = true;
      return;
    }
    msg.textContent = text || '';
    if (prog) {
      prog.hidden = !showProgress;
      prog.classList.toggle('is-determinate', !!determinate);
      if (fill && determinate && typeof pct === 'number') {
        fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
      }
    }
  }

  function runSteps(cfg) {
    function step() {
      return postPhase('step').then(function (res) {
        if (!res.ok || !res.data.success) {
          var err =
            res.data && res.data.data && res.data.data.message
              ? res.data.data.message
              : cfg.i18n.errorGeneric;
          throw new Error(err);
        }
        var p = res.data.data;
        var done = p.done || 0;
        var total = p.total || 0;
        var pct = total > 0 ? Math.round((done / total) * 100) : 0;
        setStatus(
          null,
          cfg.i18n.indexingProgress.replace('%1$d', String(done)).replace('%2$d', String(total)),
          true,
          true,
          pct
        );
        if (p.finished) {
          setStatus(null, p.message || cfg.i18n.success, false, false, 0);
          return Promise.resolve();
        }
        return step();
      });
    }
    return step();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('ai-ebot-save-index-pages');
    var wrap = document.getElementById('ai-ebot-knowledge-pages-wrap');
    var hidden = document.getElementById('ai_ebot_sync_page_ids_csv');
    if (!btn || !wrap || !hidden) return;

    var cfg = window.aiEbotKnowledgePages || {};
    var form = document.getElementById('ai-ebot-knowledge-pages-form');
    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
      });
    }

    btn.addEventListener('click', function () {
      var previousCsv = wrap.getAttribute('data-previous-csv') || '';
      var newCsv = hidden.value.trim();
      btn.disabled = true;
      setStatus(wrap, cfg.i18n.saving, true, false, 0);

      postPhase('init', {
        page_ids_csv: newCsv,
        previous_csv: previousCsv,
      })
        .then(function (res) {
          if (!res.ok || !res.data.success) {
            var err =
              res.data && res.data.data && res.data.data.message
                ? res.data.data.message
                : cfg.i18n.errorGeneric;
            throw new Error(err);
          }
          var p = res.data.data;
          wrap.setAttribute('data-previous-csv', newCsv);

          if (p.finished) {
            setStatus(wrap, p.message || cfg.i18n.success, false, false, 0);
            return;
          }

          var total = p.total || 0;
          setStatus(
            wrap,
            cfg.i18n.indexingProgress.replace('%1$d', '0').replace('%2$d', String(total)),
            true,
            total > 0,
            total > 0 ? 0 : 0
          );
          return runSteps(cfg);
        })
        .catch(function (e) {
          setStatus(wrap, e.message || cfg.i18n.errorGeneric, false, false, 0);
        })
        .finally(function () {
          btn.disabled = false;
        });
    });
  });
})();

