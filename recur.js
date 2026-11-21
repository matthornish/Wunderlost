// Wunderlost — Copyright (C) 2026 Matt Hornish. AGPL-3.0-or-later; see LICENSE.
// Date helpers. All "local" math uses the container's TZ (set TZ in docker-compose)
// so recurring reminders keep the same wall-clock time across DST changes.

const RULES = ['', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'];

function pad(n) { return String(n).padStart(2, '0'); }

function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0); // noon avoids DST edge weirdness
}

function today() { return toDateStr(new Date()); }

function addDays(dateStr, n) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

// Move by whole months, landing on `day` (default: the current day) or the month's last day
// if it's shorter. Keeping the original day stops a "31st" repeat drifting to the 28th forever.
function addMonthsClamped(d, months, day = d.getDate()) {
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

// Advance a Date object (mutates a copy) by one recurrence step, using local time.
function step(date, rule, anchorDay) {
  const d = new Date(date.getTime());
  switch (rule) {
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekdays':
      do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
      break;
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'monthly': addMonthsClamped(d, 1, anchorDay); break;
    case 'yearly': addMonthsClamped(d, 12, anchorDay); break;
    default: throw new Error('bad rule');
  }
  return d;
}

// Given a task, return {due_date, remind_at} for the next occurrence.
// Due date never lands in the past: if you complete a daily task 3 days late,
// the next one is due tomorrow-ish, not 2 days ago.
function nextOccurrence(task) {
  const rule = task.recurrence;
  const t = today();
  let due = task.due_date || t;
  // Fast-forward day-based repeats that are far overdue so the loop below stays short.
  const DAYS = { daily: 1, weekly: 7, biweekly: 14 };
  if (DAYS[rule] && due < t && !task.remind_at) {
    const behind = Math.floor((parseDateStr(t) - parseDateStr(due)) / 86400000);
    due = addDays(due, behind - (behind % DAYS[rule]));
  }
  // Day of month the repeat is anchored to (stored when the user sets the date), so
  // monthly/yearly repeats return to the 29th–31st after a shorter month.
  const anchorDay = task.repeat_day || parseDateStr(task.due_date || t).getDate();
  let remind = task.remind_at ? new Date(task.remind_at) : null;
  let guard = 0;
  do {
    const nextDue = toDateStr(step(parseDateStr(due), rule, anchorDay));
    if (remind) {
      // shift reminder by the same number of calendar days as the due date moved
      const diffDays = Math.round((parseDateStr(nextDue) - parseDateStr(due)) / 86400000);
      const r = new Date(remind.getTime());
      r.setDate(r.getDate() + diffDays);
      remind = r;
    }
    due = nextDue;
  } while (due <= t && ++guard < 100000); // ~270 years of daily steps
  return { due_date: due, remind_at: remind ? remind.toISOString() : null };
}

module.exports = { RULES, today, addDays, nextOccurrence, toDateStr, parseDateStr };
