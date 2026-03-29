(function () {
  function qs(root, sel) {
    return root.querySelector(sel);
  }

  /** Scroll the log so the top of `childEl` aligns near the top of the visible log (read new assistant replies from the start). */
  function scrollLogToAlignChildTop(logEl, childEl) {
    if (!logEl || !childEl || !logEl.contains(childEl)) {
      return;
    }
    window.requestAnimationFrame(function () {
      var logRect = logEl.getBoundingClientRect();
      var childRect = childEl.getBoundingClientRect();
      var nextTop = childRect.top - logRect.top + logEl.scrollTop;
      var pad = 2;
      logEl.scrollTop = Math.max(0, nextTop - pad);
    });
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /**
   * Turn WooCommerce / LLM echoes like &nbsp; and &#x62f; into real characters before we escape for display.
   */
  function decodeHtmlEntities(s) {
    if (!s || typeof s !== 'string') return '';
    var t = document.createElement('textarea');
    t.innerHTML = s;
    return t.value;
  }

  /**
   * Split raw text into segments; markdown links [label](url) become link tokens (http(s) or site-relative / only).
   */
  function parseMarkdownLinks(raw) {
    var re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
    var parts = [];
    var last = 0;
    var m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) {
        parts.push({ type: 'text', v: raw.slice(last, m.index) });
      }
      var href = m[2].trim();
      if (/^https?:\/\//i.test(href) || /^\//.test(href)) {
        parts.push({ type: 'link', text: m[1], href: href });
      } else {
        parts.push({ type: 'text', v: m[0] });
      }
      last = m.index + m[0].length;
    }
    if (last < raw.length) {
      parts.push({ type: 'text', v: raw.slice(last) });
    }
    if (parts.length === 0) {
      parts.push({ type: 'text', v: raw });
    }
    return parts;
  }

  function applyInlineMarkdown(escapedText) {
    return escapedText
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  function segmentsToHtml(parts) {
    var html = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.type === 'link') {
        html +=
          '<a class="ai-ebot-chat__link" href="' +
          escapeHtml(p.href) +
          '" target="_blank" rel="noopener noreferrer">' +
          applyInlineMarkdown(escapeHtml(p.text)) +
          '</a>';
      } else {
        html += applyInlineMarkdown(escapeHtml(p.v));
      }
    }
    return html;
  }

  /**
   * Turn lines into paragraphs, ordered lists, and bullet lists. Input already has inline HTML from segmentsToHtml.
   */
  function blockStructure(htmlWithNewlines) {
    var lines = htmlWithNewlines.split(/\n/);
    var out = [];
    var inOl = false;
    var inUl = false;

    function closeLists() {
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      var numMatch = /^(\d+)\.\s+(.+)$/.exec(trimmed);
      var bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);

      if (numMatch) {
        if (inUl) {
          out.push('</ul>');
          inUl = false;
        }
        if (!inOl) {
          out.push('<ol class="ai-ebot-chat__list ai-ebot-chat__list--numbered">');
          inOl = true;
        }
        out.push('<li class="ai-ebot-chat__li">' + numMatch[2] + '</li>');
      } else if (bulletMatch) {
        if (inOl) {
          out.push('</ol>');
          inOl = false;
        }
        if (!inUl) {
          out.push('<ul class="ai-ebot-chat__list ai-ebot-chat__list--bullet">');
          inUl = true;
        }
        out.push('<li class="ai-ebot-chat__li">' + bulletMatch[1] + '</li>');
      } else {
        closeLists();
        if (trimmed === '') {
          out.push('<br />');
        } else {
          out.push('<p class="ai-ebot-chat__p">' + line + '</p>');
        }
      }
    }
    closeLists();
    return out.join('');
  }

  function renderRichAnswer(raw) {
    if (!raw) return '';
    if (/<[a-z][\s\S]*>/i.test(raw)) {
      return raw;
    }
    raw = decodeHtmlEntities(raw);
    var parts = parseMarkdownLinks(raw);
    var inline = segmentsToHtml(parts);
    return blockStructure(inline);
  }

  var DEFAULT_THINKING_PHRASES = [
    'Thinking…',
    'Browsing the catalog…',
    'Fetching details…',
    'Checking what we know…',
    'Putting it together…',
  ];

  /**
   * @returns {function(): void} Call when the reply starts or errors to remove the placeholder.
   */
  function appendThinkingRow(log) {
    var phrases =
      window.aiEbotChat &&
      Array.isArray(window.aiEbotChat.thinkingPhrases) &&
      window.aiEbotChat.thinkingPhrases.length
        ? window.aiEbotChat.thinkingPhrases
        : DEFAULT_THINKING_PHRASES;
    var wrap = document.createElement('div');
    wrap.className = 'ai-ebot-chat__msg ai-ebot-chat__msg--bot ai-ebot-chat__msg--thinking';
    var bubble = document.createElement('div');
    bubble.className = 'ai-ebot-chat__bubble ai-ebot-chat__bubble--thinking';
    var span = document.createElement('span');
    span.className = 'ai-ebot-chat__thinking-label';
    span.setAttribute('aria-live', 'polite');
    span.setAttribute('aria-busy', 'true');
    span.textContent = phrases[0];
    var dots = document.createElement('span');
    dots.className = 'ai-ebot-chat__thinking-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.innerHTML = '<span>.</span><span>.</span><span>.</span>';
    bubble.appendChild(span);
    bubble.appendChild(dots);
    wrap.appendChild(bubble);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    var idx = 0;
    var timer = window.setInterval(function () {
      idx = (idx + 1) % phrases.length;
      span.textContent = phrases[idx];
    }, 2100);
    return function dismissThinking() {
      window.clearInterval(timer);
      span.removeAttribute('aria-busy');
      if (wrap.parentNode) {
        wrap.parentNode.removeChild(wrap);
      }
    };
  }

  var SESSION_STORAGE_KEY = 'ai_ebot_chat_session_id';

  function getStoredSessionId() {
    try {
      return localStorage.getItem(SESSION_STORAGE_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setStoredSessionId(id) {
    if (!id) return;
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, id);
    } catch (e) {}
  }

  function clearStoredSessionId() {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (e) {}
  }

  function isLikelySessionPublicId(s) {
    return typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
  }

  function sessionHistoryUrl(sessionId) {
    var base = (window.aiEbotChat && window.aiEbotChat.restUrl) || '';
    if (!base) return '';
    return base.replace(/\/chat\/?$/, '') + '/chat/session/' + encodeURIComponent(sessionId) + '/messages';
  }

  function init(root) {
    var log = qs(root, '[data-log]');
    var form = qs(root, '[data-form]');
    var input = qs(root, '[data-input]');
    if (!log || !form || !input) return;

    var history = [];

    function append(role, html) {
      var wrap = document.createElement('div');
      wrap.className = 'ai-ebot-chat__msg ai-ebot-chat__msg--' + role;
      var bubble = document.createElement('div');
      bubble.className = 'ai-ebot-chat__bubble';
      if (role === 'bot' && (html.indexOf('<ol') !== -1 || html.indexOf('<ul') !== -1 || html.indexOf('ai-ebot-chat__link') !== -1)) {
        bubble.className += ' ai-ebot-chat__bubble--rich';
      }
      bubble.innerHTML = html;
      wrap.appendChild(bubble);
      log.appendChild(wrap);
      if (role === 'bot') {
        scrollLogToAlignChildTop(log, wrap);
      } else {
        log.scrollTop = log.scrollHeight;
      }
    }

    function normalizeSuggestionChips(raw) {
      if (!raw) return [];
      var arr = Array.isArray(raw) ? raw : [];
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        var t = '';
        if (typeof s === 'string') t = s.trim();
        else if (s && typeof s === 'object') {
          if (typeof s.text === 'string') t = s.text.trim();
          else if (typeof s.label === 'string') t = s.label.trim();
          else if (typeof s.title === 'string') t = s.title.trim();
        }
        t = t.replace(/\s+/g, ' ');
        if (t.length < 2) continue;
        var dup = false;
        for (var j = 0; j < out.length; j++) {
          if (out[j].toLowerCase() === t.toLowerCase()) {
            dup = true;
            break;
          }
        }
        if (!dup) out.push(t.slice(0, 72));
        if (out.length >= 6) break;
      }
      return out;
    }

    function appendBotBlock(answerHtml, citeHtml, suggestions, productCards) {
      var wrap = document.createElement('div');
      wrap.className = 'ai-ebot-chat__msg ai-ebot-chat__msg--bot';
      var inner = answerHtml + citeHtml;
      var hasBubble = inner.replace(/\s/g, '') !== '';
      if (hasBubble) {
        var bubble = document.createElement('div');
        bubble.className = 'ai-ebot-chat__bubble';
        if (inner.indexOf('<ol') !== -1 || inner.indexOf('<ul') !== -1 || inner.indexOf('ai-ebot-chat__link') !== -1) {
          bubble.className += ' ai-ebot-chat__bubble--rich';
        }
        bubble.innerHTML = inner;
        wrap.appendChild(bubble);
      }

      if (productCards && productCards.length) {
        var row = document.createElement('div');
        row.className = 'ai-ebot-chat__product-row';
        row.setAttribute('role', 'list');
        for (var pi = 0; pi < productCards.length; pi++) {
          var pc = productCards[pi];
          if (!pc) continue;
          var cardTitle = pc.title || pc.name || '';
          if (!cardTitle) continue;
          var href =
            typeof pc.url === 'string'
              ? pc.url.trim()
              : typeof pc.link === 'string'
                ? pc.link.trim()
                : typeof pc.href === 'string'
                  ? pc.href.trim()
                  : '';
          if (!href) continue;
          var a = document.createElement('a');
          a.className = 'ai-ebot-chat__product-card';
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.setAttribute('role', 'listitem');
          var thumbSrc =
            (typeof pc.image_url === 'string' && pc.image_url.trim()) ||
            (typeof pc.imageUrl === 'string' && pc.imageUrl.trim()) ||
            (typeof pc.image === 'string' && pc.image.trim()) ||
            '';
          if (thumbSrc.indexOf('//') === 0) {
            thumbSrc = 'https:' + thumbSrc;
          }
          if (thumbSrc && /^https?:\/\//i.test(thumbSrc)) {
            var imgEl = document.createElement('img');
            imgEl.className = 'ai-ebot-chat__product-card-thumb';
            imgEl.src = thumbSrc;
            imgEl.alt = '';
            imgEl.setAttribute('aria-hidden', 'true');
            imgEl.loading = 'lazy';
            imgEl.decoding = 'async';
            imgEl.referrerPolicy = 'no-referrer-when-downgrade';
            imgEl.addEventListener('error', function () {
              imgEl.remove();
            });
            a.appendChild(imgEl);
          }
          var body = document.createElement('span');
          body.className = 'ai-ebot-chat__product-card-body';
          var tEl = document.createElement('span');
          tEl.className = 'ai-ebot-chat__product-card-title';
          tEl.textContent = cardTitle;
          body.appendChild(tEl);
          var priceLabel = pc.price_text || pc.priceText || '';
          if (priceLabel) {
            var pEl = document.createElement('span');
            pEl.className = 'ai-ebot-chat__product-card-price';
            pEl.textContent = priceLabel;
            body.appendChild(pEl);
          }
          a.appendChild(body);
          row.appendChild(a);
        }
        if (row.children.length) wrap.appendChild(row);
      }

      if (suggestions && suggestions.length) {
        var sug = document.createElement('div');
        sug.className = 'ai-ebot-chat__suggestions';
        sug.setAttribute('role', 'group');
        sug.setAttribute(
          'aria-label',
          (window.aiEbotChat && window.aiEbotChat.suggestionsLabel) || 'Suggested replies'
        );
        for (var si = 0; si < suggestions.length; si++) {
          var label = suggestions[si];
          if (!label || typeof label !== 'string') continue;
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'ai-ebot-chat__chip';
          chip.textContent = label;
          (function (sendText) {
            chip.addEventListener('click', function () {
              runChatRound(sendText);
            });
          })(label);
          sug.appendChild(chip);
        }
        if (sug.children.length) wrap.appendChild(sug);
      }

      log.appendChild(wrap);
      scrollLogToAlignChildTop(log, wrap);
    }

    function runChatRound(text) {
      var trimmed = (text || '').trim();
      if (!trimmed) return;
      if (!window.aiEbotChat || !window.aiEbotChat.restUrl) {
        append('bot', '<span class="ai-ebot-chat__err">Chat not configured.</span>');
        return;
      }

      append('user', escapeHtml(trimmed));
      input.value = '';
      var btn = qs(form, 'button[type="submit"]');
      if (btn) btn.disabled = true;

      var dismissThinking = appendThinkingRow(log);

      fetch(window.aiEbotChat.restUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-WP-Nonce': window.aiEbotChat.nonce,
        },
        body: JSON.stringify({
          message: trimmed,
          history: history,
          session_id: getStoredSessionId(),
        }),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            return { ok: r.ok, json: j };
          });
        })
        .then(function (res) {
          dismissThinking();
          if (!res.ok) {
            var j = res.json || {};
            var msg = j.message || 'Request failed.';
            var data = j.data || {};
            var upgrade = '';
            if (data.upgrade_url) {
              upgrade =
                ' <a class="ai-ebot-chat__upgrade" href="' +
                escapeHtml(String(data.upgrade_url)) +
                '" target="_blank" rel="noopener noreferrer">' +
                escapeHtml('Upgrade plan') +
                '</a>';
            }
            append(
              'bot',
              '<span class="ai-ebot-chat__err">' + escapeHtml(msg) + upgrade + '</span>'
            );
            return;
          }
          var data = res.json;
          if (data.session_id) {
            setStoredSessionId(data.session_id);
          }
          var answer = data.answer || '';
          var cites = data.citations || [];
          var citeHtml = '';
          if (cites.length) {
            citeHtml =
              '<div class="ai-ebot-chat__citations"><span class="ai-ebot-chat__citations-label">Sources</span><div class="ai-ebot-chat__citations-links">';
            citeHtml += cites
              .map(function (c) {
                var t = c.title ? escapeHtml(c.title) : 'Link';
                var u = c.url ? escapeHtml(c.url) : '';
                if (u) {
                  return (
                    '<a class="ai-ebot-chat__cite" href="' + u + '" target="_blank" rel="noopener">' + t + '</a>'
                  );
                }
                return '<span class="ai-ebot-chat__cite">' + t + '</span>';
              })
              .join('');
            citeHtml += '</div></div>';
          }
          var suggestions = normalizeSuggestionChips(data.suggestions);
          var productCards = Array.isArray(data.product_cards)
            ? data.product_cards
            : Array.isArray(data.productCards)
              ? data.productCards
              : [];
          appendBotBlock(renderRichAnswer(answer), citeHtml, suggestions, productCards);
          history.push({ role: 'user', content: trimmed });
          history.push({ role: 'assistant', content: answer });
          if (history.length > 20) {
            history = history.slice(-20);
          }
        })
        .catch(function () {
          dismissThinking();
          append('bot', '<span class="ai-ebot-chat__err">Network error.</span>');
        })
        .finally(function () {
          if (btn) btn.disabled = false;
        });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      runChatRound(input.value);
    });

    function showStarters() {
      var starters =
        window.aiEbotChat &&
        Array.isArray(window.aiEbotChat.starterSuggestions) &&
        window.aiEbotChat.starterSuggestions.length
          ? window.aiEbotChat.starterSuggestions
          : ['Shipping & delivery', 'Returns & refunds', 'Help me pick a product'];
      appendBotBlock('', '', starters, []);
    }

    function applyHistoryMessages(msgs) {
      history = [];
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m || typeof m !== 'object') continue;
        var role = m.role;
        var content = typeof m.content === 'string' ? m.content : '';
        if (role === 'user') {
          append('user', escapeHtml(content));
          history.push({ role: 'user', content: content });
        } else if (role === 'assistant') {
          appendBotBlock(renderRichAnswer(content), '', [], []);
          history.push({ role: 'assistant', content: content });
        }
      }
      if (history.length > 20) {
        history = history.slice(-20);
      }
      log.scrollTop = log.scrollHeight;
    }

    var submitBtn = qs(form, 'button[type="submit"]');
    function setFormBusy(busy) {
      input.disabled = busy;
      if (submitBtn) submitBtn.disabled = busy;
    }

    function loadHistoryOrStarters() {
      var sid = getStoredSessionId();
      var histUrl = isLikelySessionPublicId(sid) ? sessionHistoryUrl(sid) : '';

      if (!histUrl || !window.aiEbotChat || !window.aiEbotChat.nonce) {
        setFormBusy(false);
        if (log.children.length === 0) {
          showStarters();
        }
        return;
      }

      fetch(histUrl, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-WP-Nonce': window.aiEbotChat.nonce },
      })
        .then(function (r) {
          return r.json().then(function (j) {
            return { ok: r.ok, status: r.status, json: j };
          });
        })
        .then(function (res) {
          if (res.status === 404 || res.status === 403) {
            clearStoredSessionId();
            showStarters();
            return;
          }
          if (!res.ok || !res.json || !Array.isArray(res.json.messages)) {
            showStarters();
            return;
          }
          var msgs = res.json.messages;
          if (msgs.length === 0) {
            showStarters();
            return;
          }
          if (msgs.length > 100) {
            msgs = msgs.slice(-100);
          }
          applyHistoryMessages(msgs);
        })
        .catch(function () {
          showStarters();
        })
        .finally(function () {
          setFormBusy(false);
        });
    }

    setFormBusy(true);

    var bUrl = window.aiEbotChat && window.aiEbotChat.bootstrapUrl;
    if (bUrl) {
      var sep = bUrl.indexOf('?') >= 0 ? '&' : '?';
      fetch(bUrl + sep + '_=' + Date.now(), {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      })
        .then(function (r) {
          return r.json().then(function (j) {
            return { ok: r.ok, json: j };
          });
        })
        .then(function (res) {
          if (!res.ok || !res.json || typeof res.json.nonce !== 'string' || !res.json.nonce) {
            append(
              'bot',
              '<span class="ai-ebot-chat__err">Chat could not start. Try refreshing the page.</span>'
            );
            setFormBusy(false);
            return;
          }
          window.aiEbotChat.nonce = res.json.nonce;
          if (typeof res.json.rest_url === 'string' && res.json.rest_url) {
            window.aiEbotChat.restUrl = res.json.rest_url;
          }
          loadHistoryOrStarters();
        })
        .catch(function () {
          append('bot', '<span class="ai-ebot-chat__err">Network error.</span>');
          setFormBusy(false);
        });
    } else if (window.aiEbotChat && window.aiEbotChat.nonce) {
      loadHistoryOrStarters();
    } else {
      append(
        'bot',
        '<span class="ai-ebot-chat__err">Chat not configured.</span>'
      );
      setFormBusy(false);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-ai-ebot-chat]').forEach(init);
  });
})();
