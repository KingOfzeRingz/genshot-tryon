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
    '<svg class="gs-fab-icon" width="20" height="11" viewBox="0.39 14.63 62.34 35.14" fill="none"><path d="M17 49.768C13.448 49.768 10.424 48.984 7.928 47.416C5.464 45.816 3.592 43.688 2.312 41.032C1.032 38.376 0.392 35.416 0.392 32.152C0.392 29.752 0.744 27.496 1.448 25.384C2.184 23.24 3.256 21.368 4.664 19.768C6.072 18.168 7.8 16.92 9.848 16.024C11.928 15.096 14.312 14.632 17 14.632C21.512 14.632 25.032 15.832 27.56 18.232C30.12 20.6 31.656 23.8 32.168 27.832H25.688C25.528 26.744 25.24 25.752 24.824 24.856C24.44 23.928 23.896 23.128 23.192 22.456C22.52 21.752 21.672 21.208 20.648 20.824C19.656 20.44 18.44 20.248 17 20.248C14.664 20.248 12.728 20.824 11.192 21.976C9.688 23.096 8.568 24.568 7.832 26.392C7.128 28.184 6.776 30.104 6.776 32.152C6.776 34.232 7.128 36.184 7.832 38.008C8.568 39.832 9.688 41.32 11.192 42.472C12.728 43.592 14.664 44.152 17 44.152C18.632 44.152 20.04 43.912 21.224 43.432C22.408 42.952 23.368 42.28 24.104 41.416C24.872 40.552 25.4 39.544 25.688 38.392C26.008 37.208 26.104 35.912 25.976 34.504L28.184 36.088H17V30.712H32.312C32.6 34.872 32.168 38.376 31.016 41.224C29.864 44.04 28.104 46.168 25.736 47.608C23.368 49.048 20.456 49.768 17 49.768ZM42.0841 38.296C42.2121 39.512 42.6121 40.568 43.2841 41.464C43.9561 42.328 44.8361 43 45.9241 43.48C47.0441 43.928 48.2921 44.152 49.6681 44.152C51.6201 44.152 53.2201 43.8 54.4681 43.096C55.7161 42.392 56.3401 41.336 56.3401 39.928C56.3401 38.968 55.9721 38.216 55.2361 37.672C54.5001 37.096 53.5241 36.648 52.3081 36.328C51.0921 35.976 49.7641 35.64 48.3241 35.32C46.8841 35 45.4281 34.632 43.9561 34.216C42.5161 33.768 41.1881 33.176 39.9721 32.44C38.7561 31.672 37.7801 30.664 37.0441 29.416C36.3081 28.136 35.9401 26.504 35.9401 24.52C35.9401 22.632 36.5001 20.952 37.6201 19.48C38.7401 17.976 40.2921 16.792 42.2761 15.928C44.2921 15.064 46.5961 14.632 49.1881 14.632C51.6521 14.632 53.8601 15.128 55.8121 16.12C57.7961 17.112 59.3481 18.472 60.4681 20.2C61.6201 21.896 62.1961 23.848 62.1961 26.056H55.7641C55.6361 24.232 55.0121 22.808 53.8921 21.784C52.8041 20.76 51.1561 20.248 48.9481 20.248C46.8041 20.248 45.1561 20.648 44.0041 21.448C42.8841 22.248 42.3241 23.272 42.3241 24.52C42.3241 25.576 42.6921 26.408 43.4281 27.016C44.1641 27.624 45.1401 28.104 46.3561 28.456C47.5721 28.808 48.9001 29.128 50.3401 29.416C51.8121 29.704 53.2681 30.072 54.7081 30.52C56.1481 30.936 57.4761 31.512 58.6921 32.248C59.9081 32.952 60.8841 33.928 61.6201 35.176C62.3561 36.392 62.7241 37.976 62.7241 39.928C62.7241 43.032 61.5561 45.448 59.2201 47.176C56.8841 48.904 53.6041 49.768 49.3801 49.768C46.7881 49.768 44.4681 49.272 42.4201 48.28C40.3721 47.288 38.7401 45.928 37.5241 44.2C36.3081 42.472 35.6521 40.504 35.5561 38.296H42.0841Z" fill="white"/></svg>' +
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
    '    <svg class="gs-modal-logo-icon" width="32" height="18" viewBox="0.39 14.63 62.34 35.14" fill="none">',
    '      <path d="M17 49.768C13.448 49.768 10.424 48.984 7.928 47.416C5.464 45.816 3.592 43.688 2.312 41.032C1.032 38.376 0.392 35.416 0.392 32.152C0.392 29.752 0.744 27.496 1.448 25.384C2.184 23.24 3.256 21.368 4.664 19.768C6.072 18.168 7.8 16.92 9.848 16.024C11.928 15.096 14.312 14.632 17 14.632C21.512 14.632 25.032 15.832 27.56 18.232C30.12 20.6 31.656 23.8 32.168 27.832H25.688C25.528 26.744 25.24 25.752 24.824 24.856C24.44 23.928 23.896 23.128 23.192 22.456C22.52 21.752 21.672 21.208 20.648 20.824C19.656 20.44 18.44 20.248 17 20.248C14.664 20.248 12.728 20.824 11.192 21.976C9.688 23.096 8.568 24.568 7.832 26.392C7.128 28.184 6.776 30.104 6.776 32.152C6.776 34.232 7.128 36.184 7.832 38.008C8.568 39.832 9.688 41.32 11.192 42.472C12.728 43.592 14.664 44.152 17 44.152C18.632 44.152 20.04 43.912 21.224 43.432C22.408 42.952 23.368 42.28 24.104 41.416C24.872 40.552 25.4 39.544 25.688 38.392C26.008 37.208 26.104 35.912 25.976 34.504L28.184 36.088H17V30.712H32.312C32.6 34.872 32.168 38.376 31.016 41.224C29.864 44.04 28.104 46.168 25.736 47.608C23.368 49.048 20.456 49.768 17 49.768ZM42.0841 38.296C42.2121 39.512 42.6121 40.568 43.2841 41.464C43.9561 42.328 44.8361 43 45.9241 43.48C47.0441 43.928 48.2921 44.152 49.6681 44.152C51.6201 44.152 53.2201 43.8 54.4681 43.096C55.7161 42.392 56.3401 41.336 56.3401 39.928C56.3401 38.968 55.9721 38.216 55.2361 37.672C54.5001 37.096 53.5241 36.648 52.3081 36.328C51.0921 35.976 49.7641 35.64 48.3241 35.32C46.8841 35 45.4281 34.632 43.9561 34.216C42.5161 33.768 41.1881 33.176 39.9721 32.44C38.7561 31.672 37.7801 30.664 37.0441 29.416C36.3081 28.136 35.9401 26.504 35.9401 24.52C35.9401 22.632 36.5001 20.952 37.6201 19.48C38.7401 17.976 40.2921 16.792 42.2761 15.928C44.2921 15.064 46.5961 14.632 49.1881 14.632C51.6521 14.632 53.8601 15.128 55.8121 16.12C57.7961 17.112 59.3481 18.472 60.4681 20.2C61.6201 21.896 62.1961 23.848 62.1961 26.056H55.7641C55.6361 24.232 55.0121 22.808 53.8921 21.784C52.8041 20.76 51.1561 20.248 48.9481 20.248C46.8041 20.248 45.1561 20.648 44.0041 21.448C42.8841 22.248 42.3241 23.272 42.3241 24.52C42.3241 25.576 42.6921 26.408 43.4281 27.016C44.1641 27.624 45.1401 28.104 46.3561 28.456C47.5721 28.808 48.9001 29.128 50.3401 29.416C51.8121 29.704 53.2681 30.072 54.7081 30.52C56.1481 30.936 57.4761 31.512 58.6921 32.248C59.9081 32.952 60.8841 33.928 61.6201 35.176C62.3561 36.392 62.7241 37.976 62.7241 39.928C62.7241 43.032 61.5561 45.448 59.2201 47.176C56.8841 48.904 53.6041 49.768 49.3801 49.768C46.7881 49.768 44.4681 49.272 42.4201 48.28C40.3721 47.288 38.7401 45.928 37.5241 44.2C36.3081 42.472 35.6521 40.504 35.5561 38.296H42.0841Z" fill="currentColor"/>',
    '    </svg>',
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

    // State: Code
    '  <div class="gs-state gs-state-qr">',
    '    <div class="gs-code-section">',
    '      <div class="gs-code-badge">\u2713 Session created</div>',
    '      <div class="gs-code-digits"></div>',
    '      <div class="gs-code-countdown"></div>',
    '      <div class="gs-code-actions">',
    '        <button class="gs-btn-secondary gs-btn-copy-code">Copy Code</button>',
    '        <button class="gs-btn-secondary gs-btn-regenerate gs-hidden-el">New Code</button>',
    '      </div>',
    '      <div class="gs-code-instruction">',
    '        Enter this code in the <strong>GenShot</strong> app to import this item',
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
  var btnCopyCode  = shadow.querySelector(".gs-btn-copy-code");
  var btnRegenerate = shadow.querySelector(".gs-btn-regenerate");
  var overlayCodeDigits = shadow.querySelector(".gs-code-digits");
  var overlayCodeCountdown = shadow.querySelector(".gs-code-countdown");
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
  // Import Code display
  // =========================================================================

  var overlayCountdownInterval = null;
  var currentOverlayCode = null;

  function showOverlayCode(code, expiresAt) {
    currentOverlayCode = code;
    overlayCodeDigits.textContent = code;
    btnCopyCode.classList.remove("gs-hidden-el");
    btnRegenerate.classList.add("gs-hidden-el");
    overlayCodeDigits.classList.remove("gs-code-expired");
    overlayCodeCountdown.classList.remove("gs-code-expired");

    setImportState(ImportStates.qr);
    showState("qr");

    startOverlayCountdown(expiresAt);
  }

  function startOverlayCountdown(expiresAt) {
    if (overlayCountdownInterval) clearInterval(overlayCountdownInterval);

    var expiresMs = new Date(expiresAt).getTime();

    function tick() {
      var remaining = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
      var mins = Math.floor(remaining / 60);
      var secs = remaining % 60;
      overlayCodeCountdown.textContent = "Expires in " + mins + ":" + (secs < 10 ? "0" : "") + secs;

      if (remaining <= 0) {
        clearInterval(overlayCountdownInterval);
        overlayCountdownInterval = null;
        overlayCodeCountdown.textContent = "Code expired";
        overlayCodeCountdown.classList.add("gs-code-expired");
        overlayCodeDigits.classList.add("gs-code-expired");
        btnCopyCode.classList.add("gs-hidden-el");
        btnRegenerate.classList.remove("gs-hidden-el");
      }
    }

    tick();
    overlayCountdownInterval = setInterval(tick, 1000);
  }

  function copyOverlayCode() {
    if (!currentOverlayCode) return;
    navigator.clipboard.writeText(currentOverlayCode).then(function () {
      var original = btnCopyCode.textContent;
      btnCopyCode.textContent = "Copied!";
      setTimeout(function () { btnCopyCode.textContent = original; }, 1500);
    });
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
      name: (typeof currentProduct.name === "string" && currentProduct.name.trim()) ? currentProduct.name.trim() : "Unknown Item",
      brand: (typeof currentProduct.brand === "string") ? currentProduct.brand.trim() : "",
      category: (typeof currentProduct.category === "string" && currentProduct.category.trim()) ? currentProduct.category.trim() : "tshirt",
      price: Number.isFinite(Number(currentProduct.price)) ? Number(currentProduct.price) : null,
      currency: (typeof currentProduct.currency === "string" && currentProduct.currency.trim()) ? currentProduct.currency.trim() : "USD",
      color: (typeof currentProduct.color === "string") ? currentProduct.color.trim() : "",
      material: (typeof currentProduct.material === "string") ? currentProduct.material.trim() : "",
      sizes: Array.isArray(currentProduct.sizes) ? currentProduct.sizes : [],
      images: Array.isArray(currentProduct.images) ? currentProduct.images.filter(function (img) {
        return typeof img === "string" && img.trim();
      }) : [],
      productUrl: (typeof currentProduct.productUrl === "string") ? currentProduct.productUrl.trim() : "",
      sizeChart: Array.isArray(currentProduct.sizeChart) ? currentProduct.sizeChart : [],
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
        var code = data.import_code || data.importCode;
        var expiresAt = data.code_expires_at || data.codeExpiresAt;
        if (!code) {
          showError("Backend returned invalid session data");
          return;
        }
        showOverlayCode(code, expiresAt);
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

  btnCopyCode.addEventListener("click", function () {
    copyOverlayCode();
  });

  btnRegenerate.addEventListener("click", function () {
    overlayCodeDigits.classList.remove("gs-code-expired");
    overlayCodeCountdown.classList.remove("gs-code-expired");
    createImportSession();
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
