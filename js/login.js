const form = document.getElementById('loginForm');
const errorEl = document.getElementById('loginError');
const CUSTOMER_CART_WINDOW_NAME = 'middletonsCustomerCart';

function isElectronRuntime() {
  try {
    if (typeof window === 'undefined' || typeof window.require !== 'function') return false;
    const electron = window.require('electron');
    return !!electron?.ipcRenderer;
  } catch (_) {
    return false;
  }
}

function openCustomerCartPopup() {
  if (isElectronRuntime()) return null;
  const url = 'about:blank';
  const features = 'popup=yes,width=1280,height=720,menubar=no,toolbar=no,location=no,status=no';
  const existing = window.__customerCartWindow;
  if (existing && !existing.closed) {
    try { existing.focus(); } catch (_) { }
    return existing;
  }
  const opened = window.open(url, CUSTOMER_CART_WINDOW_NAME, features);
  if (opened) {
    window.__customerCartWindow = opened;
    try { opened.focus(); } catch (_) { }
  }
  return opened || null;
}

function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.style.display = message ? '' : 'none';
}

async function submitLogin(event) {
  event.preventDefault();
  showError('');
  const customerCartWindow = openCustomerCartPopup();
  const username = document.getElementById('username')?.value || '';
  const password = document.getElementById('password')?.value || '';
  if (!username || !password) {
    showError('Enter your username and password.');
    try { if (customerCartWindow && !customerCartWindow.closed) customerCartWindow.close(); } catch (_) { }
    return;
  }
  try {
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password })
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      showError(data?.error || 'Login failed.');
      try { if (customerCartWindow && !customerCartWindow.closed) customerCartWindow.close(); } catch (_) { }
      return;
    }
    if (customerCartWindow && !customerCartWindow.closed) {
      try { customerCartWindow.location.href = 'customer-cart.html'; } catch (_) { }
    }
    window.location.href = 'index.html';
  } catch (err) {
    showError(err?.message || 'Login failed.');
    try { if (customerCartWindow && !customerCartWindow.closed) customerCartWindow.close(); } catch (_) { }
  }
}

if (form) {
  form.addEventListener('submit', submitLogin);
}

fetch('/api/auth/me', { credentials: 'include' })
  .then(resp => {
    if (resp.ok) {
      window.location.href = 'index.html';
    }
  })
  .catch(() => {});
