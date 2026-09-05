import { decide, loadRouterCases, loadRules, mastraDecision, score } from '../lib/model-router.js'

const rules = await loadRules(); const cases = await loadRouterCases(); const model = mastraDecision(process.env.OPENAI_MODEL ?? 'openai/gpt-5.6-luna')
for (const c of [{name:'A',on:false,modelClass:'mini'},{name:'B',on:true,modelClass:'mini'},{name:'C',on:false,modelClass:'nano'},{name:'D',on:true,modelClass:'nano'}]) { let good=0; for (const item of cases) { const outcome=await decide(item.input,c.on?rules:[],model); if(score(outcome,item.groundTruth).accurate) good++ } console.log(`${c.name}: ${good}/${cases.length} (${c.modelClass}, rules=${c.on})`) }
