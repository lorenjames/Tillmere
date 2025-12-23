const { ipcRenderer } = require('electron');
const { generateMonthGrid, resolveDayInfo } = require('./calendar-utils');

function wireCloseAppLink() {
  const closeAppLink = document.getElementById('closeAppLink');
  if (!closeAppLink) return;
  closeAppLink.addEventListener('click', () => {
    try { ipcRenderer.invoke('app:quit'); } catch (_) { }
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireCloseAppLink);
} else {
  wireCloseAppLink();
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_STORE_HOURS = { start: '10:00', end: '18:00' };
const FALLBACK_BASE_SHIFTS = [
  { name: 'Morning Shift' },
  { name: 'Evening Shift' }
];
const FALLBACK_BASE_HOURS = {
  '0': { start: '13:00', end: '16:00' }, // Sunday
  '3': { start: '11:00', end: '17:30' }, // Wednesday
  '4': { start: '11:00', end: '17:30' }, // Thursday
  '5': { start: '11:00', end: '17:30' }, // Friday
  '6': { start: '10:00', end: '16:00' }  // Saturday
};
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let scheduleState = createFallbackSchedule();
let cashiers = [];
let weekStart = getWeekStart(new Date());
let calendarMonth = getMonthStart(new Date());
let printableRowCount = 0;

function createFallbackSchedule() {
  return {
    storeHours: { ...FALLBACK_STORE_HOURS },
    baseShifts: FALLBACK_BASE_SHIFTS.map(shift => ({ ...shift })),
    specialHours: [],
    baseHours: JSON.parse(JSON.stringify(FALLBACK_BASE_HOURS)),
    assignments: {}
  };
}

function getWeekStart(date) {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  const delta = (clone.getDay() + 6) % 7;
  clone.setDate(clone.getDate() - delta);
  return clone;
}

function formatTime12(time = '') {
  const [h, m] = (String(time).split(':').map(v => Number(v)));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour12 = ((h + 11) % 12) + 1;
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

function getMonthStart(date) {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  clone.setDate(1);
  return clone;
}

function formatMonthYear(date) {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function formatWeekRange(start, end) {
  const opts = { month: 'short', day: 'numeric' };
  const startText = start.toLocaleDateString(undefined, opts);
  const endText = end.toLocaleDateString(undefined, opts);
  return `${startText} - ${endText}`;
}

function toYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function initSchedule() {
  cashiers = await loadCashiers();
  refreshCashierAlert();
  try {
    scheduleState = await ipcRenderer.invoke('schedule:load');
  } catch (error) {
    console.error('Failed to load schedule data', error);
    scheduleState = createFallbackSchedule();
  }
  attachControls();
  renderWeek();
}

async function loadCashiers() {
  try {
    const list = await ipcRenderer.invoke('cashiers:load');
    return (Array.isArray(list) ? list : [])
      .map(c => String(c?.name || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.error('Unable to fetch cashiers', error);
    return [];
  }
}

function refreshCashierAlert() {
  const alert = document.getElementById('scheduleAlert');
  if (!alert) return;
  alert.classList.toggle('d-none', cashiers.length > 0);
}

function attachControls() {
  document.getElementById('prevWeekBtn')?.addEventListener('click', () => changeWeek(-7));
  document.getElementById('nextWeekBtn')?.addEventListener('click', () => changeWeek(7));
  document.getElementById('saveScheduleConfigBtn')?.addEventListener('click', handleConfigSave);
  document.getElementById('addBaseShiftBtn')?.addEventListener('click', () => appendBaseShiftRow());
  document.getElementById('addSpecialHourBtn')?.addEventListener('click', () => appendSpecialHourRow());
  document.getElementById('prevMonthBtn')?.addEventListener('click', () => changeMonth(-1));
  document.getElementById('nextMonthBtn')?.addEventListener('click', () => changeMonth(1));
  document.getElementById('printCalendarBtn')?.addEventListener('click', openCalendarWindow);
  const modalEl = document.getElementById('scheduleConfigModal');
  if (modalEl) {
    modalEl.addEventListener('show.bs.modal', () => populateConfigForm());
  }
}

function changeWeek(deltaDays) {
  const next = new Date(weekStart);
  next.setDate(next.getDate() + deltaDays);
  weekStart = next;
  renderWeek();
}

function renderWeek() {
  const grid = document.getElementById('scheduleGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const dates = Array.from({ length: 7 }, (_, idx) => new Date(weekStart.getTime() + idx * DAY_MS));
  dates.forEach(date => grid.appendChild(createDayColumn(date)));
  const windowEl = document.getElementById('scheduleWindow');
  if (windowEl) {
    windowEl.textContent = formatWeekRange(dates[0], dates[6]);
  }
  renderMonthlyCalendar();
}

function createDayColumn(date) {
  const container = document.createElement('div');
  container.className = 'col';
  const card = document.createElement('div');
  card.className = 'card h-100 schedule-day-card shadow-sm';
  const body = document.createElement('div');
  body.className = 'card-body d-flex flex-column gap-3';
  const header = document.createElement('div');
  header.className = 'd-flex justify-content-between align-items-start';
  const textWrap = document.createElement('div');
  textWrap.innerHTML = `
    <div class="fw-semibold">${date.toLocaleDateString(undefined, { weekday: 'short' })}</div>
    <div class="text-muted small">${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
  `;
  const dateKey = toYmd(date);
  const hoursInfo = resolveDayInfo(scheduleState, date);
  if (hoursInfo.type === 'special') {
    const badge = document.createElement('span');
    badge.className = 'badge bg-info text-dark ms-1 small';
    badge.textContent = hoursInfo.label;
    textWrap.appendChild(badge);
  }
  header.appendChild(textWrap);
  body.appendChild(header);
  const hoursDetail = document.createElement('div');
  hoursDetail.className = 'text-muted small';
  const hasRange = hoursInfo.start && hoursInfo.end;
  if (hasRange) {
    hoursDetail.textContent = `${hoursInfo.label}: ${formatTime12(hoursInfo.start)} - ${formatTime12(hoursInfo.end)}`;
  } else if (hoursInfo.label === 'Closed') {
    hoursDetail.textContent = 'Closed';
  } else {
    hoursDetail.textContent = 'Hours not configured';
  }
  body.appendChild(hoursDetail);
  if (hoursInfo.label !== 'Closed') {
    const shiftList = document.createElement('div');
    shiftList.className = 'd-flex flex-column gap-2';
    const shifts = Array.isArray(scheduleState.baseShifts) && scheduleState.baseShifts.length
      ? scheduleState.baseShifts
      : FALLBACK_BASE_SHIFTS;
    shifts.forEach(shift => shiftList.appendChild(createShiftRow(dateKey, shift)));
    body.appendChild(shiftList);
  }
  card.appendChild(body);
  container.appendChild(card);
  return container;
}

function createShiftRow(dateKey, shift) {
  const dayAssignments = scheduleState.assignments?.[dateKey] || {};
  const assigned = dayAssignments[shift.name] || '';
  const row = document.createElement('div');
  row.className = 'schedule-shift-row';
  const header = document.createElement('div');
  header.className = 'd-flex justify-content-between schedule-shift-header';
  const title = document.createElement('span');
  title.textContent = shift.name;
  header.appendChild(title);
  row.appendChild(header);
  const select = document.createElement('select');
  select.className = 'form-select form-select-sm mt-2';
  select.dataset.date = dateKey;
  select.dataset.shift = shift.name;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = cashiers.length ? 'Unassigned' : 'No cashiers';
  placeholder.selected = !assigned;
  select.appendChild(placeholder);
  cashiers.forEach(name => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    if (assigned && assigned === name) {
      option.selected = true;
    }
    select.appendChild(option);
  });
  if (assigned && cashiers.length && !cashiers.includes(assigned)) {
    const orphan = document.createElement('option');
    orphan.value = assigned;
    orphan.textContent = `${assigned} (inactive)`;
    orphan.disabled = true;
    orphan.selected = true;
    select.appendChild(orphan);
  }
  if (!cashiers.length) {
    select.disabled = true;
  }
  select.addEventListener('change', handleShiftChange);
  row.appendChild(select);
  const status = document.createElement('div');
  status.className = 'text-muted small mt-1';
  status.textContent = assigned ? `Covered by ${assigned}` : 'Needs coverage';
  row.appendChild(status);
  return row;
}

function changeMonth(delta) {
  const next = new Date(calendarMonth);
  next.setMonth(next.getMonth() + delta);
  calendarMonth = getMonthStart(next);
  renderMonthlyCalendar();
}

function renderMonthlyCalendar() {
  const container = document.getElementById('monthlyCalendar');
  if (!container) return;
  const header = document.getElementById('monthlyCalendarWindow');
  if (header) header.textContent = formatMonthYear(calendarMonth);
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const filteredWeeks = generateMonthGrid(year, month);
  const shiftTemplate = Array.isArray(scheduleState.baseShifts) && scheduleState.baseShifts.length
    ? scheduleState.baseShifts
    : FALLBACK_BASE_SHIFTS;
  let table = '<table><thead><tr>';
  const weekdayHeaders = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  weekdayHeaders.forEach(day => { table += `<th>${day}</th>`; });
  table += '</tr></thead><tbody>';
  filteredWeeks.forEach(row => {
    table += '<tr>';
    row.forEach(cellDate => {
      const dateKey = toYmd(cellDate);
      const isCurrent = cellDate.getMonth() === month;
      const assignmentRow = scheduleState.assignments?.[dateKey] || {};
      const hoursInfo = resolveDayInfo(scheduleState, cellDate);
      let shiftsHtml = '';
      const highlight = isCurrent ? '' : 'opacity-50';
      if (hoursInfo.label === 'Closed') {
        shiftsHtml = '<div class="shift-line text-muted">Closed</div>';
      } else {
        shiftTemplate.forEach(shift => {
          const assigned = assignmentRow[shift.name];
          shiftsHtml += `<div class="shift-line">
            ${shift.name}: ${assigned ? assigned : 'Unassigned'}
          </div>`;
        });
      }
      const hasRange = hoursInfo.start && hoursInfo.end;
      const hoursText = hasRange
        ? `${hoursInfo.label}: ${formatTime12(hoursInfo.start)} - ${formatTime12(hoursInfo.end)}`
        : hoursInfo.type === 'closed'
          ? 'Closed'
          : hoursInfo.label || 'No hours';
      table += `<td class="${highlight}">
        <div class="day-number">${cellDate.getDate()}</div>
        <div class="shift-note">${hoursText}</div>
        ${shiftsHtml}
      </td>`;
    });
    table += '</tr>';
  });
  table += '</tbody></table>';
  container.innerHTML = table;
  printableRowCount = filteredWeeks.length || 1;
}

function openCalendarWindow() {
  const payload = {
    month: calendarMonth.getMonth(),
    year: calendarMonth.getFullYear(),
    assignments: scheduleState.assignments,
    baseShifts: scheduleState.baseShifts,
    specialHours: scheduleState.specialHours,
    storeHours: scheduleState.storeHours,
    baseHours: scheduleState.baseHours
  };
  ipcRenderer.invoke('calendar:open', payload).catch(err => {
    console.error('Cannot open calendar window', err);
    showToast('Unable to open calendar window.', { type: 'error' });
  });
}

function buildPrintableCalendarHtml(headerText, tableHtml) {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>${headerText}</title>
        <style>
          @page { size: landscape; margin: 0.3in; }
          html, body { width: 11in; height: 8.5in; margin: 0; padding: 0; }
          body {
            font-family: "Playfair Display", "Times New Roman", serif;
            background: #f6f2ee;
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
          }
          h1 {
            margin: 0;
            font-size: 2rem;
            letter-spacing: 0.12em;
            text-align: center;
          }
          .calendar-wrapper {
            width: 100%;
            max-width: 10.8in;
            background: linear-gradient(135deg, #fffdfa, #f8efe2);
            border-radius: 18px;
            padding: 0.5in;
            box-shadow: 0 20px 45px rgba(0,0,0,0.15);
            border: 1px solid rgba(0,0,0,0.08);
          }
          .month-header {
            text-transform: uppercase;
            font-size: 0.95rem;
            letter-spacing: 0.5em;
            text-align: center;
            color: #ad5f34;
            margin-bottom: 0.35rem;
          }
          table {
            width: 100%;
            border-collapse:collapse;
            font-family: "Source Sans Pro", Arial, sans-serif;
          }
          thead th {
            text-transform: uppercase;
            font-size: 0.65rem;
            letter-spacing: 0.2em;
            padding: 0.4rem;
            background: #653b24;
            color: #fff;
          }
          td {
            border: 1px solid rgba(0,0,0,.1);
            padding: 0.4rem 0.35rem 0.3rem;
            min-height: 85px;
            background: #fff;
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
          }
          td:nth-child(6), td:nth-child(7) {
            background: #fef8f1;
          }
          .day-number {
            font-weight: 700;
            font-size: 1.05rem;
            margin-bottom: 0.25rem;
            color: #2c1c16;
          }
          .shift-line {
            font-size: 0.75rem;
            margin-bottom: 0.15rem;
            color: #4a2c1f;
          }
          .shift-line span {
            font-weight: 700;
          }
          .closed {
            font-weight: 700;
            color: #a3282d;
            text-transform: uppercase;
            letter-spacing: 0.2em;
          }
          @media print {
            html, body {
              zoom: 0.85;
            }
            .calendar-wrapper {
              box-shadow: none;
            }
          }
        </style>
      </head>
      <body>
        <div class="calendar-wrapper">
          <p class="month-header">Monthly Coverage</p>
          <h1>${headerText}</h1>
          ${tableHtml}
        </div>
      </body>
    </html>
  `;
}
function handleShiftChange(event) {
  const select = event.target;
  const date = select.dataset.date;
  const shiftName = select.dataset.shift;
  if (!date || !shiftName) return;
  const cashier = select.value || '';
  const assignments = { ...(scheduleState.assignments || {}) };
  const day = { ...(assignments[date] || {}) };
  if (cashier) {
    day[shiftName] = cashier;
  } else {
    delete day[shiftName];
  }
  if (Object.keys(day).length) {
    assignments[date] = day;
  } else {
    delete assignments[date];
  }
  persistSchedule({ assignments });
}

async function persistSchedule(patch) {
  try {
    const saved = await ipcRenderer.invoke('schedule:save', patch);
    scheduleState = saved;
    renderWeek();
    return saved;
  } catch (error) {
    console.error('Failed to persist schedule patch', error);
    showToast('Unable to save schedule changes.', { type: 'error' });
    return null;
  }
}

function populateConfigForm() {
  renderBaseShiftInputs();
  renderStoreHoursInputs();
  renderSpecialHoursList();
}

function renderBaseShiftInputs() {
  const container = document.getElementById('baseShiftList');
  if (!container) return;
  container.innerHTML = '';
  const shifts = Array.isArray(scheduleState.baseShifts) && scheduleState.baseShifts.length
    ? scheduleState.baseShifts
    : FALLBACK_BASE_SHIFTS;
  shifts.forEach(shift => container.appendChild(createBaseShiftRow(shift)));
}

function renderStoreHoursInputs() {
  const container = document.getElementById('baseHoursGrid');
  if (!container) return;
  container.innerHTML = '';
  WEEKDAY_LABELS.forEach((label, index) => {
    const dayKey = String(index);
    const current = scheduleState.baseHours?.[dayKey] || {};
    const row = document.createElement('div');
    row.className = 'col-12 col-sm-6 col-lg-4';
    row.innerHTML = `
      <label class="form-label mb-1">${label}</label>
      <div class="input-group input-group-sm">
        <span class="input-group-text">Start</span>
        <input type="time" class="form-control" data-field="base-hours-start" data-day="${dayKey}">
        <span class="input-group-text">End</span>
        <input type="time" class="form-control" data-field="base-hours-end" data-day="${dayKey}">
      </div>
      <div class="form-text small mb-0">Leave blank to use store hours.</div>
    `;
    const startInput = row.querySelector('[data-field="base-hours-start"]');
    const endInput = row.querySelector('[data-field="base-hours-end"]');
    if (startInput) startInput.value = current.start || '';
    if (endInput) endInput.value = current.end || '';
    container.appendChild(row);
  });
}

function createBaseShiftRow(shift = { name: '', start: '', end: '' }) {
  const row = document.createElement('div');
  row.className = 'row g-2 align-items-end mb-2 shift-entry';
  row.innerHTML = `
    <div class="col-sm-10 col-md-11">
      <label class="form-label mb-1">Shift Name</label>
      <input type="text" class="form-control form-control-sm" data-field="shift-name">
    </div>
    <div class="col-sm-1 text-end">
      <button type="button" class="btn btn-outline-danger btn-sm remove-shift-btn">Remove</button>
    </div>
  `;
  row.querySelector('[data-field="shift-name"]').value = shift.name || '';
  row.querySelector('.remove-shift-btn')?.addEventListener('click', () => {
    const rows = document.querySelectorAll('#baseShiftList .shift-entry');
    if (rows.length <= 1) return;
    row.remove();
  });
  return row;
}

function appendBaseShiftRow() {
  const container = document.getElementById('baseShiftList');
  if (!container) return;
  container.appendChild(createBaseShiftRow());
}

function renderSpecialHoursList() {
  const container = document.getElementById('specialHoursList');
  if (!container) return;
  container.innerHTML = '';
  const list = Array.isArray(scheduleState.specialHours) ? scheduleState.specialHours : [];
  list.forEach(entry => container.appendChild(createSpecialHourRow(entry)));
  if (!container.querySelector('.special-entry')) {
    const placeholder = document.createElement('div');
    placeholder.className = 'text-muted small special-placeholder';
    placeholder.textContent = 'No special hours configured yet.';
    container.appendChild(placeholder);
  }
}

function createSpecialHourRow(entry = { date: '', label: '', start: '', end: '' }) {
  const row = document.createElement('div');
  row.className = 'row g-2 align-items-end mb-2 special-entry';
  row.innerHTML = `
    <div class="col-sm-3">
      <label class="form-label mb-1">Date</label>
      <input type="date" class="form-control form-control-sm" data-field="special-date">
    </div>
    <div class="col-sm-3">
      <label class="form-label mb-1">Label</label>
      <input type="text" class="form-control form-control-sm" data-field="special-label" placeholder="Holiday">
    </div>
    <div class="col-sm-2">
      <label class="form-label mb-1">Start</label>
      <input type="time" class="form-control form-control-sm" data-field="special-start">
    </div>
    <div class="col-sm-2">
      <label class="form-label mb-1">End</label>
      <input type="time" class="form-control form-control-sm" data-field="special-end">
    </div>
    <div class="col-sm-2 text-end">
      <button type="button" class="btn btn-outline-danger btn-sm remove-special-btn">Remove</button>
    </div>
  `;
  row.querySelector('[data-field="special-date"]').value = entry.date || '';
  row.querySelector('[data-field="special-label"]').value = entry.label || '';
  row.querySelector('[data-field="special-start"]').value = entry.start || '';
  row.querySelector('[data-field="special-end"]').value = entry.end || '';
  row.querySelector('.remove-special-btn')?.addEventListener('click', () => {
    row.remove();
    const container = document.getElementById('specialHoursList');
    if (container && !container.querySelector('.special-entry')) {
      const placeholder = document.createElement('div');
      placeholder.className = 'text-muted small special-placeholder';
      placeholder.textContent = 'No special hours configured yet.';
      container.appendChild(placeholder);
    }
  });
  return row;
}

function appendSpecialHourRow() {
  const container = document.getElementById('specialHoursList');
  if (!container) return;
  const placeholder = container.querySelector('.special-placeholder');
  if (placeholder) placeholder.remove();
  container.appendChild(createSpecialHourRow());
}

function gatherBaseShiftsFromForm() {
  const rows = document.querySelectorAll('#baseShiftList .shift-entry');
  return Array.from(rows).map(row => {
    const name = String(row.querySelector('[data-field="shift-name"]')?.value || '').trim();
    return { name };
  }).filter(shift => shift.name);
}

function gatherStoreHoursFromForm() {
  const container = document.getElementById('baseHoursGrid');
  if (!container) return {};
  const result = {};
  container.querySelectorAll('[data-field="base-hours-start"]').forEach(startEl => {
    const day = String(startEl.dataset.day || '').trim();
    if (!day) return;
    const endEl = container.querySelector(`[data-field="base-hours-end"][data-day="${day}"]`);
    const start = String(startEl.value || '').trim();
    const end = String(endEl?.value || '').trim();
    if (!start || !end) return;
    result[day] = { start, end };
  });
  return result;
}

function gatherSpecialHoursFromForm() {
  const rows = document.querySelectorAll('#specialHoursList .special-entry');
  return Array.from(rows).map(row => {
    const date = String(row.querySelector('[data-field="special-date"]')?.value || '').trim();
    const label = String(row.querySelector('[data-field="special-label"]')?.value || '').trim();
    const start = String(row.querySelector('[data-field="special-start"]')?.value || '').trim();
    const end = String(row.querySelector('[data-field="special-end"]')?.value || '').trim();
    return { date, label, start, end };
  }).filter(entry => entry.date && entry.start && entry.end);
}

async function handleConfigSave() {
  const patch = {
    baseShifts: gatherBaseShiftsFromForm(),
    specialHours: gatherSpecialHoursFromForm(),
    baseHours: gatherStoreHoursFromForm()
  };
  const saved = await persistSchedule(patch);
  if (!saved) return;
  const modalEl = document.getElementById('scheduleConfigModal');
  const modalInstance = window.bootstrap?.Modal?.getInstance(modalEl);
  if (modalInstance) {
    modalInstance.hide();
  }
  showToast('Schedule settings saved.');
}

function showToast(message, opts = {}) {
  try {
    const hostId = 'schedule-toast-host';
    let host = document.getElementById(hostId);
    if (!host) {
      host = document.createElement('div');
      host.id = hostId;
      host.style.position = 'fixed';
      host.style.zIndex = '5000';
      host.style.right = '16px';
      host.style.bottom = '16px';
      host.style.display = 'flex';
      host.style.flexDirection = 'column';
      host.style.gap = '8px';
      host.style.pointerEvents = 'none';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    const tone = opts.type === 'error' ? '#dc3545' : '#198754';
    el.textContent = String(message || '');
    el.style.pointerEvents = 'none';
    el.style.background = tone;
    el.style.borderRadius = '8px';
    el.style.padding = '10px 14px';
    el.style.color = '#fff';
    el.style.boxShadow = '0 6px 12px rgba(0,0,0,0.2)';
    el.style.fontSize = '14px';
    host.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (_) { } }, Number(opts.duration || 2200));
  } catch (_) { }
}

window.addEventListener('DOMContentLoaded', () => {
  initSchedule().catch(error => console.error('Failed to initialize schedule page', error));
});

try {
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
      buildPrintableCalendarHtml
    };
  }
} catch (_) {}
