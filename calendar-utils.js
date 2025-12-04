function generateMonthGrid(year, month) {
  const startOffset = (new Date(year, month, 1).getDay() + 6) % 7;
  const weeks = [];
  let cursor = new Date(year, month, 1 - startOffset);
  for (let week = 0; week < 6; week += 1) {
    const days = [];
    for (let day = 0; day < 7; day += 1) {
      days.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(days);
  }
  return weeks.filter(row => row.some(cell => cell.getMonth() === month));
}

const CLOSED_DAYS = new Set(['1', '2']);

function resolveDayInfo(scheduleData = {}, date = new Date()) {
  const specialList = Array.isArray(scheduleData.specialHours) ? scheduleData.specialHours : [];
  const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const special = specialList.find(entry => entry.date === dateKey);
  if (special) {
    return {
      type: 'special',
      label: special.label || 'Special Hours',
      start: special.start,
      end: special.end
    };
  }
  const dayIndex = String(date.getDay());
  const baseHours = scheduleData.baseHours?.[dayIndex];
  if (baseHours?.start && baseHours?.end) {
    return { type: 'base', label: 'Hours', start: baseHours.start, end: baseHours.end };
  }
  if (CLOSED_DAYS.has(dayIndex)) {
    return { type: 'closed', label: 'Closed' };
  }
  const storeHours = scheduleData.storeHours;
  if (storeHours?.start && storeHours?.end) {
    return { type: 'store', label: 'Store Hours', start: storeHours.start, end: storeHours.end };
  }
  return { type: 'unknown', label: 'Hours TBD' };
}

module.exports = { generateMonthGrid, resolveDayInfo };
