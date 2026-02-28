/**
 * GenShot TryOn - Background Service Worker
 *
 * Handles communication between content scripts, popup, and the backend API.
 * All network requests to the backend are routed through this service worker.
 */

const DEFAULT_API_BASE = "http://localhost:8080";

/**
 * Retrieve the API base URL from storage, falling back to the default.
 */
async function getApiBase() {
  try {
    const result = await chrome.storage.local.get("apiBaseUrl");
    return result.apiBaseUrl || DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
}

/**
 * POST items to the backend to create an import session.
 * Returns the session payload including session ID, signature, and QR URL.
 */
async function createImportSession(items) {
  const apiBase = await getApiBase();
  const url = `${apiBase}/v1/import-sessions`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Backend returned ${response.status}: ${errorBody || response.statusText}`
    );
  }

  const data = await response.json();
  return data;
}

/**
 * Content script files in injection order.
 * Must match the content_scripts.js array in manifest.json.
 */
const CONTENT_SCRIPTS = [
  "content/extractors/zara.js",
  "content/extractors/hm.js",
  "content/extractors/generic.js",
  "content/image-selector.js",
  "content/content-script.js",
  "lib/qrcode.min.js",
  "content/overlay-styles.js",
  "content/inject-button.js",
];

/**
 * Programmatically inject all content scripts into a tab.
 * Used when the tab was already open before the extension loaded/reloaded.
 */
async function injectContentScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPTS,
  });
}

/**
 * Send a message to the content script running in a specific tab.
 * If the content script isn't there yet (e.g. tab was open before
 * extension load), inject it first and retry.
 */
async function sendToContentScript(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch (err) {
    // Content script not injected — inject and retry once
    if (
      err.message?.includes("Receiving end does not exist") ||
      err.message?.includes("Could not establish connection")
    ) {
      console.log("[GenShot TryOn] Content script missing, injecting into tab", tabId);
      await injectContentScripts(tabId);
      // Brief pause to let scripts initialise
      await new Promise((r) => setTimeout(r, 500));
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    }
    throw new Error(
      `Failed to communicate with content script: ${err.message}`
    );
  }
}

/**
 * Main message listener.
 * Handles messages from both the popup and content scripts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case "EXTRACT_PRODUCT": {
      // Forward extraction request to the content script in the specified tab
      const tabId = payload?.tabId;
      if (!tabId) {
        sendResponse({ success: false, error: "No tab ID provided" });
        return false;
      }

      sendToContentScript(tabId, { type: "EXTRACT_PRODUCT" })
        .then((result) => {
          sendResponse({ success: true, data: result });
        })
        .catch((err) => {
          sendResponse({ success: false, error: err.message });
        });

      // Return true to indicate we will respond asynchronously
      return true;
    }

    case "CREATE_IMPORT_SESSION": {
      const items = payload?.items;
      if (!items || !Array.isArray(items) || items.length === 0) {
        sendResponse({ success: false, error: "No items provided" });
        return false;
      }

      createImportSession(items)
        .then((sessionData) => {
          sendResponse({ success: true, data: sessionData });
        })
        .catch((err) => {
          sendResponse({ success: false, error: err.message });
        });

      return true;
    }

    case "SET_API_BASE": {
      const url = payload?.url;
      if (!url) {
        sendResponse({ success: false, error: "No URL provided" });
        return false;
      }

      chrome.storage.local
        .set({ apiBaseUrl: url })
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((err) => {
          sendResponse({ success: false, error: err.message });
        });

      return true;
    }

    case "GET_API_BASE": {
      getApiBase()
        .then((url) => {
          sendResponse({ success: true, data: { url } });
        })
        .catch((err) => {
          sendResponse({ success: false, error: err.message });
        });

      return true;
    }

    default:
      sendResponse({ success: false, error: `Unknown message type: ${type}` });
      return false;
  }
});

// Log when the service worker starts
console.log("[GenShot TryOn] Service worker initialized");
