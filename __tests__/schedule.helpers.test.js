const { generateMonthGrid } = require('../calendar-utils');
const { buildPrintableCalendarHtml } = require('../schedule.js');

describe('schedule helpers', () => {
  describe('generateMonthGrid', () => {
    it('builds a 5-week matrix for December 2025 starting on Monday', () => {
      const weeks = generateMonthGrid(2025, 11); // December is month index 11
      expect(weeks.length).toBe(5);
      const firstCell = weeks[0][0];
      expect(firstCell.getFullYear()).toBe(2025);
      expect(firstCell.getMonth()).toBe(11);
      expect(firstCell.getDate()).toBe(1);
      const lastWeek = weeks[weeks.length - 1];
      const wed = lastWeek.find(day => day.getDate() === 31);
      expect(wed).toBeDefined();
      expect(wed.getDay()).toBe(3); // Wednesday
      const allDates = weeks.flat();
      allDates.forEach(day => {
        expect(typeof day.getDate()).toBe('number');
      });
    });
  });

  describe('buildPrintableCalendarHtml', () => {
    it('renders a document with the provided header and table content', () => {
      const html = buildPrintableCalendarHtml('December 2025', '<table><tr><td>1</td></tr></table>');
      expect(html).toContain('<h1>December 2025</h1>');
      expect(html).toContain('<table><tr><td>1</td></tr></table>');
      expect(html).toContain('calendar-wrapper');
    });
  });
});
