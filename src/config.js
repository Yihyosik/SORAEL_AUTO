require('dotenv').config();
const crypto = require('crypto');

// 민감정보 마스킹 함수
function maskSensitive(value) {
  if (!value) return 'NOT_SET';
  if (value.length <= 8) return '***';
  return value.substring(0, 4) + '…' + value.substring(value.length - 4);
}

// 환경변수 검증 클래스
class ConfigValidator {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }

  require(key, description) {
    if (!process.env[key]) {
      this.errors.push(`Missing required: ${key} - ${description}`);
      return null;
    }
    return process.env[key];
  }

  optional(key, defaultValue) {
    return process.env[key] || defaultValue;
  }

  validateFeature(feature, requiredKeys) {
    const hasAll = requiredKeys.every(key => process.env[key]);
    if (!hasAll && requiredKeys.some(key => process.env[key])) {
      this.warnings.push(`Partial config for ${feature}: ${requiredKeys.join(', ')}`);
    }
    return hasAll;
  }

  finish() {
    if (this.errors.length > 0) {
      console.error('❌ Configuration Errors:');
      this.errors.forEach(e => console.error('  -', e));
      process.exit(1);
    }
    if (this.warnings.length > 0) {
      console.warn('⚠️  Configuration Warnings:');
      this.warnings.forEach(w => console.warn('  -', w));
    }
  }
}

const validator = new ConfigValidator();

const config = {
  // ✅ Render 호환: PORT는 환경변수 우선, 없으면 8080
  PORT: process.env.PORT || validator.optional('PORT', 8080),
  NODE_ENV: validator.optional('NODE_ENV', 'production'),
  LOG_LEVEL: validator.optional('LOG_LEVEL', 'info'),

  // Security
  ADMIN_TOKEN: validator.require('ADMIN_TOKEN', 'Admin API access'),
  JWT_SECRET: validator.require('JWT_SECRET', 'JWT signing'),
  RTA_WEBHOOK_SECRET: validator.optional('RTA_WEBHOOK_SECRET', crypto.randomBytes(32).toString('hex')),

  // OpenAI
  OPENAI_API_KEY: validator.require('OPENAI_API_KEY', 'OpenAI API access'),
  OPENAI_MODEL: validator.optional('OPENAI_MODEL', 'gpt-4o-mini'),
  OPENAI_MAX_TOKENS: parseInt(validator.optional('OPENAI_MAX_TOKENS', '2048')),
  OPENAI_TEMPERATURE: parseFloat(validator.optional('OPENAI_TEMPERATURE', '0.3')),

  // Features
  features: {
    supabase: validator.validateFeature('Supabase', ['SUPABASE_URL', 'SUPABASE_KEY']),
    google: validator.validateFeature('Google Search', ['GOOGLE_API_KEY', 'GOOGLE_CSE_ID']),
    make: validator.validateFeature('Make.com', ['MAKE_API_KEY', 'MAKE_SCENARIO_ID']),
    redis: validator.validateFeature('Redis', ['REDIS_URL']),
    telegram: validator.validateFeature('Telegram', ['TELEGRAM_BOT_TOKEN'])
  },

  // Feature configs
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  GOOGLE_CSE_ID: process.env.GOOGLE_CSE_ID,
  MAKE_API_BASE: process.env.MAKE_API_BASE || 'https://api.make.com',
  MAKE_API_KEY: process.env.MAKE_API_KEY,
  MAKE_SCENARIO_ID: process.env.MAKE_SCENARIO_ID,
  MAKE_WEBHOOK_URL: process.env.MAKE_WEBHOOK_URL,
  REDIS_URL: process.env.REDIS_URL,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,

  // System keys
  RENDER_KEY: process.env.RENDER_KEY,
  REWRITE_KEY: process.env.REWRITE_KEY
};

validator.finish();

// 설정 상태 출력 (민감정보 마스킹)
console.log('🔧 Configuration Status:');
console.log('  - OpenAI:', maskSensitive(config.OPENAI_API_KEY));
console.log(
  '  - Features:',
  Object.entries(config.features)
    .filter(([_, v]) => v)
    .map(([k]) => k)
    .join(', ') || 'core only'
);

module.exports = config;
