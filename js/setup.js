const form = document.getElementById('setupForm');
const errorEl = document.getElementById('setupError');

function showError(message) {
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.style.display = message ? '' : 'none';
}

async function submitSetup(event) {
  event.preventDefault();
  showError('');
  const displayName = document.getElementById('displayName')?.value || '';
  const username = document.getElementById('username')?.value || '';
  const password = document.getElementById('password')?.value || '';
  const confirmPassword = document.getElementById('confirmPassword')?.value || '';
  if (!username || !password) {
    showError('Username and password are required.');
    return;
  }
  if (password !== confirmPassword) {
    showError('Passwords do not match.');
    return;
  }
  try {
    const resp = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password, displayName })
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      showError(data?.error || 'Setup failed.');
      return;
    }
    window.location.href = 'index.html';
  } catch (err) {
    showError(err?.message || 'Setup failed.');
  }
}

if (form) {
  form.addEventListener('submit', submitSetup);
}
