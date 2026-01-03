document.addEventListener('DOMContentLoaded', () => {
  const link = document.getElementById('logoutLink');
  if (!link) return;
  const CUSTOMER_CART_WINDOW_NAME = 'middletonsCustomerCart';
  function closeCustomerCartWindow() {
    try {
      if (window.__customerCartWindow && !window.__customerCartWindow.closed) {
        window.__customerCartWindow.close();
      }
    } catch (_) { }
    try {
      const named = window.open('', CUSTOMER_CART_WINDOW_NAME);
      if (named && named !== window && !named.closed) named.close();
    } catch (_) { }
  }
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    closeCustomerCartWindow();
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
    } catch (_) { }
    window.location.href = 'login.html';
  });
});
