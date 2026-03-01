/**
 * GenShot TryOn - Smart Image Selector
 *
 * Scores and sorts product images so the best product-focused shot
 * (e.g. flat-lay / e-commerce / packshot) appears first.
 *
 * Site-specific heuristics:
 *   - Zara: `-e\d` (e-commerce) > `-p\d` (packshot) > `-a\d` (model)
 *   - H&M:  product/flat/still > model/look/outfit
 *   - Generic: product/main/hero > thumb/small/icon/logo/banner
 */

// eslint-disable-next-line no-var
var GenShotImageSelector = (function () {
  "use strict";

  /**
   * Score a single image URL using Zara-specific naming conventions.
   *
   * Zara image filenames follow patterns like:
   *   .../<id>-e1.jpg   (e-commerce flat-lay — best)
   *   .../<id>-e2.jpg   (e-commerce alternate angle)
   *   .../<id>-p1.jpg   (packshot)
   *   .../<id>-a1.jpg   (on-model / atmosphere — least useful)
   *
   * We also prefer higher `w=` query-string values (larger images).
   */
  function scoreZara(url) {
    var score = 0;
    var lower = url.toLowerCase();

    // E-commerce flat-lay shots — best for try-on
    if (/-e\d/i.test(url)) {
      score += 40;
      // Prefer the canonical first shot (-e1)
      if (/-e1/i.test(url)) score += 10;
      else if (/-e2/i.test(url)) score += 5;
    }
    // Packshot (product on plain background)
    else if (/-p\d/i.test(url)) {
      score += 30;
      if (/-p1/i.test(url)) score += 5;
    }
    // Model / atmosphere shots — deprioritize
    else if (/-a\d/i.test(url)) {
      score -= 10;
    }

    // Prefer larger renditions
    var wMatch = url.match(/[?&]w=(\d+)/);
    if (wMatch) {
      var w = parseInt(wMatch[1], 10);
      // +0-15 points based on width (prefer 800+ px)
      score += Math.min(15, Math.round(w / 60));
    }

    // Penalize thumbnails
    if (/thumb|_s\.|_xs\.|mini|icon/i.test(lower)) score -= 30;

    // Penalize non-product images (logos, banners, etc)
    if (/logo|banner|sprite|placeholder|loading/i.test(lower)) score -= 50;

    return score;
  }

  /**
   * Score a single image URL using H&M-specific heuristics.
   *
   * H&M CDN URLs often look like:
   *   https://lp2.hm.com/hmgoepprod?set=format[webp],quality[79],source[/xx/yy/id.jpg]&call=url[file:/product/main]
   *   The `call=url[file:/product/...]` part indicates the image type.
   */
  function scoreHM(url) {
    var score = 0;
    var lower = url.toLowerCase();

    // H&M CDN call-type signals
    if (/call=url\[file:\/product\/main\]/.test(lower)) score += 35;
    if (/call=url\[file:\/product\/style\]/.test(lower)) score += 25;
    if (/call=url\[file:\/product\/listing\]/.test(lower)) score += 15;

    // Filename/path keyword signals
    if (/product|flat|still|packshot/.test(lower)) score += 30;
    if (/main|primary|hero/.test(lower)) score += 20;
    if (/front|detail/.test(lower)) score += 10;

    // Negative signals
    if (/model|look|outfit|environment/.test(lower)) score -= 15;
    if (/thumb|mini|icon|tiny/.test(lower)) score -= 25;
    if (/logo|banner|sprite|placeholder|loading/i.test(lower)) score -= 50;

    // Prefer larger images (check w= param)
    var wMatch = lower.match(/[?&]w=(\d+)/);
    if (wMatch) {
      var w = parseInt(wMatch[1], 10);
      score += Math.min(15, Math.round(w / 80));
    }

    return score;
  }

  /**
   * Score a single image URL using generic heuristics.
   */
  function scoreGeneric(url) {
    var score = 0;
    var lower = url.toLowerCase();

    // Positive signals
    if (/product|main|primary|hero|large|detail|full/.test(lower)) score += 20;
    if (/flat|still|front|packshot/.test(lower)) score += 15;

    // Negative signals
    if (/thumb|small|icon|logo|banner|sprite|placeholder|loading/.test(lower)) score -= 30;
    if (/model|lifestyle|look|outfit|environment/.test(lower)) score -= 10;
    if (/swatch|color-chip|favicon/.test(lower)) score -= 40;

    // Prefer larger images
    var wMatch = lower.match(/[?&](?:w|width)=(\d+)/);
    if (wMatch) {
      var w = parseInt(wMatch[1], 10);
      score += Math.min(15, Math.round(w / 80));
    }

    // Penalize very small images by filename clues (e.g., _100x100)
    if (/\d{2,3}x\d{2,3}/.test(lower)) {
      var dims = lower.match(/(\d{2,3})x(\d{2,3})/);
      if (dims && parseInt(dims[1], 10) < 200) score -= 20;
    }

    return score;
  }

  /**
   * Select and sort product images, best first.
   *
   * @param {string[]} images - Array of image URLs
   * @param {string}   site   - One of "zara", "hm", "generic"
   * @returns {string[]} Images sorted by score descending
   */
  function selectBestProductImage(images, site) {
    if (!images || images.length <= 1) return images;

    var scoreFn;
    switch (site) {
      case "zara":
        scoreFn = scoreZara;
        break;
      case "hm":
        scoreFn = scoreHM;
        break;
      default:
        scoreFn = scoreGeneric;
        break;
    }

    // Build scored list, preserving original index as tie-breaker
    var scored = images.map(function (url, idx) {
      return { url: url, score: scoreFn(url), idx: idx };
    });

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx; // stable: preserve original order on tie
    });

    return scored.map(function (item) {
      return item.url;
    });
  }

  return {
    selectBestProductImage: selectBestProductImage,
  };
})();
