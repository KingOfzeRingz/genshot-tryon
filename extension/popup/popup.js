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

  const codeDigits = document.getElementById("code-digits");
  const codeCountdown = document.getElementById("code-countdown");
  const btnCopyCode = document.getElementById("btn-copy-code");
  const btnRegenerate = document.getElementById("btn-regenerate");
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
  // Import Code Display
  // =========================================================================

  let countdownInterval = null;
  let currentImportCode = null;

  function showCode(code, expiresAt) {
    currentImportCode = code;
    codeDigits.textContent = code;
    btnCopyCode.classList.remove("hidden");
    btnRegenerate.classList.add("hidden");

    showState(stateQr);
    setImportState(ImportStates.qr);

    startCountdown(expiresAt);
  }

  function startCountdown(expiresAt) {
    if (countdownInterval) clearInterval(countdownInterval);

    const expiresMs = new Date(expiresAt).getTime();

    function tick() {
      const remaining = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      codeCountdown.textContent = `Expires in ${mins}:${secs.toString().padStart(2, "0")}`;

      if (remaining <= 0) {
        clearInterval(countdownInterval);
        countdownInterval = null;
        codeCountdown.textContent = "Code expired";
        codeCountdown.classList.add("code-expired");
        codeDigits.classList.add("code-expired");
        btnCopyCode.classList.add("hidden");
        btnRegenerate.classList.remove("hidden");
      }
    }

    tick();
    countdownInterval = setInterval(tick, 1000);
  }

  function copyCode() {
    if (!currentImportCode) return;
    navigator.clipboard.writeText(currentImportCode).then(() => {
      const original = btnCopyCode.textContent;
      btnCopyCode.textContent = "Copied!";
      setTimeout(() => { btnCopyCode.textContent = original; }, 1500);
    });
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
        category: typeof currentProduct.category === "string" && currentProduct.category.trim() ? currentProduct.category.trim() : "tshirt",
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
        const code = response.data.import_code || response.data.importCode;
        const expiresAt = response.data.code_expires_at || response.data.codeExpiresAt;
        if (!code) {
          showError("Backend returned invalid session data");
          return;
        }
        showCode(code, expiresAt);
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

  btnCopyCode.addEventListener("click", () => {
    copyCode();
  });

  btnRegenerate.addEventListener("click", () => {
    codeDigits.classList.remove("code-expired");
    codeCountdown.classList.remove("code-expired");
    createImportSession();
  });

  // =========================================================================
  // Initialize
  // =========================================================================

  syncImportButtonState();
  extractProduct();
})();
