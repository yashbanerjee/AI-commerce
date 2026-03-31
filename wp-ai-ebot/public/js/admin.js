(function () {
  function $(id) {
    return document.getElementById(id);
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

  document.addEventListener('DOMContentLoaded', function () {
    if (!window.aiEbotAdmin) {
      return;
    }

    var clearBtn = $('ai-ebot-clear-vector-index-btn');
    var clearStatus = $('ai-ebot-clear-vector-index-status');
    var i18n = window.aiEbotAdmin.i18n || {};
    if (clearBtn && window.aiEbotAdmin.clearVectorIndexNonce) {
      clearBtn.addEventListener('click', function () {
        var confirmMsg = (i18n.clearIndexConfirm || '').trim();
        if (confirmMsg && !window.confirm(confirmMsg)) {
          return;
        }
        clearBtn.disabled = true;
        if (clearStatus) {
          clearStatus.hidden = false;
          clearStatus.textContent = i18n.clearIndexWorking || '…';
          clearStatus.className = 'description';
          clearStatus.style.color = '';
        }
        var cfd = new FormData();
        cfd.append('action', 'ai_ebot_clear_vector_index');
        cfd.append('nonce', window.aiEbotAdmin.clearVectorIndexNonce);
        fetch(window.aiEbotAdmin.ajaxUrl, {
          method: 'POST',
          credentials: 'same-origin',
          body: cfd,
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (j) {
            if (!j.success || !j.data) {
              var emsg =
                j.data && typeof j.data.message === 'string'
                  ? j.data.message
                  : i18n.clearIndexError || 'Error';
              if (clearStatus) {
                clearStatus.textContent = emsg;
                clearStatus.style.color = '#b32d2e';
              }
              return;
            }
            if (clearStatus) {
              clearStatus.style.color = '';
              clearStatus.textContent = j.data.message || i18n.clearIndexDone || '';
            }
            if (j.data.index_status) {
              applyIndexStatusFromAjax(j.data.index_status);
            }
          })
          .catch(function () {
            if (clearStatus) {
              clearStatus.textContent = i18n.clearIndexError || 'Error';
              clearStatus.style.color = '#b32d2e';
            }
          })
          .finally(function () {
            clearBtn.disabled = false;
          });
      });
    }
  });
})();
