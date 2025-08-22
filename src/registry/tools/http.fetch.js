// src/registry/tools/http.fetch.js
const axios = require('axios');
const { URL } = require('url');

const BLOCKED = new Set(['example.com','www.example.com','api.example.com','localhost','127.0.0.1']);
const PRIVATE = [/^127\./,/^10\./,/^192\.168\./,/^172\.(1[6-9]|2\d|3[0-1])\./,/^::1$/, /^localhost$/i];

function guard(raw){
  const u = new URL(raw);
  const h = u.hostname;
  if (PRIVATE.some(r=>r.test(h))) throw new Error(`http.fetch blocked: private host (${h})`);
  if (BLOCKED.has(h)) throw new Error(`http.fetch blocked: blocked/placeholder host (${h})`);
}

module.exports = async function httpFetch(args){
  const { url, method='GET', headers={}, data, timeoutMs=20000 } = args || {};
  if (!url) throw new Error('http.fetch: url required');
  guard(url);

  const params = args.params || args.query || undefined;

  try{
    const r = await axios({
      url, method, headers, params, data,
      timeout: timeoutMs, validateStatus: () => true
    });
    return { status: r.status, headers: r.headers, data: r.data };
  }catch(e){
    const code = e?.code || e?.cause?.code;
    if (code === 'ENOTFOUND') throw new Error(`http.fetch: DNS resolution failed (${url})`);
    if (code === 'ECONNREFUSED') throw new Error(`http.fetch: connection refused (${url})`);
    throw e;
  }
};
