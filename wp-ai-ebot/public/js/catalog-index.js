(function () {
  'use strict';

  function post(subAction, extra) {
    var cfg = window.aiEbotCatalogIndex || {};
    var body = new URLSearchParams();
    body.set('action', 'ai_ebot_catalog_index');
    body.set('nonce', cfg.nonce || '');
    body.set('sub_action', subAction);
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

  function postCuratedReindex(orphanBatch, productOffset) {
    var cfg = window.aiEbotCatalogIndex || {};
    var body = new URLSearchParams();
    body.set('action', 'ai_ebot_curated_reindex');
    body.set('nonce', cfg.curatedReindexNonce || '');
    body.set('reindex_progress', '1');
    body.set('orphan_batch', String(orphanBatch));
    body.set('product_offset', String(productOffset));
    return fetch(cfg.ajaxUrl || '', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, json: j };
      });
    });
  }

  function setStatus(text, showProgress, determinate, pct) {
    var box = document.getElementById('ai-ebot-ci-action-status');
    var prog = document.getElementById('ai-ebot-ci-progress');
    var fill = prog ? prog.querySelector('.ai-ebot-knowledge-index-progress__fill') : null;
    if (box) {
      var hide = !text && !showProgress;
      box.hidden = hide;
      if (!hide) {
        box.textContent = text || '';
      }
    }
    if (prog) {
      prog.hidden = !showProgress;
      prog.classList.toggle('is-determinate', !!determinate);
      if (fill && determinate && typeof pct === 'number') {
        fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
      }
    }
  }

  function setReindexUiVisible(progress, success, err) {
    var p = document.getElementById('ai-ebot-ci-reindex-progress');
    var s = document.getElementById('ai-ebot-ci-reindex-success');
    var e = document.getElementById('ai-ebot-ci-reindex-error');
    if (p) p.hidden = !progress;
    if (s) s.hidden = !success;
    if (e) e.hidden = !err;
  }

  function setReindexProgressLabel(cfg, text, pct) {
    var label = document.getElementById('ai-ebot-ci-reindex-progress-label');
    var progress = document.getElementById('ai-ebot-ci-reindex-progress');
    if (label) label.textContent = text || '';
    if (progress) {
      progress.classList.add('is-determinate');
      var fill = progress.querySelector('.ai-ebot-reindex-progress__fill');
      if (fill && typeof pct === 'number') {
        fill.style.width = Math.min(100, Math.max(0, pct)) + '%';
      }
    }
  }

  function fmtTwo(str, a, b) {
    return str.replace(/%1\$d/g, String(a)).replace(/%2\$d/g, String(b));
  }

  function selectedLeftIds() {
    var list = [];
    document.querySelectorAll('.ai-ebot-ci-left-cb:checked').forEach(function (cb) {
      list.push(cb.value);
    });
    return list;
  }

  function selectedRightIds() {
    var list = [];
    document.querySelectorAll('.ai-ebot-ci-right-cb:checked').forEach(function (cb) {
      list.push(cb.value);
    });
    return list;
  }

  function runSendSteps(cfg) {
    function step() {
      return post('send_step').then(function (res) {
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
          cfg.i18n.indexingProgress.replace('%1$d', String(done)).replace('%2$d', String(total)),
          true,
          true,
          pct
        );
        if (p.finished) {
          var msg = p.message || cfg.i18n.successSend;
          setStatus(msg, false, false, 0);
          return;
        }
        return step();
      });
    }
    return step();
  }

  function setBulkDisabled(disabled) {
    ['ai-ebot-ci-reindex-btn', 'ai-ebot-ci-remove-all-btn'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.hasAttribute('data-ai-ebot-ci-toolbar-locked')) {
        el.disabled = disabled;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var wrap = document.getElementById('ai-ebot-catalog-index-wrap');
    if (!wrap) return;

    var cfg = window.aiEbotCatalogIndex || {};
    var i18n = cfg.i18n || {};

    var checkAllLeft = document.getElementById('ai-ebot-ci-check-all-left');
    if (checkAllLeft) {
      checkAllLeft.addEventListener('change', function () {
        var on = checkAllLeft.checked;
        wrap.querySelectorAll('.ai-ebot-ci-left-cb').forEach(function (cb) {
          cb.checked = on;
        });
      });
    }

    var checkAllRight = document.getElementById('ai-ebot-ci-check-all-right');
    if (checkAllRight) {
      checkAllRight.addEventListener('change', function () {
        var on = checkAllRight.checked;
        wrap.querySelectorAll('.ai-ebot-ci-right-cb').forEach(function (cb) {
          cb.checked = on;
        });
      });
    }

    var sendBtn = document.getElementById('ai-ebot-ci-send');
    var removeBtn = document.getElementById('ai-ebot-ci-remove');
    var syncBtn = document.getElementById('ai-ebot-ci-sync-structure');

    if (sendBtn) {
      sendBtn.addEventListener('click', function () {
        var ids = selectedLeftIds();
        if (!ids.length) {
          setStatus(i18n.noneSelected, false, false, 0);
          return;
        }
        sendBtn.disabled = true;
        if (removeBtn) removeBtn.disabled = true;
        setBulkDisabled(true);
        setStatus(i18n.sending, true, false, 0);

        post('send_init', { product_ids: ids.join(',') })
          .then(function (res) {
            if (!res.ok || !res.data.success) {
              var err =
                res.data && res.data.data && res.data.data.message
                  ? res.data.data.message
                  : i18n.errorGeneric;
              throw new Error(err);
            }
            var p = res.data.data;
            if (p.finished) {
              setStatus(p.message || i18n.successSend, false, false, 0);
              return false;
            }
            return runSendSteps(cfg).then(function () {
              return true;
            });
          })
          .then(function (shouldReload) {
            if (shouldReload) {
              window.location.reload();
            }
          })
          .catch(function (e) {
            setStatus(e.message || i18n.errorGeneric, false, false, 0);
          })
          .finally(function () {
            sendBtn.disabled = false;
            if (removeBtn) removeBtn.disabled = false;
            setBulkDisabled(false);
          });
      });
    }

    if (removeBtn) {
      removeBtn.addEventListener('click', function () {
        var ids = selectedRightIds();
        if (!ids.length) {
          setStatus(i18n.noneSelected, false, false, 0);
          return;
        }
        if (sendBtn) sendBtn.disabled = true;
        removeBtn.disabled = true;
        setBulkDisabled(true);
        setStatus(i18n.removing, true, false, 0);

        post('remove', { product_ids: ids.join(',') })
          .then(function (res) {
            if (!res.ok || !res.data.success) {
              var err =
                res.data && res.data.data && res.data.data.message
                  ? res.data.data.message
                  : i18n.errorGeneric;
              throw new Error(err);
            }
            setStatus(res.data.data.message || i18n.successRemove, false, false, 0);
            window.location.reload();
          })
          .catch(function (e) {
            setStatus(e.message || i18n.errorGeneric, false, false, 0);
          })
          .finally(function () {
            if (sendBtn) sendBtn.disabled = false;
            removeBtn.disabled = false;
            setBulkDisabled(false);
          });
      });
    }

    if (syncBtn && cfg.storeStructureNonce) {
      syncBtn.addEventListener('click', function () {
        syncBtn.disabled = true;
        if (sendBtn) sendBtn.disabled = true;
        if (removeBtn) removeBtn.disabled = true;
        setBulkDisabled(true);
        setStatus(i18n.storeStructureWorking || '…', true, false, 0);

        var body = new URLSearchParams();
        body.set('action', 'ai_ebot_store_structure_sync');
        body.set('nonce', cfg.storeStructureNonce || '');
        fetch(cfg.ajaxUrl || '', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: body.toString(),
        })
          .then(function (r) {
            return r.json().then(function (j) {
              return { ok: r.ok, json: j };
            });
          })
          .then(function (res) {
            if (!res.ok || !res.json || !res.json.success) {
              var msg =
                res.json && res.json.data && res.json.data.message
                  ? res.json.data.message
                  : i18n.errorGeneric;
              throw new Error(msg);
            }
            var m = res.json.data && res.json.data.message ? res.json.data.message : i18n.storeStructureDone;
            setStatus(m, false, false, 0);
          })
          .catch(function (e) {
            setStatus(e.message || i18n.errorGeneric, false, false, 0);
          })
          .finally(function () {
            syncBtn.disabled = false;
            if (sendBtn) sendBtn.disabled = false;
            if (removeBtn) removeBtn.disabled = false;
            setBulkDisabled(false);
          });
      });
    }

    var reBtn = document.getElementById('ai-ebot-ci-reindex-btn');
    var reErr = document.getElementById('ai-ebot-ci-reindex-error');
    var reOkText = document.getElementById('ai-ebot-ci-reindex-success-text');

    function curatedReindexStep(orphanBatch, productOffset) {
      return postCuratedReindex(orphanBatch, productOffset).then(function (res) {
        var j = res.json;
        if (!j.success || !j.data) {
          var em =
            j.data && j.data.message
              ? j.data.message
              : typeof j.data === 'string'
                ? j.data
                : i18n.reindexError || i18n.errorGeneric;
          throw new Error(em);
        }
        var d = j.data;
        if (d.phase === 'orphans' && !d.done) {
          var ot = d.orphan_total > 0 ? d.orphan_total : 1;
          var od = d.orphan_done || 0;
          setReindexProgressLabel(
            cfg,
            fmtTwo(i18n.reindexOrphanProgress || '', od, d.orphan_total || 0),
            Math.min(45, (od / ot) * 45)
          );
        } else if (d.phase === 'products' && !d.done) {
          var tot = typeof d.total_products === 'number' ? d.total_products : 0;
          var cur = typeof d.indexed_so_far === 'number' ? d.indexed_so_far : 0;
          setReindexProgressLabel(
            cfg,
            fmtTwo(i18n.reindexProgress || '', cur, tot || 0),
            45 + (tot > 0 ? (cur / tot) * 55 : 0)
          );
        }
        if (d.done) {
          return d;
        }
        return curatedReindexStep(d.orphan_batch || 0, d.product_offset || 0);
      });
    }

    if (reBtn && cfg.curatedReindexNonce) {
      reBtn.addEventListener('click', function () {
        if (reErr) {
          reErr.textContent = '';
          reErr.hidden = true;
        }
        var succ = document.getElementById('ai-ebot-ci-reindex-success');
        if (succ) succ.hidden = true;
        setReindexUiVisible(true, false, false);
        var pr = document.getElementById('ai-ebot-ci-reindex-progress');
        if (pr) {
          pr.classList.remove('is-determinate');
          var f0 = pr.querySelector('.ai-ebot-reindex-progress__fill');
          if (f0) f0.style.width = '';
        }
        setReindexProgressLabel(cfg, i18n.reindexing || '…', 0);
        reBtn.disabled = true;
        setBulkDisabled(true);

        curatedReindexStep(0, 0)
          .then(function (d) {
            setReindexUiVisible(false, true, false);
            if (reOkText) {
              reOkText.textContent = d.message || i18n.reindexComplete || i18n.successSend;
            }
          })
          .catch(function (e) {
            setReindexUiVisible(false, false, true);
            if (reErr) {
              reErr.textContent = e.message || i18n.reindexError || '';
              reErr.hidden = false;
            }
          })
          .finally(function () {
            reBtn.disabled = false;
            setBulkDisabled(false);
          });
      });
    }

    var removeAllBtn = document.getElementById('ai-ebot-ci-remove-all-btn');
    if (removeAllBtn) {
      removeAllBtn.addEventListener('click', function () {
        var c = (i18n.removeAllConfirm || '').trim();
        if (c && !window.confirm(c)) {
          return;
        }
        removeAllBtn.disabled = true;
        setBulkDisabled(true);
        if (sendBtn) sendBtn.disabled = true;
        if (removeBtn) removeBtn.disabled = true;
        setStatus(i18n.removeAllWorking || i18n.removing, true, false, 0);

        post('remove_all')
          .then(function (res) {
            if (!res.ok || !res.data.success) {
              var err =
                res.data && res.data.data && res.data.data.message
                  ? res.data.data.message
                  : i18n.errorGeneric;
              throw new Error(err);
            }
            setStatus(res.data.data.message || i18n.successRemove, false, false, 0);
            window.location.reload();
          })
          .catch(function (e) {
            setStatus(e.message || i18n.errorGeneric, false, false, 0);
          })
          .finally(function () {
            removeAllBtn.disabled = false;
            if (sendBtn) sendBtn.disabled = false;
            if (removeBtn) removeBtn.disabled = false;
            setBulkDisabled(false);
          });
      });
    }
  });
})();
