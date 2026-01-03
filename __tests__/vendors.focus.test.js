jest.mock('electron');

const { ipcRenderer } = require('electron');

function setupVendorsDom() {
  document.body.innerHTML = `
    <button id="dummyFocus">Dummy</button>
    <button id="vendorSortButton"></button>
    <table id="vendorTable"><tbody></tbody></table>

    <input id="newVendorCode" />
    <input id="newVendorName" />
    <input id="newVendorPhone" />
    <input id="newVendorEmail" />

    <div id="vendorEditModal">
      <input id="edit_vendor_code" />
      <input id="edit_vendor_name" />
      <input id="edit_vendor_phone" />
      <input id="edit_vendor_email" />
      <button id="vendor_edit_save_btn">Save</button>
    </div>
  `;
}

function dispatchLoad() {
  window.dispatchEvent(new Event('load'));
}

describe('Vendor page focus and toasts', () => {
  beforeEach(() => {
    jest.resetModules();
    setupVendorsDom();
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'vendors:load') return [{ name: 'Existing', code: 'V1', phone: '' }];
      if (channel === 'vendors:save') return Promise.resolve([]);
      return undefined;
    });
    // Stub confirm so delete flow can run without jsdom errors
    global.confirm = jest.fn(() => true);
    // Require after DOM/mocks so onload handler binds correctly
    require('../js/vendors.js');
    dispatchLoad();
  });

  test('Add Vendor with missing name shows toast and focuses name input', async () => {
    const nameEl = document.getElementById('newVendorName');
    const codeEl = document.getElementById('newVendorCode');
    const phoneEl = document.getElementById('newVendorPhone');
    expect(nameEl).toBeTruthy();
    expect(codeEl).toBeTruthy();
    expect(phoneEl).toBeTruthy();

    // Ensure blank name
    nameEl.value = '';
    codeEl.value = '';
    phoneEl.value = '';

    await window.addVendor();

    const host = document.getElementById('toast-host');
    expect(host).toBeTruthy();
    const lastToast = host.lastElementChild;
    expect(lastToast).toBeTruthy();
    expect(lastToast.textContent).toContain('Vendor name is required.');
    expect(document.activeElement).toBe(nameEl);
  });

  test('Add Vendor with missing code shows toast and focuses code input', async () => {
    const nameEl = document.getElementById('newVendorName');
    const codeEl = document.getElementById('newVendorCode');
    const phoneEl = document.getElementById('newVendorPhone');

    nameEl.value = 'Vendor With No Code';
    codeEl.value = '';
    phoneEl.value = '';

    await window.addVendor();

    const host = document.getElementById('toast-host');
    const lastToast = host && host.lastElementChild;
    expect(lastToast).toBeTruthy();
    expect(lastToast.textContent).toContain('Vendor code is required.');
    expect(document.activeElement).toBe(codeEl);
  });

  // Duplicate code behavior is covered indirectly; here we focus on required-field focus behavior
});

