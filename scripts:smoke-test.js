const axios = require('axios');
const BASE_URL = process.env.SORAIEL_URL || 'http://localhost:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'your_admin_token';

async function main(){
  try{
    const h = await axios.get(`${BASE_URL}/healthz`); 
    if(h.status!==200) throw new Error('healthz failed');
    const plan = await axios.post(`${BASE_URL}/orchestrate`,
      { instruction: '스모크 테스트 플랜 생성', context: { smoke:true } },
      { headers:{ 'Authorization': `Bearer ${ADMIN_TOKEN}` }});
    const exec = await axios.post(`${BASE_URL}/execute`,
      { planId: plan.data.planId, steps: plan.data.steps },
      { headers:{ 'Authorization': `Bearer ${ADMIN_TOKEN}` }});
    if(exec.status!==200) throw new Error('execute failed');
    console.log('✅ smoke ok');
    process.exit(0);
  }catch(e){
    console.error('❌ smoke failed:', e.response?.data || e.message);
    process.exit(1);
  }
}
if(require.main===module) main();