import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metric to track actual server errors (e.g. 5xx status codes)
export const serverErrors = new Rate('server_errors');

export const options = {
  scenarios: {
    sustained_load: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 600,
      stages: [
        { target: 500, duration: '10s' }, // Ramp up to 500 req/s
        { target: 550, duration: '30s' }, // Sustain 500+ req/s
        { target: 0, duration: '5s' },   // Ramp down
      ],
    },
  },
  thresholds: {
    server_errors: ['rate<0.01'], // Less than 1% actual server errors (HTTP 500)
    http_req_duration: ['p(95)<150'], // 95% of requests should be under 150ms
  },
};

const clients = [
  ...Array.from({ length: 10 }, (_, i) => `client-tb-${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `client-sw-${i + 1}`),
];

// Helper for case-insensitive header checks
function hasHeader(headers, name) {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      return true;
    }
  }
  return false;
}

export default function () {
  // Randomly pick a client to distribute load
  const clientKey = clients[Math.floor(Math.random() * clients.length)];
  const url = `http://localhost:3000/check/${clientKey}`;

  const res = http.post(url);

  // Track if this was a server error
  serverErrors.add(res.status >= 500);

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    'has X-RateLimit-Limit': (r) => hasHeader(r.headers, 'x-ratelimit-limit'),
    'has X-RateLimit-Remaining': (r) => hasHeader(r.headers, 'x-ratelimit-remaining'),
    'has X-RateLimit-Reset': (r) => hasHeader(r.headers, 'x-ratelimit-reset'),
    'has Retry-After if status is 429': (r) => {
      if (r.status === 429) {
        return hasHeader(r.headers, 'retry-after');
      }
      return true;
    },
    'response time under 200ms': (r) => r.timings.duration < 200,
  });
}
