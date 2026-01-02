const api = (typeof window !== 'undefined' && window.MiddletonsApiClient)
  ? window.MiddletonsApiClient
  : null;
const invoke = (...args) => {
  if (!api || typeof api.invoke !== 'function') {
    return Promise.reject(new Error('API client unavailable.'));
  }
  return api.invoke(...args);
};

const state = {
  bodyEl: null,
  titleEl: null,
  metaEl: null,
  subtotalEl: null,
  taxEl: null,
  totalEl: null,
  totalSummaryEl: null,
  changeDueWrapEl: null,
  changeDueEl: null,
  cashReceivedWrapEl: null,
  cashReceivedEl: null,
  splitTenderWrapEl: null,
  splitTenderLabelEl: null,
  splitTenderAmountEl: null,
  cardFeeWrapEl: null,
  cardFeeLabelEl: null,
  cardFeeEl: null
};

const carouselState = {
  slides: [],
  currentIndex: 0,
  timer: null,
  intervalMs: 10000
};

const layoutState = {
  cartCardEl: null
};

const carouselElements = {
  section: null,
  title: null,
  caption: null,
  image: null,
  indicators: null
};
let __pollTimer = null;
let __lastPollSignature = '';
let __eventSource = null;
let __sseConnected = false;
let __sseFallbackTimer = null;
const POLL_INTERVAL_MS = 1000;

const DEFAULT_CAROUSEL_SLIDES = [
  {
    title: 'Welcome to Middleton\'s',
    caption: 'Thank you for shopping small & local!',
    image: './assets/MiddletonsWindow2.jpg'
  },
  {
    title: 'Follow us on Facebook',
    caption: 'Be first to know about promotions, new items and events.',
    image: './assets/QR.png'
  },
  {
    title: 'Share the love',
    caption: 'Tag @MiddletonsAntiques on social to share your finds in their new space!',
    image: './assets/antiqueSocial.png'
  },
  {
    title: 'Where\s Dolly Purrton?',
    caption: 'Remember to look for our store cat Dolly Purrton if she isn\'t on the front counter the next time you stop in, a sweet discount awaits you!',
    image: './assets/Dolly Purrton.png'
  }
];

/* Customer carousel logic disabled
const carouselState = {
  slides: [],
  currentIndex: 0,
  timer: null,
  intervalMs: 7000
};
const carouselElements = {
  title: null,
  caption: null,
  image: null,
  indicators: null
};
*/

function escapeHtml(value) {
  const str = String(value || '');
  return str.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}

function safeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatMoney(value) {
  return safeNumber(value).toFixed(2);
}

function cloneDefaultSlides() {
  return DEFAULT_CAROUSEL_SLIDES.map(slide => ({ ...slide }));
}

function sanitizeSlides(source) {
  if (!Array.isArray(source)) return cloneDefaultSlides();
  const cleaned = source.map((slide) => {
    if (!slide || typeof slide !== 'object') return null;
    const title = String(slide.title || '').trim();
    const caption = String(slide.caption || '').trim();
    const image = String(slide.image || '').trim();
    if (!title && !caption && !image) return null;
    return { title, caption, image };
  }).filter(Boolean);
  return cleaned.length ? cleaned : cloneDefaultSlides();
}

function clearCarouselTimer() {
  if (carouselState.timer) {
    clearInterval(carouselState.timer);
    carouselState.timer = null;
  }
}

function restartCarouselTimer() {
  clearCarouselTimer();
  if (!carouselElements.section || !carouselState.slides.length) return;
  carouselState.timer = setInterval(() => {
    carouselState.currentIndex = (carouselState.currentIndex + 1) % carouselState.slides.length;
    renderCarouselSlide();
  }, carouselState.intervalMs);
}

function rebuildCarouselIndicators() {
  const container = carouselElements.indicators;
  if (!container) return;
  container.innerHTML = '';
  carouselState.slides.forEach((_, idx) => {
    const indicator = document.createElement('button');
    indicator.type = 'button';
    indicator.setAttribute('aria-label', `Slide ${idx + 1}`);
    indicator.className = 'customer-carousel-indicator' + (idx === carouselState.currentIndex ? ' active' : '');
    indicator.addEventListener('click', () => {
      carouselState.currentIndex = idx;
      renderCarouselSlide();
      restartCarouselTimer();
    });
    container.appendChild(indicator);
  });
}

function getCarouselMinHeight() {
  const section = carouselElements.section;
  if (!section) return 0;
  const styles = window.getComputedStyle(section);
  const minHeight = parseFloat(styles.minHeight);
  if (Number.isFinite(minHeight)) return minHeight;
  return section.getBoundingClientRect().height;
}

function updateCarouselLayout() {
  const section = carouselElements.section;
  if (!section) return;
  if (!carouselState.slides.length) {
    section.classList.add('d-none');
    return;
  }
  const cartCard = layoutState.cartCardEl;
  if (!cartCard) {
    section.classList.remove('d-none');
    return;
  }
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const cartRect = cartCard.getBoundingClientRect();
  const carouselMinHeight = getCarouselMinHeight();
  const buffer = 48;
  const shouldHide = cartRect.height + carouselMinHeight + buffer > viewportHeight;
  section.classList.toggle('d-none', shouldHide);
}

function renderCarouselSlide() {
  if (!carouselElements.section) return;
  const slides = carouselState.slides;
  const hasSlides = slides.length > 0;
  if (!hasSlides) {
    carouselElements.section.classList.add('d-none');
    return;
  }
  const slide = slides[carouselState.currentIndex] || slides[0];
  carouselState.currentIndex = slides.indexOf(slide) >= 0 ? slides.indexOf(slide) : 0;
  if (carouselElements.title) carouselElements.title.textContent = slide.title || '';
  if (carouselElements.caption) carouselElements.caption.textContent = slide.caption || '';
  if (carouselElements.image) {
    if (slide.image) {
      carouselElements.image.src = slide.image;
      carouselElements.image.style.display = '';
    } else {
      carouselElements.image.style.display = 'none';
    }
  }
  rebuildCarouselIndicators();
  updateCarouselLayout();
}

function setCarouselSlides(slides) {
  if (!carouselElements.section) return;
  carouselState.slides = sanitizeSlides(slides);
  carouselState.currentIndex = 0;
  renderCarouselSlide();
  restartCarouselTimer();
}

function initCarouselElements() {
  carouselElements.section = document.getElementById('customerCarouselSection');
  carouselElements.title = document.getElementById('customerCarouselTitle');
  carouselElements.caption = document.getElementById('customerCarouselCaption');
  carouselElements.image = document.getElementById('customerCarouselImage');
  carouselElements.indicators = document.getElementById('customerCarouselIndicators');
  if (!carouselElements.section) return;
  setCarouselSlides(DEFAULT_CAROUSEL_SLIDES);
  carouselElements.section.addEventListener('mouseenter', clearCarouselTimer);
  carouselElements.section.addEventListener('mouseleave', restartCarouselTimer);
}

function handleCarouselSlidesUpdate(_evt, slides) {
  setCarouselSlides(Array.isArray(slides) ? slides : []);
}

function renderCart(payload) {
  if (!state.bodyEl) return;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  state.bodyEl.innerHTML = '';
  if (!items.length) {
    state.bodyEl.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-5">Welcome to Middletons! Thank you for shopping small!</td></tr>';
  } else {
    items.forEach((item) => {
      const tr = document.createElement('tr');
      const qty = Math.max(0, safeNumber(item.quantity));
      const vendorParts = [];
      if (item.comment) vendorParts.push(escapeHtml(item.comment));
      const meta = vendorParts.length ? `<div class="text-muted small">${vendorParts.join(' A? ')}</div>` : '';
      let discountBlock = '';
      if (item.hasDiscount && safeNumber(item.discountAmount) > 0) {
        const suffix = item.discountSuffix ? ` ${escapeHtml(item.discountSuffix)}` : '';
        discountBlock = `
          <div class="text-danger small text-uppercase">Discount: -$${formatMoney(item.discountAmount)}${suffix}</div>
          <div class="text-muted small text-decoration-line-through">Original (unit): $${formatMoney(item.originalPrice)}</div>`;
      }
      tr.innerHTML = `
        <td>
          <div class="fw-semibold">${escapeHtml(item.name)}</div>
          ${meta}
          ${discountBlock}
        </td>
        <td class="text-center fs-4">${qty}</td>
        <td class="text-end">
          <div class="fw-semibold">$${formatMoney(item.total)}</div>
          <div class="text-muted small">${formatMoney(item.unitPrice)} ea</div>
        </td>`;
      state.bodyEl.appendChild(tr);
    });
  }
  const subtotal = formatMoney(payload?.subtotal);
  const tax = formatMoney(payload?.tax);
  const total = formatMoney(payload?.total);
  state.subtotalEl.textContent = subtotal;
  state.taxEl.textContent = tax;
  state.totalEl.textContent = total;
  state.totalSummaryEl.textContent = total;
  state.titleEl.textContent = payload?.cartTitle?.trim() || 'Current Cart';
  const paymentValue = String(payload?.payment || '');
  const changeDueText = formatMoney(payload?.changeDue);
  const cashReceivedText = formatMoney(payload?.cashReceived);
  const splitEnabled = !!payload?.splitTenderEnabled;
  const splitType = String(payload?.splitTenderType || '');
  const splitAmount = safeNumber(payload?.splitTenderAmount);
  const cardFee = safeNumber(payload?.cardFee);
  const isCashPayment = paymentValue.trim().toLowerCase() === 'cash'
    || (splitEnabled && splitType.trim().toLowerCase() === 'cash');
  const metaPieces = [];
  if (payload?.cashier) metaPieces.push(`Cashier: ${payload.cashier}`);
  if (payload?.payment) metaPieces.push(`Payment: ${payload.payment}`);
  const metaSeparator = ` ${String.fromCodePoint(0x2022)} `;
  state.metaEl.textContent = metaPieces.join(metaSeparator) || 'Thank You for Shopping Small!';
  if (state.changeDueWrapEl && state.changeDueEl) {
    state.changeDueEl.textContent = changeDueText;
    state.changeDueWrapEl.classList.toggle('d-none', !isCashPayment);
  }
  if (state.cashReceivedWrapEl && state.cashReceivedEl) {
    state.cashReceivedEl.textContent = cashReceivedText;
    state.cashReceivedWrapEl.classList.toggle('d-none', !isCashPayment);
  }
  if (state.splitTenderLabelEl) {
    const cleanedType = splitType.trim();
    state.splitTenderLabelEl.textContent = cleanedType ? `Split Tender (${cleanedType})` : 'Split Tender';
  }
  if (state.splitTenderAmountEl) {
    state.splitTenderAmountEl.textContent = formatMoney(splitAmount);
  }
  if (state.splitTenderWrapEl) {
    const showSplit = splitEnabled && (splitAmount > 0 || splitType.trim());
    state.splitTenderWrapEl.classList.toggle('d-none', !showSplit);
  }
  if (state.cardFeeLabelEl) {
    state.cardFeeLabelEl.textContent = 'Gift Card Fee';
  }
  if (state.cardFeeEl) {
    state.cardFeeEl.textContent = formatMoney(cardFee);
  }
  if (state.cardFeeWrapEl) {
    state.cardFeeWrapEl.classList.toggle('d-none', !(cardFee > 0));
  }
  const carouselSlides = Array.isArray(payload?.customerAnnouncements)
    ? payload.customerAnnouncements
    : Array.isArray(payload?.carouselSlides)
      ? payload.carouselSlides
      : null;
  if (carouselSlides) setCarouselSlides(carouselSlides);
  updateCarouselLayout();
}
function handleCartUpdate(_evt, payload) {
  renderCart(payload);
}

function getApiBase() {
  if (typeof window !== 'undefined' && window.MIDDLETONS_API_BASE) {
    return String(window.MIDDLETONS_API_BASE).trim();
  }
  if (typeof window !== 'undefined' && window.location) {
    const protocol = String(window.location.protocol || '').toLowerCase();
    if (protocol === 'http:' || protocol === 'https:') {
      return String(window.location.origin || '').trim();
    }
  }
  return '';
}

function normalizeBase(base) {
  return String(base || '').replace(/\/+$/, '');
}

async function pollCustomerCart() {
  try {
    const payload = await invoke('customer-cart:request');
    const sig = JSON.stringify(payload || null);
    if (sig !== __lastPollSignature) {
      __lastPollSignature = sig;
      renderCart(payload);
    }
  } catch (_) { }
}

function stopCustomerCartStream() {
  if (__eventSource) {
    try { __eventSource.close(); } catch (_) { }
    __eventSource = null;
  }
  __sseConnected = false;
  if (__sseFallbackTimer) {
    clearTimeout(__sseFallbackTimer);
    __sseFallbackTimer = null;
  }
}

function startCustomerCartStream() {
  if (__eventSource || typeof EventSource !== 'function') return false;
  const base = normalizeBase(getApiBase());
  if (!base) return false;
  try {
    const url = `${base}/api/customer-cart/stream`;
    __eventSource = new EventSource(url);
    if (__sseFallbackTimer) clearTimeout(__sseFallbackTimer);
    __sseFallbackTimer = setTimeout(() => {
      if (!__sseConnected) {
        startCustomerCartPolling();
      }
    }, 2500);
    __eventSource.addEventListener('cart', (event) => {
      try {
        const payload = event?.data ? JSON.parse(event.data) : null;
        renderCart(payload);
      } catch (_) { }
    });
    __eventSource.addEventListener('refresh', () => {
      try { window.location.reload(); } catch (_) { }
    });
    __eventSource.onerror = () => {
      if (__sseConnected) {
        __sseConnected = false;
      }
      if (!__pollTimer) {
        startCustomerCartPolling();
      }
    };
    __eventSource.onopen = () => {
      __sseConnected = true;
      if (__sseFallbackTimer) {
        clearTimeout(__sseFallbackTimer);
        __sseFallbackTimer = null;
      }
      if (__pollTimer) {
        clearInterval(__pollTimer);
        __pollTimer = null;
      }
    };
    return true;
  } catch (_) {
    stopCustomerCartStream();
    return false;
  }
}

function startCustomerCartPolling() {
  if (__pollTimer || __sseConnected) return;
  __pollTimer = setInterval(pollCustomerCart, POLL_INTERVAL_MS);
  pollCustomerCart();
}

function initCustomerCartView() {
  state.bodyEl = document.getElementById('customerCartBody');
  state.titleEl = document.getElementById('customerCartTitle');
  state.metaEl = document.getElementById('customerCartMeta');
  state.subtotalEl = document.getElementById('customerSubtotal');
  state.taxEl = document.getElementById('customerTax');
  state.totalEl = document.getElementById('customerTotal');
  state.totalSummaryEl = document.getElementById('customerTotalSummary');
  state.changeDueWrapEl = document.getElementById('customerChangeDueWrap');
  state.changeDueEl = document.getElementById('customerChangeDue');
  state.cashReceivedWrapEl = document.getElementById('customerCashReceivedWrap');
  state.cashReceivedEl = document.getElementById('customerCashReceived');
  state.splitTenderWrapEl = document.getElementById('customerSplitTenderWrap');
  state.splitTenderLabelEl = document.getElementById('customerSplitTenderLabel');
  state.splitTenderAmountEl = document.getElementById('customerSplitTenderAmount');
  state.cardFeeWrapEl = document.getElementById('customerCardFeeWrap');
  state.cardFeeLabelEl = document.getElementById('customerCardFeeLabel');
  state.cardFeeEl = document.getElementById('customerCardFee');
  layoutState.cartCardEl = document.getElementById('customerCartCard');
  initCarouselElements();
  renderCart(null);
  window.addEventListener('resize', updateCarouselLayout);
  if (api?.hasIpc && typeof api.on === 'function') {
    api.on('customer-cart:update', handleCartUpdate);
    api.on('customer-carousel:update', handleCarouselSlidesUpdate);
  } else {
    const started = startCustomerCartStream();
    if (!started) startCustomerCartPolling();
  }
  invoke('customer-cart:request')
    .then((initial) => { if (initial) renderCart(initial); })
    .catch(() => { });
}

document.addEventListener('DOMContentLoaded', initCustomerCartView);
