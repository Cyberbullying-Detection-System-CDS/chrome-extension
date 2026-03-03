// popup.js
// Handles popup UI, scanning flow, backend posting, and user settings.

const DEFAULT_SETTINGS = {
  baseUrl: 'http://localhost:8081',
  path: '/api/broker/process'
};

const STORAGE_KEY = 'backendSettings';

const scanBtn = document.getElementById('scanBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const jsonPreviewEl = document.getElementById('jsonPreview');
const summaryEl = document.getElementById('summary');
const findingsEl = document.getElementById('findings');

const baseUrlInput = document.getElementById('baseUrlInput');
const pathInput = document.getElementById('pathInput');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const resetSettingsBtn = document.getElementById('resetSettingsBtn');
const settingsStatusEl = document.getElementById('settingsStatus');

function getStorageArea() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return 'chrome';
    }
  } catch (_error) {
    // Ignore and fallback to localStorage.
  }
  return 'local';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b42318' : '#334155';
}

function setSettingsStatus(message, isError = false) {
  settingsStatusEl.textContent = message;
  settingsStatusEl.style.color = isError ? '#b42318' : '#4b5563';
}

function clearResults() {
  resultsEl.innerHTML = '';
}

function setJsonPreview(payload) {
  jsonPreviewEl.textContent = payload ? JSON.stringify(payload, null, 2) : '';
}

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  const trimmed = (raw || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, '');
  return trimmed;
}

function normalizePath(path) {
  const raw = String(path || '').trim();
  const trimmed = raw || DEFAULT_SETTINGS.path;
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function buildBackendCandidates(settings) {
  const normalizedBase = normalizeBaseUrl(settings.baseUrl);
  const normalizedPath = normalizePath(settings.path);
  const mainUrl = `${normalizedBase}${normalizedPath}`;

  const urls = [mainUrl];

  // Convenience fallback for localhost hostname mapping.
  if (normalizedBase.includes('localhost')) {
    urls.push(mainUrl.replace('localhost', '127.0.0.1'));
  } else if (normalizedBase.includes('127.0.0.1')) {
    urls.push(mainUrl.replace('127.0.0.1', 'localhost'));
  }

  return Array.from(new Set(urls));
}

function validateSettings(settings) {
  const base = normalizeBaseUrl(settings.baseUrl);
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('Base URL must start with http:// or https://');
  }

  const path = normalizePath(settings.path);
  if (!path || !path.startsWith('/')) {
    throw new Error('Path must start with /');
  }
}

async function loadSettings() {
  let saved = {};
  const storageArea = getStorageArea();

  if (storageArea === 'chrome') {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    saved = data && data[STORAGE_KEY] ? data[STORAGE_KEY] : {};
  } else {
    const raw = localStorage.getItem(STORAGE_KEY);
    saved = raw ? JSON.parse(raw) : {};
  }

  const settings = {
    baseUrl: saved.baseUrl || DEFAULT_SETTINGS.baseUrl,
    path: saved.path || DEFAULT_SETTINGS.path
  };

  baseUrlInput.value = settings.baseUrl;
  pathInput.value = settings.path;
  return settings;
}

async function saveSettings(settings) {
  const normalized = {
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    path: normalizePath(settings.path)
  };
  validateSettings(normalized);

  const storageArea = getStorageArea();
  if (storageArea === 'chrome') {
    await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }

  return normalized;
}

function renderBackendAnalysis(data) {
  if (!data || typeof data !== 'object') {
    summaryEl.innerHTML = '<div class="muted">No analysis yet.</div>';
    findingsEl.innerHTML = '<div class="muted">Run a scan to see findings.</div>';
    return;
  }

  const totalPosts = Number.isFinite(Number(data.totalPostsProcessed)) ? Number(data.totalPostsProcessed) : 0;
  const totalItems = Number.isFinite(Number(data.totalItemsAnalyzed)) ? Number(data.totalItemsAnalyzed) : 0;
  const detected = Number.isFinite(Number(data.cyberbullyingDetected)) ? Number(data.cyberbullyingDetected) : 0;
  const processedAt = escapeHtml(data.processedAt || '-');

  summaryEl.innerHTML = `
    <div class="kpi"><div class="k">Posts</div><div class="v">${totalPosts}</div></div>
    <div class="kpi"><div class="k">Items</div><div class="v">${totalItems}</div></div>
    <div class="kpi"><div class="k">Detected</div><div class="v">${detected}</div></div>
    <div class="kpi"><div class="k">Processed At</div><div class="v">${processedAt}</div></div>
  `;

  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    findingsEl.innerHTML = '<div class="muted">No analysis items returned.</div>';
    return;
  }

  findingsEl.innerHTML = results
    .map((item) => {
      const source = escapeHtml(item && item.source ? item.source : '-');
      const type = escapeHtml(item && item.type ? item.type : '-');
      const confidence = escapeHtml(item && item.confidence ? item.confidence : '-');
      const isHit = Boolean(item && (item.isCyberbullying === true || item.cyberbullying === true));

      return `
        <div class="finding">
          <div><span class="badge ${isHit ? 'hit' : 'safe'}">${isHit ? 'CYBERBULLYING' : 'SAFE'}</span></div>
          <div><strong>Source:</strong> ${source}</div>
          <div><strong>Type:</strong> ${type}</div>
          <div><strong>Confidence:</strong> ${confidence}</div>
        </div>
      `;
    })
    .join('');
}

function renderResults(posts) {
  clearResults();

  if (!Array.isArray(posts) || posts.length === 0) {
    resultsEl.innerHTML = '<div class="muted">No visible posts found.</div>';
    return;
  }

  resultsEl.innerHTML = posts
    .map((post, index) => {
      const caption = escapeHtml(post && post.caption ? post.caption : '(No caption)');
      const comments = Array.isArray(post && post.comments) ? post.comments : [];
      const imageCount = Array.isArray(post && post.imageUrls) ? post.imageUrls.length : 0;

      return `
        <div class="post">
          <div><strong>Post #${index + 1}</strong></div>
          <div>${caption}</div>
          <div class="muted" style="margin-top:6px">Comments: ${comments.length} | Images: ${imageCount}</div>
        </div>
      `;
    })
    .join('');
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function sendScanRequest(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        action: 'SCAN_FACEBOOK',
        options: {
          autoScroll: true,
          maxScrollSteps: 14,
          stepDelayMs: 1200,
          minScrollSteps: 4
        }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      }
    );
  });
}

async function imageUrlToBase64(url) {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image fetch failed (${response.status})`);

  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        resolve(null);
        return;
      }
      const commaIndex = reader.result.indexOf(',');
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };
    reader.onerror = () => reject(new Error('Failed to convert image to base64'));
    reader.readAsDataURL(blob);
  });
}

async function buildPayload(pageUrl, posts) {
  const normalizedPosts = Array.isArray(posts) ? posts : [];
  const payloadPosts = [];

  for (const post of normalizedPosts) {
    const imageUrls = Array.isArray(post && post.imageUrls) ? post.imageUrls : [];
    const images = [];

    for (const imageUrl of imageUrls) {
      try {
        const rawBase64 = await imageUrlToBase64(imageUrl);
        if (rawBase64) images.push(rawBase64);
      } catch (_error) {
        // Ignore single-image conversion errors and continue.
      }
    }

    payloadPosts.push({
      caption: String(post && post.caption ? post.caption : ''),
      images,
      comments: Array.isArray(post && post.comments) ? post.comments : []
    });
  }

  return {
    pageUrl: String(pageUrl || ''),
    posts: payloadPosts
  };
}

async function postResultsToBackend(payload, settings) {
  const body = JSON.stringify(payload);
  const urls = buildBackendCandidates(settings);
  const errors = [];

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const txt = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${txt ? `: ${txt.slice(0, 120)}` : ''}`);
      }

      const data = await response.json().catch(() => null);
      return { url, data };
    } catch (error) {
      errors.push(`${url} -> ${error && error.message ? error.message : 'unknown error'}`);
    }
  }

  throw new Error(`Failed to POST to backend. ${errors.join(' | ')}`);
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

async function getCurrentSettingsFromUi() {
  const baseUrl = String(baseUrlInput.value || '').trim();
  const path = String(pathInput.value || '').trim();
  return {
    baseUrl: baseUrl || DEFAULT_SETTINGS.baseUrl,
    path: path || DEFAULT_SETTINGS.path
  };
}

async function runScan() {
  setStatus('Starting scan...');
  setJsonPreview(null);
  renderBackendAnalysis(null);
  clearResults();
  scanBtn.disabled = true;

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id || !tab.url) {
      throw new Error('Could not identify active tab.');
    }
    if (!tab.url.includes('facebook.com')) {
      throw new Error('Open a Facebook page in the active tab before scanning.');
    }

    const settings = await saveSettings(await getCurrentSettingsFromUi());

    setStatus('Injecting scanner...');
    await injectContentScript(tab.id);

    setStatus('Auto-scrolling and extracting posts...');
    const response = await sendScanRequest(tab.id);
    if (!response || !response.success) {
      throw new Error((response && response.error) || 'No valid response from scanner.');
    }

    setStatus('Converting images to base64...');
    const payload = await buildPayload(tab.url, response.data || []);
    setJsonPreview(payload);

    setStatus('Posting to backend...');
    const result = await postResultsToBackend(payload, settings);

    renderResults(response.data || []);
    renderBackendAnalysis(result.data);

    const processed = result.data && Number.isFinite(Number(result.data.totalPostsProcessed))
      ? Number(result.data.totalPostsProcessed)
      : (Array.isArray(response.data) ? response.data.length : 0);
    const detected = result.data && Number.isFinite(Number(result.data.cyberbullyingDetected))
      ? Number(result.data.cyberbullyingDetected)
      : 0;

    setStatus(`Done. Endpoint: ${result.url} | Processed: ${processed} | Detected: ${detected}`);
  } catch (error) {
    setStatus(error && error.message ? error.message : 'Unexpected error during scan.', true);
  } finally {
    scanBtn.disabled = false;
  }
}

async function initSettingsUi() {
  try {
    const settings = await loadSettings();
    setSettingsStatus(`Current endpoint: ${normalizeBaseUrl(settings.baseUrl)}${normalizePath(settings.path)}`);
  } catch (error) {
    setSettingsStatus(error && error.message ? error.message : 'Failed to load settings', true);
  }
}

saveSettingsBtn.addEventListener('click', async () => {
  try {
    const saved = await saveSettings(await getCurrentSettingsFromUi());
    setSettingsStatus(`Saved: ${normalizeBaseUrl(saved.baseUrl)}${normalizePath(saved.path)}`);
  } catch (error) {
    setSettingsStatus(error && error.message ? error.message : 'Failed to save settings', true);
  }
});

resetSettingsBtn.addEventListener('click', async () => {
  try {
    const saved = await saveSettings(DEFAULT_SETTINGS);
    baseUrlInput.value = saved.baseUrl;
    pathInput.value = saved.path;
    setSettingsStatus(`Reset: ${normalizeBaseUrl(saved.baseUrl)}${normalizePath(saved.path)}`);
  } catch (error) {
    setSettingsStatus(error && error.message ? error.message : 'Failed to reset settings', true);
  }
});

scanBtn.addEventListener('click', () => {
  runScan();
});

renderBackendAnalysis(null);
initSettingsUi();
