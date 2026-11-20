// Wunderlost — Copyright (C) 2026 Matt Hornish. AGPL-3.0-or-later; see LICENSE.
// Unit tests for repeat-date math (recur.js). Runs with TZ=America/New_York (see package.json).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextOccurrence, addDays, today } = require('../recur');

test('daily, weekly and every-2-weeks step by days', () => {
  assert.equal(nextOccurrence({ recurrence: 'daily', due_date: '2099-03-10' }).due_date, '2099-03-11');
  assert.equal(nextOccurrence({ recurrence: 'weekly', due_date: '2099-03-10' }).due_date, '2099-03-17');
  assert.equal(nextOccurrence({ recurrence: 'biweekly', due_date: '2099-03-10' }).due_date, '2099-03-24');
});

test('weekdays skip Saturday and Sunday', () => {
  // 2099-01-02 is a Friday
  assert.equal(nextOccurrence({ recurrence: 'weekdays', due_date: '2099-01-02' }).due_date, '2099-01-05');
});

test('monthly clamps to the end of shorter months', () => {
  assert.equal(nextOccurrence({ recurrence: 'monthly', due_date: '2099-01-31' }).due_date, '2099-02-28');
  assert.equal(nextOccurrence({ recurrence: 'monthly', due_date: '2096-01-31' }).due_date, '2096-02-29', 'leap year');
});

test('monthly on the 31st returns to the 31st after a short month', () => {
  const feb = nextOccurrence({ recurrence: 'monthly', due_date: '2099-01-31', repeat_day: 31 });
  assert.equal(feb.due_date, '2099-02-28');
  const mar = nextOccurrence({ recurrence: 'monthly', due_date: feb.due_date, repeat_day: 31 });
  assert.equal(mar.due_date, '2099-03-31');
  const apr = nextOccurrence({ recurrence: 'monthly', due_date: mar.due_date, repeat_day: 31 });
  assert.equal(apr.due_date, '2099-04-30');
});

test('far-overdue daily and weekly repeats land on the next future date, on the right weekday', () => {
  const d = nextOccurrence({ recurrence: 'daily', due_date: '2015-06-01' });
  assert.equal(d.due_date, addDays(today(), 1));
  const w = nextOccurrence({ recurrence: 'weekly', due_date: '2015-06-01' }); // a Monday
  assert.ok(w.due_date > today());
  assert.equal(new Date(w.due_date + 'T12:00:00').getDay(), 1);
});

test('yearly handles Feb 29', () => {
  assert.equal(nextOccurrence({ recurrence: 'yearly', due_date: '2096-02-29' }).due_date, '2097-02-28');
});

test('a late completion jumps to the next future date, not a past one', () => {
  const n = nextOccurrence({ recurrence: 'daily', due_date: '2020-01-01' });
  assert.ok(n.due_date > today());
  assert.equal(n.due_date, addDays(today(), 1));
});

test('reminder keeps its wall-clock time across a DST change', () => {
  // US DST starts 2099-03-08. A 9:00 AM reminder on 03-07 should stay 9:00 AM local on 03-14.
  const remind = new Date(2099, 2, 7, 9, 0).toISOString();
  const n = nextOccurrence({ recurrence: 'weekly', due_date: '2099-03-07', remind_at: remind });
  const r = new Date(n.remind_at);
  assert.equal(n.due_date, '2099-03-14');
  assert.equal(r.getHours(), 9);
  assert.equal(r.getMinutes(), 0);
});

test('no due date: starts from today', () => {
  const n = nextOccurrence({ recurrence: 'daily', due_date: null });
  assert.equal(n.due_date, addDays(today(), 1));
  assert.equal(n.remind_at, null);
});

