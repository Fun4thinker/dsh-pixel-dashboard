import assert from 'node:assert/strict'
import { TimingBreakdown } from '../src/timing.js'
let passed = 0
function check(name, test) {
  try { test(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { process.exitCode = 1; console.error(`  ✗ ${name}: ${error.message}`) }
}
const event = (type, time, data = {}) => ({ type, time, data: { turn: 1, step: 1, ...data } })
function project(events) { const timing = new TimingBreakdown(); for (const value of events) timing.observe(value); return timing.toJSON() }
check('model and other durations have honest names while legacy numeric fields stay compatible', () => {
  const value = project([event('step/start', 0), event('assistant/message', 8000), event('step/end', 9000)])
  assert.equal(value.modelMs, 8000)
  assert.equal(value.otherMs, 1000)
  assert.equal(value.ttftMs, value.modelMs)
  assert.equal(value.genMs, value.otherMs)
})
check('packed output reconstructs cumulative dt without calling the final message a first token', () => {
  const value = project([event('step/start', 1000), event('assistant/message', 9000, {stream:[{type:'text-chunks',index:0,time0:3000,dt:[1000,2000],texts:['x','y','z']}]}),event('step/end',9500)])
  assert.equal(value.firstOutputWaitMs,2000)
  assert.equal(value.streamedMs,3000)
  assert.equal(value.responseSteps,1)
  assert.equal(value.streamedSteps,1)
  assert.equal(value.firstOutputSteps,1)
})
check('native and packed reasoning/tool deltas follow the official token predicate, not finish or usage', () => {
  const streams = [
    {stream:[{type:'chunk',time:2000,chunk:{type:'usage',usage:{}}},{type:'chunk',time:3000,chunk:{type:'text-delta',text:''}},{type:'chunk',time:4000,chunk:{type:'reasoning-delta',text:'x'}},{type:'chunk',time:5000,chunk:{type:'tool-call-delta',name:'read',argumentsDelta:''}},{type:'chunk',time:6000,chunk:{type:'finish',reason:{kind:'stop'}}}],wait:3000,span:1000},
    {stream:[{type:'reasoning-chunks',time0:3000,index:0,dt:[1000,1000],texts:['','x','y']}],wait:3000,span:1000},
    {stream:[{type:'tool-call-chunks',time0:3000,index:0,id:'call',name:'read',dt:[2000],args:['','']}],wait:2000,span:2000},
    {stream:[{type:'tool-call-chunks',time0:3000,index:0,id:'call',dt:[1000,1000],args:['','x','y']}],wait:3000,span:1000},
  ]
  for (const sample of streams) {
    const value=project([event('step/start',1000),event('assistant/message',9000,{stream:sample.stream}),event('step/end',10000)])
    assert.equal(value.firstOutputWaitMs,sample.wait)
    assert.equal(value.streamedMs,sample.span)
  }
})
check('retry output spans are unioned separately without connecting quiet retry gaps', () => {
  const run=(time0,dt)=>[{type:'text-chunks',time0,index:0,dt:[dt],texts:['x','y']}]
  const value=project([event('step/start',1000),event('assistant/attempt',4000,{stream:run(2000,1000)}),event('assistant/message',10000,{stream:run(8000,1000)}),event('step/end',11000)])
  assert.equal(value.firstOutputWaitMs,1000)
  assert.equal(value.streamedMs,2000)
  assert.equal(value.streamedSteps,1)
  assert.equal(value.responseSteps,1)
  const overlap=project([event('step/start',1000),event('assistant/attempt',7000,{stream:run(2000,3000)}),event('assistant/message',10000,{stream:run(3000,3000)}),event('step/end',11000)])
  assert.equal(overlap.streamedMs,4000)
})
check('missing, single-time, invalid and out-of-step stream timing stays unknown with explicit coverage', () => {
  const packed=(time0,dt,texts)=>[{type:'text-chunks',time0,index:0,dt,texts}]
  for (const stream of [undefined,[],packed(2000,[NaN],['a','b']),packed(2000,[-1],['a','b']),packed(0,[100],['a','b']),packed(2000,[9000],['a','b']),packed(2000,[],['a','b']),[{type:'tool-call-chunks',index:0,time0:2000,name:null,args:['',''],dt:[1000]}]]) {
    const value=project([event('step/start',1000),event('assistant/message',9000,{stream}),event('step/end',10000)])
    assert.equal(value.streamedMs,null)
    assert.equal(value.streamedSteps,0)
    assert.equal(value.responseSteps,1)
  }
  const single=project([event('step/start',1000),event('assistant/message',9000,{stream:packed(2000,[],['x'])}),event('step/end',10000)])
  assert.equal(single.firstOutputWaitMs,1000)
  assert.equal(single.streamedMs,null)
  const unclosed=project([event('step/start',1000),event('assistant/message',9000,{stream:packed(2000,[1000],['x','y'])})])
  assert.equal(unclosed.responseSteps,0)
  assert.equal(unclosed.streamedMs,null)
  const foreign=project([event('step/start',1000),event('assistant/message',9000,{step:2,stream:packed(2000,[1000],['x','y'])}),event('step/end',10000)])
  assert.equal(foreign.responseSteps,0)
  assert.equal(foreign.streamedMs,null)
})
check('only clock scalars survive observe; no stream text, args or message bodies are retained', () => {
  const timing=new TimingBreakdown()
  timing.observe(event('step/start',1000))
  timing.observe(event('assistant/message',9000,{stream:[{type:'text-chunks',time0:2000,index:0,dt:[1000],texts:['DO_NOT_RETAIN_TEXT','DO_NOT_RETAIN_ARGUMENTS']}],message:{content:'DO_NOT_RETAIN_BODY'}}))
  timing.observe(event('step/end',10000))
  assert.ok(!JSON.stringify({...timing}).includes('DO_NOT_RETAIN'))
})
check('foreign end boundaries and a future end cannot manufacture a completed stream sample', () => {
  const stream=[{type:'text-chunks',index:0,time0:2000,dt:[1000],texts:['x','y']}]
  const foreign=project([event('step/start',1000),event('assistant/message',4000,{stream}),event('step/end',5000,{step:2})])
  assert.equal(foreign.responseSteps,0)
  const timing=new TimingBreakdown()
  for(const value of [event('step/start',1000),event('assistant/message',4000,{stream}),event('step/end',10000)]) timing.observe(value)
  assert.equal(timing.toJSON(5000).responseSteps,0)
  assert.equal(timing.toJSON(5000).streamedMs,null)
})
console.log(`\n${passed} stream timing checks passed`)
