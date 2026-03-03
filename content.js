// content.js
// Extracts visible Facebook post captions, comments, and image URLs, then replies to popup.

(() => {
  // Prevent duplicate listener registration if script is injected multiple times.
  if (window.__fbScannerListenerRegistered) {
    return;
  }
  window.__fbScannerListenerRegistered = true;
  const __interactedPosts = new WeakSet();

  // Waits for feed content to appear and briefly settle.
  async function waitForContent(timeoutMs = 12000) {
    const pollInterval = 300;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const hasFeed =
        document.querySelector('[role="feed"], main') !== null ||
        document.querySelectorAll('[role="article"], [data-pagelet*="FeedUnit"]').length > 0;

      if (hasFeed) {
        // Let dynamic content hydrate before extraction.
        await new Promise((resolve) => setTimeout(resolve, 700));
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  // Returns true if an element is likely visible to the user.
  function isVisible(el) {
    if (!el) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    // Allow partially visible nodes, but reject elements far outside viewport.
    return rect.bottom > -200 && rect.top < window.innerHeight + 200;
  }

  // Basic normalizer to clean extracted text.
  function cleanText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getScrollableContainer() {
    const mainEl = document.querySelector('[role="main"], main');
    if (mainEl) {
      const style = window.getComputedStyle(mainEl);
      const scrollableY = /(auto|scroll)/i.test(style.overflowY || '');
      if (scrollableY && mainEl.scrollHeight > mainEl.clientHeight + 200) {
        return mainEl;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  function getScrollTopFor(el) {
    const isWindowScroller = el === document.scrollingElement || el === document.documentElement;
    return isWindowScroller ? (window.scrollY || document.documentElement.scrollTop || 0) : el.scrollTop;
  }

  function getViewHeightFor(el) {
    const isWindowScroller = el === document.scrollingElement || el === document.documentElement;
    return isWindowScroller ? window.innerHeight : el.clientHeight;
  }

  function getScrollHeightFor(el) {
    const isWindowScroller = el === document.scrollingElement || el === document.documentElement;
    return isWindowScroller
      ? Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        )
      : el.scrollHeight;
  }

  async function performScrollStep(preferredEl, delta) {
    const documentScroller = document.scrollingElement || document.documentElement;
    const beforePreferred = getScrollTopFor(preferredEl);
    const beforeWindow = window.scrollY || document.documentElement.scrollTop || 0;

    const isPreferredWindow = preferredEl === document.scrollingElement || preferredEl === document.documentElement;
    if (isPreferredWindow) {
      window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
    } else {
      preferredEl.scrollTop += delta;
    }
    await sleep(180);

    // Fallback 1: window scroll.
    const afterPreferred1 = getScrollTopFor(preferredEl);
    if (afterPreferred1 === beforePreferred) {
      window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
      await sleep(180);
    }

    // Fallback 2: document scroller direct set.
    const afterWindow = window.scrollY || document.documentElement.scrollTop || 0;
    if (afterWindow === beforeWindow) {
      documentScroller.scrollTop += delta;
      await sleep(180);
    }

    // Fallback 3: move to the last visible post/action row, then nudge down.
    const visibleAnchors = findPostElements();
    if (visibleAnchors.length > 0) {
      const last = visibleAnchors[visibleAnchors.length - 1];
      if (last && isVisible(last)) {
        last.scrollIntoView({ behavior: 'auto', block: 'end' });
        await sleep(180);
        window.scrollBy({ top: Math.floor(delta * 0.5), left: 0, behavior: 'auto' });
        await sleep(120);
      }
    }
  }

  function looksLikeActionText(text) {
    return /^(like|comment|share|follow|send|reels?|see more|view more|reply)$/i.test(cleanText(text));
  }

  function isLikelyNoiseLine(line) {
    return /^(like|comment|share|write a public comment|most relevant|see more|see less)$/i.test(cleanText(line));
  }

  function hasPostSignals(el) {
    if (!el) return false;
    const text = cleanText(el.textContent || '');
    const hasActionRow = /\bcomment\b/i.test(text) && /\bshare\b/i.test(text);
    const hasMedia = el.querySelector('img, video') !== null;
    const hasBodyText = el.querySelector('[data-ad-preview="message"], [dir="auto"], div[lang]') !== null;
    return hasActionRow && (hasMedia || hasBodyText);
  }

  function isActionRowText(text) {
    const t = cleanText(text).toLowerCase();
    return t.includes('like') && t.includes('comment') && t.includes('share');
  }

  function scorePostContainer(el) {
    if (!el || !isVisible(el)) return -1;
    const rect = el.getBoundingClientRect();
    if (rect.width < 220 || rect.height < 180 || rect.height > 3600) return -1;

    let score = 0;
    const text = cleanText(el.textContent || '');
    if (isActionRowText(text)) score += 3;
    if (el.querySelector('img, video')) score += 2;
    if (el.querySelector('[data-ad-preview="message"], [dir="auto"], div[lang]')) score += 2;
    if (/write a public comment/i.test(text)) score += 1;
    return score;
  }

  function getBestAncestorFromNode(node) {
    let best = null;
    let bestScore = -1;
    let el = node;
    for (let i = 0; i < 16 && el; i += 1) {
      const score = scorePostContainer(el);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
      el = el.parentElement;
    }
    return bestScore >= 3 ? best : null;
  }

  function findAncestorPostFromAction(node) {
    let el = node;
    for (let i = 0; i < 18 && el; i += 1) {
      if (el.matches && (el.matches('[role="article"]') || el.matches('[data-pagelet*="FeedUnit"]'))) {
        return el;
      }

      if (el.tagName === 'DIV' && isVisible(el)) {
        const rect = el.getBoundingClientRect();
        if (rect.height > 180 && rect.width > 220 && hasPostSignals(el)) {
          return el;
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  // Multi-strategy post detection without class-name dependency.
  function findPostElements() {
    const set = new Set();

    // Strategy 1: Standard semantic wrappers.
    document.querySelectorAll('[role="article"], [data-pagelet*="FeedUnit"], div[aria-posinset][aria-setsize]').forEach((el) => {
      if (isVisible(el)) set.add(el);
    });

    // Strategy 2: Fallback using action bar text (Comment + Share) when role/article is missing.
    const actionNodes = Array.from(document.querySelectorAll('div[role="button"], a[role="button"], span'));
    const commentNodes = actionNodes.filter((el) => /comment/i.test(cleanText(el.textContent)) && isVisible(el));

    commentNodes.forEach((commentNode) => {
      const container = findAncestorPostFromAction(commentNode);
      if (!container || !isVisible(container)) return;
      set.add(container);
    });

    // Strategy 3: Generic feed-card fallback for layouts without useful roles/pagelets.
    document.querySelectorAll('main div, [role="main"] div').forEach((el) => {
      if (!isVisible(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.height < 220 || rect.width < 240 || rect.height > 2800) return;
      if (hasPostSignals(el)) set.add(el);
    });

    // Strategy 4: Build post containers from visible action rows in Groups/Home feeds.
    document.querySelectorAll('span, div[role="button"], a[role="button"]').forEach((node) => {
      if (!isVisible(node)) return;
      const text = cleanText(node.textContent);
      if (!/^comment$/i.test(text)) return;

      let ancestor = node.parentElement;
      for (let i = 0; i < 14 && ancestor; i += 1) {
        if (!isVisible(ancestor)) {
          ancestor = ancestor.parentElement;
          continue;
        }
        const ancestorText = cleanText(ancestor.textContent || '');
        const hasLike = /\blike\b/i.test(ancestorText);
        const hasShare = /\bshare\b/i.test(ancestorText);
        const rect = ancestor.getBoundingClientRect();
        if (hasLike && hasShare && rect.height > 180 && rect.width > 220) {
          set.add(ancestor);
          break;
        }
        ancestor = ancestor.parentElement;
      }
    });

    // Strategy 5: Direct action-row matcher for UIs where row text is merged in one element.
    document.querySelectorAll('div, span').forEach((el) => {
      if (!isVisible(el)) return;
      const text = cleanText(el.textContent);
      if (!isActionRowText(text)) return;
      // Keep likely action rows only; avoid huge containers that merely contain these words.
      if (text.length > 220) return;

      const candidate = getBestAncestorFromNode(el);
      if (candidate) set.add(candidate);
    });

    // Strategy 6: Detect post cards by visible comment composer placeholders.
    document
      .querySelectorAll('[aria-label*="comment" i], [placeholder*="comment" i], div[role="textbox"]')
      .forEach((node) => {
        if (!isVisible(node)) return;
        const candidate = getBestAncestorFromNode(node);
        if (candidate) set.add(candidate);
      });

    // Keep only reasonably sized containers to avoid tiny widgets.
    const candidates = Array.from(set).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.height > 140 && rect.width > 180 && rect.height < 3600;
    });

    // Sort top-to-bottom and cap to reduce expensive processing on huge feeds.
    candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return candidates.slice(0, 20);
  }

  // Extract comments from likely comment containers.
  function extractComments(postEl, captionText) {
    const comments = new Set();
    const selectors = [
      '[aria-label*="Comment by" i] [dir="auto"]',
      '[aria-label*="comment" i] [dir="auto"]',
      '[aria-label*="comment" i] span',
      '[aria-label*="comment" i] div[dir]',
      'ul li [dir="auto"]',
      'ul li span',
      '[role="article"] [dir="auto"]'
    ];

    postEl.querySelectorAll(selectors.join(', ')).forEach((node) => {
      if (!isVisible(node)) return;

      const txt = cleanText(node.textContent);
      if (!txt) return;
      if (txt.length < 3 || txt.length > 800) return;
      if (looksLikeActionText(txt)) return;
      if (captionText && txt === captionText) return;

      comments.add(txt);
    });

    return Array.from(comments);
  }

  // Extract likely post caption text.
  function extractCaption(postEl) {
    const preferred = Array.from(postEl.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]'));

    for (const node of preferred) {
      if (!isVisible(node)) continue;
      const txt = cleanText(node.textContent);
      if (txt.length >= 10) return txt;
    }

    const candidates = [];
    postEl.querySelectorAll('[dir="auto"], div[lang], span[dir="auto"]').forEach((node) => {
      if (!isVisible(node)) return;

      const txt = cleanText(node.textContent);
      if (!txt) return;
      if (txt.length < 10 || txt.length > 5000) return;
      if (looksLikeActionText(txt)) return;

      candidates.push(txt);
    });

    // Longest non-action text is usually the caption/body.
    candidates.sort((a, b) => b.length - a.length);
    if (candidates.length > 0) return candidates[0];

    // Final text fallback for feeds where message attributes are absent.
    const lines = cleanText(postEl.innerText || '')
      .split('\n')
      .map((line) => cleanText(line))
      .filter((line) => line.length >= 12 && line.length <= 400 && !isLikelyNoiseLine(line));
    lines.sort((a, b) => b.length - a.length);
    return lines[0] || '';
  }

  // Extract visible images in a post.
  function extractImages(postEl) {
    const urls = new Set();

    postEl.querySelectorAll('img').forEach((img) => {
      if (!isVisible(img)) return;

      const src = img.currentSrc || img.src;
      if (!src || !/^https?:\/\//i.test(src)) return;

      // Skip icons/avatars where possible.
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;
      if (width < 120 || height < 120) return;

      urls.add(src);
    });

    // Some Facebook media appears as CSS background-image blocks.
    postEl.querySelectorAll('div, a, span').forEach((node) => {
      if (!isVisible(node)) return;
      const style = window.getComputedStyle(node);
      const bg = style.backgroundImage || '';
      if (!bg || bg === 'none') return;
      const match = bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);
      if (match && match[1]) {
        urls.add(match[1]);
      }
    });

    return Array.from(urls);
  }

  function safeClick(el) {
    try {
      el.click();
      return true;
    } catch (_error) {
      return false;
    }
  }

  function isLikelyNavigationClickTarget(el) {
    if (!el) return false;
    const anchor = el.closest('a[href]');
    if (!anchor) return false;
    const href = anchor.getAttribute('href') || '';
    // Avoid clicks that can open dedicated post pages/comments routes.
    return href.startsWith('/') || href.startsWith('http');
  }

  function closeOpenDialogs() {
    // Close modal/single-post overlays that can block further feed scanning.
    const closeSelectors = [
      '[role="dialog"] [aria-label="Close"]',
      '[role="dialog"] [aria-label*="close" i]',
      '[role="dialog"] div[role="button"][aria-label*="close" i]',
      '[aria-label="Close"]'
    ];

    closeSelectors.forEach((selector) => {
      const node = document.querySelector(selector);
      if (node && isVisible(node)) {
        safeClick(node);
      }
    });
  }

  async function recoverFeedContext(originUrl) {
    closeOpenDialogs();
    await sleep(120);

    // If scanner navigated away to single-post view, go back to feed.
    if (location.href !== originUrl && history.length > 0) {
      history.back();
      await sleep(900);
      closeOpenDialogs();
      await sleep(250);
    }
  }

  async function expandSeeMoreInPost(postEl) {
    // Expand truncated post text by clicking "See more" variants inside the post.
    const clickableNodes = postEl.querySelectorAll('div[role="button"], span, a[role="button"], a');
    let clicked = 0;

    clickableNodes.forEach((node) => {
      if (clicked >= 4) return;
      if (!isVisible(node)) return;
      const text = cleanText(node.textContent);
      if (!/^(see more|view more|more)$/i.test(text)) return;
      if (safeClick(node)) clicked += 1;
    });

    if (clicked > 0) {
      await sleep(350);
    }
  }

  async function openCommentsInPost(postEl) {
    // Open comment section to force rendering comment nodes before extraction.
    const candidates = postEl.querySelectorAll('div[role="button"], a[role="button"]');
    let clicked = false;

    for (const node of candidates) {
      if (!isVisible(node)) continue;
      if (isLikelyNavigationClickTarget(node)) continue;
      const text = cleanText(node.textContent);
      if (!/^(comment|comments)$/i.test(text) && !/^\d+(\.\d+)?[kmb]?\s+comments?$/i.test(text)) continue;
      if (text.length > 60) continue;
      if (safeClick(node)) {
        clicked = true;
        break;
      }
    }

    if (clicked) {
      await sleep(500);
    }
  }

  async function expandCommentsInPost(postEl) {
    // Expand collapsed comment threads/replies without following links.
    const candidates = postEl.querySelectorAll('div[role="button"], a[role="button"], span');
    let clicks = 0;

    for (const node of candidates) {
      if (clicks >= 4) break;
      if (!isVisible(node)) continue;
      if (isLikelyNavigationClickTarget(node)) continue;

      const text = cleanText(node.textContent);
      if (!text || text.length > 90) continue;
      if (!/(view|see|more|all|previous)\s+comments?/i.test(text) && !/(view|see|more)\s+repl(y|ies)/i.test(text)) {
        continue;
      }

      if (safeClick(node)) {
        clicks += 1;
        await sleep(280);
      }
    }
  }

  async function preparePostForExtraction(postEl, behavior = {}) {
    const allowScrollIntoView = behavior.allowScrollIntoView !== false;
    const allowExpandSeeMore = behavior.allowExpandSeeMore !== false;
    const allowOpenComments = behavior.allowOpenComments === true;
    const allowExpandComments = behavior.allowExpandComments === true;
    const skipRepeatInteractions = behavior.skipRepeatInteractions === true;

    if (!postEl || !isVisible(postEl)) return;
    const alreadyInteracted = __interactedPosts.has(postEl);
    if (allowScrollIntoView) {
      postEl.scrollIntoView({ behavior: 'auto', block: 'center' });
      await sleep(220);
    }
    if (allowExpandSeeMore && (!skipRepeatInteractions || !alreadyInteracted)) {
      await expandSeeMoreInPost(postEl);
    }
    if (allowOpenComments && (!skipRepeatInteractions || !alreadyInteracted)) {
      await openCommentsInPost(postEl);
    }
    if (allowExpandComments && (!skipRepeatInteractions || !alreadyInteracted)) {
      await expandCommentsInPost(postEl);
    }
    if (skipRepeatInteractions) {
      __interactedPosts.add(postEl);
    }
  }

  async function collectPostsFromElements(postElements, originUrl, behavior = {}) {
    const posts = [];
    const seen = new Set();
    const limited = postElements.slice(0, 12);
    const allowRecovery = behavior.allowRecovery !== false;

    for (const postEl of limited) {
      if (allowRecovery) {
        await recoverFeedContext(originUrl);
      }
      await preparePostForExtraction(postEl, behavior);
      const caption = extractCaption(postEl);
      const comments = extractComments(postEl, caption);
      const imageUrls = extractImages(postEl);

      if (caption || comments.length > 0 || imageUrls.length > 0) {
        // Deduplicate near-identical captures across fallback containers.
        const key = `${caption}|${comments.slice(0, 3).join('||')}|${imageUrls.slice(0, 2).join('||')}`;
        if (!seen.has(key)) {
          posts.push({ caption, comments, imageUrls });
          seen.add(key);
        }
      }
    }

    return posts;
  }

  async function collectDirectActionRowPosts(originUrl, behavior = {}) {
    const posts = [];
    const seen = new Set();
    const allowRecovery = behavior.allowRecovery !== false;

    // Last-resort extraction: derive post from explicit Like+Comment+Share row.
    const nodes = Array.from(document.querySelectorAll('div, span')).slice(0, 120);
    if (allowRecovery) {
      await recoverFeedContext(originUrl);
    }
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const text = cleanText(node.textContent);
      if (!isActionRowText(text)) continue;
      if (text.length > 220) continue;

      const candidate = getBestAncestorFromNode(node);
      if (!candidate) continue;
      await preparePostForExtraction(candidate, behavior);

      const caption = extractCaption(candidate);
      const comments = extractComments(candidate, caption);
      const imageUrls = extractImages(candidate);
      if (!caption && comments.length === 0 && imageUrls.length === 0) continue;

      const key = `${caption}|${comments.slice(0, 2).join('||')}|${imageUrls.slice(0, 2).join('||')}`;
      if (!seen.has(key)) {
        posts.push({ caption, comments, imageUrls });
        seen.add(key);
        if (posts.length >= 10) break;
      }
    }

    return posts;
  }

  function dedupePosts(posts) {
    const unique = [];
    const seen = new Set();

    posts.forEach((post) => {
      const caption = cleanText(post && post.caption ? post.caption : '');
      const comments = Array.isArray(post && post.comments) ? post.comments.map((c) => cleanText(c)).filter(Boolean) : [];
      const imageUrls = Array.isArray(post && post.imageUrls) ? post.imageUrls.filter(Boolean) : [];
      const key = `${caption}|${comments.slice(0, 4).join('||')}|${imageUrls.slice(0, 3).join('||')}`;
      if (!seen.has(key) && (caption || comments.length > 0 || imageUrls.length > 0)) {
        unique.push({ caption, comments, imageUrls });
        seen.add(key);
      }
    });

    return unique;
  }

  async function collectCurrentSnapshot(originUrl, behavior = {}) {
    const postElements = findPostElements();
    const posts = await collectPostsFromElements(postElements, originUrl, behavior);
    const directPosts = await collectDirectActionRowPosts(originUrl, behavior);
    return dedupePosts([...posts, ...directPosts]);
  }

  async function scanCurrentViewWithRetries(maxAttempts = 5, behavior = {}) {
    await waitForContent();
    const originUrl = location.href;
    const allowRecovery = behavior.allowRecovery !== false;

    // Multi-pass retries improve reliability on Facebook's delayed/lazy rendering.
    let bestResult = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (allowRecovery) {
        await recoverFeedContext(originUrl);
      }
      const merged = await collectCurrentSnapshot(originUrl, behavior);

      if (merged.length > bestResult.length) {
        bestResult = merged;
      }

      // Return early as soon as we have useful data.
      if (merged.length > 0) {
        return merged;
      }

      // Give React/hydration time to mount feed cards and text.
      await new Promise((resolve) => setTimeout(resolve, 900 + attempt * 300));
    }

    return bestResult;
  }

  async function autoScrollAndScan(options = {}) {
    const maxScrollSteps = Number(options.maxScrollSteps) > 0 ? Number(options.maxScrollSteps) : 14;
    const stepDelayMs = Number(options.stepDelayMs) > 0 ? Number(options.stepDelayMs) : 1200;
    const minScrollSteps = Number(options.minScrollSteps) > 0 ? Number(options.minScrollSteps) : 4;

    await waitForContent();
    const originUrl = location.href;
    const autoBehavior = {
      // Critical: avoid jumping back to first post during auto-scroll.
      allowScrollIntoView: false,
      // Strict auto mode: no clicks, only scroll + extract currently visible content.
      allowExpandSeeMore: false,
      allowOpenComments: false,
      allowExpandComments: false,
      skipRepeatInteractions: true,
      allowRecovery: false
    };

    let collected = [];
    let previousScrollTop = -1;
    let stableBottomHits = 0;
    const scrollEl = getScrollableContainer();

    for (let step = 0; step < maxScrollSteps; step += 1) {
      await recoverFeedContext(originUrl);
      const snapshotPosts = await scanCurrentViewWithRetries(2, autoBehavior);
      collected = dedupePosts([...collected, ...snapshotPosts]);

      const scrollTop = getScrollTopFor(scrollEl);
      const scrollHeight = getScrollHeightFor(scrollEl);
      const viewHeight = getViewHeightFor(scrollEl);
      const viewportBottom = scrollTop + viewHeight;
      const isNearBottom = viewportBottom >= scrollHeight - 80;

      if (isNearBottom || scrollTop === previousScrollTop) {
        stableBottomHits += 1;
      } else {
        stableBottomHits = 0;
      }

      if (step + 1 >= minScrollSteps && stableBottomHits >= 2) {
        break;
      }

      previousScrollTop = scrollTop;
      const delta = Math.floor(viewHeight * 0.9);
      await performScrollStep(scrollEl, delta);
      await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    }

    // Final capture after last scroll.
    await recoverFeedContext(originUrl);
    const finalSnapshot = await scanCurrentViewWithRetries(2, autoBehavior);
    return dedupePosts([...collected, ...finalSnapshot]);
  }

  async function scanFacebookPage(options = {}) {
    if (options && options.autoScroll) {
      return autoScrollAndScan(options);
    }
    return scanCurrentViewWithRetries(5, {
      allowScrollIntoView: true,
      allowExpandSeeMore: true,
      allowOpenComments: true,
      allowExpandComments: true,
      skipRepeatInteractions: false
    });
  }

  // Listen for popup scan requests and send data back asynchronously.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.action !== 'SCAN_FACEBOOK') {
      return;
    }

    (async () => {
      try {
        const options = message.options && typeof message.options === 'object' ? message.options : {};
        const data = await scanFacebookPage(options);
        sendResponse({ success: true, data });
      } catch (error) {
        sendResponse({
          success: false,
          error: error && error.message ? error.message : 'Failed to scan Facebook page.'
        });
      }
    })();

    // Indicates asynchronous response.
    return true;
  });
})();
