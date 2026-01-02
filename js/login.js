const form = document.getElementById('loginForm');
const errorEl = document.getElementById('loginError');

function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.style.display = message ? '' : 'none';
}

async function submitLogin(event) {
  event.preventDefault();
  showError('');
  const username = document.getElementById('username')?.value || '';
  const password = document.getElementById('password')?.value || '';
  if (!username || !password) {
    showError('Enter your username and password.');
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
      return;
    }
    window.location.href = 'index.html';
  } catch (err) {
    showError(err?.message || 'Login failed.');
  }
}

if (form) {
  form.addEventListener('submit', submitLogin);
}
