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
   * Extract price and currency.
   */
  function extractPrice(jsonLd) {
    const result = { price: null, currency: null };

    // Try JSON-LD first
    if (jsonLd?.offers) {
      const offer = Array.isArray(jsonLd.offers)
        ? jsonLd.offers[0]
        : jsonLd.offers;
      if (offer.price) {
        result.price = parseFloat(offer.price);
        result.currency = offer.priceCurrency || null;
        return result;
      }
    }

    // DOM fallback
    const priceSelectors = [
      '[data-testid="product-price"]',
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
        const match = text.match(/[\d]+[.,]?\d*/);
        if (match) {
          result.price = parseFloat(match[0].replace(",", "."));
          if (text.includes("$")) result.currency = "USD";
          else if (text.includes("\u20AC")) result.currency = "EUR";
          else if (text.includes("\u00A3")) result.currency = "GBP";
          else if (text.includes("kr")) result.currency = "SEK";
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
        if (src) images.add(src);
      });
    }

    // DOM images
    const imgSelectors = [
      '[data-testid="product-image"] img',
      '.product-detail-main-image-container img',
      '[class*="ProductImage"] img',
      '[class*="product-image"] img',
      '.product-media img',
      'img[src*="lp2.hm.com"]',
      'img[src*="image.hm.com"]',
      'img[src*="hmgroup"]',
    ];

    for (const selector of imgSelectors) {
      document.querySelectorAll(selector).forEach((el) => {
        let src = el.getAttribute("src") || el.getAttribute("data-src");
        if (src && !src.includes("data:image") && !src.includes("placeholder")) {
          if (src.startsWith("//")) src = "https:" + src;
          else if (src.startsWith("/")) src = window.location.origin + src;
          images.add(src);
        }
      });
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
   * Infer category from breadcrumb or URL path.
   */
  function extractCategory(jsonLd) {
    if (jsonLd?.category) return jsonLd.category;

    // Try breadcrumbs
    const breadcrumbSelectors = [
      '[class*="breadcrumb"] a',
      'nav[aria-label*="breadcrumb"] a',
      '[class*="Breadcrumb"] a',
    ];

    for (const selector of breadcrumbSelectors) {
      const links = document.querySelectorAll(selector);
      if (links.length > 1) {
        const category = links[links.length - 1]?.textContent.trim();
        if (category) return category;
      }
    }

    // Infer from URL
    const path = window.location.pathname.toLowerCase();
    const categoryPatterns = [
      { pattern: /dress/i, category: "Dresses" },
      { pattern: /shirt|blouse|top/i, category: "Tops" },
      { pattern: /trouser|pant|jean/i, category: "Bottoms" },
      { pattern: /jacket|coat|blazer/i, category: "Outerwear" },
      { pattern: /skirt/i, category: "Skirts" },
      { pattern: /shoe|boot|sandal|sneaker/i, category: "Shoes" },
      { pattern: /bag|purse/i, category: "Bags" },
      { pattern: /knit|sweater|cardigan/i, category: "Knitwear" },
      { pattern: /t-shirt|tee/i, category: "T-Shirts" },
      { pattern: /hoodie|sweatshirt/i, category: "Sweatshirts" },
    ];

    for (const { pattern, category } of categoryPatterns) {
      if (pattern.test(path)) return category;
    }

    return "Clothing";
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
