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

  /**
   * Replace markdown images with placeholders so they are not parsed as [text](url) links, then restore as <img> after markdown runs.
   */
  function extractMarkdownImages(raw) {
    var imgs = [];
    if (!raw || typeof raw !== 'string') return { text: raw || '', imgs: imgs };
    var text = raw.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_full, alt, href) {
      var idx = imgs.length;
      imgs.push({ alt: (alt || '').trim(), href: (href || '').trim() });
      return '\n%%AIEBOTIMG' + idx + '%%\n';
    });
    return { text: text, imgs: imgs };
  }

  function restoreMarkdownImages(html, imgs) {
    if (!html || !imgs || !imgs.length) return html || '';
    for (var i = 0; i < imgs.length; i++) {
      var ph = '%%AIEBOTIMG' + i + '%%';
      var im = imgs[i];
      if (!im || !im.href) continue;
      var tag =
        '<img class="ai-ebot-chat__inline-img" src="' +
        escapeHtml(im.href) +
        '" alt="' +
        escapeHtml(im.alt || '') +
        '" loading="lazy" decoding="async" referrerpolicy="no-referrer-when-downgrade" />';
      html = html.split(ph).join(tag);
    }
    return html;
  }

  /**
   * Wrap bold product titles and catalog images in links using product_cards metadata (no separate card rail).
   */
  function linkifyProductReferencesInHtml(html, productCards) {
    if (!html || !productCards || !productCards.length) return html || '';
    var mapTitle = {};
    var imgToProductUrl = {};
    for (var i = 0; i < productCards.length; i++) {
      var c = productCards[i];
      if (!c) continue;
      var title =
        typeof c.title === 'string'
          ? c.title.trim()
          : typeof c.name === 'string'
            ? c.name.trim()
            : '';
      var url = typeof c.url === 'string' ? c.url.trim() : '';
      if (title && url && !looksLikeImageAssetUrl(url)) {
        mapTitle[title.toLowerCase()] = url;
      }
      var imgu =
        (typeof c.image_url === 'string' && c.image_url.trim()) ||
        (typeof c.imageUrl === 'string' && c.imageUrl.trim()) ||
        '';
      if (imgu && url && !looksLikeImageAssetUrl(url)) {
        var k = productUrlKeyBrowser(imgu);
        if (k) imgToProductUrl[k] = url;
      }
    }
    if (Object.keys(mapTitle).length === 0 && Object.keys(imgToProductUrl).length === 0) {
      return html;
    }
    var doc;
    try {
      doc = new DOMParser().parseFromString('<div class="ai-ebot-chat__tmp-root">' + html + '</div>', 'text/html');
    } catch (e) {
      return html;
    }
    var root = doc.body && doc.body.firstElementChild;
    if (!root) return html;

    var strongs = root.querySelectorAll('strong');
    for (var s = strongs.length - 1; s >= 0; s--) {
      var el = strongs[s];
      if (el.closest('a')) continue;
      var txt = (el.textContent || '').trim();
      if (!txt) continue;
      var href = mapTitle[txt.toLowerCase()];
      if (!href) continue;
      var a = doc.createElement('a');
      a.className = 'ai-ebot-chat__link ai-ebot-chat__link--product';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      while (el.firstChild) {
        a.appendChild(el.firstChild);
      }
      el.parentNode.replaceChild(a, el);
    }

    var imgs = root.querySelectorAll('img');
    for (var im = imgs.length - 1; im >= 0; im--) {
      var imgEl = imgs[im];
      if (imgEl.closest('a')) continue;
      var src = imgEl.getAttribute('src') || '';
      if (!src) continue;
      var pk = productUrlKeyBrowser(src);
      var href2 = pk && imgToProductUrl[pk];
      if (!href2) continue;
      var wrapA = doc.createElement('a');
      wrapA.className = 'ai-ebot-chat__link ai-ebot-chat__link--product-thumb';
      wrapA.href = href2;
      wrapA.target = '_blank';
      wrapA.rel = 'noopener noreferrer';
      imgEl.parentNode.insertBefore(wrapA, imgEl);
      wrapA.appendChild(imgEl);
    }

    return root.innerHTML;
  }

  /**
   * In numbered product lists, replace the CSS counter badge with a thumbnail when the row matches product_cards.
   */
  function decorateNumberedListWithProductThumbs(html, productCards) {
    if (!html || !productCards || !productCards.length) return html || '';
    var byUrl = {};
    var byTitle = {};
    for (var i = 0; i < productCards.length; i++) {
      var c = productCards[i];
      if (!c) continue;
      var url = typeof c.url === 'string' ? c.url.trim() : '';
      if (url && !looksLikeImageAssetUrl(url)) {
        var uk = productUrlKeyBrowser(url);
        if (uk) byUrl[uk] = c;
      }
      var t =
        typeof c.title === 'string'
          ? c.title.trim().toLowerCase()
          : typeof c.name === 'string'
            ? c.name.trim().toLowerCase()
            : '';
      if (t) byTitle[t] = c;
    }
    if (Object.keys(byUrl).length === 0 && Object.keys(byTitle).length === 0) return html;

    var doc;
    try {
      doc = new DOMParser().parseFromString('<div class="ai-ebot-chat__tmp-root">' + html + '</div>', 'text/html');
    } catch (e) {
      return html;
    }
    var root = doc.body && doc.body.firstElementChild;
    if (!root) return html;

    var ols = root.querySelectorAll('ol.ai-ebot-chat__list--numbered');
    for (var o = 0; o < ols.length; o++) {
      var ol = ols[o];
      var child = ol.firstElementChild;
      while (child) {
        var next = child.nextElementSibling;
        if (child.tagName === 'LI' && /\bai-ebot-chat__li\b/.test(child.className)) {
          if (!child.querySelector('.ai-ebot-chat__list-thumb')) {
            var card = null;
            var links = child.querySelectorAll('a[href]');
            for (var k = 0; k < links.length; k++) {
              var h = links[k].getAttribute('href') || '';
              if (!h || looksLikeImageAssetUrl(h)) continue;
              var key = productUrlKeyBrowser(h);
              if (key && byUrl[key]) {
                card = byUrl[key];
                break;
              }
            }
            if (!card) {
              var probe = child.querySelector('a, strong');
              if (probe) {
                var tit = (probe.textContent || '').trim().toLowerCase();
                if (tit && byTitle[tit]) card = byTitle[tit];
              }
            }
            if (card) {
              var pdp = typeof card.url === 'string' ? card.url.trim() : '';
              if (pdp && !looksLikeImageAssetUrl(pdp)) {
                var imgUrl =
                  (typeof card.image_url === 'string' && card.image_url.trim()) ||
                  (typeof card.imageUrl === 'string' && card.imageUrl.trim()) ||
                  '';
                child.classList.add('ai-ebot-chat__li--with-thumb');
                var wrap = doc.createElement('a');
                wrap.className = 'ai-ebot-chat__list-thumb ai-ebot-chat__list-thumb--link';
                wrap.href = pdp;
                wrap.target = '_blank';
                wrap.rel = 'noopener noreferrer';
                if (imgUrl) {
                  if (imgUrl.indexOf('//') === 0) imgUrl = 'https:' + imgUrl;
                  if (/^https?:\/\//i.test(imgUrl)) {
                    var imgEl = doc.createElement('img');
                    imgEl.className = 'ai-ebot-chat__list-thumb-img';
                    imgEl.src = imgUrl;
                    imgEl.alt = '';
                    imgEl.loading = 'lazy';
                    imgEl.decoding = 'async';
                    imgEl.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
                    wrap.appendChild(imgEl);
                  } else {
                    wrap.appendChild(makeListThumbPlaceholder(doc, card));
                  }
                } else {
                  wrap.appendChild(makeListThumbPlaceholder(doc, card));
                }
                child.insertBefore(wrap, child.firstChild);
              }
            }
          }
        }
        child = next;
      }
    }
    return root.innerHTML;
  }

  function makeListThumbPlaceholder(doc, card) {
    var ph = doc.createElement('span');
    ph.className = 'ai-ebot-chat__list-thumb-ph';
    ph.setAttribute('aria-hidden', 'true');
    var initial = ((card.title || card.name || '?').trim().charAt(0) || '?').toUpperCase();
    ph.textContent = initial;
    return ph;
  }

  function buildBotAnswerHtml(rawAnswer, productCards) {
    var ex = extractMarkdownImages(rawAnswer || '');
    var h = renderRichAnswer(ex.text);
    h = restoreMarkdownImages(h, ex.imgs);
    h = linkifyProductReferencesInHtml(h, productCards || []);
    h = decorateNumberedListWithProductThumbs(h, productCards || []);
    return h;
  }

  /** Set true to show the separate product card rail below the bubble again. */
  var AI_EBOT_SHOW_PRODUCT_CARD_RAIL = false;

  /** Canonical URL key (aligned with server) for deduping cards. */
  function productUrlKeyBrowser(u) {
    if (!u || typeof u !== 'string') return '';
    var s = u.trim();
    if (!s) return '';
    try {
      var base = /^https?:\/\//i.test(s) ? undefined : typeof window !== 'undefined' ? window.location.origin : '';
      var x = new URL(s, base || 'https://placeholder.local');
      // Include ?query (e.g. WooCommerce `/?product=slug`) — pathname alone is `/` for every product on the same host.
      var path = x.pathname.replace(/\/$/, '');
      return x.hostname.toLowerCase() + path + x.search;
    } catch (e) {
      return s.replace(/\/$/, '').toLowerCase();
    }
  }

  /** Avoid using CDN / upload image URLs as the product card link (opens image, not PDP). */
  function looksLikeImageAssetUrl(u) {
    if (!u || typeof u !== 'string') return false;
    var t = u.trim();
    if (!t) return false;
    try {
      var base = /^https?:\/\//i.test(t) ? undefined : typeof window !== 'undefined' ? window.location.origin : '';
      var x = new URL(t, base || 'https://placeholder.local');
      var path = x.pathname + x.search;
      return /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)(\?|#|$)/i.test(path);
    } catch (e) {
      return /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)(\?|#|$)/i.test(t);
    }
  }

  function dedupeProductCards(cards) {
    if (!cards || !cards.length) return [];
    var seen = {};
    var out = [];
    for (var i = 0; i < cards.length; i++) {
      var pc = cards[i];
      if (!pc) continue;
      var href = typeof pc.url === 'string' ? pc.url.trim() : '';
      var k = productUrlKeyBrowser(href);
      if (k) {
        if (seen[k]) continue;
        seen[k] = true;
      }
      out.push(pc);
    }
    return out;
  }

  function normalizeCardField(v, maxLen) {
    if (typeof v !== 'string') return '';
    var s = v.trim();
    if (!s) return '';
    if (typeof maxLen === 'number' && maxLen > 0 && s.length > maxLen) {
      s = s.slice(0, maxLen);
    }
    return s;
  }

  /**
   * Frontend fallback: infer product cards from the assistant answer when the API did not return enough.
   * Supports markdown links [Title](url), optional markdown images ![Title](img), and optional bullet details.
   */
  function inferProductCardsFromAnswer(rawAnswer, cap) {
    var out = [];
    if (!rawAnswer || typeof rawAnswer !== 'string') return out;
    var limit = typeof cap === 'number' && cap > 0 ? cap : 8;

    var imgByAlt = {};
    rawAnswer.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_full, alt, href) {
      var a = (alt || '').trim().toLowerCase();
      var u = (href || '').trim();
      if (a && u) imgByAlt[a] = u;
      return _full;
    });

    // Capture [title](url) links; skip the inner [alt](url) of markdown images ![alt](url).
    var linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
    var m;
    while ((m = linkRe.exec(rawAnswer)) !== null) {
      if (m.index > 0 && rawAnswer.charAt(m.index - 1) === '!') continue;
      var title = (m[1] || '').trim();
      var url = (m[2] || '').trim();
      if (!title || !url) continue;
      if (
        /^(view products?|read more|learn more|shop now|buy now|click here|see products?|more details)$/i.test(title)
      ) {
        continue;
      }
      if (!/^https?:\/\//i.test(url) && url.indexOf('/') !== 0) continue;
      if (looksLikeImageAssetUrl(url)) continue;
      out.push({
        title: title,
        url: url,
        price_text: '',
        image_url: imgByAlt[title.toLowerCase()] || '',
      });
      if (out.length >= limit) break;
    }

    // Best-effort: pick up "Price:" lines if the answer uses the common format.
    if (out.length) {
      var lines = rawAnswer.split(/\r?\n/);
      var current = null;
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (!t) continue;
        var lm = t.match(/^\s*(?:\d+\.)?\s*\[([^\]]+)\]\(([^)\s]+)\)/);
        if (lm) {
          var tt = (lm[1] || '').trim();
          current = null;
          for (var k = 0; k < out.length; k++) {
            if (out[k].title && out[k].title.toLowerCase() === tt.toLowerCase()) {
              current = out[k];
              break;
            }
          }
          continue;
        }
        if (current) {
          var pm = t.match(/^\s*[-*]\s*\**Price:\**\s*(.+)$/i);
          if (pm) {
            current.price_text = (pm[1] || '').trim();
          }
        }
      }
    }

    // Normalize fields.
    for (var j = 0; j < out.length; j++) {
      out[j].title = normalizeCardField(out[j].title, 140);
      out[j].url = normalizeCardField(out[j].url, 2000);
      out[j].price_text = normalizeCardField(out[j].price_text, 80);
      out[j].image_url = normalizeCardField(out[j].image_url, 2000);
    }
    return out.filter(function (c) {
      return c.title && c.url;
    });
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

  /** Matches server quick-small-talk: do not attach product cards or shopping chips. */
  function isGreetingOnly(text) {
    var t = (text || '').trim();
    if (t.length > 96) return false;
    return /^(hi|hello|hey|hiya|howdy|good\s+(morning|afternoon|evening)|thanks|thank\s+you|thx|ok+|okay|bye|goodbye)[\s!.?]*$/i.test(
      t
    );
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
    var suppressAutoScroll = false;

    function append(role, html) {
      var wrap = document.createElement('div');
      wrap.className = 'ai-ebot-chat__msg ai-ebot-chat__msg--' + role;
      var bubble = document.createElement('div');
      bubble.className = 'ai-ebot-chat__bubble';
      if (
        role === 'bot' &&
        (html.indexOf('<ol') !== -1 ||
          html.indexOf('<ul') !== -1 ||
          html.indexOf('ai-ebot-chat__link') !== -1 ||
          html.indexOf('ai-ebot-chat__inline-img') !== -1)
      ) {
        bubble.className += ' ai-ebot-chat__bubble--rich';
      }
      bubble.innerHTML = html;
      wrap.appendChild(bubble);
      log.appendChild(wrap);
      if (suppressAutoScroll) {
        return;
      }
      if (role === 'bot') {
        scrollLogToAlignChildTop(log, wrap);
      } else {
        log.scrollTop = log.scrollHeight;
      }
    }

    function normalizeSuggestionChips(raw, max) {
      if (!raw) return [];
      var arr = Array.isArray(raw) ? raw : [];
      var out = [];
      var cap = typeof max === 'number' && max > 0 ? max : 6;
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
        if (out.length >= cap) break;
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
        if (
          inner.indexOf('<ol') !== -1 ||
          inner.indexOf('<ul') !== -1 ||
          inner.indexOf('ai-ebot-chat__link') !== -1 ||
          inner.indexOf('ai-ebot-chat__inline-img') !== -1
        ) {
          bubble.className += ' ai-ebot-chat__bubble--rich';
        }
        bubble.innerHTML = inner;
        wrap.appendChild(bubble);
      }

      if (AI_EBOT_SHOW_PRODUCT_CARD_RAIL && productCards && productCards.length) {
        var section = document.createElement('div');
        section.className = 'ai-ebot-chat__product-section';
        var heading =
          window.aiEbotChat && typeof window.aiEbotChat.productCardsHeading === 'string'
            ? window.aiEbotChat.productCardsHeading.trim()
            : '';
        if (heading) {
          var ht = document.createElement('div');
          ht.className = 'ai-ebot-chat__product-section-title';
          ht.textContent = heading;
          section.appendChild(ht);
        }
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
          if (!href || looksLikeImageAssetUrl(href)) continue;
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
            (function (el) {
              el.addEventListener('error', function () {
                el.remove();
              });
            })(imgEl);
            a.appendChild(imgEl);
          } else {
            var ph = document.createElement('div');
            ph.className = 'ai-ebot-chat__product-card-thumb ai-ebot-chat__product-card-thumb--placeholder';
            ph.setAttribute('aria-hidden', 'true');
            var initial = (cardTitle || '?').trim().charAt(0);
            ph.textContent = initial ? initial.toUpperCase() : '?';
            a.appendChild(ph);
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
        if (row.children.length) {
          section.appendChild(row);
          wrap.appendChild(section);
        }
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
              // Record category selection when chips represent categories.
              if (
                !selectedCategory &&
                window.aiEbotChat &&
                Array.isArray(window.aiEbotChat.categoryChips) &&
                window.aiEbotChat.categoryChips.length
              ) {
                for (var ci = 0; ci < window.aiEbotChat.categoryChips.length; ci++) {
                  if (
                    String(window.aiEbotChat.categoryChips[ci]).toLowerCase().trim() ===
                    String(sendText).toLowerCase().trim()
                  ) {
                    selectedCategory = String(sendText).trim();
                    break;
                  }
                }
              }
              runChatRound(sendText);
            });
          })(label);
          sug.appendChild(chip);
        }
        if (sug.children.length) wrap.appendChild(sug);
      }

      log.appendChild(wrap);
      if (!suppressAutoScroll) {
        scrollLogToAlignChildTop(log, wrap);
      }
    }

    var selectedCategory = '';

    function looksLikeBroadCatalogAsk(s) {
      var t = (s || '').toLowerCase().trim();
      if (!t) return false;
      // Broad intent: asking for everything / full catalog.
      return (
        /show\s+me\s+(all|everything)\s+(products|items)/.test(t) ||
        /\b(all|everything)\s+(products|items)\b/.test(t) ||
        /\bwhat\s+do\s+you\s+have\b/.test(t) ||
        /\bwhat\s+products\s+do\s+you\s+have\b/.test(t) ||
        /\bshow\s+me\s+your\s+(store|catalog)\b/.test(t)
      );
    }

    function categoryChipList() {
      var raw =
        window.aiEbotChat &&
        Array.isArray(window.aiEbotChat.categoryChips) &&
        window.aiEbotChat.categoryChips.length
          ? window.aiEbotChat.categoryChips
          : [];
      var normalized = normalizeSuggestionChips(raw, 48);
      if (normalized.length) return normalized;
      return normalizeSuggestionChips(
        window.aiEbotChat && Array.isArray(window.aiEbotChat.starterSuggestions)
          ? window.aiEbotChat.starterSuggestions
          : ['Shipping & delivery', 'Returns & refunds', 'Help me pick a product'],
        6
      );
    }

    function appendCategoryPicker(promptText) {
      var prompt =
        (promptText && String(promptText)) ||
        (window.aiEbotChat && typeof window.aiEbotChat.initPrompt === 'string' ? window.aiEbotChat.initPrompt : '') ||
        'What are you looking for?';
      appendBotBlock(renderRichAnswer(prompt), '', categoryChipList(), []);
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

      // If user asks for the whole store, guide them into a category-first flow.
      if (!selectedCategory && looksLikeBroadCatalogAsk(trimmed)) {
        appendCategoryPicker(
          "We have products in the following categories—pick one so I can take you to the right products."
        );
        return;
      }

      var btn = qs(form, 'button[type="submit"]');
      if (btn) btn.disabled = true;
      input.setAttribute('aria-busy', 'true');
      input.disabled = true;
      form.setAttribute('aria-busy', 'true');

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
          productCards = dedupeProductCards(productCards);
          var greetingOnly = isGreetingOnly(trimmed);
          if (!greetingOnly) {
            var inferredCards = inferProductCardsFromAnswer(answer, 24);
            if (inferredCards && inferredCards.length) {
              productCards = dedupeProductCards((productCards || []).concat(inferredCards));
            }
          } else {
            productCards = [];
            suggestions = [];
          }

          var answerHtml = buildBotAnswerHtml(answer, productCards);
          appendBotBlock(answerHtml, citeHtml, suggestions, AI_EBOT_SHOW_PRODUCT_CARD_RAIL ? productCards : []);
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
          input.disabled = false;
          input.removeAttribute('aria-busy');
          form.removeAttribute('aria-busy');
        });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      runChatRound(input.value);
    });

    function showStarters() {
      // First question + category chips (preferred). Falls back to old starter suggestions.
      appendCategoryPicker('');
    }

    var historyHiddenBody = null;
    var historyToggleBtn = null;
    var historyLoaded = false;

    function ensureHistoryToggle(messagesUrl) {
      if (historyToggleBtn) return;

      var header = qs(root, '.ai-ebot-chat__header');

      historyToggleBtn = document.createElement('button');
      historyToggleBtn.type = 'button';
      historyToggleBtn.className = 'ai-ebot-chat__history-link';
      historyToggleBtn.textContent = 'View previous messages';

      historyHiddenBody = document.createElement('div');
      historyHiddenBody.className = 'ai-ebot-chat__history-body';
      historyHiddenBody.hidden = true;

      if (log.firstChild) {
        log.insertBefore(historyHiddenBody, log.firstChild);
      } else {
        log.appendChild(historyHiddenBody);
      }

      if (header) {
        var titleEl = qs(header, '.ai-ebot-chat__header-title');
        if (titleEl) {
          header.insertBefore(historyToggleBtn, titleEl);
        } else {
          header.insertBefore(historyToggleBtn, header.firstChild);
        }
      } else {
        log.insertBefore(historyToggleBtn, historyHiddenBody);
      }

      historyToggleBtn.addEventListener('click', function () {
        if (!historyHiddenBody) return;
        if (!historyLoaded) {
          historyToggleBtn.disabled = true;
          historyToggleBtn.textContent = 'Loading…';
          fetch(messagesUrl, {
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
                historyToggleBtn.textContent = 'No previous messages';
                return;
              }
              if (!res.ok || !res.json || !Array.isArray(res.json.messages)) {
                historyToggleBtn.textContent = 'Could not load previous messages';
                return;
              }
              var msgs = res.json.messages;
              if (msgs.length > 200) {
                msgs = msgs.slice(-200);
              }
              renderHistoryInto(historyHiddenBody, msgs);
              historyLoaded = true;
              historyHiddenBody.hidden = false;
              historyToggleBtn.textContent = 'Hide previous messages';
            })
            .catch(function () {
              historyToggleBtn.textContent = 'Could not load previous messages';
            })
            .finally(function () {
              historyToggleBtn.disabled = false;
            });
          return;
        }

        var nowHidden = !historyHiddenBody.hidden ? true : false;
        historyHiddenBody.hidden = nowHidden;
        historyToggleBtn.textContent = nowHidden ? 'View previous messages' : 'Hide previous messages';
      });
    }

    function renderHistoryInto(container, msgs) {
      if (!container) return;
      container.innerHTML = '';
      history = [];
      suppressAutoScroll = true;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m || typeof m !== 'object') continue;
        var role = m.role;
        var content = typeof m.content === 'string' ? m.content : '';
        if (role === 'user') {
          var u = document.createElement('div');
          u.className = 'ai-ebot-chat__msg ai-ebot-chat__msg--user';
          var ub = document.createElement('div');
          ub.className = 'ai-ebot-chat__bubble';
          ub.innerHTML = escapeHtml(content);
          u.appendChild(ub);
          container.appendChild(u);
          history.push({ role: 'user', content: content });
        } else if (role === 'assistant') {
          var a = document.createElement('div');
          a.className = 'ai-ebot-chat__msg ai-ebot-chat__msg--bot';
          var ab = document.createElement('div');
          ab.className = 'ai-ebot-chat__bubble ai-ebot-chat__bubble--rich';
          ab.innerHTML = renderRichAnswer(content);
          a.appendChild(ab);
          container.appendChild(a);
          history.push({ role: 'assistant', content: content });
        }
      }
      suppressAutoScroll = false;
      if (history.length > 20) {
        history = history.slice(-20);
      }
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

      // Greeting + chips first; older messages load from a small header link into the panel at top of the log.
      if (log.children.length === 0) {
        showStarters();
      }

      ensureHistoryToggle(histUrl);

      setFormBusy(false);
    }

    setFormBusy(true);

    var bUrl = window.aiEbotChat && window.aiEbotChat.bootstrapUrl;
    if (bUrl) {
      var sep = bUrl.indexOf('?') >= 0 ? '&' : '?';
      var bootHeaders = { Accept: 'application/json' };
      var probe = window.aiEbotChat && window.aiEbotChat.bootstrapProbeNonce;
      if (probe && typeof probe === 'string' && probe.length) {
        bootHeaders['X-WP-Nonce'] = probe;
      }
      fetch(bUrl + sep + '_=' + Date.now(), {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: bootHeaders,
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
