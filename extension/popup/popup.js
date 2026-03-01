/**
 * GenShot TryOn - Popup Script
 *
 * Controls the popup UI lifecycle:
 *   1. On open: request product extraction from the active tab
 *   2. Display product preview
 *   3. On import click: create import session via service worker
 *   4. On session created: render QR code
 *
 * States: loading -> product | no-product | error
 *         product -> importing -> qr | error
 */

(function () {
  "use strict";

  // =========================================================================
  // DOM References
  // =========================================================================

  const stateLoading = document.getElementById("state-loading");
  const stateNoProduct = document.getElementById("state-no-product");
  const stateProduct = document.getElementById("state-product");
  const stateImporting = document.getElementById("state-importing");
  const stateQr = document.getElementById("state-qr");
  const stateError = document.getElementById("state-error");

  const productImage = document.getElementById("product-image");
  const productBrand = document.getElementById("product-brand");
  const productName = document.getElementById("product-name");
  const productPrice = document.getElementById("product-price");
  const productColor = document.getElementById("product-color");
  const productSizes = document.getElementById("product-sizes");

  const btnImport = document.getElementById("btn-import");
  const btnRetry = document.getElementById("btn-retry");

  const qrCanvas = document.getElementById("qr-canvas");
  const errorMessage = document.getElementById("error-message");

  // =========================================================================
  // State Management
  // =========================================================================

  const allStates = [
    stateLoading,
    stateNoProduct,
    stateProduct,
    stateImporting,
    stateQr,
    stateError,
  ];

  const ImportStates = Object.freeze({
    idle: "idle",
    extracting: "extracting",
    importing: "importing",
    qr: "qr",
    error: "error",
  });

  let currentProduct = null;
  let importState = ImportStates.extracting;

  function hasValidProduct() {
    if (!currentProduct) return false;
    const hasName = typeof currentProduct.name === "string" && currentProduct.name.trim().length > 0;
    const hasImages = Array.isArray(currentProduct.images) && currentProduct.images.length > 0;
    return hasName || hasImages;
  }

  function syncImportButtonState() {
    btnImport.disabled = !(importState === ImportStates.idle && hasValidProduct());
  }

  function setImportState(nextState) {
    importState = nextState;
    syncImportButtonState();
  }

  function showState(stateEl) {
    allStates.forEach((s) => s.classList.add("hidden"));
    stateEl.classList.remove("hidden");
  }

  function showError(msg) {
    errorMessage.textContent = msg || "Something went wrong. Please try again.";
    setImportState(ImportStates.error);
    showState(stateError);
  }

  // =========================================================================
  // Currency Formatting
  // =========================================================================

  const currencySymbols = {
    USD: "$",
    EUR: "\u20AC",
    GBP: "\u00A3",
    SEK: "kr",
    RUB: "\u20BD",
    JPY: "\u00A5",
    CNY: "\u00A5",
    KRW: "\u20A9",
  };

  function formatPrice(price, currency) {
    if (price == null) return "";

    const symbol = currencySymbols[currency] || currency || "";
    const formatted = price.toFixed(2);

    // Some currencies put symbol after the number
    if (["SEK"].includes(currency)) {
      return `${formatted} ${symbol}`;
    }
    return `${symbol}${formatted}`;
  }

  // =========================================================================
  // Product Display
  // =========================================================================

  function displayProduct(product) {
    currentProduct = product;
    setImportState(ImportStates.idle);

    // Image
    if (product.images && product.images.length > 0) {
      productImage.src = product.images[0];
      productImage.alt = product.name || "Product image";
    } else {
      productImage.style.display = "none";
    }

    // Brand
    productBrand.textContent = product.brand || "";

    // Name
    productName.textContent = product.name || "Unknown Product";

    // Price
    productPrice.textContent = formatPrice(product.price, product.currency);

    // Color
    if (product.color) {
      productColor.textContent = product.color;
      productColor.style.display = "";
    } else {
      productColor.style.display = "none";
    }

    // Sizes
    productSizes.innerHTML = "";
    if (product.sizes && product.sizes.length > 0) {
      product.sizes.forEach((size) => {
        const tag = document.createElement("span");
        tag.className = `size-tag${size.available ? "" : " unavailable"}`;
        tag.textContent = size.label;
        productSizes.appendChild(tag);
      });
    }

    showState(stateProduct);
  }

  // =========================================================================
  // QR Code Rendering
  // =========================================================================

  function renderQrCode(url) {
    if (typeof QRCode === "undefined") {
      showError("QR code library not loaded");
      return;
    }

    try {
      // Our bundled generator targets EC level M; using L can yield invalid matrices.
      const errorCorrection = QRCode.ErrorCorrectLevel.M;
      const qr = new QRCode(0, errorCorrection);
      qr.addData(url);
      qr.make();

      const moduleCount = qr.getModuleCount();
      const canvas = qrCanvas;
      const ctx = canvas.getContext("2d");
      const quietZoneModules = 4;
      const totalModules = moduleCount + quietZoneModules * 2;
      const targetSize = 420;
      const visibleStateWidth = stateImporting?.clientWidth || stateProduct?.clientWidth || stateNoProduct?.clientWidth || 0;
      const popupStateWidth = Math.floor(visibleStateWidth > 0 ? visibleStateWidth : (document.body.clientWidth - 40));
      const framePadding = 28; // .qr-frame horizontal padding (14 + 14)
      const maxDrawableSize = Math.max(200, popupStateWidth - framePadding);
      const effectiveTarget = Math.min(targetSize, maxDrawableSize);
      const modulePixelSize = Math.max(5, Math.floor(effectiveTarget / totalModules));
      const qrSize = totalModules * modulePixelSize;
      const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

      canvas.width = qrSize * dpr;
      canvas.height = qrSize * dpr;
      canvas.style.width = `${qrSize}px`;
      canvas.style.height = `${qrSize}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, qrSize, qrSize);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, qrSize, qrSize);

      ctx.fillStyle = "#000000";
      for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
          if (qr.isDark(row, col)) {
            const x = (quietZoneModules + col) * modulePixelSize;
            const y = (quietZoneModules + row) * modulePixelSize;
            ctx.fillRect(x, y, modulePixelSize, modulePixelSize);
          }
        }
      }

      const frame = canvas.closest(".qr-frame");
      if (frame) {
        frame.style.width = `${qrSize + framePadding}px`;
        frame.style.maxWidth = "100%";
      }

      showState(stateQr);
      setImportState(ImportStates.qr);
    } catch (err) {
      console.error("[GenShot TryOn] QR render error:", err);
      showError("Failed to generate QR code: " + err.message);
    }
  }

  function normalizeQrValue(value) {
    if (value == null) return "";
    return String(value).trim();
  }

  function getQrDebugPayload() {
    try {
      return normalizeQrValue(localStorage.getItem("genshot.tryon.qrTestPayload"));
    } catch {
      return "";
    }
  }

  function buildScannerPayload(sid) {
    if (!sid) return "";
    // Compact app-scanner token (shorter than deep links, lower QR density).
    return `GS2:${sid}`;
  }

  function resolveQrPayload(data) {
    const sid = normalizeQrValue(data?.sessionId || data?.session_id || data?.sid);
    const compactPayload = normalizeQrValue(data?.qr_payload || data?.qrPayload);
    const legacyPayload = normalizeQrValue(data?.qr_payload_legacy || data?.qrPayloadLegacy);

    if (sid) return buildScannerPayload(sid);

    if (compactPayload) return compactPayload;
    if (legacyPayload) return legacyPayload;

    return sid;
  }

  // =========================================================================
  // Product Extraction
  // =========================================================================

  async function extractProduct() {
    setImportState(ImportStates.extracting);
    showState(stateLoading);

    try {
      // Get the currently active tab
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab) {
        showState(stateNoProduct);
        return;
      }

      // Check if we have a cached product in session storage
      const cacheKey = `product_${tab.id}`;
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        try {
          const cachedData = JSON.parse(cached);
          if (cachedData.productUrl === tab.url) {
            displayProduct(cachedData);
            return;
          }
        } catch {
          // Invalid cache, ignore
        }
      }

      // Send extraction request through the service worker
      const response = await chrome.runtime.sendMessage({
        type: "EXTRACT_PRODUCT",
        payload: { tabId: tab.id },
      });

      if (response?.success && response.data?.success && response.data.data) {
        const product = response.data.data;
        // Cache for this session
        sessionStorage.setItem(cacheKey, JSON.stringify(product));
        displayProduct(product);
      } else if (response?.success && response.data?.data) {
        // Direct content script response format
        const product = response.data.data;
        sessionStorage.setItem(cacheKey, JSON.stringify(product));
        displayProduct(product);
      } else {
        const errorMsg =
          response?.error ||
          response?.data?.error ||
          "No product detected on this page";
        console.warn("[GenShot TryOn]", errorMsg);
        showState(stateNoProduct);
      }
    } catch (err) {
      console.error("[GenShot TryOn] Extraction error:", err);

      // If content script is not injected, show a helpful message
      if (err.message?.includes("Receiving end does not exist") ||
          err.message?.includes("Could not establish connection")) {
        showState(stateNoProduct);
      } else {
        showError(err.message);
      }
    }
  }

  // =========================================================================
  // Import Session Creation
  // =========================================================================

  async function createImportSession() {
    if (!currentProduct) {
      setImportState(ImportStates.error);
      return;
    }

    setImportState(ImportStates.importing);
    showState(stateImporting);

    try {
      // Prepare the item payload
      const item = {
        name: typeof currentProduct.name === "string" && currentProduct.name.trim() ? currentProduct.name.trim() : "Unknown Item",
        brand: typeof currentProduct.brand === "string" ? currentProduct.brand.trim() : "",
        category: typeof currentProduct.category === "string" && currentProduct.category.trim() ? currentProduct.category.trim() : "top",
        price: Number.isFinite(Number(currentProduct.price)) ? Number(currentProduct.price) : null,
        currency: typeof currentProduct.currency === "string" && currentProduct.currency.trim() ? currentProduct.currency.trim() : "USD",
        color: typeof currentProduct.color === "string" ? currentProduct.color.trim() : "",
        material: typeof currentProduct.material === "string" ? currentProduct.material.trim() : "",
        sizes: Array.isArray(currentProduct.sizes) ? currentProduct.sizes : [],
        images: Array.isArray(currentProduct.images) ? currentProduct.images.filter((img) => typeof img === "string" && img.trim()) : [],
        productUrl: typeof currentProduct.productUrl === "string" ? currentProduct.productUrl.trim() : "",
        sizeChart: Array.isArray(currentProduct.sizeChart) ? currentProduct.sizeChart : [],
      };

      // Send to service worker to create the import session
      const response = await chrome.runtime.sendMessage({
        type: "CREATE_IMPORT_SESSION",
        payload: { items: [item] },
      });

      if (response?.success && response.data) {
        const debugPayload = getQrDebugPayload();
        const qrUrl = debugPayload || resolveQrPayload(response.data);
        if (!qrUrl) {
          showError("Backend returned invalid session data");
          return;
        }
        if (debugPayload) {
          console.info("[GenShot TryOn] QR test payload override active:", debugPayload);
        }
        renderQrCode(qrUrl);
      } else {
        showError(response?.error || "Failed to create import session");
      }
    } catch (err) {
      console.error("[GenShot TryOn] Import error:", err);
      showError(
        err.message?.includes("Failed to fetch") || err.message?.includes("NetworkError")
          ? "Cannot connect to the GenShot server. Make sure the backend is running."
          : err.message
      );
    }
  }

  // =========================================================================
  // Event Listeners
  // =========================================================================

  btnImport.addEventListener("click", () => {
    if (btnImport.disabled) return;
    createImportSession();
  });

  btnRetry.addEventListener("click", () => {
    extractProduct();
  });

  // =========================================================================
  // Initialize
  // =========================================================================

  syncImportButtonState();
  extractProduct();
})();
