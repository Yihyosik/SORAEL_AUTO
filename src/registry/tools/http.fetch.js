const axios = require('axios');
module.exports = async function httpFetch(args){
  const { url, method='GET', headers={}, data, timeoutMs=20000 } = args;
  const res = await axios({ url, method, headers, data, timeout: timeoutMs, validateStatus:()=>true });
  return { status: res.status, headers: res.headers, data: res.data };
};
