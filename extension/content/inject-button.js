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
  // Constants
  // =========================================================================
  var ICON_URL = chrome.runtime.getURL("icons/icon48.png");

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
    '      <canvas class="gs-qr-canvas" width="400" height="400"></canvas>',
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

  var currentProduct = null;

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
    showState("error");
  }

  // =========================================================================
  // Product display
  // =========================================================================

  function displayProduct(product) {
    currentProduct = product;

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
  // QR Code rendering (mirrors popup.js logic)
  // =========================================================================

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

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

      var displaySize = 200;
      var scale = 2;
      qrCanvas.width = displaySize * scale;
      qrCanvas.height = displaySize * scale;
      qrCanvas.style.width = displaySize + "px";
      qrCanvas.style.height = displaySize + "px";
      ctx.scale(scale, scale);

      var padding = 12;
      var cellSize = (displaySize - padding * 2) / moduleCount;

      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, displaySize, displaySize);

      ctx.fillStyle = "#2D3748";
      for (var row = 0; row < moduleCount; row++) {
        for (var col = 0; col < moduleCount; col++) {
          if (qr.isDark(row, col)) {
            var x = padding + col * cellSize;
            var y = padding + row * cellSize;
            var radius = cellSize * 0.15;
            roundRect(ctx, x, y, cellSize, cellSize, radius);
            ctx.fill();
          }
        }
      }

      showState("qr");
    } catch (err) {
      console.error("[GenShot TryOn] QR render error:", err);
      showError("Failed to generate QR code: " + err.message);
    }
  }

  // =========================================================================
  // Extraction
  // =========================================================================

  function extractAndShow() {
    openModal();
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
    if (!currentProduct) return;

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

    chrome.runtime.sendMessage(
      { type: "CREATE_IMPORT_SESSION", payload: { items: [item] } },
      function (response) {
        if (chrome.runtime.lastError) {
          showError("Extension error: " + chrome.runtime.lastError.message);
          return;
        }

        if (response && response.success && response.data) {
          var data = response.data;
          var sid = data.sessionId || data.session_id || data.sid;
          var sig = data.signature || data.sig || "";

          if (!sid) {
            showError("Backend returned invalid session data");
            return;
          }

          var qrUrl = "genshot-fit://import?sid=" + encodeURIComponent(sid) +
                      "&sig=" + encodeURIComponent(sig);
          renderQrCode(qrUrl);
        } else {
          var errText = (response && response.error) || "Failed to create import session";
          if (errText.indexOf("Failed to fetch") !== -1 || errText.indexOf("NetworkError") !== -1) {
            errText = "Cannot connect to GenShot server. Is the backend running?";
          }
          showError(errText);
        }
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
    btnImport.disabled = true;
    createImportSession();
    // Re-enable after a delay in case user closes and retries
    setTimeout(function () { btnImport.disabled = false; }, 3000);
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
    if (window.location.href !== lastHref) {
      onNavigate();
    }
  });

  navObserver.observe(document.body, { childList: true, subtree: true });

  console.log("[GenShot TryOn] Embedded Try-On button injected");
})();
