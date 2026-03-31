(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('ai-ebot-assistant-save-index');
    var form = document.getElementById('ai-ebot-assistant-form');
    var box = document.getElementById('ai-ebot-assistant-index-status');
    var msgEl = document.getElementById('ai-ebot-assistant-index-status-text');
    var prog = document.getElementById('ai-ebot-assistant-index-progress');
    if (!btn || !form || !box || !msgEl) return;

    var cfg = window.aiEbotAssistantIndex || {};

    function setStatus(text, showProg) {
      box.hidden = !text && !showProg;
      msgEl.textContent = text || '';
      if (prog) prog.hidden = !showProg;
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
    });

    btn.addEventListener('click', function () {
      var presetInput = form.querySelector('input[name="' + (cfg.presetName || 'ai_ebot_tone_preset') + '"]:checked');
      var preset = presetInput ? presetInput.value : 'custom';
      var tone = form.querySelector('#ai_ebot_tone');
      var toneVal = tone ? tone.value : '';
      var strict = form.querySelector('input[name="ai_ebot_strict_grounding"]');
      var strictOn = strict && strict.checked;

      var body = new URLSearchParams();
      body.set('action', 'ai_ebot_assistant_save_index');
      body.set('nonce', cfg.nonce || '');
      body.set(cfg.presetName || 'ai_ebot_tone_preset', preset);
      body.set('ai_ebot_tone', toneVal);
      if (strictOn) body.set('ai_ebot_strict_grounding', '1');

      btn.disabled = true;
      setStatus(cfg.i18n.saving, true);

      fetch(cfg.ajaxUrl || '', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body.toString(),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            return { ok: r.ok, data: j };
          });
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
          setStatus(p.message || cfg.i18n.success, false);
        })
        .catch(function (e) {
          setStatus(e.message || cfg.i18n.errorGeneric, false);
        })
        .finally(function () {
          btn.disabled = false;
        });
    });
  });
})();
