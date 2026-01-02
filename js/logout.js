document.addEventListener('DOMContentLoaded', () => {
  const link = document.getElementById('logoutLink');
  if (!link) return;
  link.addEventListener('click', async (event) => {
    event.preventDefault();
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
