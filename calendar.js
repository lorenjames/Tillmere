const api = (typeof window !== 'undefined' && window.MiddletonsApiClient)
  ? window.MiddletonsApiClient
  : null;
const invoke = (...args) => {
  if (!api || typeof api.invoke !== 'function') {
    return Promise.reject(new Error('API client unavailable.'));
  }
  return api.invoke(...args);
};
const calendarUtils = (typeof window !== 'undefined' && window.CalendarUtils)
  ? window.CalendarUtils
  : (() => { try { return require('./calendar-utils'); } catch (_) { return {}; } })();
const generateMonthGrid = calendarUtils.generateMonthGrid || (() => []);
const resolveDayInfo = calendarUtils.resolveDayInfo || (() => ({ type: 'unknown', label: 'Hours TBD' }));

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const accentColor = '#6f3f1b';
const fallbackShifts = [{ name: 'Morning Shift' }, { name: 'Evening Shift' }];

let monthSelect;
let yearSelect;
let updateButton;
let printButton;
let calendarGrid;
let titleElement;
let schedulePayload = {};
let domReady = false;
let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();

function populateControls() {
  if (!monthSelect || !yearSelect) return;
  monthSelect.innerHTML = monthNames.map((name, index) => `<option value="${index}">${name}</option>`).join('');
  const yearSpan = 3;
  const startYear = new Date().getFullYear() - yearSpan;
  const endYear = new Date().getFullYear() + yearSpan;
  let options = '';
  for (let y = startYear; y <= endYear; y += 1) {
    options += `<option value="${y}">${y}</option>`;
  }
  yearSelect.innerHTML = options;
  if (currentMonth < 0 || currentMonth > 11) currentMonth = new Date().getMonth();
  if (currentYear < startYear) currentYear = startYear;
  if (currentYear > endYear) currentYear = endYear;
  monthSelect.value = currentMonth;
  yearSelect.value = currentYear;
}

function formatTime12(value) {
  if (!value) return '';
  const [hours, minutes] = value.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return '';
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = ((hours + 11) % 12) + 1;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function renderCalendar(month, year) {
  if (!calendarGrid || !titleElement) return;
  const weeks = generateMonthGrid(year, month);
  titleElement.textContent = `${monthNames[month]} ${year}`;
  const assignments = schedulePayload.assignments || {};
  const shifts = Array.isArray(schedulePayload.baseShifts) && schedulePayload.baseShifts.length
    ? schedulePayload.baseShifts
    : fallbackShifts;
  let html = '<table class="calendar-table table table-borderless">';
  html += '<thead><tr>';
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(day => {
    html += `<th style="color:${accentColor};">${day}</th>`;
  });
  html += `<th class="notes-header" style="color:${accentColor};">NOTES</th>`;
  html += '</tr></thead><tbody>';
  weeks.forEach((row, rowIndex) => {
    html += '<tr>';
    row.forEach(cellDate => {
      const dateKey = `${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, '0')}-${String(cellDate.getDate()).padStart(2, '0')}`;
      const isCurrentMonth = cellDate.getMonth() === month;
      const classes = ['calendar-day'];
      if (!isCurrentMonth) classes.push('outside');
      const assignment = assignments[dateKey] || {};
      const dayInfo = isCurrentMonth ? resolveDayInfo(schedulePayload, cellDate) : null;
      const workerNames = shifts.map(shift => assignment[shift.name]).filter(Boolean);
      const shiftLines =
        dayInfo?.type === 'closed'
          ? ''
          : workerNames.length
            ? workerNames.map(name => `<div class="shift-line">${name}</div>`).join('')
            : (isCurrentMonth ? '<div class="shift-line text-muted">Unassigned</div>' : '');
      html += `<td class="${classes.join(' ')}">
        ${isCurrentMonth ? `<span class="day-number">${cellDate.getDate()}</span>
        <div class="shift-note">${dayInfo?.start && dayInfo?.end ? `${formatTime12(dayInfo.start)} – ${formatTime12(dayInfo.end)}` : dayInfo?.label || ''}</div>
        ${shiftLines}` : ''}
      </td>`;
    });
    if (rowIndex === 0) {
      html += `<td class="notes-column" rowspan="${weeks.length}">
        <span class="notes-label">NOTES</span>
        ${Array.from({ length: 14 }, () => '<div class="note-line"></div>').join('')}
      </td>`;
    }
    html += '</tr>';
  });
  html += '</tbody></table>';
  calendarGrid.innerHTML = html;
}

function handlePayload(payload = {}) {
  schedulePayload = payload || {};
  if (domReady) {
    populateControls();
    renderCalendar(currentMonth, currentYear);
  }
}

function applyQueryParams() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const monthParam = Number(params.get('month'));
    const yearParam = Number(params.get('year'));
    if (Number.isFinite(monthParam)) currentMonth = Math.max(0, Math.min(11, monthParam));
    if (Number.isFinite(yearParam)) currentYear = Math.max(2000, Math.min(2100, yearParam));
  } catch (_) { }
}

async function loadSchedulePayload() {
  try {
    const raw = sessionStorage.getItem('calendarPayload');
    if (raw) {
      sessionStorage.removeItem('calendarPayload');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        handlePayload(parsed);
        return;
      }
    }
  } catch (_) { }
  try {
    const payload = await invoke('schedule:load');
    handlePayload(payload || {});
  } catch (_) {
    handlePayload({});
  }
}

function updateFromControls() {
  currentMonth = Number(monthSelect.value);
  currentYear = Number(yearSelect.value);
  renderCalendar(currentMonth, currentYear);
}

async function initControls() {
  monthSelect = document.getElementById('monthSelect');
  yearSelect = document.getElementById('yearSelect');
  updateButton = document.getElementById('updateCalendarBtn');
  printButton = document.getElementById('printCalendarBtn');
  calendarGrid = document.getElementById('calendarGrid');
  titleElement = document.getElementById('calendarTitle');
  updateButton?.addEventListener('click', updateFromControls);
  printButton?.addEventListener('click', () => {
    if (api?.hasIpc) {
      invoke('calendar:print').catch(err => console.error('Calendar print failed', err));
    } else {
      try { window.print(); } catch (_) { }
    }
  });
  domReady = true;
  applyQueryParams();
  await loadSchedulePayload();
  populateControls();
  renderCalendar(currentMonth, currentYear);
}

window.addEventListener('DOMContentLoaded', () => {
  initControls().catch(err => console.error('Calendar init failed', err));
});
