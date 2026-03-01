/**
 * GenShot TryOn - H&M Product Extractor
 *
 * Extracts product data from H&M product pages.
 * Prioritizes JSON-LD structured data (H&M often provides it),
 * with DOM scraping as fallback.
 */

// eslint-disable-next-line no-var
var HMExtractor = (function () {
  /**
   * Check if the current page is an H&M product page.
   */
  function canHandle() {
    const host = window.location.hostname;
    if (!host.includes("hm.com")) return false;

    const path = window.location.pathname;
    return (
      path.includes("/productpage") ||
      path.includes("/product/") ||
      path.match(/\.\d+\.html$/) !== null ||
      !!document.querySelector('[data-testid="product-detail"]') ||
      !!document.querySelector('[class*="product-detail"]') ||
      !!document.querySelector('#product-schema')
    );
  }

  /**
   * Try to extract JSON-LD structured data from the page.
   * H&M commonly includes schema.org Product data.
   */
  function extractJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data["@type"] === "Product") return data;
        if (Array.isArray(data)) {
          const product = data.find((d) => d["@type"] === "Product");
          if (product) return product;
        }
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
   * Extract the product name.
   */
  function extractName(jsonLd) {
    if (jsonLd?.name) return jsonLd.name;

    const selectors = [
      'h1[data-testid="product-title"]',
      'h1.product-item-headline',
      '[class*="product-name"] h1',
      '[class*="ProductName"]',
      'h1[class*="heading"]',
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
   * Parse a price string, handling US (1,299.99) and EU (1.299,99) formats.
   */
  function parsePriceText(text) {
    const match = text.match(
      /\d{1,3}(?:[.,]\d{3})*[.,]\d{1,2}|\d+[.,]\d{1,2}|\d+/
    );
    if (!match) return null;
    let num = match[0];
    if (/\.\d{3}/.test(num) && num.includes(",")) {
      num = num.replace(/\./g, "").replace(",", ".");
    } else if (/^\d+,\d{1,2}$/.test(num)) {
      num = num.replace(",", ".");
    } else {
      num = num.replace(/,/g, "");
    }
    const val = parseFloat(num);
    return isNaN(val) ? null : val;
  }

  /**
   * Detect currency from text containing a price.
   */
  function detectCurrency(text) {
    if (text.includes("$")) return "USD";
    if (text.includes("\u20AC")) return "EUR";
    if (text.includes("\u00A3")) return "GBP";
    if (/\bkr\.?\b/i.test(text)) return "SEK";
    if (text.includes("\u20BD")) return "RUB";
    if (text.includes("\u00A5")) return "JPY";
    const lang = document.documentElement.lang || "";
    if (lang.startsWith("sv")) return "SEK";
    if (lang.startsWith("de") || lang.startsWith("fr") || lang.startsWith("it")) return "EUR";
    return null;
  }

  /**
   * Extract price and currency.
   */
  function extractPrice(jsonLd) {
    const result = { price: null, currency: null };

    // Try JSON-LD first
    if (jsonLd?.offers) {
      const offers = Array.isArray(jsonLd.offers) ? jsonLd.offers : [jsonLd.offers];
      // Prefer the lowest current price (sale price)
      let best = null;
      for (const offer of offers) {
        if (offer.price != null) {
          const p = parseFloat(offer.price);
          if (!isNaN(p) && (best === null || p < best)) best = p;
          result.currency = offer.priceCurrency || result.currency;
        }
      }
      if (best !== null) {
        result.price = best;
        return result;
      }
    }

    // DOM fallback — prefer "current" / "sale" selectors
    const priceSelectors = [
      '[data-testid="product-price"] [class*="sale"]',
      '[data-testid="product-price"] [class*="current"]',
      '[data-testid="product-price"]',
      '[class*="ProductPrice"] [class*="sale"]',
      '[class*="ProductPrice"] [class*="red"]',
      '[class*="ProductPrice"]',
      '.product-item-price span',
      '[class*="product-price"]',
      '[id*="product-price"]',
      '.price-value',
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

    // Meta tag fallback
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
   * Normalize an image URL and upgrade H&M CDN to high resolution.
   */
  function normalizeImageUrl(src) {
    if (!src || src.includes("data:image") || src.includes("placeholder")) return null;
    if (src.startsWith("//")) src = "https:" + src;
    else if (src.startsWith("/")) src = window.location.origin + src;
    // Upgrade H&M CDN width parameter to high-res
    src = src.replace(/([?&])w=\d+/, "$1w=1200");
    // If using set= format, upgrade quality and width
    src = src.replace(/quality\[\d+\]/, "quality[90]");
    return src;
  }

  /**
   * Remove duplicate images that differ only in size params.
   */
  function deduplicateByBase(urls) {
    const seen = new Map();
    for (const url of urls) {
      const base = url
        .replace(/[?&](w|width|h|height|size|quality)=[^&]*/g, "")
        .replace(/quality\[\d+\]/, "")
        .replace(/\?$/, "");
      if (!seen.has(base)) {
        seen.set(base, url);
      }
    }
    return [...seen.values()];
  }

  /**
   * Extract product images.
   */
  function extractImages(jsonLd) {
    const images = new Set();

    // Try JSON-LD images
    if (jsonLd?.image) {
      const ldImages = Array.isArray(jsonLd.image)
        ? jsonLd.image
        : [jsonLd.image];
      ldImages.forEach((img) => {
        const src = typeof img === "string" ? img : img?.url || img?.contentUrl;
        const normalized = normalizeImageUrl(src);
        if (normalized) images.add(normalized);
      });
    }

    // DOM images — collect from all selectors, prefer srcset for high-res
    const imgSelectors = [
      '[data-testid="product-image"] img',
      '.product-detail-main-image-container img',
      '[class*="ProductImage"] img',
      '[class*="product-image"] img',
      '.product-media img',
      'picture source[type="image/jpeg"]',
      'picture source[type="image/webp"]',
      'img[src*="lp2.hm.com"]',
      'img[src*="image.hm.com"]',
      'img[src*="hmgroup"]',
    ];

    for (const selector of imgSelectors) {
      document.querySelectorAll(selector).forEach((el) => {
        let src;
        if (el.tagName === "SOURCE") {
          src = bestFromSrcset(el.getAttribute("srcset"));
        } else {
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

    return deduplicateByBase([...images]);
  }

  /**
   * Extract color/colors.
   */
  function extractColor(jsonLd) {
    if (jsonLd?.color) return jsonLd.color;

    const selectors = [
      '[data-testid="product-color"]',
      '[class*="product-input-label"] [class*="color"]',
      '.product-colors .active',
      '[class*="ColorName"]',
      '[class*="color-name"]',
      '[class*="selected-color"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent.trim()) {
        return el.textContent.trim().replace(/^colou?r\s*:\s*/i, "");
      }
    }

    return null;
  }

  /**
   * Extract material/composition.
   */
  function extractMaterial(jsonLd) {
    if (jsonLd?.material) return jsonLd.material;

    const selectors = [
      '[data-testid="product-composition"]',
      '[class*="composition"]',
      '[class*="material"]',
      '.product-detail-facts li',
      '[class*="ProductDescription"] [class*="composition"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent.trim();
        if (text.match(/\d+%|cotton|polyester|wool|silk|linen|nylon|viscose/i)) {
          return text;
        }
      }
    }

    // Check description text for material info
    const descEl = document.querySelector('[class*="description"], [class*="ProductDescription"]');
    if (descEl) {
      const text = descEl.textContent;
      const matMatch = text.match(/(?:composition|material|made of)[:\s]*([\w\s,%]+)/i);
      if (matMatch) return matMatch[1].trim();
    }

    return null;
  }

  /**
   * Extract available sizes.
   */
  function extractSizes() {
    const sizes = [];

    const sizeSelectors = [
      '[data-testid="size-selector"] li',
      '[class*="SizeSelector"] li',
      '.product-size-selector li',
      '[class*="size-list"] li',
      '[class*="size-selector"] button',
      'select[id*="size"] option',
    ];

    for (const selector of sizeSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        elements.forEach((el) => {
          // Skip "Select size" placeholder options
          if (el.tagName === "OPTION" && el.value === "") return;

          const label =
            el.getAttribute("data-size") ||
            el.getAttribute("data-value") ||
            el.getAttribute("value") ||
            el.textContent.trim();

          if (label && label.toLowerCase() !== "select size") {
            const isDisabled =
              el.classList.contains("disabled") ||
              el.classList.contains("out-of-stock") ||
              el.getAttribute("aria-disabled") === "true" ||
              el.getAttribute("disabled") !== null ||
              el.classList.contains("noStock");

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
   * Extract size chart data if available.
   */
  function extractSizeChart() {
    const sizeChart = [];

    const tableSelectors = [
      '[class*="size-guide"] table',
      '[class*="SizeGuide"] table',
      '[data-testid="size-guide"] table',
      '.size-chart table',
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
   * Infer category from JSON-LD, breadcrumbs, product name, and URL path.
   */
  function extractCategory(jsonLd) {
    // 1. Try JSON-LD category
    if (jsonLd?.category) {
      const cat = normalizeCategory(jsonLd.category);
      if (cat) return cat;
    }

    // 2. Try breadcrumbs
    const breadcrumbSelectors = [
      '[class*="breadcrumb"] a',
      'nav[aria-label*="breadcrumb"] a',
      '[class*="Breadcrumb"] a',
    ];

    for (const selector of breadcrumbSelectors) {
      const links = document.querySelectorAll(selector);
      if (links.length > 1) {
        const text = links[links.length - 1]?.textContent.trim();
        const cat = normalizeCategory(text);
        if (cat) return cat;
      }
    }

    // 3. Try product name (from JSON-LD or DOM)
    const name = extractName(jsonLd);
    const fromName = normalizeCategory(name);
    if (fromName) return fromName;

    // 4. Try URL path
    const fromUrl = normalizeCategory(window.location.pathname);
    if (fromUrl) return fromUrl;

    return "tshirt";
  }

  /**
   * Main extraction function.
   */
  function extract() {
    const jsonLd = extractJsonLd();
    const { price, currency } = extractPrice(jsonLd);

    return {
      name: extractName(jsonLd),
      brand: "H&M",
      category: extractCategory(jsonLd),
      price,
      currency,
      color: extractColor(jsonLd),
      material: extractMaterial(jsonLd),
      sizes: extractSizes(),
      images: extractImages(jsonLd),
      productUrl: window.location.href,
      sizeChart: extractSizeChart(),
      extractedAt: new Date().toISOString(),
      extractorVersion: "1.0.0",
      confidence: jsonLd ? "high" : "medium",
    };
  }

  return {
    canHandle,
    extract,
  };
})();
