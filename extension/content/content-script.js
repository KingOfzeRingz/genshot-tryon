/**
 * GenShot TryOn - Content Script
 *
 * Orchestrates product extraction on ecommerce pages.
 * Listens for messages from the popup/service worker and dispatches
 * to the appropriate site-specific extractor.
 * Also auto-extracts on page load for supported sites and caches the result.
 */

(function () {
  "use strict";

  // Cache for extracted product data to avoid redundant DOM traversals
  let cachedProduct = null;
  let cacheUrl = null;

  /**
   * Detect the current site and select the appropriate extractor.
   * Returns the extractor module or null.
   */
  function selectExtractor() {
    // Check site-specific extractors first (higher confidence)
    if (typeof ZaraExtractor !== "undefined" && ZaraExtractor.canHandle()) {
      return { extractor: ZaraExtractor, site: "zara" };
    }

    if (typeof HMExtractor !== "undefined" && HMExtractor.canHandle()) {
      return { extractor: HMExtractor, site: "hm" };
    }

    // Fall back to generic extractor
    if (typeof GenericExtractor !== "undefined" && GenericExtractor.canHandle()) {
      return { extractor: GenericExtractor, site: "generic" };
    }

    return null;
  }

  /**
   * Extract product data from the current page.
   * Uses cached result if available and the URL hasn't changed.
   */
  function extractProduct(forceRefresh = false) {
    const currentUrl = window.location.href;

    // Return cached result if URL hasn't changed and no force refresh
    if (!forceRefresh && cachedProduct && cacheUrl === currentUrl) {
      console.log("[GenShot TryOn] Returning cached product data");
      return cachedProduct;
    }

    const selected = selectExtractor();
    if (!selected) {
      console.warn("[GenShot TryOn] No suitable extractor found for this page");
      return null;
    }

    console.log(`[GenShot TryOn] Using ${selected.site} extractor`);

    try {
      const product = selected.extractor.extract();

      // Sort images so the best product-focused shot is first
      if (typeof GenShotImageSelector !== "undefined" && product.images?.length > 1) {
        product.images = GenShotImageSelector.selectBestProductImage(product.images, selected.site);
      }

      // Validate minimal data requirements
      if (!product.name && !product.images?.length) {
        console.warn("[GenShot TryOn] Extraction yielded insufficient data");
        return null;
      }

      // Attach extraction metadata
      product.source = selected.site;

      // Cache the result
      cachedProduct = product;
      cacheUrl = currentUrl;

      console.log("[GenShot TryOn] Product extracted:", product.name);
      return product;
    } catch (err) {
      console.error("[GenShot TryOn] Extraction error:", err);
      return null;
    }
  }

  /**
   * Listen for messages from the popup or service worker.
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "EXTRACT_PRODUCT") {
      const forceRefresh = message.payload?.forceRefresh || false;

      try {
        const product = extractProduct(forceRefresh);

        if (product) {
          sendResponse({ success: true, data: product });
        } else {
          sendResponse({
            success: false,
            error: "Could not extract product data from this page",
          });
        }
      } catch (err) {
        sendResponse({
          success: false,
          error: `Extraction failed: ${err.message}`,
        });
      }

      // Synchronous response
      return false;
    }

    if (message.type === "PING") {
      sendResponse({ success: true, data: { alive: true } });
      return false;
    }
  });

  /**
   * Auto-extract on page load for supported sites.
   * This pre-populates the cache so the popup opens faster.
   */
  function autoExtract() {
    // Only auto-extract on known supported sites
    const host = window.location.hostname;
    const isSupported =
      host.includes("zara.com") || host.includes("hm.com");

    if (!isSupported) return;

    // Small delay to let dynamic content load
    setTimeout(() => {
      const product = extractProduct();
      if (product) {
        console.log("[GenShot TryOn] Auto-extracted product:", product.name);
      }
    }, 1500);
  }

  // Run auto-extraction
  autoExtract();

  // Also listen for SPA navigation (URL changes without page reload)
  let lastUrl = window.location.href;
  const urlObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      console.log("[GenShot TryOn] URL changed, clearing cache");
      cachedProduct = null;
      cacheUrl = null;

      // Re-extract after a delay for the new page content
      setTimeout(() => {
        autoExtract();
      }, 2000);
    }
  });

  urlObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log("[GenShot TryOn] Content script loaded");
})();
