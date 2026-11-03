'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDailyActiveTrend } = require('../server');

test('30-day activity chart maps PostgreSQL DATE Date objects to their calendar-day buckets', () => {
  const today = new Date('2026-11-03T09:00:00.000Z');
  // node-postgres parses DATE text as local midnight, rather than an ISO date string.
  const postgresToday = new Date(2026, 10, 3);
  const postgresYesterday = new Date(2026, 10, 2);
  const trend = buildDailyActiveTrend([
    { activity_day: postgresYesterday, active_users: 2 },
    { activity_day: postgresToday, active_users: 3 }
  ], today);

  assert.equal(trend.length, 30);
  assert.deepEqual(trend.at(-2), { day: '2026-11-02', active_users: 2 });
  assert.deepEqual(trend.at(-1), { day: '2026-11-03', active_users: 3 });
  assert.equal(trend.reduce((sum, item) => sum + item.active_users, 0), 5);
});
