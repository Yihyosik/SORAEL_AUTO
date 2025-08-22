const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const { createClient } = require('redis');
const cfg = require('./config');
const { logInfo, logError } = require('./logging');

async function applySecurity(app){
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'","'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'","data:","https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: true,
    crossOriginOpenerPolicy: true,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    hidePoweredBy: true,
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' }
  }));

  let store;
  if(cfg.features.redis && cfg.REDIS_URL){
    try{
      const client = createClient({ url: cfg.REDIS_URL, password: cfg.REDIS_PASSWORD });
      await client.connect();
      store = new RedisStore({ sendCommand: (...args)=>client.sendCommand(args) });
      logInfo('SECURITY','Redis rate limiter initialized');
    }catch(e){ logError('SECURITY', e, { msg:'Redis connection failed, using memory store' }); }
  }

  const limiter = rateLimit({
    windowMs: 60_000, max: 60, standardHeaders:'draft-6', legacyHeaders:false,
    store, skip:(req)=>req.path==='/healthz',
    message:{ ok:false, error:'RATE_LIMIT' }
  });
  app.use(limiter);

  app.use((req,res,next)=>{
    res.header('Access-Control-Allow-Origin','*');
    res.header('Access-Control-Allow-Methods','GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers','Content-Type, Authorization, X-Request-ID');
    res.header('X-Content-Type-Options','nosniff');
    res.header('X-Frame-Options','DENY');
    if(req.method==='OPTIONS') return res.sendStatus(200);
    next();
  });
}

function requestId(req,res,next){
  const { v4 } = require('uuid');
  req.id = req.headers['x-request-id'] || v4();
  res.setHeader('X-Request-ID', req.id);
  next();
}

module.exports = { applySecurity, requestId };
