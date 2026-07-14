import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// Custom metrics to track exact response classifications
export const allowedRequests = new Counter('allowed_requests');
export const deniedRequests = new Counter('denied_requests');

export const options = {
  scenarios: {
    concurrency_proof: {
      executor: 'per-vu-iterations',
      vus: 1000,
      iterations: 1,
      maxDuration: '15s',
    },
  },
};

export default function () {
  const url = 'http://localhost:3000/check/client-hot-tb';
  const res = http.post(url);

  if (res.status === 200) {
    allowedRequests.add(1);
  } else if (res.status === 429) {
    deniedRequests.add(1);
  }

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
  });
}
