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
   * Parse a price string, handling US (1,299.99) and EU (1.299,99) formats.
   */
  function parsePriceText(text) {
    // Match price-like numbers: 1,299.99 | 1.299,99 | 29.99 | 29,99 | 1299
    const match = text.match(
      /\d{1,3}(?:[.,]\d{3})*[.,]\d{1,2}|\d+[.,]\d{1,2}|\d+/
    );
    if (!match) return null;
    let num = match[0];
    // EU thousands (1.234,56) — period groups, comma decimal
    if (/\.\d{3}/.test(num) && num.includes(",")) {
      num = num.replace(/\./g, "").replace(",", ".");
    }
    // Simple comma-as-decimal (29,99)
    else if (/^\d+,\d{1,2}$/.test(num)) {
      num = num.replace(",", ".");
    }
    // US thousands (1,299.99) or clean (29.99)
    else {
      num = num.replace(/,/g, "");
    }
    const val = parseFloat(num);
    return isNaN(val) ? null : val;
  }

  /**
   * Detect currency from a text string containing a price.
   */
  function detectCurrency(text) {
    if (text.includes("$")) return "USD";
    if (text.includes("\u20AC")) return "EUR";
    if (text.includes("\u00A3")) return "GBP";
    if (text.includes("\u20BD")) return "RUB";
    if (/\bkr\b/i.test(text)) return "SEK";
    if (text.includes("\u00A5")) return "JPY";
    if (text.includes("\u20A9")) return "KRW";
    // Try HTML lang for additional hints
    const lang = document.documentElement.lang || "";
    if (lang.startsWith("de") || lang.startsWith("fr") || lang.startsWith("it")) return "EUR";
    if (lang.startsWith("ja")) return "JPY";
    return null;
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

    // Try DOM selectors — prefer "current" / "sale" price over original
    const priceSelectors = [
      '[class*="price__amount"] [class*="current"]',
      '.price__amount--current',
      '[class*="product-price"] [class*="current"]',
      '[class*="price"] [class*="sale"]',
      '[data-qa="product-price"]',
      '.money-amount__main',
      '[class*="price"] [class*="amount"]',
      '[class*="product-detail"] [class*="price"]',
    ];

    for (const selector of priceSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent.trim();
        const parsed = parsePriceText(text);
        if (parsed !== null) {
          result.price = parsed;
          result.currency = detectCurrency(text);
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
  /**
   * Pick the largest image from a srcset string.
   */
  function bestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null;
    let bestW = 0;
    srcset.split(",").forEach((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      const descriptor = parts[1] || "";
      const w = parseInt(descriptor, 10) || 0;
      if (!best || w > bestW) {
        best = url;
        bestW = w;
      }
    });
    return best;
  }

  /**
   * Normalize an image URL to absolute and upgrade to a higher resolution.
   */
  function normalizeImageUrl(src) {
    if (!src || src.includes("data:image") || src.includes("placeholder")) return null;
    if (src.startsWith("//")) src = "https:" + src;
    else if (src.startsWith("/")) src = window.location.origin + src;
    // Upgrade Zara CDN to larger width if it has a w= param
    src = src.replace(/([?&])w=\d+/, "$1w=1920");
    return src;
  }

  function extractImages() {
    const images = new Set();

    // Try gallery/carousel images — collect from ALL matching selectors
    const imgSelectors = [
      '.media-image img',
      '.product-detail-images img',
      '[class*="product-media"] img',
      '[class*="gallery"] img',
      'picture source[type="image/jpeg"]',
      'picture source[type="image/webp"]',
      'picture img',
      '.product-detail-view img[src*="static.zara.net"]',
      'img[src*="static.zara.net"]',
    ];

    for (const selector of imgSelectors) {
      document.querySelectorAll(selector).forEach((el) => {
        let src;
        if (el.tagName === "SOURCE") {
          // Pick the largest from srcset
          src = bestFromSrcset(el.getAttribute("srcset"));
        } else {
          // Prefer srcset > data-srcset > src > data-src
          src = bestFromSrcset(el.getAttribute("srcset"))
            || bestFromSrcset(el.getAttribute("data-srcset"))
            || el.getAttribute("src")
            || el.getAttribute("data-src");
        }
        src = normalizeImageUrl(src);
        if (src) images.add(src);
      });
    }

    // Fallback: OG image
    if (images.size === 0) {
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) {
        const src = normalizeImageUrl(ogImage.getAttribute("content"));
        if (src) images.add(src);
      }
    }

    // Deduplicate by base path (same image at different widths)
    return deduplicateByBase([...images]);
  }

  /**
   * Remove duplicate images that differ only in size params.
   */
  function deduplicateByBase(urls) {
    const seen = new Map();
    for (const url of urls) {
      // Strip common size query params for comparison
      const base = url.replace(/[?&](w|width|h|height|size|quality)=[^&]*/g, "").replace(/\?$/, "");
      if (!seen.has(base)) {
        seen.set(base, url);
      }
    }
    return [...seen.values()];
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
   * Try to map a text string to one of: tshirt, pants, jacket, sneakers.
   * Returns null if no confident match.
   */
  function normalizeCategory(raw) {
    if (!raw) return null;
    const s = raw.toLowerCase();
    if (/\b(jacket|coat|blazer|parka|puffer|anorak|outerwear|overcoat|trench|windbreaker|gilet|vest(?:e)?|cape|poncho)\b/.test(s)) return "jacket";
    if (/\b(trouser|pant|jean|skirt|short(?!s?\s*sleeve)|legging|bottom|chino|jogger|cargo|culottes|bermuda)\b/.test(s)) return "pants";
    if (/\b(shoe|boot|sandal|sneaker|trainer|loafer|heel|slipper|mule|clog|footwear|espadrille|oxford|derby|pump)\b/.test(s)) return "sneakers";
    if (/\b(shirt|blouse|top|dress|knit|sweater|cardigan|hoodie|sweatshirt|t-shirt|tee|polo|crop|tunic|camisole|bodysuit|jumpsuit|romper|pullover|jersey|henley|tank)\b/.test(s)) return "tshirt";
    return null;
  }

  /**
   * Infer category from breadcrumbs, product name, and URL path.
   */
  function extractCategory() {
    // 1. Try breadcrumbs
    const breadcrumbSelectors = [
      '[class*="breadcrumb"] a',
      '[class*="product-path"] a',
      'nav[aria-label="breadcrumb"] a',
    ];

    for (const selector of breadcrumbSelectors) {
      const links = document.querySelectorAll(selector);
      if (links.length > 1) {
        const text = links[links.length - 1]?.textContent.trim();
        const cat = normalizeCategory(text);
        if (cat) return cat;
      }
    }

    // 2. Try product name
    const name = extractName();
    const fromName = normalizeCategory(name);
    if (fromName) return fromName;

    // 3. Try URL path
    const fromUrl = normalizeCategory(window.location.pathname);
    if (fromUrl) return fromUrl;

    return "tshirt";
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
