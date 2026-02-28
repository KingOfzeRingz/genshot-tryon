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

  let currentProduct = null;

  function showState(stateEl) {
    allStates.forEach((s) => s.classList.add("hidden"));
    stateEl.classList.remove("hidden");
  }

  function showError(msg) {
    errorMessage.textContent = msg || "Something went wrong. Please try again.";
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
      // Determine error correction level and version based on data length
      const errorCorrection = QRCode.ErrorCorrectLevel.M;
      const qr = new QRCode(0, errorCorrection);
      qr.addData(url);
      qr.make();

      const moduleCount = qr.getModuleCount();
      const canvas = qrCanvas;
      const ctx = canvas.getContext("2d");

      // Set canvas resolution for crisp rendering
      const displaySize = 200;
      const scale = 2; // 2x for retina
      canvas.width = displaySize * scale;
      canvas.height = displaySize * scale;
      canvas.style.width = displaySize + "px";
      canvas.style.height = displaySize + "px";
      ctx.scale(scale, scale);

      const padding = 12;
      const cellSize = (displaySize - padding * 2) / moduleCount;

      // White background
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, displaySize, displaySize);

      // Draw QR modules
      ctx.fillStyle = "#2D3748";
      for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
          if (qr.isDark(row, col)) {
            const x = padding + col * cellSize;
            const y = padding + row * cellSize;
            // Slightly rounded squares for a modern look
            const radius = cellSize * 0.15;
            roundRect(ctx, x, y, cellSize, cellSize, radius);
            ctx.fill();
          }
        }
      }

      showState(stateQr);
    } catch (err) {
      console.error("[GenShot TryOn] QR render error:", err);
      showError("Failed to generate QR code: " + err.message);
    }
  }

  /**
   * Draw a rounded rectangle path.
   */
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

  // =========================================================================
  // Product Extraction
  // =========================================================================

  async function extractProduct() {
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
    if (!currentProduct) return;

    showState(stateImporting);

    try {
      // Prepare the item payload
      const item = {
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

      // Send to service worker to create the import session
      const response = await chrome.runtime.sendMessage({
        type: "CREATE_IMPORT_SESSION",
        payload: { items: [item] },
      });

      if (response?.success && response.data) {
        const { sessionId, signature, sid, sig, session_id, qr_payload } = response.data;

        // Support different backend response formats (camelCase and snake_case)
        const finalSid = sessionId || session_id || sid;
        const finalSig = signature || sig;

        if (!finalSid) {
          showError("Backend returned invalid session data");
          return;
        }

        // Build the deep link URL for the QR code
        const qrUrl = `genshot-fit://import?sid=${encodeURIComponent(finalSid)}&sig=${encodeURIComponent(finalSig || "")}`;
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
    btnImport.disabled = true;
    createImportSession().finally(() => {
      btnImport.disabled = false;
    });
  });

  btnRetry.addEventListener("click", () => {
    extractProduct();
  });

  // =========================================================================
  // Initialize
  // =========================================================================

  extractProduct();
})();
