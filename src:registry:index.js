const fs = require('fs');
const path = require('path');

let registry = {};
function load(dir){
  registry = {};
  if(!fs.existsSync(dir)) return;
  for(const f of fs.readdirSync(dir)){
    if(!/\.(js|cjs|mjs)$/.test(f)) continue;
    const name = f.replace(/\.(js|cjs|mjs)$/,'');
    // eslint-disable-next-line global-require, import/no-dynamic-require
    registry[name] = require(path.join(dir,f));
  }
}

function getRegistry(){ if(!Object.keys(registry).length){ load(path.join(__dirname,'tools')); } return registry; }
function reloadRegistry(){ load(path.join(__dirname,'tools')); }

module.exports={ getRegistry, reloadRegistry };