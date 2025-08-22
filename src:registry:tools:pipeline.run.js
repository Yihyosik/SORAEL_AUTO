module.exports = async function pipelineRun(args, ctx){
  return { ok:true, received: args, ctxKeys: Object.keys(ctx) };
};