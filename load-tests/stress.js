/**
 * k6 Load Test — Institutional Custody Infrastructure
 *
 * Install: brew install k6 (or https://k6.io/docs/get-started/installation/)
 *
 * Run:
 *   k6 run load-tests/stress.js                         # default (ramp to 500 VUs)
 *   k6 run --vus 100 --duration 30s load-tests/stress.js  # quick smoke
 *   k6 run -e TARGET_TPS=10000 load-tests/stress.js       # 10k TPS target
 *   k6 run -e BASE_URL=https://staging:3000 load-tests/stress.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TARGET_TPS = parseInt(__ENV.TARGET_TPS || '5000');

// Custom metrics
const errorRate = new Rate('errors');
const latencyP99 = new Trend('latency_p99', true);
const txCounter = new Counter('successful_txs');

// Stages: ramp up → sustained load → spike → cooldown
export const options = {
  stages: [
    { duration: '1m', target: Math.ceil(TARGET_TPS * 0.1) },  // warmup
    { duration: '5m', target: Math.ceil(TARGET_TPS * 0.5) },  // ramp to 50%
    { duration: '10m', target: TARGET_TPS },                   // sustained peak
    { duration: '2m', target: Math.ceil(TARGET_TPS * 1.5) },  // spike (150%)
    { duration: '5m', target: TARGET_TPS },                    // back to peak
    { duration: '2m', target: 0 },                             // cooldown
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<2000'],  // p95 < 500ms, p99 < 2s
    errors: ['rate<0.01'],                            // <1% error rate
    http_req_failed: ['rate<0.01'],
  },
};

const headers = { 'Content-Type': 'application/json' };

export default function () {
  group('health', () => {
    const res = http.get(`${BASE_URL}/health`);
    check(res, { 'health 200': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);
    latencyP99.add(res.timings.duration);
  });

  group('create_account', () => {
    const payload = JSON.stringify({
      externalId: `load-test-${__VU}-${__ITER}-${Date.now()}`,
      accountType: 'asset',
      currency: 'USD',
    });
    const res = http.post(`${BASE_URL}/api/v1/accounts`, payload, { headers });
    const ok = res.status === 200 || res.status === 201;
    check(res, { 'account created': () => ok });
    errorRate.add(!ok);
    latencyP99.add(res.timings.duration);
    if (ok) txCounter.add(1);
  });

  group('list_accounts', () => {
    const res = http.get(`${BASE_URL}/api/v1/accounts`);
    check(res, { 'accounts listed': (r) => r.status === 200 });
    errorRate.add(res.status !== 200);
  });

  group('post_journal', () => {
    const payload = JSON.stringify({
      idempotencyKey: `k6-${__VU}-${__ITER}-${Date.now()}`,
      entries: [
        { accountId: 'load-test-debit', amount: '100', type: 'debit' },
        { accountId: 'load-test-credit', amount: '100', type: 'credit' },
      ],
    });
    const res = http.post(`${BASE_URL}/api/v1/journal`, payload, { headers });
    const ok = res.status >= 200 && res.status < 500; // 4xx is "handled", not an infra error
    check(res, { 'journal accepted': () => ok });
    errorRate.add(res.status >= 500);
    latencyP99.add(res.timings.duration);
  });

  group('metrics_endpoint', () => {
    const res = http.get(`${BASE_URL}/metrics`);
    check(res, { 'metrics 200': (r) => r.status === 200 });
  });

  sleep(0.1); // 100ms think time
}

// Soak test export — 72-hour sustained load
export function soak() {
  const res = http.get(`${BASE_URL}/health`);
  check(res, { 'soak health ok': (r) => r.status === 200 });
  errorRate.add(res.status !== 200);

  const payload = JSON.stringify({
    externalId: `soak-${__VU}-${__ITER}-${Date.now()}`,
    accountType: 'asset',
    currency: 'USD',
  });
  const res2 = http.post(`${BASE_URL}/api/v1/accounts`, payload, { headers });
  errorRate.add(res2.status >= 500);
  sleep(0.05);
}

// Soak options (run with: k6 run --config load-tests/soak-options.json load-tests/stress.js)
export const soakOptions = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: TARGET_TPS,
      timeUnit: '1s',
      duration: '72h',
      preAllocatedVUs: 500,
      maxVUs: 2000,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<3000'],
    errors: ['rate<0.005'], // stricter for soak: <0.5%
    http_req_failed: ['rate<0.005'],
  },
};
