'use strict';

/**
 * Adsterra publisher statistics.
 *
 * The admin panel of a site that lives on advertising should answer "is it
 * earning?" without a second login. This reads the network's own numbers so
 * that question has an answer on the same page as traffic and moderation.
 *
 * The API key is a credential — it reads the account's earnings — so it stays
 * on the server and is never included in any payload the browser receives.
 * The route in front of this is admin-only for the same reason.
 *
 * Adsterra's API is somebody else's uptime, so every failure here is reported
 * as "unavailable" rather than thrown: a network that is down for ten minutes
 * must not take the admin panel with it.
 */

const ENDPOINT = 'https://api3.adsterratools.com/publisher';
const API_KEY = String(process.env.ADSTERRA_API_KEY || '').trim();

// Adsterra rate-limits, and an admin refreshing a dashboard should not be able
// to spend that budget. Five minutes is far finer than the numbers move.
const TTL_MS = 5 * 60_000;
const cache = new Map();

const day = (ts) => new Date(ts).toISOString().slice(0, 10);

async function get(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${ENDPOINT}/${path}`, {
      headers: { 'X-API-Key': API_KEY, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Adsterra responded ${res.status}`);
    const value = await res.json();
    cache.set(path, { at: Date.now(), value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

const sum = (rows, field) => rows.reduce((n, r) => n + (Number(r[field]) || 0), 0);

/**
 * Earnings for the last `days` days, plus a per-day series for the sparkline
 * and a country breakdown — which is the number that explains a low CPM when
 * everything else looks healthy.
 */
async function report({ days = 7 } = {}) {
  if (!API_KEY) return { configured: false };

  const finish = day(Date.now());
  const start = day(Date.now() - (days - 1) * 86400e3);
  const range = `start_date=${start}&finish_date=${finish}`;

  const [byDate, byCountry] = await Promise.all([
    get(`stats.json?${range}&group_by[]=date`),
    get(`stats.json?${range}&group_by[]=country`),
  ]);

  const dates = byDate.items || [];
  const impressions = sum(dates, 'impression');
  const revenue = sum(dates, 'revenue');

  return {
    configured: true,
    days,
    impressions,
    clicks: sum(dates, 'clicks'),
    revenue: Number(revenue.toFixed(4)),
    // Derived rather than averaged: a mean of daily CPMs weights a quiet day
    // the same as a busy one and quietly lies about the week.
    cpm: impressions ? Number(((revenue / impressions) * 1000).toFixed(4)) : 0,
    series: dates.map((d) => ({
      date: d.date,
      impressions: Number(d.impression) || 0,
      revenue: Number(d.revenue) || 0,
    })),
    countries: (byCountry.items || [])
      .map((c) => ({
        country: c.country,
        impressions: Number(c.impression) || 0,
        revenue: Number(c.revenue) || 0,
        cpm: Number(c.cpm) || 0,
      }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 8),
  };
}

module.exports = { report, isConfigured: () => !!API_KEY };
