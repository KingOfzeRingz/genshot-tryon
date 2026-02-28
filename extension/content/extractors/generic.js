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
   * Extract price and currency.
   */
  function extractPrice(jsonLd, og) {
    const result = { price: null, currency: null };

    // JSON-LD offers
    if (jsonLd?.offers) {
      const offer = Array.isArray(jsonLd.offers)
        ? jsonLd.offers[0]
        : jsonLd.offers;
      if (offer?.price) {
        result.price = parseFloat(offer.price);
        result.currency = offer.priceCurrency || null;
        return result;
      }
    }

    // OpenGraph price
    if (og?.priceAmount) {
      result.price = parseFloat(og.priceAmount);
      result.currency = og.priceCurrency || null;
      return result;
    }

    // Microdata
    const priceEl = document.querySelector('[itemprop="price"]');
    if (priceEl) {
      const val =
        priceEl.getAttribute("content") || priceEl.textContent.trim();
      const match = val.match(/[\d]+[.,]?\d*/);
      if (match) {
        result.price = parseFloat(match[0].replace(",", "."));
        const currEl = document.querySelector('[itemprop="priceCurrency"]');
        result.currency = currEl?.getAttribute("content") || null;
        return result;
      }
    }

    // Common DOM patterns
    const priceSelectors = [
      '[data-testid*="price"]',
      '[class*="product-price"]',
      '[class*="ProductPrice"]',
      '.price',
      '#price',
      '[class*="price"] [class*="current"]',
      '[class*="price"] [class*="sale"]',
      '[class*="price"] span',
    ];

    for (const selector of priceSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent.trim();
        const match = text.match(/[\d]+[.,]?\d*/);
        if (match) {
          result.price = parseFloat(match[0].replace(",", "."));
          if (text.includes("$")) result.currency = "USD";
          else if (text.includes("\u20AC")) result.currency = "EUR";
          else if (text.includes("\u00A3")) result.currency = "GBP";
          return result;
        }
      }
    }

    return result;
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
        if (src) images.add(src);
      });
    }

    // OG image
    if (og?.image) {
      images.add(og.image);
    }

    // All og:image tags (there can be multiple)
    document.querySelectorAll('meta[property="og:image"]').forEach((el) => {
      const src = el.getAttribute("content");
      if (src) images.add(src);
    });

    // Microdata images
    document.querySelectorAll('[itemprop="image"]').forEach((el) => {
      const src =
        el.getAttribute("content") ||
        el.getAttribute("src") ||
        el.getAttribute("href");
      if (src) images.add(src);
    });

    // DOM images in product areas
    const containerSelectors = [
      '[class*="product-image"]',
      '[class*="product-gallery"]',
      '[class*="ProductImage"]',
      '[class*="product-media"]',
      '[data-testid*="product-image"]',
      '#product-images',
      '.gallery',
    ];

    for (const selector of containerSelectors) {
      const container = document.querySelector(selector);
      if (container) {
        container.querySelectorAll("img").forEach((img) => {
          let src = img.getAttribute("src") || img.getAttribute("data-src");
          if (src && !src.includes("data:image") && !src.includes("placeholder")) {
            if (src.startsWith("//")) src = "https:" + src;
            else if (src.startsWith("/")) src = window.location.origin + src;
            images.add(src);
          }
        });
        break;
      }
    }

    return [...images];
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
   * Infer category from various sources.
   */
  function extractCategory(jsonLd) {
    if (jsonLd?.category) return jsonLd.category;

    // Breadcrumbs
    const breadcrumbSelectors = [
      '[class*="breadcrumb"] a',
      'nav[aria-label*="breadcrumb"] a',
      '[itemtype*="BreadcrumbList"] a',
      'ol[class*="breadcrumb"] li a',
    ];

    for (const selector of breadcrumbSelectors) {
      const links = document.querySelectorAll(selector);
      if (links.length > 1) {
        const category = links[links.length - 1]?.textContent.trim();
        if (category) return category;
      }
    }

    // URL inference
    const path = window.location.pathname.toLowerCase();
    const patterns = [
      { pattern: /dress/i, category: "Dresses" },
      { pattern: /shirt|blouse|top/i, category: "Tops" },
      { pattern: /trouser|pant|jean/i, category: "Bottoms" },
      { pattern: /jacket|coat|blazer/i, category: "Outerwear" },
      { pattern: /skirt/i, category: "Skirts" },
      { pattern: /shoe|boot|sandal|sneaker/i, category: "Shoes" },
    ];

    for (const { pattern, category } of patterns) {
      if (pattern.test(path)) return category;
    }

    return "Clothing";
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
      category: extractCategory(jsonLd),
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
