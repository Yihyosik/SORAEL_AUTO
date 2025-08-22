require('dotenv').config();
const crypto = require('crypto');

function mask(value){
  if(!value) return 'NOT_SET';
  if(value.length <= 8) return '***';
  return value.slice(0,4)+'...'+value.slice(-4);
}

class Validator{
  constructor(){ this.errors=[]; this.warnings=[]; }
  require(key, desc){ if(!process.env[key]){ this.errors.push(`Missing required: ${key} - ${desc}`); return null; } return process.env[key]; }
  optional(key, def){ return process.env[key] || def; }
  feature(name, keys){ const present = keys.filter(k=>!!process.env[k]);
    if(present.length && present.length<keys.length){ this.warnings.push(`Partial config for ${name}: ${keys.join(', ')}`); }
    return keys.every(k=>!!process.env[k]); }
  finish(){ if(this.errors.length){ console.error('❌ Configuration Errors:'); this.errors.forEach(e=>console.error(' -',e)); process.exit(1); }
            if(this.warnings.length){ console.warn('⚠️  Configuration Warnings:'); this.warnings.forEach(w=>console.warn(' -',w)); } }
}

const v = new Validator();
const cfg = {
  PORT: parseInt(v.optional('PORT','8080'),10),
  NODE_ENV: v.optional('NODE_ENV','production'),
  LOG_LEVEL: v.optional('LOG_LEVEL','info'),

  ADMIN_TOKEN: v.require('ADMIN_TOKEN','Admin API access'),
  JWT_SECRET: v.require('JWT_SECRET','JWT signing'),
  RTA_WEBHOOK_SECRET: v.optional('RTA_WEBHOOK_SECRET', crypto.randomBytes(32).toString('hex')),

  OPENAI_API_KEY: v.require('OPENAI_API_KEY','OpenAI API access'),
  OPENAI_MODEL: v.optional('OPENAI_MODEL','gpt-5-thinking'),
  OPENAI_MAX_TOKENS: parseInt(v.optional('OPENAI_MAX_TOKENS','2048'),10),
  OPENAI_TEMPERATURE: parseFloat(v.optional('OPENAI_TEMPERATURE','0.3')),

  features: {
    supabase: v.feature('Supabase', ['SUPABASE_URL','SUPABASE_KEY']),
    google: v.feature('Google CSE', ['GOOGLE_API_KEY','GOOGLE_CSE_ID']),
    redis: v.feature('Redis', ['REDIS_URL']),
    telegram: v.feature('Telegram', ['TELEGRAM_BOT_TOKEN'])
  },

  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  GOOGLE_CSE_ID: process.env.GOOGLE_CSE_ID,
  REDIS_URL: process.env.REDIS_URL,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN
};

v.finish();
console.log('🔧 Configuration Status');
console.log('  - OpenAI:', mask(cfg.OPENAI_API_KEY));
console.log('  - Features:', Object.entries(cfg.features).filter(([_,on])=>on).map(([k])=>k).join(', ')||'core only');

module.exports = cfg;
