const crypto = require('crypto');
function verifyHmac(bodyRaw, secret, signature, timestamp, driftMs=300000){
  const ts = parseInt(timestamp||'0',10);
  if(!ts || Math.abs(Date.now()-ts) > driftMs) return false;
  const mac = crypto.createHmac('sha256', secret).update(`${ts}.${bodyRaw}`).digest('hex');
  try{ return crypto.timingSafeEqual(Buffer.from(mac,'hex'), Buffer.from(signature||'', 'hex')); }catch{ return false; }
}
module.exports={ verifyHmac };