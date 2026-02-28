/**
 * GenShot TryOn - Zara Product Extractor
 *
 * Extracts product data from Zara product pages.
 * Uses CSS selectors and DOM traversal, designed to be resilient
 * to minor DOM changes by trying multiple selector strategies.
 */

// eslint-disable-next-line no-var
var ZaraExtractor = (function () {
  /**
   * Check if the current page is a Zara product page.
   */
  function canHandle() {
    const host = window.location.hostname;
    if (!host.includes("zara.com")) return false;

    // Zara product pages typically have /p/ or product detail indicators
    const path = window.location.pathname;
    return (
      path.includes("/p") ||
      !!document.querySelector('[data-productid]') ||
      !!document.querySelector('.product-detail-view')
    );
  }

  /**
   * Extract the product name.
   */
  function extractName() {
    // Try multiple selectors in order of specificity
    const selectors = [
      'h1.product-detail-info__header-name',
      'h1[class*="product-detail"] [class*="name"]',
      '.product-detail-info__name',
      '[class*="product-name"]',
      'h1',
      'meta[property="og:title"]',
    ];

    for (const selector of selectors) {
      if (selector.startsWith("meta")) {
        const el = document.querySelector(selector);
        if (el) return el.getAttribute("content")?.trim();
      } else {
        const el = document.querySelector(selector);
        if (el && el.textContent.trim()) {
          return el.textContent.trim();
        }
      }
    }

    return null;
  }

  /**
   * Extract the price and currency.
   */
  function extractPrice() {
    const result = { price: null, currency: null };

    // Try structured data first
    const ldJson = extractJsonLd();
    if (ldJson?.offers) {
      const offer = Array.isArray(ldJson.offers)
        ? ldJson.offers[0]
        : ldJson.offers;
      if (offer.price) {
        result.price = parseFloat(offer.price);
        result.currency = offer.priceCurrency || null;
        return result;
      }
    }

    // Try DOM selectors
    const priceSelectors = [
      '[class*="price__amount"] [class*="current"]',
      '.price__amount--current',
      '[class*="product-price"] [class*="current"]',
      '[data-qa="product-price"]',
      '.money-amount__main',
      '[class*="price"] [class*="amount"]',
      '[class*="product-detail"] [class*="price"]',
    ];

    for (const selector of priceSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent.trim();
        const match = text.match(/[\d]+[.,]?\d*/);
        if (match) {
          result.price = parseFloat(match[0].replace(",", "."));
          // Try to detect currency
          if (text.includes("$")) result.currency = "USD";
          else if (text.includes("\u20AC")) result.currency = "EUR";
          else if (text.includes("\u00A3")) result.currency = "GBP";
          else if (text.includes("\u20BD")) result.currency = "RUB";
          return result;
        }
      }
    }

    // Try meta tag
    const priceMeta = document.querySelector('meta[property="product:price:amount"]');
    if (priceMeta) {
      result.price = parseFloat(priceMeta.getAttribute("content"));
      const currMeta = document.querySelector('meta[property="product:price:currency"]');
      if (currMeta) result.currency = currMeta.getAttribute("content");
      return result;
    }

    return result;
  }

  /**
   * Extract product images from the gallery.
   */
  function extractImages() {
    const images = new Set();

    // Try gallery/carousel images
    const imgSelectors = [
      '.media-image img',
      '.product-detail-images img',
      '[class*="product-media"] img',
      '[class*="gallery"] img',
      'picture source[type="image/jpeg"]',
      'picture img',
      '.product-detail-view img[src*="static.zara.net"]',
    ];

    for (const selector of imgSelectors) {
      document.querySelectorAll(selector).forEach((el) => {
        let src;
        if (el.tagName === "SOURCE") {
          src = el.getAttribute("srcset")?.split(",")[0]?.trim()?.split(" ")[0];
        } else {
          src = el.getAttribute("src") || el.getAttribute("data-src");
        }
        if (src && !src.includes("data:image") && !src.includes("placeholder")) {
          // Normalize to full URL
          if (src.startsWith("//")) src = "https:" + src;
          else if (src.startsWith("/")) src = window.location.origin + src;
          images.add(src);
        }
      });
      if (images.size > 0) break;
    }

    // Fallback: OG image
    if (images.size === 0) {
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) {
        const src = ogImage.getAttribute("content");
        if (src) images.add(src);
      }
    }

    return [...images];
  }

  /**
   * Extract color information.
   */
  function extractColor() {
    const selectors = [
      '[class*="product-color"] [class*="name"]',
      '[class*="product-detail-color"]',
      '[class*="color-name"]',
      '[data-qa="product-color"]',
      '.product-detail-info__color',
      '[class*="selected-color"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent.trim()) {
        // Clean up: remove "Color:" prefix if present
        return el.textContent.trim().replace(/^colou?r\s*:\s*/i, "");
      }
    }

    return null;
  }

  /**
   * Extract material/composition information.
   */
  function extractMaterial() {
    const selectors = [
      '[class*="composition"]',
      '[class*="material"]',
      '[class*="product-detail-extra-detail"] li',
      '[class*="care-detail"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent.trim()) {
        const text = el.textContent.trim();
        // Look for material-like patterns
        if (text.match(/\d+%|cotton|polyester|wool|silk|linen|nylon|viscose/i)) {
          return text;
        }
      }
    }

    return null;
  }

  /**
   * Extract available sizes.
   */
  function extractSizes() {
    const sizes = [];

    const sizeSelectors = [
      '[class*="size-selector"] [class*="size-list"] li',
      '[class*="size-selector__list"] li',
      '[class*="product-size"] li',
      '[data-qa="size-selector"] li',
      '[class*="size-list"] button',
      '[class*="size-selector"] button',
    ];

    for (const selector of sizeSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        elements.forEach((el) => {
          const label =
            el.getAttribute("data-size") ||
            el.getAttribute("aria-label") ||
            el.textContent.trim();

          if (label) {
            const isDisabled =
              el.classList.contains("disabled") ||
              el.classList.contains("size--not-available") ||
              el.getAttribute("aria-disabled") === "true" ||
              el.querySelector('[class*="crossed"]') !== null;

            sizes.push({
              label: label.replace(/\s+/g, " ").trim(),
              available: !isDisabled,
            });
          }
        });
        break;
      }
    }

    return sizes;
  }

  /**
   * Try to extract size chart / measurement data.
   */
  function extractSizeChart() {
    const sizeChart = [];

    // Look for a measurements table
    const tableSelectors = [
      '[class*="size-guide"] table',
      '[class*="size-chart"] table',
      '[class*="measurement"] table',
      '.product-detail-size-guide table',
    ];

    for (const selector of tableSelectors) {
      const table = document.querySelector(selector);
      if (!table) continue;

      const headers = [];
      table.querySelectorAll("thead th, tr:first-child th, tr:first-child td").forEach((th) => {
        headers.push(th.textContent.trim());
      });

      if (headers.length === 0) continue;

      const rows = table.querySelectorAll("tbody tr, tr:not(:first-child)");
      rows.forEach((row) => {
        const cells = row.querySelectorAll("td, th");
        if (cells.length === 0) return;

        const sizeName = cells[0]?.textContent.trim();
        const measurements = {};

        for (let i = 1; i < cells.length && i < headers.length; i++) {
          measurements[headers[i]] = cells[i]?.textContent.trim();
        }

        if (sizeName) {
          sizeChart.push({ size: sizeName, measurements });
        }
      });

      if (sizeChart.length > 0) break;
    }

    return sizeChart;
  }

  /**
   * Infer category from breadcrumb or URL path.
   */
  function extractCategory() {
    // Try breadcrumbs
    const breadcrumbSelectors = [
      '[class*="breadcrumb"] a',
      '[class*="product-path"] a',
      'nav[aria-label="breadcrumb"] a',
    ];

    for (const selector of breadcrumbSelectors) {
      const links = document.querySelectorAll(selector);
      if (links.length > 1) {
        // Take the second-to-last breadcrumb as category
        const category = links[links.length - 1]?.textContent.trim();
        if (category) return category;
      }
    }

    // Infer from URL
    const path = window.location.pathname.toLowerCase();
    const categoryPatterns = [
      { pattern: /dress/i, category: "Dresses" },
      { pattern: /shirt|blouse/i, category: "Tops" },
      { pattern: /trouser|pant|jean/i, category: "Bottoms" },
      { pattern: /jacket|coat|blazer/i, category: "Outerwear" },
      { pattern: /skirt/i, category: "Skirts" },
      { pattern: /shoe|boot|sandal|sneaker/i, category: "Shoes" },
      { pattern: /bag|purse/i, category: "Bags" },
      { pattern: /knit|sweater|cardigan/i, category: "Knitwear" },
      { pattern: /t-shirt|tee/i, category: "T-Shirts" },
    ];

    for (const { pattern, category } of categoryPatterns) {
      if (pattern.test(path)) return category;
    }

    return "Clothing";
  }

  /**
   * Try to extract JSON-LD structured data from the page.
   */
  function extractJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data["@type"] === "Product") return data;
        // Sometimes it's in an array
        if (Array.isArray(data)) {
          const product = data.find((d) => d["@type"] === "Product");
          if (product) return product;
        }
        // Sometimes nested in @graph
        if (data["@graph"]) {
          const product = data["@graph"].find((d) => d["@type"] === "Product");
          if (product) return product;
        }
      } catch {
        // Invalid JSON, skip
      }
    }
    return null;
  }

  /**
   * Main extraction function. Returns structured product data.
   */
  function extract() {
    const { price, currency } = extractPrice();

    return {
      name: extractName(),
      brand: "Zara",
      category: extractCategory(),
      price,
      currency,
      color: extractColor(),
      material: extractMaterial(),
      sizes: extractSizes(),
      images: extractImages(),
      productUrl: window.location.href,
      sizeChart: extractSizeChart(),
      extractedAt: new Date().toISOString(),
      extractorVersion: "1.0.0",
      confidence: "high",
    };
  }

  return {
    canHandle,
    extract,
  };
})();
