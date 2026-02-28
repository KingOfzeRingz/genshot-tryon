/**
 * GenShot TryOn - Embedded Try-On Button
 *
 * Injects a floating "Try On" FAB and overlay modal directly into
 * supported product pages.  Runs after all other content scripts so
 * the extractors, image-selector, QRCode lib, and overlay CSS are
 * already in scope.
 *
 * Flow:
 *   FAB click -> extract product -> show preview -> import -> QR code
 *
 * Uses a closed Shadow DOM to avoid style collisions with host pages.
 */

(function () {
  "use strict";

  // =========================================================================
  // Guard: prevent double-injection
  // =========================================================================
  if (document.getElementById("genshot-tryon-root")) return;

  // =========================================================================
  // Extension context validity check
  // =========================================================================

  /** Returns true if the extension context is still alive. */
  function isContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  /** Safely send a message to the service worker. */
  function safeSendMessage(message, callback) {
    if (!isContextValid()) {
      callback({ success: false, error: "Extension was reloaded. Please refresh the page." });
      return;
    }
    try {
      chrome.runtime.sendMessage(message, function (response) {
        try {
          if (chrome.runtime.lastError) {
            callback({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          callback(response);
        } catch (err) {
          callback({ success: false, error: "Extension context lost. Please refresh the page." });
        }
      });
    } catch (err) {
      callback({ success: false, error: "Extension context lost. Please refresh the page." });
    }
  }

  // =========================================================================
  // Constants
  // =========================================================================
  var ICON_URL;
  try {
    ICON_URL = chrome.runtime.getURL("icons/icon48.png");
  } catch {
    // Context already invalidated at load time — bail out
    return;
  }

  var CURRENCY_SYMBOLS = {
    USD: "$", EUR: "\u20AC", GBP: "\u00A3", SEK: "kr",
    RUB: "\u20BD", JPY: "\u00A5", CNY: "\u00A5", KRW: "\u20A9",
  };

  // =========================================================================
  // Helpers
  // =========================================================================

  function formatPrice(price, currency) {
    if (price == null) return "";
    var symbol = CURRENCY_SYMBOLS[currency] || currency || "";
    var formatted = price.toFixed(2);
    if (currency === "SEK") return formatted + " " + symbol;
    return symbol + formatted;
  }

  /** Detect which extractor matches the current page (or null). */
  function detectExtractor() {
    if (typeof ZaraExtractor !== "undefined" && ZaraExtractor.canHandle()) {
      return { extractor: ZaraExtractor, site: "zara" };
    }
    if (typeof HMExtractor !== "undefined" && HMExtractor.canHandle()) {
      return { extractor: HMExtractor, site: "hm" };
    }
    if (typeof GenericExtractor !== "undefined" && GenericExtractor.canHandle()) {
      return { extractor: GenericExtractor, site: "generic" };
    }
    return null;
  }

  // =========================================================================
  // Shadow DOM setup
  // =========================================================================

  var host = document.createElement("div");
  host.id = "genshot-tryon-root";
  document.body.appendChild(host);

  var shadow = host.attachShadow({ mode: "closed" });

  // Inject CSS
  var styleEl = document.createElement("style");
  styleEl.textContent = typeof GENSHOT_OVERLAY_CSS === "string" ? GENSHOT_OVERLAY_CSS : "";
  shadow.appendChild(styleEl);

  // =========================================================================
  // Build DOM
  // =========================================================================

  // --- FAB ---
  var fab = document.createElement("button");
  fab.className = "gs-fab gs-hidden";
  fab.innerHTML =
    '<img class="gs-fab-icon" src="' + ICON_URL + '" alt="">' +
    '<span>Try On</span>';
  shadow.appendChild(fab);

  // --- Backdrop ---
  var backdrop = document.createElement("div");
  backdrop.className = "gs-backdrop";
  shadow.appendChild(backdrop);

  // --- Modal ---
  var modal = document.createElement("div");
  modal.className = "gs-modal";
  modal.innerHTML = [
    // Header
    '<div class="gs-modal-header">',
    '  <div class="gs-modal-logo">',
    '    <img class="gs-modal-logo-icon" src="' + ICON_URL + '" alt="">',
    '    <span class="gs-modal-logo-text">GenShot TryOn</span>',
    '  </div>',
    '  <button class="gs-modal-close" aria-label="Close">&times;</button>',
    '</div>',
    '<div class="gs-modal-body">',

    // State: extracting
    '  <div class="gs-state gs-state-extracting">',
    '    <div class="gs-loading">',
    '      <div class="gs-spinner"></div>',
    '      <div class="gs-loading-text">Extracting product\u2026</div>',
    '    </div>',
    '  </div>',

    // State: ready (product preview + import button)
    '  <div class="gs-state gs-state-ready">',
    '    <div class="gs-product-card">',
    '      <div class="gs-product-img-wrap">',
    '        <img class="gs-product-img" src="" alt="Product">',
    '      </div>',
    '      <div class="gs-product-info">',
    '        <div class="gs-product-brand"></div>',
    '        <div class="gs-product-name"></div>',
    '        <div class="gs-product-meta">',
    '          <span class="gs-product-price"></span>',
    '          <span class="gs-product-color"></span>',
    '        </div>',
    '      </div>',
    '    </div>',
    '    <button class="gs-btn-primary gs-btn-import">',
    '      Import to GenShot',
    '    </button>',
    '  </div>',

    // State: creating (import in progress)
    '  <div class="gs-state gs-state-creating">',
    '    <div class="gs-loading">',
    '      <div class="gs-spinner"></div>',
    '      <div class="gs-loading-text">Creating import session\u2026</div>',
    '    </div>',
    '  </div>',

    // State: QR
    '  <div class="gs-state gs-state-qr">',
    '    <div class="gs-qr-section">',
    '      <div class="gs-qr-badge">\u2713 Session created</div>',
    '      <div class="gs-qr-frame">',
    '        <canvas class="gs-qr-canvas" width="400" height="400"></canvas>',
    '      </div>',
    '      <div class="gs-qr-instruction">',
    '        Scan with the <strong>GenShot</strong> app to try on this item',
    '      </div>',
    '    </div>',
    '  </div>',

    // State: error
    '  <div class="gs-state gs-state-error">',
    '    <div class="gs-error">',
    '      <div class="gs-error-icon">\u26A0</div>',
    '      <div class="gs-error-message">Something went wrong.</div>',
    '      <button class="gs-btn-secondary gs-btn-retry">Try Again</button>',
    '    </div>',
    '  </div>',

    '</div>',
  ].join("\n");
  shadow.appendChild(modal);

  // =========================================================================
  // DOM references inside shadow
  // =========================================================================

  var closeBtn     = shadow.querySelector(".gs-modal-close");
  var stateEls     = {
    extracting: shadow.querySelector(".gs-state-extracting"),
    ready:      shadow.querySelector(".gs-state-ready"),
    creating:   shadow.querySelector(".gs-state-creating"),
    qr:         shadow.querySelector(".gs-state-qr"),
    error:      shadow.querySelector(".gs-state-error"),
  };
  var productImg   = shadow.querySelector(".gs-product-img");
  var productBrand = shadow.querySelector(".gs-product-brand");
  var productName  = shadow.querySelector(".gs-product-name");
  var productPrice = shadow.querySelector(".gs-product-price");
  var productColor = shadow.querySelector(".gs-product-color");
  var btnImport    = shadow.querySelector(".gs-btn-import");
  var btnRetry     = shadow.querySelector(".gs-btn-retry");
  var qrCanvas     = shadow.querySelector(".gs-qr-canvas");
  var errorMsg     = shadow.querySelector(".gs-error-message");

  // =========================================================================
  // State helpers
  // =========================================================================

  var ImportStates = {
    idle: "idle",
    extracting: "extracting",
    importing: "importing",
    qr: "qr",
    error: "error",
  };

  var currentProduct = null;
  var importState = ImportStates.extracting;

  function hasValidProduct() {
    if (!currentProduct) return false;
    var hasName = typeof currentProduct.name === "string" && currentProduct.name.trim().length > 0;
    var hasImages = Array.isArray(currentProduct.images) && currentProduct.images.length > 0;
    return hasName || hasImages;
  }

  function syncImportButtonState() {
    btnImport.disabled = !(importState === ImportStates.idle && hasValidProduct());
  }

  function setImportState(nextState) {
    importState = nextState;
    syncImportButtonState();
  }

  function showState(name) {
    Object.keys(stateEls).forEach(function (k) {
      stateEls[k].classList.remove("gs-active");
    });
    if (stateEls[name]) stateEls[name].classList.add("gs-active");
  }

  function openModal() {
    backdrop.classList.add("gs-visible");
    modal.classList.add("gs-visible");
  }

  function closeModal() {
    backdrop.classList.remove("gs-visible");
    modal.classList.remove("gs-visible");
  }

  function showError(msg) {
    errorMsg.textContent = msg || "Something went wrong. Please try again.";
    setImportState(ImportStates.error);
    showState("error");
  }

  // =========================================================================
  // Product display
  // =========================================================================

  function displayProduct(product) {
    currentProduct = product;
    setImportState(ImportStates.idle);

    if (product.images && product.images.length > 0) {
      productImg.src = product.images[0];
      productImg.alt = product.name || "Product image";
      productImg.parentElement.style.display = "";
    } else {
      productImg.parentElement.style.display = "none";
    }

    productBrand.textContent = product.brand || "";
    productName.textContent  = product.name || "Unknown Product";
    productPrice.textContent = formatPrice(product.price, product.currency);

    if (product.color) {
      productColor.textContent = product.color;
      productColor.style.display = "";
    } else {
      productColor.style.display = "none";
    }

    showState("ready");
  }

  // =========================================================================
  // QR Code rendering
  // =========================================================================

  function renderQrCode(url) {
    if (typeof QRCode === "undefined") {
      showError("QR code library not loaded");
      return;
    }

    try {
      var qr = new QRCode(0, QRCode.ErrorCorrectLevel.M);
      qr.addData(url);
      qr.make();

      var moduleCount = qr.getModuleCount();
      var ctx = qrCanvas.getContext("2d");
      var quietZoneModules = 4;
      var totalModules = moduleCount + quietZoneModules * 2;
      var targetSize = 320;
      var modulePixelSize = Math.max(5, Math.floor(targetSize / totalModules));
      var qrSize = totalModules * modulePixelSize;
      var dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

      qrCanvas.width = qrSize * dpr;
      qrCanvas.height = qrSize * dpr;
      qrCanvas.style.width = qrSize + "px";
      qrCanvas.style.height = qrSize + "px";

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, qrSize, qrSize);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, qrSize, qrSize);
      ctx.fillStyle = "#000000";

      for (var row = 0; row < moduleCount; row++) {
        for (var col = 0; col < moduleCount; col++) {
          if (qr.isDark(row, col)) {
            var x = (quietZoneModules + col) * modulePixelSize;
            var y = (quietZoneModules + row) * modulePixelSize;
            ctx.fillRect(x, y, modulePixelSize, modulePixelSize);
          }
        }
      }

      setImportState(ImportStates.qr);
      showState("qr");
    } catch (err) {
      console.error("[GenShot TryOn] QR render error:", err);
      showError("Failed to generate QR code: " + err.message);
    }
  }

  function resolveQrPayload(data) {
    var sid = data && (data.sessionId || data.session_id || data.sid);
    var sig = data && (data.signature || data.sig || "");
    var compactPayload = data && (data.qr_payload || data.qrPayload);
    var legacyPayload = data && (data.qr_payload_legacy || data.qrPayloadLegacy);

    if (typeof compactPayload === "string" && compactPayload.indexOf("genshot-fit://import") === 0) {
      return compactPayload;
    }

    if (sid) {
      return "genshot-fit://import?sid=" + encodeURIComponent(sid) + "&v=2";
    }

    if (typeof legacyPayload === "string" && legacyPayload.indexOf("genshot-fit://import") === 0) {
      return legacyPayload;
    }

    if (sid && sig) {
      return "genshot-fit://import?sid=" + encodeURIComponent(sid) +
        "&sig=" + encodeURIComponent(sig);
    }

    return "";
  }

  // =========================================================================
  // Extraction
  // =========================================================================

  function extractAndShow() {
    openModal();
    setImportState(ImportStates.extracting);
    showState("extracting");

    // Small delay to let SPA content settle
    setTimeout(function () {
      try {
        var detected = detectExtractor();
        if (!detected) {
          showError("No product detected on this page");
          return;
        }

        var product = detected.extractor.extract();

        if (!product || (!product.name && !(product.images && product.images.length))) {
          showError("Could not extract product data");
          return;
        }

        product.source = detected.site;

        // Sort images
        if (typeof GenShotImageSelector !== "undefined" && product.images && product.images.length > 1) {
          product.images = GenShotImageSelector.selectBestProductImage(product.images, detected.site);
        }

        displayProduct(product);
      } catch (err) {
        console.error("[GenShot TryOn] Extraction error:", err);
        showError("Extraction failed: " + err.message);
      }
    }, 300);
  }

  // =========================================================================
  // Import session
  // =========================================================================

  function createImportSession() {
    if (!currentProduct) {
      setImportState(ImportStates.error);
      return;
    }

    setImportState(ImportStates.importing);
    showState("creating");

    var item = {
      name: currentProduct.name,
      brand: currentProduct.brand,
      category: currentProduct.category,
      price: currentProduct.price,
      currency: currentProduct.currency,
      color: currentProduct.color,
      material: currentProduct.material,
      sizes: currentProduct.sizes,
      images: currentProduct.images,
      productUrl: currentProduct.productUrl,
      sizeChart: currentProduct.sizeChart,
    };

    safeSendMessage(
      { type: "CREATE_IMPORT_SESSION", payload: { items: [item] } },
      function (response) {
        if (!response || !response.success) {
          var errText = (response && response.error) || "Failed to create import session";
          if (errText.indexOf("Failed to fetch") !== -1 || errText.indexOf("NetworkError") !== -1) {
            errText = "Cannot connect to GenShot server. Is the backend running?";
          }
          showError(errText);
          return;
        }

        var data = response.data;
        var qrUrl = resolveQrPayload(data);
        if (!qrUrl) {
          showError("Backend returned invalid session data");
          return;
        }
        renderQrCode(qrUrl);
      }
    );
  }

  // =========================================================================
  // Event listeners
  // =========================================================================

  fab.addEventListener("click", function () {
    currentProduct = null;
    extractAndShow();
  });

  closeBtn.addEventListener("click", closeModal);
  backdrop.addEventListener("click", closeModal);

  btnImport.addEventListener("click", function () {
    if (btnImport.disabled) return;
    try {
      if (!isContextValid()) {
        showError("Extension was reloaded. Please refresh the page and try again.");
        return;
      }
      createImportSession();
    } catch (err) {
      showError(
        err && typeof err.message === "string" && err.message.indexOf("Extension context invalidated") !== -1
          ? "Extension was reloaded. Please refresh the page and try again."
          : "Failed to start import. Please try again."
      );
    }
  });

  btnRetry.addEventListener("click", function () {
    extractAndShow();
  });

  // Close on Escape
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
  });

  // =========================================================================
  // FAB visibility: show only on product pages
  // =========================================================================

  function updateFabVisibility() {
    var detected = detectExtractor();
    if (detected) {
      fab.classList.remove("gs-hidden");
    } else {
      fab.classList.add("gs-hidden");
      closeModal();
    }
  }

  // Initial check
  syncImportButtonState();
  updateFabVisibility();

  // =========================================================================
  // SPA navigation handling
  // =========================================================================

  var lastHref = window.location.href;

  function onNavigate() {
    if (window.location.href === lastHref) return;
    lastHref = window.location.href;
    closeModal();
    currentProduct = null;
    // Delay to let new page content render
    setTimeout(updateFabVisibility, 1500);
  }

  // URL changes in SPAs: popstate + hashchange
  window.addEventListener("popstate", onNavigate);
  window.addEventListener("hashchange", onNavigate);

  // MutationObserver catches pushState-driven SPAs (Zara, H&M)
  var navObserver = new MutationObserver(function () {
    // Stop observing if extension context is invalidated
    if (!isContextValid()) {
      navObserver.disconnect();
      return;
    }
    if (window.location.href !== lastHref) {
      onNavigate();
    }
  });

  navObserver.observe(document.body, { childList: true, subtree: true });

  console.log("[GenShot TryOn] Embedded Try-On button injected");
})();
