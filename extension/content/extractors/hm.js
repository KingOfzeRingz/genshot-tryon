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
   * Extract product data from H&M's __NEXT_DATA__ (Next.js hydration payload).
   * This is the most reliable source on H&M's newer productpage.XXXXX.html pages
   * where JSON-LD and breadcrumbs may be absent.
   *
   * Returns a flat object: { category, name, price, currency } (all optional).
   */
  function extractNextData() {
    const result = {};
    try {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el) return result;
      const nd = JSON.parse(el.textContent);

      // H&M nests product data under varying paths — try common ones
      const pp = nd?.props?.pageProps;
      const product =
        pp?.product || pp?.productData || pp?.pdpData?.product || null;
      if (!product) return result;

      // Category: H&M uses categoryName, mainCategoryCode, or category
      const catRaw =
        product.categoryName ||
        product.mainCategory?.name ||
        product.category ||
        product.departmentName ||
        "";
      if (catRaw) result.category = catRaw;

      // Name
      if (product.name || product.productName || product.title) {
        result.name = product.name || product.productName || product.title;
      }

      // Price — H&M stores whitePrice (regular) and redPrice (sale)
      const redPrice = product.redPrice || product.price?.redPrice;
      const whitePrice = product.whitePrice || product.price?.whitePrice;
      const priceObj = redPrice || whitePrice;
      if (priceObj) {
        const val = parseFloat(priceObj.price ?? priceObj.value ?? priceObj);
        if (!isNaN(val)) {
          result.price = val;
          result.currency = priceObj.currency || priceObj.currencyIso || null;
        }
      }
    } catch {
      // __NEXT_DATA__ missing or malformed — not critical
    }
    return result;
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
    if (text.includes("\u00A3") || text.includes("£")) return "GBP";
    if (text.includes("\u20AC") || text.includes("€")) return "EUR";
    if (text.includes("$")) return "USD";
    if (/\bkr\.?\b/i.test(text)) return "SEK";
    if (text.includes("\u20BD")) return "RUB";
    if (text.includes("\u00A5") || text.includes("¥")) return "JPY";
    // H&M locale hints from URL or page lang
    const path = window.location.pathname;
    if (path.startsWith("/en_gb")) return "GBP";
    if (path.startsWith("/en_us")) return "USD";
    if (path.match(/^\/(de|fr|it|es|nl|at|be)_/)) return "EUR";
    if (path.startsWith("/sv_")) return "SEK";
    const lang = document.documentElement.lang || "";
    if (lang.startsWith("sv")) return "SEK";
    if (lang.startsWith("de") || lang.startsWith("fr") || lang.startsWith("it")) return "EUR";
    return null;
  }

  /**
   * Extract price and currency.
   * Prioritizes: JSON-LD → __NEXT_DATA__ → DOM (red > sale > current > member > regular) → meta.
   */
  function extractPrice(jsonLd, nextData) {
    const result = { price: null, currency: null };

    // Try JSON-LD first
    if (jsonLd?.offers) {
      const offers = Array.isArray(jsonLd.offers) ? jsonLd.offers : [jsonLd.offers];
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

    // Try __NEXT_DATA__ (has redPrice / whitePrice parsed already)
    if (nextData?.price != null) {
      result.price = nextData.price;
      result.currency = nextData.currency || null;
      return result;
    }

    // DOM fallback — ordered: red/sale → current → member → general.
    // H&M uses data-testid="red-price" / "current-price" directly on the
    // price <span>, NOT nested inside a "product-price" container.
    const priceSelectors = [
      // H&M data-testid price spans (the actual elements on the page)
      '[data-testid="red-price"]',
      '[data-testid="sale-price"]',
      '[data-testid="current-price"]',
      // Nested inside a product-price container (older layout)
      '[data-testid="product-price"] [class*="sale"]',
      '[data-testid="product-price"] [class*="red"]',
      '[data-testid="product-price"]',
      // Class-based patterns
      '[class*="ProductPrice"] [class*="sale"]',
      '[class*="ProductPrice"] [class*="red"]',
      '[class*="ProductPrice"] [class*="current"]',
      '[class*="ProductPrice"]',
      // Member price
      '[class*="member-price"] [class*="amount"]',
      '[class*="MemberPrice"]',
      // Generic
      '.product-item-price span',
      '[class*="product-price"]',
      '[id*="product-price"]',
      '.price-value',
    ];

    for (const selector of priceSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        let text = el.textContent.trim();
        // Strip "From" / "Member price" prefixes
        text = text.replace(/^(?:from|member\s+price|price)\s*:?\s*/i, "");
        const parsed = parsePriceText(text);
        if (parsed !== null) {
          result.price = parsed;
          result.currency = detectCurrency(el.textContent);
          return result;
        }
      }
    }

    // Meta tag fallback
    const priceMeta = document.querySelector('meta[property="product:price:amount"]');
    if (priceMeta) {
      const val = parseFloat(priceMeta.getAttribute("content"));
      if (!isNaN(val)) {
        result.price = val;
        const currMeta = document.querySelector('meta[property="product:price:currency"]');
        if (currMeta) result.currency = currMeta.getAttribute("content");
        return result;
      }
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
   * Map a text string to a backend-compatible category.
   * Returns: "top" | "bottom" | "outerwear" | "shoes" | null
   */
  function normalizeCategory(raw) {
    if (!raw) return null;
    const s = raw.toLowerCase();
    if (/\b(jacket|coat|blazer|parka|puffer|anorak|outerwear|overcoat|trench|windbreaker|gilet|vest(?:e)?|cape|poncho|waistcoat)\b/.test(s)) return "outerwear";
    if (/\b(trouser|pant|jean|skirt|short(?!s?\s*sleeve)|legging|bottom|chino|jogger|cargo|culottes|bermuda)\b/.test(s)) return "bottom";
    if (/\b(shoe|boot|sandal|sneaker|trainer|loafer|heel|slipper|mule|clog|footwear|espadrille|oxford|derby|pump)\b/.test(s)) return "shoes";
    if (/\b(shirt|blouse|top|dress|knit|sweater|cardigan|hoodie|sweatshirt|t-shirt|tee|polo|crop|tunic|camisole|bodysuit|jumpsuit|romper|pullover|jersey|henley|tank)\b/.test(s)) return "top";
    return null;
  }

  /**
   * Parse H&M URL path for category hints.
   * H&M product URLs:
   *   /en_us/men/product/t-shirts/slim-fit-t-shirt.1234567.html
   *   /en_us/productpage.1234567001.html  (no category in path)
   * Category pages:
   *   /en_us/men/products/t-shirts-tank-tops.html
   */
  function categoryFromHMPath() {
    const path = window.location.pathname.toLowerCase();
    const segments = path.split("/").filter(Boolean);

    const slugMap = {
      // Tops
      "t-shirts": "top", "t-shirts-tank-tops": "top", "tank-tops": "top",
      "shirts": "top", "polo-shirts": "top", "tops": "top",
      "dresses": "top", "knitwear": "top", "cardigans-jumpers": "top",
      "sweaters": "top", "sweatshirts": "top", "hoodies-sweatshirts": "top",
      "hoodies": "top", "bodysuits": "top", "blouses": "top",
      "tunics": "top",
      // Bottoms
      "trousers": "bottom", "jeans": "bottom", "shorts": "bottom",
      "skirts": "bottom", "joggers": "bottom", "leggings": "bottom",
      "chinos": "bottom", "cargo-trousers": "bottom", "cargo-pants": "bottom",
      "wide-leg-trousers": "bottom", "slim-fit-jeans": "bottom",
      // Outerwear
      "jackets": "outerwear", "coats": "outerwear", "jackets-coats": "outerwear",
      "blazers": "outerwear", "puffers": "outerwear", "waistcoats": "outerwear",
      "leather-jackets": "outerwear", "denim-jackets": "outerwear",
      "bomber-jackets": "outerwear", "shackets": "outerwear",
      "overshirts": "outerwear",
      // Shoes
      "shoes": "shoes", "boots": "shoes", "sneakers": "shoes",
      "sandals": "shoes", "loafers": "shoes", "slippers": "shoes",
    };

    for (const seg of segments) {
      if (slugMap[seg]) return slugMap[seg];
    }

    // Also check compound segments like "product/t-shirts"
    const joined = segments.join("/");
    for (const [slug, cat] of Object.entries(slugMap)) {
      if (joined.includes("/" + slug + "/") || joined.includes("/" + slug + ".")) {
        return cat;
      }
    }

    return null;
  }

  /**
   * Infer category from H&M URL, __NEXT_DATA__, JSON-LD, breadcrumbs, and product name.
   */
  function extractCategory(jsonLd, nextData) {
    // 1. Try H&M URL path analysis (most reliable when path has category)
    const fromPath = categoryFromHMPath();
    if (fromPath) return fromPath;

    // 2. Try __NEXT_DATA__ category (best source for productpage.XXXXX.html URLs)
    if (nextData?.category) {
      const parts = nextData.category.split(/\s*[\/|>,]\s*/);
      for (let i = parts.length - 1; i >= 0; i--) {
        const cat = normalizeCategory(parts[i]);
        if (cat) return cat;
      }
    }

    // 3. Try JSON-LD category — H&M uses compound paths like "Men / T-shirts & Tank Tops"
    if (jsonLd?.category) {
      const parts = jsonLd.category.split(/\s*[\/|>]\s*/);
      for (let i = parts.length - 1; i >= 0; i--) {
        const cat = normalizeCategory(parts[i]);
        if (cat) return cat;
      }
    }

    // 4. Try breadcrumbs (walk deepest to shallowest)
    const breadcrumbSelectors = [
      '[class*="breadcrumb"] a',
      'nav[aria-label*="breadcrumb"] a',
      '[class*="Breadcrumb"] a',
      '[class*="BreadCrumb"] a',
    ];

    for (const selector of breadcrumbSelectors) {
      const links = document.querySelectorAll(selector);
      for (let i = links.length - 1; i >= 0; i--) {
        const text = links[i]?.textContent.trim();
        const cat = normalizeCategory(text);
        if (cat) return cat;
      }
    }

    // 5. Try product name
    const name = extractName(jsonLd);
    const fromName = normalizeCategory(name);
    if (fromName) return fromName;

    // 6. Try __NEXT_DATA__ name as last resort (may differ from DOM h1)
    if (nextData?.name) {
      const fromNd = normalizeCategory(nextData.name);
      if (fromNd) return fromNd;
    }

    // 7. Try full URL text as fallback
    const fromUrl = normalizeCategory(window.location.pathname.replace(/-/g, " "));
    if (fromUrl) return fromUrl;

    return "top";
  }

  /**
   * Main extraction function.
   */
  function extract() {
    const jsonLd = extractJsonLd();
    const nextData = extractNextData();
    const { price, currency } = extractPrice(jsonLd, nextData);

    return {
      name: nextData?.name || extractName(jsonLd),
      brand: "H&M",
      category: extractCategory(jsonLd, nextData),
      price,
      currency,
      color: extractColor(jsonLd),
      material: extractMaterial(jsonLd),
      sizes: extractSizes(),
      images: extractImages(jsonLd),
      productUrl: window.location.href,
      sizeChart: extractSizeChart(),
      extractedAt: new Date().toISOString(),
      extractorVersion: "1.1.0",
      confidence: jsonLd || Object.keys(nextData).length > 0 ? "high" : "medium",
    };
  }

  return {
    canHandle,
    extract,
  };
})();
