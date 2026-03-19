// ==UserScript==
// @name         AirbnbSpy - Pricing Analytics
// @namespace    https://github.com/airbnbspy
// @version      2.1.0
// @description  Scrape Airbnb search results to analyze pricing and optimize your listings
// @match        https://www.airbnb.com/s/*
// @match        https://www.airbnb.com/rooms/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  const listings = new Map(); // id -> listing data
  let panelCollapsed = false;
  let panelEl = null;
  let activeTab = 'overview';
  let detectedNights = 0;

  // Auto-collect state
  let autoCollecting = false;
  let autoCollectPage = 1;
  let autoCollectAbort = false;

  // My Listing state — persisted to localStorage
  let myPrice = parseFloat(localStorage.getItem('abspy_my_price')) || 0;

  // ── Night Detection ────────────────────────────────────────────────────────
  function detectNights() {
    // Method 1: URL params (checkin/checkout)
    try {
      const params = new URLSearchParams(window.location.search);
      const checkin = params.get('checkin');
      const checkout = params.get('checkout');
      if (checkin && checkout) {
        const nights = Math.round((new Date(checkout) - new Date(checkin)) / 86400000);
        if (nights > 0 && nights < 365) {
          detectedNights = nights;
          return nights;
        }
      }
    } catch (e) { /* ignore */ }

    // Method 2: Search bar text (e.g., "Jul 4 – 11")
    try {
      const headerText = document.querySelector('header')?.textContent || '';
      const searchBarText = document.querySelector('[data-testid="little-search"]')?.textContent || '';
      const allText = headerText + ' ' + searchBarText;
      const dateRangeMatch = allText.match(/(\w+\s+\d+)\s*[–—-]\s*(\d+)/);
      if (dateRangeMatch) {
        const start = parseInt(dateRangeMatch[1].match(/\d+/)[0]);
        const end = parseInt(dateRangeMatch[2]);
        if (end > start) {
          detectedNights = end - start;
          return detectedNights;
        }
      }
    } catch (e) { /* ignore */ }

    // Method 3: Look for "for X nights" text on the page
    try {
      const pageText = document.body.textContent || '';
      const nightsMatch = pageText.match(/for\s+(\d+)\s+nights?/i);
      if (nightsMatch) {
        detectedNights = parseInt(nightsMatch[1]);
        return detectedNights;
      }
    } catch (e) { /* ignore */ }

    return detectedNights;
  }

  // ── Fetch / XHR Interception ───────────────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('/api/v3/StaysSearch') ||
          url.includes('/api/v3/ExploreSearch') ||
          url.includes('StaysSearch') ||
          url.includes('/api/v3/PdpPlatformSections')) {
        const clone = response.clone();
        clone.json().then(json => processApiResponse(json)).catch(() => {});
      }
    } catch (e) { /* ignore */ }
    return response;
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._abspy_url = url;
    return originalXHROpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        const url = this._abspy_url || '';
        if (url.includes('StaysSearch') || url.includes('ExploreSearch') || url.includes('PdpPlatformSections')) {
          const json = JSON.parse(this.responseText);
          processApiResponse(json);
        }
      } catch (e) { /* ignore */ }
    });
    return originalXHRSend.apply(this, args);
  };

  // ── API Response Parser ────────────────────────────────────────────────────
  function processApiResponse(json) {
    try {
      const results = findSearchResults(json);
      if (results && results.length > 0) {
        let added = 0;
        for (const result of results) {
          const listing = extractListingFromApi(result);
          if (listing && listing.id && listing.pricePerNight > 0) {
            if (!listings.has(listing.id)) added++;
            listings.set(listing.id, listing);
          }
        }
        if (added > 0) updatePanel();
      }
    } catch (e) {
      console.log('[AirbnbSpy] API parse error:', e.message);
    }
  }

  function findSearchResults(obj, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      if (obj.length > 0 && obj[0] && (obj[0].listing || obj[0].pricingQuote || obj[0].id)) {
        return obj;
      }
    }
    const resultKeys = [
      'searchResults', 'results', 'listings', 'items',
      'staysSearchResults', 'exploreSearchResults',
      'sections', 'data', 'presentation',
      'staysSearch', 'exploreSearch'
    ];
    for (const key of resultKeys) {
      if (obj[key]) {
        const found = findSearchResults(obj[key], depth + 1);
        if (found) return found;
      }
    }
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key]) && obj[key].length > 2) {
        const sample = obj[key][0];
        if (sample && typeof sample === 'object' && (sample.listing || sample.pricingQuote || sample.listingId)) {
          return obj[key];
        }
      }
      if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
        const found = findSearchResults(obj[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function extractListingFromApi(result) {
    try {
      const l = result.listing || result;
      const pricing = result.pricingQuote || result.pricing || l.pricingQuote || l.pricing || {};

      const id = l.id || l.listingId || result.listingId || result.id;
      const name = l.name || l.title || '';
      const roomType = l.roomType || l.room_type || l.roomTypeCategory || '';

      let pricePerNight = 0;
      let totalPrice = 0;
      let rawDisplayPrice = 0;

      if (pricing.rate) pricePerNight = extractAmount(pricing.rate);
      if (pricing.rateWithServiceFee) pricePerNight = extractAmount(pricing.rateWithServiceFee) || pricePerNight;

      if (pricing.price) rawDisplayPrice = extractAmount(pricing.price);
      if (pricing.priceString) rawDisplayPrice = parsePrice(pricing.priceString) || rawDisplayPrice;
      if (pricing.structuredStayDisplayPrice) {
        const dp = pricing.structuredStayDisplayPrice;
        if (dp.primaryLine) {
          rawDisplayPrice = parsePrice(dp.primaryLine.price || dp.primaryLine.displayComponentMap?.price || dp.primaryLine.accessibilityLabel || '') || rawDisplayPrice;
        }
        if (dp.secondaryLine) {
          const secText = dp.secondaryLine.price || dp.secondaryLine.accessibilityLabel || '';
          const nightsM = String(secText).match(/(\d+)\s*nights?/i);
          if (nightsM && !detectedNights) detectedNights = parseInt(nightsM[1]);
          const secPrice = parsePrice(secText);
          if (secPrice > 0) totalPrice = secPrice;
        }
      }

      if (pricing.total) totalPrice = extractAmount(pricing.total) || totalPrice;

      const nights = detectedNights;
      if (pricePerNight === 0 && rawDisplayPrice > 0) {
        if (nights > 1) {
          totalPrice = totalPrice || rawDisplayPrice;
          pricePerNight = Math.round(rawDisplayPrice / nights);
        } else {
          pricePerNight = rawDisplayPrice;
        }
      }
      if (pricePerNight > 0 && nights > 1 && totalPrice > 0 && pricePerNight > totalPrice) {
        pricePerNight = Math.round(totalPrice / nights);
      }
      if (pricePerNight > 0 && nights > 1 && pricePerNight > 1000 && totalPrice === 0) {
        totalPrice = pricePerNight;
        pricePerNight = Math.round(pricePerNight / nights);
      }

      let bedrooms = 0, beds = 0, bathrooms = 0;
      if (l.bedrooms !== undefined) bedrooms = l.bedrooms;
      if (l.beds !== undefined) beds = l.beds;
      if (l.bathrooms !== undefined) bathrooms = l.bathrooms;

      const labels = [l.listingObjType, l.structuredContent, l.subtitle, l.listingSubtitle, l.formattedBadges]
        .filter(Boolean).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
      if (bedrooms === 0) {
        const brMatch = labels.match(/(\d+)\s*bedroom/i);
        if (brMatch) bedrooms = parseInt(brMatch[1]);
      }
      if (beds === 0) {
        const bedMatch = labels.match(/(\d+)\s*bed(?!room)/i);
        if (bedMatch) beds = parseInt(bedMatch[1]);
      }
      if (bathrooms === 0) {
        const bathMatch = labels.match(/(\d+\.?\d*)\s*bath/i);
        if (bathMatch) bathrooms = parseFloat(bathMatch[1]);
      }

      let rating = 0, reviewCount = 0;
      if (l.avgRating) rating = l.avgRating;
      if (l.avgRatingA11yLabel) {
        const rm = l.avgRatingA11yLabel.match(/([\d.]+)/);
        if (rm) rating = parseFloat(rm[1]);
      }
      if (l.reviewsCount) reviewCount = l.reviewsCount;
      if (l.reviews_count) reviewCount = l.reviews_count;

      const isSuperhost = !!(l.isSuperhost || l.is_superhost);
      const isGuestFavorite = !!(l.isGuestFavorite || l.guestFavorite);

      let propertyType = roomType || l.listingObjType || l.propertyType || l.property_type || '';
      if (typeof propertyType !== 'string') propertyType = '';

      return {
        id: String(id), name, pricePerNight, totalPrice, bedrooms, beds, bathrooms,
        rating, reviewCount, propertyType: normalizePropertyType(propertyType),
        isSuperhost, isGuestFavorite,
        url: id ? `https://www.airbnb.com/rooms/${id}` : ''
      };
    } catch (e) {
      return null;
    }
  }

  function extractAmount(obj) {
    if (typeof obj === 'number') return obj;
    if (typeof obj === 'string') return parsePrice(obj);
    if (obj && obj.amount) return parseFloat(obj.amount) || 0;
    if (obj && obj.amountFormatted) return parsePrice(obj.amountFormatted);
    if (obj && obj.total) return extractAmount(obj.total);
    return 0;
  }

  function parsePrice(str) {
    if (!str) return 0;
    const match = String(str).replace(/,/g, '').match(/[\d]+\.?\d*/);
    return match ? parseFloat(match[0]) : 0;
  }

  function normalizePropertyType(type) {
    const t = type.toLowerCase();
    if (t.includes('entire') && t.includes('home')) return 'Entire home';
    if (t.includes('entire') && t.includes('apt')) return 'Entire apt';
    if (t.includes('entire') && t.includes('condo')) return 'Entire condo';
    if (t.includes('entire')) return 'Entire place';
    if (t.includes('private') && t.includes('room')) return 'Private room';
    if (t.includes('shared') && t.includes('room')) return 'Shared room';
    if (t.includes('hotel')) return 'Hotel room';
    return type || 'Unknown';
  }

  // ── DOM Scraping Fallback ──────────────────────────────────────────────────
  function scrapeDom() {
    const cards = document.querySelectorAll('[itemprop="itemListElement"], [data-testid="card-container"], [id^="listing-card"]');
    const allLinks = document.querySelectorAll('a[href*="/rooms/"]');
    const cardSet = new Set();
    for (const card of cards) cardSet.add(card);
    for (const link of allLinks) {
      const container = link.closest('[class*="card"], [class*="listing"], div[style*="position"]');
      if (container) cardSet.add(container);
    }

    let added = 0;
    for (const card of cardSet) {
      const listing = extractFromCard(card);
      if (listing && listing.id && listing.pricePerNight > 0 && !listings.has(listing.id)) {
        listings.set(listing.id, listing);
        added++;
      }
    }
    if (added > 0) updatePanel();
  }

  function extractFromCard(card) {
    try {
      const link = card.querySelector('a[href*="/rooms/"]') || card.closest('a[href*="/rooms/"]');
      if (!link) return null;
      const hrefMatch = link.href.match(/\/rooms\/(\d+)/);
      if (!hrefMatch) return null;
      const id = hrefMatch[1];

      const text = card.textContent || '';

      let rawPrice = 0, totalPrice = 0, pricePerNight = 0, nightsFromCard = 0;

      const nightsMatch = text.match(/for\s+(\d+)\s+nights?/i);
      if (nightsMatch) nightsFromCard = parseInt(nightsMatch[1]);

      const priceEls = card.querySelectorAll('span, div');
      for (const el of priceEls) {
        const t = el.textContent.trim();
        if (/^\$[\d,]+$/.test(t) && t.length < 8) {
          const p = parsePrice(t);
          if (p > 0 && p < 100000) { rawPrice = p; break; }
        }
      }
      if (rawPrice === 0) {
        const pm2 = text.match(/\$([\d,]+)/);
        if (pm2) rawPrice = parsePrice(pm2[0]);
      }

      const nights = nightsFromCard || detectedNights;
      if (nights > 1 && rawPrice > 0) {
        totalPrice = rawPrice;
        pricePerNight = Math.round(rawPrice / nights);
      } else if (text.match(/\$([\d,]+)\s*(?:\/\s*night|per\s*night|night)/i)) {
        pricePerNight = rawPrice;
      } else if (rawPrice > 0) {
        pricePerNight = rawPrice;
        if (detectedNights > 1 && rawPrice > 500) {
          totalPrice = rawPrice;
          pricePerNight = Math.round(rawPrice / detectedNights);
        }
      }

      let bedrooms = 0, beds = 0, bathrooms = 0;
      const brM = text.match(/(\d+)\s*bedroom/i);
      if (brM) bedrooms = parseInt(brM[1]);
      const beM = text.match(/(\d+)\s*bed(?!room)/i);
      if (beM) beds = parseInt(beM[1]);
      const baM = text.match(/(\d+\.?\d*)\s*bath/i);
      if (baM) bathrooms = parseFloat(baM[1]);

      let rating = 0, reviewCount = 0;
      const ratingM = text.match(/([\d.]+)\s*\((\d+)\)/);
      if (ratingM) { rating = parseFloat(ratingM[1]); reviewCount = parseInt(ratingM[2]); }

      const nameEl = card.querySelector('[id*="title"], [data-testid*="title"]');
      const name = nameEl ? nameEl.textContent.trim() : '';

      const isSuperhost = text.toLowerCase().includes('superhost');
      const isGuestFavorite = text.toLowerCase().includes('guest favorite');

      return {
        id, name, pricePerNight, totalPrice, bedrooms, beds, bathrooms,
        rating, reviewCount, propertyType: 'Unknown', isSuperhost, isGuestFavorite,
        url: `https://www.airbnb.com/rooms/${id}`
      };
    } catch (e) {
      return null;
    }
  }

  // ── Statistics ──────────────────────────────────────────────────────────────
  function computeStats() {
    const all = Array.from(listings.values());
    if (all.length === 0) return null;
    const prices = all.map(l => l.pricePerNight).sort((a, b) => a - b);

    const byBedroom = {};
    for (const l of all) {
      const key = l.bedrooms === 0 ? 'Studio' : `${l.bedrooms} BR`;
      if (!byBedroom[key]) byBedroom[key] = [];
      byBedroom[key].push(l.pricePerNight);
    }

    const byType = {};
    for (const l of all) {
      const key = l.propertyType || 'Unknown';
      if (!byType[key]) byType[key] = [];
      byType[key].push(l.pricePerNight);
    }

    const guestFavCount = all.filter(l => l.isGuestFavorite).length;

    return {
      count: all.length,
      avg: avg(prices),
      median: percentile(prices, 50),
      min: prices[0],
      max: prices[prices.length - 1],
      p25: percentile(prices, 25),
      p75: percentile(prices, 75),
      byBedroom: summarizeGroups(byBedroom),
      byType: summarizeGroups(byType),
      prices,
      superhostCount: all.filter(l => l.isSuperhost).length,
      guestFavCount,
      avgRating: avg(all.filter(l => l.rating > 0).map(l => l.rating))
    };
  }

  function avg(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const i = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function summarizeGroups(groups) {
    const result = {};
    for (const [key, prices] of Object.entries(groups)) {
      const sorted = prices.sort((a, b) => a - b);
      result[key] = {
        count: prices.length,
        avg: avg(sorted),
        median: percentile(sorted, 50),
        min: sorted[0],
        max: sorted[sorted.length - 1]
      };
    }
    return Object.fromEntries(
      Object.entries(result).sort((a, b) => b[1].count - a[1].count)
    );
  }

  // ── My Listing Percentile ─────────────────────────────────────────────────
  function getMyPricePercentile(prices) {
    if (!myPrice || prices.length === 0) return null;
    const below = prices.filter(p => p < myPrice).length;
    const equal = prices.filter(p => p === myPrice).length;
    const pct = Math.round(((below + equal * 0.5) / prices.length) * 100);
    return pct;
  }

  function getMyPriceLabel(prices) {
    const pct = getMyPricePercentile(prices);
    if (pct === null) return '';
    if (pct <= 50) {
      return `Cheaper than ${100 - pct}% of listings`;
    } else {
      return `More expensive than ${pct}% of listings`;
    }
  }

  // ── Histogram ──────────────────────────────────────────────────────────────
  function buildHistogram(prices, bucketCount = 14) {
    if (prices.length < 2) return '<div class="abspy-empty">Not enough data for distribution</div>';
    const min = prices[0];
    const max = prices[prices.length - 1];
    const range = max - min;
    if (range === 0) return '';

    const bucketSize = range / bucketCount;
    const buckets = new Array(bucketCount).fill(0);
    for (const p of prices) {
      let idx = Math.floor((p - min) / bucketSize);
      if (idx >= bucketCount) idx = bucketCount - 1;
      buckets[idx]++;
    }

    const maxCount = Math.max(...buckets);

    // Find which bucket myPrice falls in
    let myBucketIdx = -1;
    if (myPrice > 0) {
      myBucketIdx = Math.floor((myPrice - min) / bucketSize);
      if (myBucketIdx >= bucketCount) myBucketIdx = bucketCount - 1;
      if (myBucketIdx < 0) myBucketIdx = 0;
    }

    let html = '<div class="abspy-histogram">';
    for (let i = 0; i < bucketCount; i++) {
      const pct = maxCount > 0 ? (buckets[i] / maxCount) * 100 : 0;
      const lo = Math.round(min + i * bucketSize);
      const hi = Math.round(min + (i + 1) * bucketSize);
      const isMyBucket = i === myBucketIdx;
      const barClass = isMyBucket ? 'abspy-hist-bar abspy-hist-bar-mine' : 'abspy-hist-bar';
      html += `<div class="abspy-hist-bar-wrap" title="$${lo}-$${hi}: ${buckets[i]} listings${isMyBucket ? ' (YOUR PRICE)' : ''}">
        <div class="abspy-hist-count">${buckets[i] > 0 ? buckets[i] : ''}</div>
        <div class="${barClass}" style="height:${pct}%"></div>
        ${isMyBucket ? '<div class="abspy-hist-mine-marker">YOU</div>' : ''}
        <div class="abspy-hist-label">$${lo}</div>
      </div>`;
    }
    html += '</div>';

    if (myPrice > 0) {
      const pctLabel = getMyPriceLabel(prices);
      html += `<div class="abspy-my-price-note">Your $${Math.round(myPrice).toLocaleString()}/night: ${pctLabel}</div>`;
    }

    return html;
  }

  // ── Auto-Collect ───────────────────────────────────────────────────────────
  async function startAutoCollect() {
    if (autoCollecting) return;
    autoCollecting = true;
    autoCollectAbort = false;
    autoCollectPage = 1;
    updateAutoCollectUI();

    while (autoCollecting && !autoCollectAbort) {
      // Step 1: Scroll through the current page to trigger lazy-loading
      updateAutoCollectStatus(`Scrolling page ${autoCollectPage}...`);

      const listingsArea = document.querySelector('[itemprop="itemList"]')
        || document.querySelector('main')
        || document.documentElement;

      // Scroll incrementally down the listings area
      const scrollContainer = document.documentElement;
      const startScroll = scrollContainer.scrollTop;
      const maxScroll = scrollContainer.scrollHeight - window.innerHeight;
      const scrollStep = window.innerHeight * 0.7;

      for (let pos = startScroll; pos < maxScroll; pos += scrollStep) {
        if (autoCollectAbort) break;
        scrollContainer.scrollTo({ top: pos, behavior: 'smooth' });
        await sleep(800);
        scrapeDom();
        updatePanel();
      }

      // Scroll to very bottom
      if (!autoCollectAbort) {
        scrollContainer.scrollTo({ top: maxScroll, behavior: 'smooth' });
        await sleep(1000);
        scrapeDom();
        updatePanel();
      }

      if (autoCollectAbort) break;

      // Step 2: Find and click "Next" pagination button
      const nextBtn = findNextButton();
      if (!nextBtn) {
        updateAutoCollectStatus('All pages collected!');
        await sleep(2000);
        break;
      }

      autoCollectPage++;
      updateAutoCollectStatus(`Loading page ${autoCollectPage}...`);

      nextBtn.click();
      await sleep(2500); // Wait for page to load

      // Wait for new content to appear
      await waitForNewContent(1500);
      detectNights();

      // Scroll back to top for next pass
      scrollContainer.scrollTo({ top: 0, behavior: 'instant' });
      await sleep(500);
    }

    autoCollecting = false;
    updateAutoCollectUI();
  }

  function stopAutoCollect() {
    autoCollectAbort = true;
    autoCollecting = false;
    updateAutoCollectUI();
  }

  function findNextButton() {
    // Look for the "Next" pagination link/button
    const allLinks = document.querySelectorAll('a[aria-label*="Next"], a[aria-label*="next"]');
    if (allLinks.length > 0) return allLinks[0];

    // Fallback: look for pagination nav with "next" in it
    const navLinks = document.querySelectorAll('nav a');
    for (const l of navLinks) {
      if (l.textContent.trim().toLowerCase() === 'next' || l.getAttribute('aria-label')?.toLowerCase().includes('next')) {
        return l;
      }
    }

    // Fallback: look for SVG arrow buttons in pagination
    const paginationBtns = document.querySelectorAll('nav[aria-label*="earch"] a, nav[aria-label*="agination"] a, nav[role="navigation"] a');
    for (const btn of paginationBtns) {
      const ariaLabel = btn.getAttribute('aria-label') || '';
      if (ariaLabel.toLowerCase().includes('next')) return btn;
    }

    return null;
  }

  function waitForNewContent(ms) {
    return new Promise(resolve => {
      const observer = new MutationObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(); }, ms);
    });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function updateAutoCollectUI() {
    const btn = panelEl?.querySelector('#abspy-autocollect');
    if (!btn) return;
    if (autoCollecting) {
      btn.textContent = 'Stop';
      btn.classList.add('abspy-btn-stop');
    } else {
      btn.textContent = 'Collect All';
      btn.classList.remove('abspy-btn-stop');
    }
  }

  function updateAutoCollectStatus(msg) {
    const el = panelEl?.querySelector('#abspy-collect-status');
    if (el) el.textContent = msg;
    const countEl = panelEl?.querySelector('#abspy-count');
    if (countEl) {
      const nightsInfo = detectedNights > 0 ? ` · ${detectedNights}n stay` : '';
      countEl.textContent = `(${listings.size} listings${nightsInfo})`;
    }
  }

  // ── CSV Export ──────────────────────────────────────────────────────────────
  function exportCsv() {
    const all = Array.from(listings.values());
    if (all.length === 0) return;
    const nights = detectedNights || 1;
    const headers = ['ID', 'Name', 'Price/Night', 'Total Price', 'Nights', 'Bedrooms', 'Beds', 'Bathrooms', 'Rating', 'Reviews', 'Property Type', 'Superhost', 'Guest Favorite', 'URL'];
    const rows = all.map(l => [
      l.id,
      `"${(l.name || '').replace(/"/g, '""')}"`,
      l.pricePerNight,
      l.totalPrice || (l.pricePerNight * nights),
      nights, l.bedrooms, l.beds, l.bathrooms, l.rating, l.reviewCount,
      l.propertyType, l.isSuperhost ? 'Yes' : 'No', l.isGuestFavorite ? 'Yes' : 'No', l.url
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `airbnbspy_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Panel UI ───────────────────────────────────────────────────────────────
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'abspy-panel';
    panel.innerHTML = `
      <div id="abspy-header">
        <div id="abspy-header-top">
          <span id="abspy-title">AirbnbSpy</span>
          <span id="abspy-count">(0 listings)</span>
          <div id="abspy-header-icons">
            <button id="abspy-refresh" title="Re-scan page">&#x21bb;</button>
            <button id="abspy-export" title="Export CSV">&#x2913;</button>
            <button id="abspy-clear" title="Clear data">&#x2715;</button>
            <button id="abspy-toggle">&#x25BC;</button>
          </div>
        </div>
        <div id="abspy-header-actions">
          <button id="abspy-autocollect" title="Auto-scroll and paginate to collect all listings">Collect All</button>
        </div>
      </div>
      <div id="abspy-myprice-bar">
        <label for="abspy-myprice-input">My Price:</label>
        <div class="abspy-myprice-input-wrap">
          <span class="abspy-myprice-dollar">$</span>
          <input type="number" id="abspy-myprice-input" placeholder="0" min="0" value="${myPrice || ''}">
          <span class="abspy-myprice-suffix">/night</span>
        </div>
        <span id="abspy-myprice-result"></span>
      </div>
      <div id="abspy-collect-status"></div>
      <div id="abspy-tabs">
        <button class="abspy-tab active" data-tab="overview">Overview</button>
        <button class="abspy-tab" data-tab="bedrooms">By Bedrooms</button>
        <button class="abspy-tab" data-tab="types">By Type</button>
        <button class="abspy-tab" data-tab="chart">Distribution</button>
      </div>
      <div id="abspy-body">
        <div class="abspy-empty">Browse Airbnb search results to collect pricing data...</div>
      </div>
    `;
    document.body.appendChild(panel);
    panelEl = panel;

    // Event listeners
    panel.querySelector('#abspy-toggle').addEventListener('click', togglePanel);
    panel.querySelector('#abspy-export').addEventListener('click', exportCsv);
    panel.querySelector('#abspy-refresh').addEventListener('click', () => { scrapeDom(); });
    panel.querySelector('#abspy-clear').addEventListener('click', () => {
      listings.clear();
      updatePanel();
    });

    // Auto-collect button
    panel.querySelector('#abspy-autocollect').addEventListener('click', () => {
      if (autoCollecting) { stopAutoCollect(); } else { startAutoCollect(); }
    });

    // My Price input
    const priceInput = panel.querySelector('#abspy-myprice-input');
    priceInput.addEventListener('input', () => {
      myPrice = parseFloat(priceInput.value) || 0;
      if (myPrice > 0) {
        localStorage.setItem('abspy_my_price', myPrice);
      } else {
        localStorage.removeItem('abspy_my_price');
      }
      updatePanel();
    });

    // Tabs
    panel.querySelectorAll('.abspy-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        panel.querySelectorAll('.abspy-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.tab;
        updatePanel();
      });
    });

    makeDraggable(panel, panel.querySelector('#abspy-header'));
  }

  function togglePanel() {
    panelCollapsed = !panelCollapsed;
    const body = panelEl.querySelector('#abspy-body');
    const tabs = panelEl.querySelector('#abspy-tabs');
    const myPriceBar = panelEl.querySelector('#abspy-myprice-bar');
    const collectStatus = panelEl.querySelector('#abspy-collect-status');
    const btn = panelEl.querySelector('#abspy-toggle');
    const hidden = panelCollapsed ? 'none' : '';
    body.style.display = panelCollapsed ? 'none' : 'block';
    tabs.style.display = panelCollapsed ? 'none' : 'flex';
    myPriceBar.style.display = panelCollapsed ? 'none' : 'flex';
    collectStatus.style.display = panelCollapsed ? 'none' : 'block';
    btn.innerHTML = panelCollapsed ? '&#x25B2;' : '&#x25BC;';
  }

  function makeDraggable(panel, handle) {
    let isDragging = false, startX, startY, startLeft, startTop;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = (startLeft + e.clientX - startX) + 'px';
      panel.style.top = (startTop + e.clientY - startY) + 'px';
    });
    document.addEventListener('mouseup', () => { isDragging = false; });
  }

  function updatePanel() {
    if (!panelEl) return;
    const stats = computeStats();
    const body = panelEl.querySelector('#abspy-body');
    const countEl = panelEl.querySelector('#abspy-count');
    const nightsInfo = detectedNights > 0 ? ` · ${detectedNights}n stay` : '';
    countEl.textContent = `(${listings.size} listings${nightsInfo})`;

    // Update My Price result
    const myPriceResult = panelEl.querySelector('#abspy-myprice-result');
    if (stats && myPrice > 0) {
      myPriceResult.textContent = getMyPriceLabel(stats.prices);
      myPriceResult.style.display = 'block';
    } else {
      myPriceResult.textContent = '';
      myPriceResult.style.display = 'none';
    }

    if (!stats) {
      body.innerHTML = '<div class="abspy-empty">Browse Airbnb search results to collect pricing data...</div>';
      return;
    }

    const fmt = (n) => '$' + Math.round(n).toLocaleString();

    if (activeTab === 'overview') {
      // Build "My Price" comparison row if set
      let myPriceRow = '';
      if (myPrice > 0) {
        const pct = getMyPricePercentile(stats.prices);
        const pctColor = pct <= 30 ? '#53d769' : pct <= 60 ? '#f5a623' : '#e94560';
        myPriceRow = `
          <tr class="abspy-sep"><td colspan="2" style="color:#8899aa;font-size:11px;padding-top:10px">Your Listing</td></tr>
          <tr><td>Your Price</td><td class="abspy-val" style="color:${pctColor}">${fmt(myPrice)}/night</td></tr>
          <tr><td>Percentile</td><td class="abspy-val" style="color:${pctColor}">${pct}th percentile</td></tr>
          <tr><td>vs Median</td><td class="abspy-val" style="color:${pctColor}">${myPrice > stats.median ? '+' : ''}${fmt(myPrice - stats.median)} (${myPrice > stats.median ? '+' : ''}${Math.round((myPrice - stats.median) / stats.median * 100)}%)</td></tr>
        `;
      }

      const totalRow = detectedNights > 1
        ? `<tr class="abspy-sep"><td colspan="2" style="color:#8899aa;font-size:11px;padding-top:10px">Total for ${detectedNights}-night stay</td></tr>
           <tr><td>Avg Total</td><td class="abspy-val">${fmt(stats.avg * detectedNights)}</td></tr>
           <tr><td>Med Total</td><td class="abspy-val">${fmt(stats.median * detectedNights)}</td></tr>`
        : '';

      body.innerHTML = `
        <table class="abspy-table">
          <tr><td>Average</td><td class="abspy-val">${fmt(stats.avg)}/night</td></tr>
          <tr><td>Median</td><td class="abspy-val">${fmt(stats.median)}/night</td></tr>
          <tr><td>Min</td><td class="abspy-val">${fmt(stats.min)}/night</td></tr>
          <tr><td>Max</td><td class="abspy-val">${fmt(stats.max)}/night</td></tr>
          <tr><td>25th %ile</td><td class="abspy-val">${fmt(stats.p25)}/night</td></tr>
          <tr><td>75th %ile</td><td class="abspy-val">${fmt(stats.p75)}/night</td></tr>
          ${totalRow}
          ${myPriceRow}
          <tr class="abspy-sep"><td>Avg Rating</td><td class="abspy-val">${stats.avgRating > 0 ? stats.avgRating.toFixed(2) + ' ★' : 'N/A'}</td></tr>
          <tr><td>Superhosts</td><td class="abspy-val">${stats.superhostCount} (${Math.round(stats.superhostCount / stats.count * 100)}%)</td></tr>
          <tr><td>Guest Favorites</td><td class="abspy-val">${stats.guestFavCount} (${Math.round(stats.guestFavCount / stats.count * 100)}%)</td></tr>
          <tr><td>Total Listings</td><td class="abspy-val">${stats.count}</td></tr>
        </table>
        <div class="abspy-note">Per-night = total cost ÷ nights (includes cleaning fees, service fees & taxes)</div>
      `;
    } else if (activeTab === 'bedrooms') {
      body.innerHTML = buildGroupTable(stats.byBedroom);
    } else if (activeTab === 'types') {
      body.innerHTML = buildGroupTable(stats.byType);
    } else if (activeTab === 'chart') {
      body.innerHTML = buildHistogram(stats.prices);
    }
  }

  function buildGroupTable(groups) {
    if (!groups || Object.keys(groups).length === 0) {
      return '<div class="abspy-empty">Not enough data yet</div>';
    }
    let html = `<table class="abspy-table">
      <tr class="abspy-thead"><th>Type</th><th>#</th><th>Avg</th><th>Med</th><th>Range</th></tr>`;
    const fmt = (n) => '$' + Math.round(n).toLocaleString();
    for (const [key, s] of Object.entries(groups)) {
      // Highlight row if myPrice is set and falls in this group's range
      const rowClass = (myPrice > 0 && myPrice >= s.min && myPrice <= s.max) ? ' class="abspy-row-highlight"' : '';
      html += `<tr${rowClass}>
        <td>${key}</td>
        <td>${s.count}</td>
        <td class="abspy-val">${fmt(s.avg)}</td>
        <td class="abspy-val">${fmt(s.median)}</td>
        <td class="abspy-val">${fmt(s.min)}-${fmt(s.max)}</td>
      </tr>`;
    }
    html += '</table>';
    if (myPrice > 0) {
      html += `<div class="abspy-note">Rows highlighted where your $${Math.round(myPrice).toLocaleString()}/night falls within range</div>`;
    }
    return html;
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  GM_addStyle(`
    /* ── Keyframes ── */
    @keyframes abspy-slideIn {
      from { opacity: 0; transform: translateY(24px) scale(0.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes abspy-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(83,215,105,0.4); }
      50% { box-shadow: 0 0 0 6px rgba(83,215,105,0); }
    }
    @keyframes abspy-pulseStop {
      0%, 100% { box-shadow: 0 0 0 0 rgba(233,69,96,0.4); }
      50% { box-shadow: 0 0 0 6px rgba(233,69,96,0); }
    }
    @keyframes abspy-shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes abspy-barGrow {
      from { transform: scaleY(0); }
      to { transform: scaleY(1); }
    }

    /* ── Panel ── */
    #abspy-panel {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 390px;
      max-height: 85vh;
      background: rgba(12, 12, 28, 0.82);
      backdrop-filter: blur(24px) saturate(1.6);
      -webkit-backdrop-filter: blur(24px) saturate(1.6);
      color: #e4e4ef;
      border-radius: 16px;
      box-shadow:
        0 0 0 1px rgba(255,255,255,0.08),
        0 4px 16px rgba(0,0,0,0.3),
        0 12px 48px rgba(0,0,0,0.4),
        inset 0 1px 0 rgba(255,255,255,0.06);
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
      font-size: 13px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.06);
      animation: abspy-slideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    /* ── Header ── */
    #abspy-header {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 16px;
      background: linear-gradient(135deg, rgba(22,33,62,0.7), rgba(15,52,96,0.5));
      cursor: move;
      user-select: none;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    #abspy-header-top {
      display: flex;
      align-items: center;
      width: 100%;
    }
    #abspy-title {
      font-weight: 800;
      font-size: 15px;
      background: linear-gradient(135deg, #ff6b6b, #e94560);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      letter-spacing: 0.3px;
    }
    #abspy-count {
      margin-left: 10px;
      font-size: 10px;
      color: #6b7a8d;
      background: rgba(255,255,255,0.05);
      padding: 3px 8px;
      border-radius: 10px;
      font-weight: 500;
      letter-spacing: 0.2px;
      white-space: nowrap;
    }
    #abspy-header-icons {
      margin-left: auto;
      display: flex;
      gap: 5px;
    }
    #abspy-header-icons button {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.06);
      color: #7a8a9d;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      padding: 0;
    }
    #abspy-header-icons button:hover {
      background: rgba(255,255,255,0.12);
      border-color: rgba(255,255,255,0.12);
      color: #fff;
      transform: translateY(-1px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }
    #abspy-header-icons button:active {
      transform: translateY(0);
    }

    /* ── Collect All Row ── */
    #abspy-header-actions {
      display: flex;
      width: 100%;
    }
    #abspy-autocollect {
      width: 100%;
      height: 32px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: #53d769;
      border: 1px solid rgba(83,215,105,0.25);
      background: rgba(83,215,105,0.06);
      text-transform: uppercase;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    #abspy-autocollect:hover {
      background: rgba(83,215,105,0.14);
      border-color: rgba(83,215,105,0.4);
      box-shadow: 0 2px 12px rgba(83,215,105,0.15);
    }
    #abspy-autocollect.abspy-btn-stop {
      color: #ff6b6b;
      border-color: rgba(233,69,96,0.25);
      background: rgba(233,69,96,0.06);
      animation: abspy-pulseStop 2s ease-in-out infinite;
    }
    #abspy-autocollect.abspy-btn-stop:hover {
      background: rgba(233,69,96,0.14);
      border-color: rgba(233,69,96,0.4);
    }

    /* ── My Price Bar ── */
    #abspy-myprice-bar {
      display: flex;
      align-items: center;
      padding: 10px 16px;
      background: rgba(0,0,0,0.2);
      border-bottom: 1px solid rgba(255,255,255,0.04);
      border-left: 3px solid rgba(245,166,35,0.5);
      gap: 8px;
      flex-wrap: wrap;
    }
    #abspy-myprice-bar label {
      font-size: 11px;
      font-weight: 700;
      color: #7a8a9d;
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .abspy-myprice-input-wrap {
      display: flex;
      align-items: center;
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
      padding: 0 10px;
      border: 1px solid rgba(255,255,255,0.08);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .abspy-myprice-input-wrap:focus-within {
      border-color: rgba(233,69,96,0.5);
      box-shadow: 0 0 0 3px rgba(233,69,96,0.1), 0 2px 8px rgba(233,69,96,0.08);
      background: rgba(255,255,255,0.07);
    }
    .abspy-myprice-dollar {
      color: #7a8a9d;
      font-size: 14px;
      font-weight: 700;
    }
    #abspy-myprice-input {
      background: none;
      border: none;
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      width: 70px;
      padding: 6px 4px;
      outline: none;
      font-family: inherit;
    }
    #abspy-myprice-input::placeholder { color: #3a4555; }
    #abspy-myprice-input::-webkit-inner-spin-button,
    #abspy-myprice-input::-webkit-outer-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    .abspy-myprice-suffix {
      color: #556;
      font-size: 11px;
      font-weight: 500;
    }
    #abspy-myprice-result {
      font-size: 11px;
      color: #f5a623;
      font-weight: 600;
      width: 100%;
      padding-left: 76px;
      padding-top: 2px;
    }

    /* ── Collect Status ── */
    #abspy-collect-status {
      font-size: 11px;
      color: #53d769;
      text-align: center;
      padding: 0;
      min-height: 0;
      transition: all 0.25s;
      font-weight: 500;
      letter-spacing: 0.2px;
    }
    #abspy-collect-status:not(:empty) {
      padding: 7px 16px;
      background: linear-gradient(90deg, rgba(83,215,105,0.04), rgba(83,215,105,0.08), rgba(83,215,105,0.04));
      background-size: 200% 100%;
      animation: abspy-shimmer 2s linear infinite;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }

    /* ── Tabs ── */
    #abspy-tabs {
      display: flex;
      background: rgba(0,0,0,0.15);
      border-bottom: 1px solid rgba(255,255,255,0.04);
      padding: 0 4px;
    }
    .abspy-tab {
      flex: 1;
      padding: 9px 4px;
      background: none;
      border: none;
      color: #6b7a8d;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      letter-spacing: 0.2px;
    }
    .abspy-tab:hover {
      color: #b0bec5;
      background: rgba(255,255,255,0.02);
    }
    .abspy-tab.active {
      color: #ff6b6b;
      border-image: linear-gradient(90deg, #e94560, #ff6b6b) 1;
    }

    /* ── Body ── */
    #abspy-body {
      padding: 14px 16px;
      overflow-y: auto;
      max-height: 55vh;
    }

    /* Custom scrollbar */
    #abspy-body::-webkit-scrollbar {
      width: 5px;
    }
    #abspy-body::-webkit-scrollbar-track {
      background: transparent;
    }
    #abspy-body::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.1);
      border-radius: 10px;
    }
    #abspy-body::-webkit-scrollbar-thumb:hover {
      background: rgba(255,255,255,0.2);
    }

    .abspy-empty {
      text-align: center;
      color: #4a5568;
      padding: 28px 14px;
      font-size: 12px;
      font-weight: 500;
    }

    /* ── Table ── */
    .abspy-table {
      width: 100%;
      border-collapse: collapse;
    }
    .abspy-table td, .abspy-table th {
      padding: 7px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      text-align: left;
      transition: background 0.15s;
    }
    .abspy-table tr:hover td {
      background: rgba(255,255,255,0.02);
    }
    .abspy-table td:first-child {
      color: #8899aa;
      font-weight: 500;
    }
    .abspy-table th {
      color: #6b7a8d;
      font-weight: 700;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding-bottom: 10px;
    }
    .abspy-val {
      text-align: right !important;
      font-variant-numeric: tabular-nums;
      font-weight: 700;
      color: #5ee67a;
      text-shadow: 0 0 12px rgba(94,230,122,0.15);
    }
    .abspy-sep td {
      border-top: 1px solid rgba(255,255,255,0.06);
      padding-top: 12px;
    }
    .abspy-thead th { font-size: 10px; }

    .abspy-note {
      margin-top: 12px;
      padding: 8px 10px;
      background: rgba(255,255,255,0.03);
      border-radius: 8px;
      font-size: 10px;
      color: #6b7a8d;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.03);
    }
    .abspy-row-highlight {
      background: rgba(233,69,96,0.06) !important;
    }
    .abspy-row-highlight td {
      border-bottom-color: rgba(233,69,96,0.1) !important;
    }

    /* ── Histogram ── */
    .abspy-histogram {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      height: 170px;
      padding-bottom: 30px;
      padding-top: 18px;
      position: relative;
    }
    .abspy-hist-bar-wrap {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      justify-content: flex-end;
      position: relative;
    }
    .abspy-hist-count {
      font-size: 9px;
      color: #556;
      margin-bottom: 3px;
      font-weight: 600;
    }
    .abspy-hist-bar {
      width: 100%;
      background: linear-gradient(to top, #e94560, rgba(255,107,107,0.7));
      border-radius: 4px 4px 0 0;
      min-height: 2px;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      transform-origin: bottom;
      animation: abspy-barGrow 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .abspy-hist-bar-wrap:hover .abspy-hist-bar {
      background: linear-gradient(to top, #ff6b81, rgba(255,107,129,0.85));
      box-shadow: 0 0 12px rgba(233,69,96,0.25);
      transform: scaleX(1.08);
    }
    .abspy-hist-bar-mine {
      background: linear-gradient(to top, #f5a623, rgba(255,193,68,0.8)) !important;
      box-shadow: 0 0 14px rgba(245,166,35,0.3);
    }
    .abspy-hist-bar-wrap:hover .abspy-hist-bar-mine {
      box-shadow: 0 0 20px rgba(245,166,35,0.4);
    }
    .abspy-hist-mine-marker {
      position: absolute;
      bottom: -28px;
      font-size: 8px;
      font-weight: 800;
      color: #f5a623;
      text-align: center;
      letter-spacing: 1px;
      text-shadow: 0 0 8px rgba(245,166,35,0.4);
    }
    .abspy-hist-label {
      position: absolute;
      bottom: -22px;
      font-size: 8px;
      color: #4a5568;
      transform: rotate(-40deg);
      white-space: nowrap;
      font-weight: 500;
    }
    .abspy-my-price-note {
      margin-top: 16px;
      padding: 10px 12px;
      background: rgba(245,166,35,0.06);
      border: 1px solid rgba(245,166,35,0.15);
      border-radius: 10px;
      font-size: 12px;
      color: #f5a623;
      text-align: center;
      font-weight: 700;
      text-shadow: 0 0 12px rgba(245,166,35,0.15);
    }
  `);

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    if (document.getElementById('abspy-panel')) return;
    detectNights();
    createPanel();
    setTimeout(() => { detectNights(); scrapeDom(); }, 2000);
    setTimeout(() => { detectNights(); scrapeDom(); }, 5000);

    const observer = new MutationObserver(debounce(() => scrapeDom(), 1500));
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', debounce(() => scrapeDom(), 2000));
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // SPA navigation handling
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (location.pathname.startsWith('/s/')) {
        detectedNights = 0;
        setTimeout(init, 1000);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
