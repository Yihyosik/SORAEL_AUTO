const axios = require('axios');
const { URL } = require('url');

const BLOCKED_HOSTS = new Set([
  'example.com',
  'www.example.com',
  'api.example.com',
  'localhost',
  '127.0.0.1'
]);

// 필요 시 화이트리스트 예시 (비워두면 모든 합법 공개 호스트 허용)
const ALLOWLIST = new Set([
  // 'www.googleapis.com',
  // 'api.telegram.org',
  // 'newsapi.org'
]);

function assertHostAllowed(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.hostname;

  // 사설IP, loopback 등 간단 차단
  const privateRanges = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[0-1])\./, /^::1$/, /^localhost$/i];
  if (privateRanges.some(r => r.test(host))) {
    throw new Error(`http.fetch blocked: private host (${host})`);
  }
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(`http.fetch blocked: example/blocked host (${host})`);
  }
  // 화이트리스트를 쓰고 싶으면 주석 해제
  if (ALLOWLIST.size && !ALLOWLIST.has(host)) {
    throw new Error(`http.fetch blocked: host not in allowlist (${host})`);
  }
}

module.exports = async function httpFetch(args) {
  const { url, method = 'GET', headers = {}, data, timeoutMs = 20000 } = args || {};
  if (!url) throw new Error('http.fetch: url required');

  assertHostAllowed(url);

  // params | query 둘 다 지원
  const params = args.params || args.query || undefined;

  try {
    const res = await axios({
      url,
      method,
      headers,
      params,
      data,
      timeout: timeoutMs,
      validateStatus: () => true
    });

    return { status: res.status, headers: res.headers, data: res.data };
  } catch (e) {
    // 네트워크 계열은 사람이 이해할 수 있게 요약
    const code = e?.code || e?.cause?.code;
    if (code === 'ENOTFOUND') {
      throw new Error(`http.fetch: DNS resolution failed for host in ${url}`);
    }
    if (code === 'ECONNREFUSED') {
      throw new Error(`http.fetch: connection refused for ${url}`);
    }
    throw e;
  }
};
