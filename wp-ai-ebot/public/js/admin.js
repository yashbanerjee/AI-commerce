(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function qs(root, sel) {
    return root.querySelector(sel);
  }

  function fmtProgress(str, a, b) {
    return str
      .replace(/%1\$d/g, String(a))
      .replace(/%2\$d/g, String(b));
  }

  function applyIndexStatusFromAjax(s) {
    var str = window.aiEbotAdmin && window.aiEbotAdmin.indexStatusStrings;
    if (!str || !s) {
      return;
    }
    var catalogEl = $('ai-ebot-index-catalog-line');
    if (catalogEl) {
      if (s.has_full_reindex) {
        catalogEl.textContent = str.catalogSynced
          .replace(/%1\$d/g, String(s.indexed))
          .replace(/%2\$d/g, String(s.published));
      } else {
        catalogEl.textContent =
          str.catalogPending +
          (s.published > 0 ? ' ' + str.catalogPublishedOnly.replace(/%d/g, String(s.published)) : '');
      }
    }
    var reindexAt = $('ai-ebot-index-reindex-at');
    if (reindexAt) {
      reindexAt.textContent = s.has_full_reindex ? s.full_reindex_human : str.reindexNever;
    }
    var syncEl = $('ai-ebot-index-last-sync');
    if (syncEl) {
      syncEl.className =
        'ai-ebot-index-status__value ai-ebot-index-status__sync' +
        (s.last_ingest_ok ? ' is-ok' : ' is-bad');
      if (!s.last_ingest_formatted || s.last_ingest_formatted === '—') {
        syncEl.textContent = str.reindexNever;
        syncEl.className = 'ai-ebot-index-status__value ai-ebot-index-status__sync';
      } else {
        syncEl.textContent =
          (s.last_ingest_ok ? str.syncSucceeded : str.syncFailed) + ' — ' + s.last_ingest_formatted;
      }
    }
    var hint = $('ai-ebot-index-hint');
    if (hint) {
      hint.hidden = !(s.has_full_reindex && s.indexed < s.published);
    }
  }

  function runReindexRequest(productOffset, extrasOnly) {
    var fd = new FormData();
    fd.append('action', 'ai_ebot_reindex');
    fd.append('nonce', window.aiEbotAdmin.reindexNonce);
    fd.append('reindex_progress', '1');
    if (extrasOnly) {
      fd.append('reindex_extras', '1');
    } else {
      fd.append('product_offset', String(productOffset));
    }
    return fetch(window.aiEbotAdmin.ajaxUrl, {
      method: 'POST',
      credentials: 'same-origin',
      body: fd,
    }).then(function (r) {
      return r.json().then(function (j) {
        return j;
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!window.aiEbotAdmin) {
      return;
    }
    var btn = $('ai-ebot-reindex-btn');

    var progress = $('ai-ebot-reindex-progress');
    var success = $('ai-ebot-reindex-success');
    var errEl = $('ai-ebot-reindex-error');
    var label = $('ai-ebot-reindex-progress-label');
    var successText = $('ai-ebot-reindex-success-text');
    var i18n = window.aiEbotAdmin.i18n || {};

    function setDeterminateProgress(pct) {
      if (!progress) return;
      progress.classList.add('is-determinate');
      var fill = qs(progress, '.ai-ebot-reindex-progress__fill');
      if (fill) {
        fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      }
    }

    function updateProgressLabel(data) {
      var total = typeof data.total_products === 'number' ? data.total_products : 0;
      var cur = typeof data.indexed_so_far === 'number' ? data.indexed_so_far : 0;
      if (label) {
        if (total > 0 && i18n.indexingProgress) {
          label.textContent = fmtProgress(i18n.indexingProgress, cur, total);
          setDeterminateProgress((cur / total) * 100);
        } else {
          label.textContent = i18n.indexing || 'Indexing…';
          setDeterminateProgress(0);
        }
      }
      var str = window.aiEbotAdmin.indexStatusStrings;
      var liveCatalog = $('ai-ebot-index-catalog-line');
      if (liveCatalog && str && str.syncLive && total > 0) {
        liveCatalog.textContent = fmtProgress(str.syncLive, cur, total);
      }
    }

    function finishSuccess(finalJson) {
      var j = finalJson;
      if (!j.success || !j.data) {
        return;
      }
      var msg = j.data.message ? j.data.message : i18n.success;
      if (
        typeof j.data.product_count === 'number' &&
        j.data.product_count > 0 &&
        i18n.productCountSuffix
      ) {
        msg += ' ' + i18n.productCountSuffix.replace('%s', String(j.data.product_count));
      }
      successText.textContent = msg;
      success.hidden = false;
      if (j.data.index_status) {
        applyIndexStatusFromAjax(j.data.index_status);
      }
    }

    function finishError(j) {
      var errMsg = i18n.errorGeneric;
      if (j && j.data) {
        if (typeof j.data === 'string') {
          errMsg = j.data;
        } else if (j.data.message) {
          errMsg = j.data.message;
        }
      }
      errEl.textContent = errMsg;
      errEl.hidden = false;
    }

    function setInteractiveReindexDisabled(disabled) {
      if (btn) btn.disabled = disabled;
    }

    if (btn && progress && success && errEl && successText) {
      btn.addEventListener('click', function () {
        errEl.hidden = true;
        success.hidden = true;
        errEl.textContent = '';
        btn.disabled = true;
        progress.hidden = false;
        progress.classList.remove('is-determinate');
        var fillReset = qs(progress, '.ai-ebot-reindex-progress__fill');
        if (fillReset) {
          fillReset.style.width = '';
        }
        if (label) {
          label.textContent = i18n.indexing || 'Indexing…';
        }

        function doProducts(offset) {
          return runReindexRequest(offset, false).then(function (j) {
            if (!j.success) {
              return Promise.reject(j);
            }
            var d = j.data;
            updateProgressLabel(d);
            if (d.requires_extras) {
              if (label && i18n.indexingExtras) {
                label.textContent = i18n.indexingExtras;
              }
              setDeterminateProgress(100);
              return runReindexRequest(0, true).then(function (j2) {
                if (!j2.success) {
                  return Promise.reject(j2);
                }
                return j2;
              });
            }
            return doProducts(d.indexed_so_far);
          });
        }

        doProducts(0)
          .then(function (finalJ) {
            progress.hidden = true;
            finishSuccess(finalJ);
          })
          .catch(function (j) {
            progress.hidden = true;
            finishError(j);
          })
          .finally(function () {
            btn.disabled = false;
          });
      });
    }

    var bgBtn = $('ai-ebot-reindex-bg-btn');
    var bgLine = $('ai-ebot-bg-reindex-line');
    var bgCancel = $('ai-ebot-reindex-bg-cancel');
    var bgTimer = null;

    function bgPost(action) {
      var fd = new FormData();
      fd.append('action', action);
      fd.append('nonce', window.aiEbotAdmin.bgReindexNonce);
      return fetch(window.aiEbotAdmin.ajaxUrl, {
        method: 'POST',
        credentials: 'same-origin',
        body: fd,
      }).then(function (r) {
        return r.json();
      });
    }

    function showBgRunning(msg) {
      if (!bgLine) return;
      bgLine.hidden = false;
      var tpl = i18n.bgRunning || '%s';
      bgLine.textContent = tpl.replace('%s', msg || '…');
      if (bgCancel) bgCancel.hidden = false;
    }

    function hideBgLine() {
      if (!bgLine) return;
      bgLine.hidden = true;
      if (bgCancel) bgCancel.hidden = true;
    }

    function pollBg() {
      bgPost('ai_ebot_bg_reindex_status').then(function (j) {
        if (!j.success || !j.data) return;
        var st = j.data.status;
        if (st === 'running') {
          showBgRunning(j.data.message);
          setInteractiveReindexDisabled(true);
          bgTimer = setTimeout(pollBg, 4000);
        } else if (st === 'error') {
          var et = i18n.bgError || '%s';
          bgLine.hidden = false;
          bgLine.textContent = et.replace('%s', j.data.message || '');
          if (bgCancel) bgCancel.hidden = true;
          setInteractiveReindexDisabled(false);
        } else {
          hideBgLine();
          setInteractiveReindexDisabled(false);
        }
      });
    }

    if (bgBtn && window.aiEbotAdmin.bgReindexNonce) {
      bgBtn.addEventListener('click', function () {
        bgPost('ai_ebot_bg_reindex_start').then(function (j) {
          if (j.success) {
            var t = (i18n.bgStarted || '') + (i18n.bgCronHint ? ' ' + i18n.bgCronHint : '');
            if (bgLine) {
              bgLine.hidden = false;
              bgLine.textContent = t;
            }
            if (bgCancel) bgCancel.hidden = false;
            setInteractiveReindexDisabled(true);
            setTimeout(pollBg, 2000);
          } else {
            var m =
              j.data && typeof j.data.message === 'string'
                ? j.data.message
                : j.data && j.data.message
                  ? String(j.data.message)
                  : 'Error';
            if (bgLine) {
              bgLine.hidden = false;
              bgLine.textContent = m;
            }
          }
        });
      });
      if (bgCancel) {
        bgCancel.addEventListener('click', function () {
          bgPost('ai_ebot_bg_reindex_cancel').then(function () {
            if (bgTimer) clearTimeout(bgTimer);
            hideBgLine();
            setInteractiveReindexDisabled(false);
          });
        });
      }
      bgPost('ai_ebot_bg_reindex_status').then(function (j) {
        if (j.success && j.data && j.data.status === 'running') {
          showBgRunning(j.data.message);
          setInteractiveReindexDisabled(true);
          pollBg();
        }
      });
    }
  });
})();
