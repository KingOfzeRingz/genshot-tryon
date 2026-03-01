/**
 * GenShot TryOn - Generic Product Extractor
 *
 * Fallback extractor that works across any ecommerce site.
 * Attempts multiple strategies in order:
 *   1. JSON-LD (schema.org Product)
 *   2. OpenGraph meta tags
 *   3. Common CSS patterns
 *
 * Returns whatever product data can be found with lower confidence
 * than site-specific extractors.
 */

// eslint-disable-next-line no-var
var GenericExtractor = (function () {
  /**
   * This extractor can always attempt extraction on any page.
   */
  function canHandle() {
    return true;
  }

  /**
   * Try to extract JSON-LD Product structured data.
   */
  function extractJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);

        // Direct Product type
        if (data["@type"] === "Product") return data;

        // Array of items
        if (Array.isArray(data)) {
          const product = data.find((d) => d["@type"] === "Product");
          if (product) return product;
        }

        // @graph container
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
   * Extract data from OpenGraph meta tags.
   */
  function extractOpenGraph() {
    const og = {};

    const tags = {
      title: 'meta[property="og:title"]',
      description: 'meta[property="og:description"]',
      image: 'meta[property="og:image"]',
      url: 'meta[property="og:url"]',
      siteName: 'meta[property="og:site_name"]',
      type: 'meta[property="og:type"]',
      priceAmount: 'meta[property="product:price:amount"]',
      priceCurrency: 'meta[property="product:price:currency"]',
      brand: 'meta[property="product:brand"]',
      availability: 'meta[property="product:availability"]',
      color: 'meta[property="product:color"]',
    };

    for (const [key, selector] of Object.entries(tags)) {
      const el = document.querySelector(selector);
      if (el) {
        og[key] = el.getAttribute("content");
      }
    }

    return Object.keys(og).length > 0 ? og : null;
  }

  /**
   * Extract product name using multiple strategies.
   */
  function extractName(jsonLd, og) {
    if (jsonLd?.name) return jsonLd.name;
    if (og?.title) return og.title;

    const selectors = [
      '[itemprop="name"]',
      'h1[class*="product"]',
      'h1[class*="title"]',
      '[data-testid*="product-name"]',
      '[data-testid*="product-title"]',
      '#product-name',
      '.product-name',
      '.product-title',
      'h1',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent.trim().length > 0 && el.textContent.trim().length < 300) {
        return el.textContent.trim();
      }
    }

    // Last resort: document title
    const docTitle = document.title;
    if (docTitle) {
      // Strip common suffixes like " | Store Name" or " - Store Name"
      return docTitle.split(/\s*[|\-\u2013\u2014]\s*/)[0].trim();
    }

    return null;
  }

  /**
   * Extract brand.
   */
  function extractBrand(jsonLd, og) {
    if (jsonLd?.brand) {
      return typeof jsonLd.brand === "string"
        ? jsonLd.brand
        : jsonLd.brand?.name || null;
    }
    if (og?.brand) return og.brand;
    if (og?.siteName) return og.siteName;

    const selectors = [
      '[itemprop="brand"]',
      '[class*="brand-name"]',
      '[class*="product-brand"]',
      'a[class*="brand"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }

    return window.location.hostname.replace("www.", "").split(".")[0];
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
    if (text.includes("\u20BD")) return "RUB";
    if (/\bkr\.?\b/i.test(text)) return "SEK";
    if (text.includes("\u00A5")) return "JPY";
    if (text.includes("\u20A9")) return "KRW";
    const lang = document.documentElement.lang || "";
    if (lang.startsWith("de") || lang.startsWith("fr") || lang.startsWith("it")) return "EUR";
    if (lang.startsWith("sv") || lang.startsWith("nb") || lang.startsWith("da")) return "SEK";
    if (lang.startsWith("ja")) return "JPY";
    return null;
  }

  /**
   * Extract price and currency.
   */
  function extractPrice(jsonLd, og) {
    const result = { price: null, currency: null };

    // JSON-LD offers — prefer lowest current price
    if (jsonLd?.offers) {
      const offers = Array.isArray(jsonLd.offers) ? jsonLd.offers : [jsonLd.offers];
      let best = null;
      for (const offer of offers) {
        if (offer?.price != null) {
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

    // OpenGraph price
    if (og?.priceAmount) {
      result.price = parseFloat(og.priceAmount);
      result.currency = og.priceCurrency || null;
      if (!isNaN(result.price)) return result;
      result.price = null;
    }

    // Microdata
    const priceEl = document.querySelector('[itemprop="price"]');
    if (priceEl) {
      const val =
        priceEl.getAttribute("content") || priceEl.textContent.trim();
      const parsed = parsePriceText(val);
      if (parsed !== null) {
        result.price = parsed;
        const currEl = document.querySelector('[itemprop="priceCurrency"]');
        result.currency = currEl?.getAttribute("content") || null;
        return result;
      }
    }

    // Common DOM patterns — prefer sale/current price selectors first
    const priceSelectors = [
      '[class*="price"] [class*="sale"]',
      '[class*="price"] [class*="current"]',
      '[class*="price"] [class*="reduced"]',
      '[data-testid*="price"]',
      '[class*="product-price"]',
      '[class*="ProductPrice"]',
      '.price',
      '#price',
      '[class*="price"] span',
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
   * Normalize an image URL to absolute.
   */
  function normalizeImageUrl(src) {
    if (!src || src.includes("data:image") || src.includes("placeholder")) return null;
    if (src.startsWith("//")) src = "https:" + src;
    else if (src.startsWith("/")) src = window.location.origin + src;
    return src;
  }

  /**
   * Remove duplicate images that differ only in size params.
   */
  function deduplicateByBase(urls) {
    const seen = new Map();
    for (const url of urls) {
      const base = url
        .replace(/[?&](w|width|h|height|size|quality|resize)=[^&]*/g, "")
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
  function extractImages(jsonLd, og) {
    const images = new Set();

    // JSON-LD images
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

    // OG image
    if (og?.image) {
      const src = normalizeImageUrl(og.image);
      if (src) images.add(src);
    }

    // All og:image tags (there can be multiple)
    document.querySelectorAll('meta[property="og:image"]').forEach((el) => {
      const src = normalizeImageUrl(el.getAttribute("content"));
      if (src) images.add(src);
    });

    // Microdata images
    document.querySelectorAll('[itemprop="image"]').forEach((el) => {
      const src = normalizeImageUrl(
        el.getAttribute("content") ||
        el.getAttribute("src") ||
        el.getAttribute("href")
      );
      if (src) images.add(src);
    });

    // DOM images in product areas — prefer srcset for high-res
    const containerSelectors = [
      '[class*="product-image"]',
      '[class*="product-gallery"]',
      '[class*="ProductImage"]',
      '[class*="product-media"]',
      '[data-testid*="product-image"]',
      '#product-images',
      '.gallery',
      '[class*="product-detail"] [class*="image"]',
    ];

    for (const selector of containerSelectors) {
      const container = document.querySelector(selector);
      if (container) {
        // Extract from <img> and <source> within the container
        container.querySelectorAll("img, picture source").forEach((el) => {
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
    }

    return deduplicateByBase([...images]);
  }

  /**
   * Extract color.
   */
  function extractColor(jsonLd, og) {
    if (jsonLd?.color) return jsonLd.color;
    if (og?.color) return og.color;

    const selectors = [
      '[itemprop="color"]',
      '[class*="color-name"]',
      '[class*="selected-color"]',
      '[class*="ColorName"]',
      '[data-testid*="color"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = (
          el.getAttribute("content") || el.textContent
        ).trim();
        if (text) return text.replace(/^colou?r\s*:\s*/i, "");
      }
    }

    return null;
  }

  /**
   * Extract material.
   */
  function extractMaterial(jsonLd) {
    if (jsonLd?.material) return jsonLd.material;

    const selectors = [
      '[itemprop="material"]',
      '[class*="composition"]',
      '[class*="material"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = (el.getAttribute("content") || el.textContent).trim();
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
      '[class*="size-selector"] li',
      '[class*="size-list"] li',
      'select[name*="size"] option',
      'select[id*="size"] option',
      '[class*="SizeSelector"] button',
      '[data-testid*="size"] button',
      '[class*="size-option"]',
      '[class*="size"] input[type="radio"]',
    ];

    for (const selector of sizeSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        elements.forEach((el) => {
          if (el.tagName === "OPTION" && el.value === "") return;

          const label =
            el.getAttribute("data-size") ||
            el.getAttribute("data-value") ||
            el.getAttribute("value") ||
            el.getAttribute("aria-label") ||
            el.textContent.trim();

          if (label && label.toLowerCase() !== "select size" && label.length < 20) {
            const isDisabled =
              el.classList.contains("disabled") ||
              el.classList.contains("out-of-stock") ||
              el.getAttribute("aria-disabled") === "true" ||
              el.getAttribute("disabled") !== null;

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
  function extractCategory(jsonLd, og) {
    // 1. Try JSON-LD category
    if (jsonLd?.category) {
      const cat = normalizeCategory(jsonLd.category);
      if (cat) return cat;
    }

    // 2. Try breadcrumbs
    const breadcrumbSelectors = [
      '[class*="breadcrumb"] a',
      'nav[aria-label*="breadcrumb"] a',
      '[itemtype*="BreadcrumbList"] a',
      'ol[class*="breadcrumb"] li a',
    ];

    for (const selector of breadcrumbSelectors) {
      const links = document.querySelectorAll(selector);
      if (links.length > 1) {
        const text = links[links.length - 1]?.textContent.trim();
        const cat = normalizeCategory(text);
        if (cat) return cat;
      }
    }

    // 3. Try product name
    const name = extractName(jsonLd, og);
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
    const og = extractOpenGraph();
    const { price, currency } = extractPrice(jsonLd, og);

    // Determine confidence based on available data sources
    let confidence = "low";
    if (jsonLd) confidence = "medium";
    if (jsonLd && extractName(jsonLd, og) && price) confidence = "medium-high";

    return {
      name: extractName(jsonLd, og),
      brand: extractBrand(jsonLd, og),
      category: extractCategory(jsonLd, og),
      price,
      currency,
      color: extractColor(jsonLd, og),
      material: extractMaterial(jsonLd),
      sizes: extractSizes(),
      images: extractImages(jsonLd, og),
      productUrl: window.location.href,
      sizeChart: [],
      extractedAt: new Date().toISOString(),
      extractorVersion: "1.0.0",
      confidence,
    };
  }

  return {
    canHandle,
    extract,
  };
})();
