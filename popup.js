// popup.js
// Handles popup UI interactions, injects content script, and renders extracted data.

const scanBtn = document.getElementById('scanBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

// Utility to update status text in the popup.
function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b00020' : '#1f2937';
}

// Clears previous scan results.
function clearResults() {
  resultsEl.innerHTML = '';
}

// Escapes text to avoid HTML injection when rendering strings.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Renders post data list in the popup.
function renderResults(posts) {
  clearResults();

  if (!Array.isArray(posts) || posts.length === 0) {
    resultsEl.innerHTML = '<div class="empty">No visible posts found.</div>';
    return;
  }

  posts.forEach((post, index) => {
    const postDiv = document.createElement('div');
    postDiv.className = 'post';

    const caption = post.caption ? escapeHtml(post.caption) : '(No caption found)';
    const comments = Array.isArray(post.comments) ? post.comments : [];
    const imageUrls = Array.isArray(post.imageUrls) ? post.imageUrls : [];

    const commentsHtml = comments.length
      ? comments.map((c) => `<li>${escapeHtml(c)}</li>`).join('')
      : '<li class="empty">No visible comments found.</li>';

    const imagesHtml = imageUrls.length
      ? imageUrls.map((url) => `<li><a href="${escapeHtml(url)}" target="_blank">${escapeHtml(url)}</a></li>`).join('')
      : '<li class="empty">No images found.</li>';

    postDiv.innerHTML = `
      <div class="label">Post #${index + 1} Caption:</div>
      <ul>
        <li>${caption}</li>
      </ul>

      <div class="label">Comments:</div>
      <ul>
        ${commentsHtml}
      </ul>

      <div class="label">Image URLs:</div>
      <ul>
        ${imagesHtml}
      </ul>
    `;

    resultsEl.appendChild(postDiv);
  });
}

// Gets the currently active tab in the current window.
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// Sends a scan request to content script in the active tab.
function sendScanRequest(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        action: 'SCAN_FACEBOOK',
        options: {
          autoScroll: true,
          maxScrollSteps: 14,
          stepDelayMs: 1200
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

// Injects content.js into the active tab.
async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

// Main scan flow triggered by button click.
async function runScan() {
  setStatus('Starting auto-scroll scan...');
  clearResults();
  scanBtn.disabled = true;

  try {
    const tab = await getActiveTab();

    if (!tab || !tab.id || !tab.url) {
      throw new Error('Could not identify the active tab.');
    }

    // Basic guard to avoid scanning non-Facebook pages.
    const isFacebook = tab.url.includes('facebook.com');
    if (!isFacebook) {
      throw new Error('Open a Facebook page in the active tab before scanning.');
    }

    setStatus('Injecting scanner...');
    await injectContentScript(tab.id);

    setStatus('Auto-scrolling feed and collecting posts...');
    const response = await sendScanRequest(tab.id);

    if (!response) {
      throw new Error('No response from content script.');
    }

    if (!response.success) {
      throw new Error(response.error || 'Scan failed due to an unknown error.');
    }

    renderResults(response.data || []);
    setStatus(`Scan complete. Found ${Array.isArray(response.data) ? response.data.length : 0} posts.`);
  } catch (error) {
    setStatus(error.message || 'Unexpected error occurred while scanning.', true);
    clearResults();
  } finally {
    scanBtn.disabled = false;
  }
}

scanBtn.addEventListener('click', () => {
  runScan();
});
