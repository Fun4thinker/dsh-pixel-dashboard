import assert from 'node:assert/strict'
import { accountDetailModel, timeDetailModel } from '../src/client/dockDetail.js'
import { costDetailModel } from '../src/client/costDetail.js'
import { resolveAccount } from '../src/client/account.js'
import { normalizeBalance } from '../src/balance.js'
let passed = 0
function check(name, fn) {
 try { fn(); passed += 1; console.log(`  ✓ ${name}`) }
 catch (error) { process.exitCode = 1; console.error(`  ✗ ${name}: ${error.message}`) }
}
check('account card separates wallet and bonus per currency without adding dollars to yuan', () => {
 const model = accountDetailModel({ account: { kind:'balance',source:'route',text:'¥115.00',payload:{ official:true, balances:[{currency:'CNY',total:115},{currency:'USD',total:8}],wallets:[{currency:'CNY',total:100},{currency:'USD',total:3}],bonusWallets:[{currency:'CNY',total:15},{currency:'USD',total:5}] } } })
 assert.equal(model.headline,'¥115.00')
 assert.deepEqual(model.sections.slice(0,2).map((section) => [section.label,...section.rows.map((row) => row.value)]),[
  ['CNY 余额构成','¥115.00','¥100.00','¥15.00'], ['USD 余额构成','$8.00','$3.00','$5.00']
 ])
})
check('quota card shows remaining percentage and amount, preserves reset and flags overage', () => {
 const hourly = {label:'5 小时',used:28.25,total:100,unit:'$'}
 const monthly = {label:'每月',remaining:65.55,unit:'$',resetAt:Date.parse('2026-11-18T00:00:00Z'),note:'官方只报余额'}
 const weekly = {label:'每周',usedPercent:140,remaining:-4,unit:'$'}
 const model = accountDetailModel({ account:{kind:'plan',label:'CC',fullLabel:'Command Code',source:'route',plan:{window:hourly}}, provider:{windows:[hourly,monthly,weekly],secretMarker:'NEVER-SERIALIZE'},now:Date.parse('2026-11-17T00:00:00Z'),timezone:'Asia/Shanghai' })
 assert.equal(model.headline,'剩余 71.75%')
 assert.deepEqual(model.sections[0].rows,[
   {label:'剩余比例',value:'71.75%',share:0.7175,tone:'purple'},
   {label:'剩余额度',value:'$71.75'},
   {label:'总额度',value:'$100'},
 ])
 assert.deepEqual(model.sections[1].rows.map((row) => row.label),['剩余额度','重置时间'])
 assert.equal(model.sections[1].rows[0].value,'$65.55')
 assert.ok(model.sections[1].rows[1].value.includes('重置'))
 assert.deepEqual(model.sections[2].rows[0],{label:'剩余比例',value:'0%',share:0,tone:'red'})
 assert.ok(model.sections[2].rows.some((row) => row.value==='已超限'))
 assert.ok(!/已用|NEVER-SERIALIZE/.test(JSON.stringify(model)))
})
check('quota card distinguishes exhausted quota from exceeding the limit', () => {
 const cardFor = (window) => accountDetailModel({account:{kind:'plan',label:'CC',plan:{window}}})
 const full = cardFor({usedPercent:0})
 assert.equal(full.headline,'剩余 100%')
 assert.equal(full.sections[0].rows[0].share,1)
 const exhausted = cardFor({usedPercent:100})
 assert.equal(exhausted.headline,'剩余 0%')
 assert.ok(!exhausted.sections[0].rows.some((row) => row.value==='已超限'))
 const emptyBalance = cardFor({remaining:0,unit:'$'})
 assert.equal(emptyBalance.headline,'剩余 $0')
 assert.equal(emptyBalance.tone,'red')
 const blocked = cardFor({usedPercent:28,exceeded:true})
 assert.equal(blocked.headline,'已超限')
 assert.equal(blocked.sections[0].rows[0].share,undefined)
 for (const window of [{usedPercent:120},{remaining:-4,unit:'$'},{remaining:0,exceeded:true}]) {
  const over = cardFor(window)
  assert.equal(over.headline,'已超限')
  assert.equal(over.tone,'red')
 }
})
check('time view uses effective completed timing, not the hour spent waiting for a human', () => {
 const model = timeDetailModel({row:{completedTurns:1,completedTurnMs:2000,completedWallMs:3602000,awaitingUserMs:3600000,maxCompletedTurnMs:2000,turns:1}})
 assert.equal(model.headline,'2s')
 const rows = model.sections.flatMap((section) => section.rows)
 assert.equal(rows.find((row) => row.label==='等待用户（近似）').value,'1h')
 assert.ok(model.notes.some((note) => note.includes('已完成') && note.includes('问答')))
 const zero = timeDetailModel({row:{completedTurns:1,completedTurnMs:0,completedWallMs:1000,awaitingUserMs:1000}})
 assert.equal(zero.headline,'0s')
 const pending = timeDetailModel({row:{completedTurns:0,completedTurnMs:0}})
 assert.equal(pending.headline,'—')
})
check('team time is per-member with known coverage, not a fabricated zero for an untimed member', () => {
 const lead={id:'lead',completedTurns:1,completedTurnMs:2000,completedWallMs:3000,awaitingUserMs:1000}
 const worker={id:'worker',completedTurns:1,completedTurnMs:3000,completedWallMs:3000,awaitingUserMs:0}
 const model=timeDetailModel({row:lead,team:{members:[{id:'lead',name:'Lead',role:'lead'},{id:'worker',name:'实现'},{id:'missing',name:'旧记录'}]},sessions:[lead,worker]})
 assert.equal(model.headline,'5s')
 assert.equal(model.badge,'计时 2/3')
 const members=model.sections.find((section) => section.label==='成员有效处理')
 assert.deepEqual(members.rows.map((row) => row.value),['2s','3s','—'])
 assert.ok(model.notes.some((note) => note.includes('并行')))
})
check('account card exposes unavailable reasons and fallback binding instead of a fabricated healthy balance', () => {
 const unavailable=accountDetailModel({account:{kind:'unavailable',label:'余额',reason:'查询已关闭',source:'route'}})
 assert.equal(unavailable.headline,'不可用')
 assert.ok(unavailable.notes.includes('查询已关闭'))
 assert.equal(accountDetailModel({account:{kind:'none'}}).empty,true)
 const fallback=accountDetailModel({account:{kind:'balance',source:'fallback',text:'¥1.00',payload:{official:false,fetchedAt:Date.parse('2026-11-17T03:00:00Z'),balances:[{currency:'CNY',total:1}]}},timezone:'Asia/Shanghai'})
 assert.ok(fallback.notes.some((note)=>note.includes('回落')))
 assert.ok(fallback.sections.some((section)=>section.rows.some((row)=>row.label==='更新时间' && row.value.includes('11:00'))))
 assert.equal(fallback.badge,'自建端点')
})
check('team fee headline matches member total while per-session time-of-day costs stay explicitly local', () => {
 const model=costDetailModel({cost:{standard:2,peak:1,idle:1},team:{cost:5,memberCount:2,lines:[{name:'Lead',role:'lead',cost:2},{name:'实现',cost:3}]}})
 assert.equal(model.headline,'¥5.00')
 assert.ok(model.sections.some((section)=>section.label==='本会话分时计价'))
})
check('real signed-in account contract yields one total per currency and the same pill and card headline', () => {
  // BalanceService #readAccount returns balances as wallet+bonus, not currency totals.
  const balance = { source:'account',official:true,
    wallets:[{currency:'CNY',total:100},{currency:'USD',total:3}],
    bonusWallets:[{currency:'CNY',total:15},{currency:'USD',total:5}],
    balances:[{currency:'CNY',total:100},{currency:'USD',total:3},{currency:'CNY',total:15},{currency:'USD',total:5}] }
  const account = resolveAccount({selection:{next:{provider:'deepseek-official'}},balance})
  const model = accountDetailModel({account})
  assert.equal(account.text,'¥115.00')
  assert.equal(model.headline,'¥115.00')
  assert.deepEqual(model.sections.filter((section)=>section.label.endsWith('余额构成')).map((section)=>[section.label,...section.rows.map((row)=>row.value)]),[
    ['CNY 余额构成','¥115.00','¥100.00','¥15.00'], ['USD 余额构成','$8.00','$3.00','$5.00'],
  ])
})
check('API totals include grants once and expose normalized topped-up and granted components', () => {
  const balance = normalizeBalance({is_available:true,balance_infos:[
    {currency:'CNY',total_balance:'115',topped_up_balance:'100',granted_balance:'15'},
    {currency:'USD',total_balance:'8',topped_up_balance:'3',granted_balance:'5'},
  ]})
  const account = resolveAccount({selection:{next:{provider:'deepseek-official'}},balance})
  assert.equal(account.text,'¥115.00')
  assert.deepEqual(accountDetailModel({account}).sections.slice(0,2).map((section)=>section.rows.map((row)=>row.value)),[
    ['¥115.00','¥100.00','¥15.00'],['$8.00','$3.00','$5.00'],
  ])
  const unknown = normalizeBalance({balance_infos:[{currency:'CNY',total_balance:null,topped_up_balance:'',granted_balance:null}]})
  assert.equal(resolveAccount({selection:{next:{provider:'deepseek-official'}},balance:unknown}).kind,'unavailable')
})
check('missing member money is unknown without a meter while a measured zero stays zero', () => {
  const model = costDetailModel({team:{cost:2,lines:[{name:'Known',cost:2},{name:'Missing'},{name:'Null',cost:null},{name:'Zero',cost:0}]}})
  const rows = model.sections.find((section)=>section.label.startsWith('成员')).rows
  assert.deepEqual(rows.map((row)=>row.value),['¥2.00','—','—','¥0'])
  assert.equal(rows[1].share,undefined)
  assert.equal(rows[2].share,undefined)
  assert.equal(rows[3].share,0)
})
check('remaining-only quota is reachable through real route binding without inventing a percentage', () => {
  const plans = {providers:[{id:'commandcode',name:'Command Code',ok:true,windows:[{label:'每月',remaining:65.55,unit:'$'}]},
    {id:'zhipu',name:'智谱',ok:true,windows:[{usedPercent:99}]}]}
  const account = resolveAccount({selection:{next:{provider:'commandcode'}},plans,selectedPlan:'zhipu'})
  assert.equal(account.kind,'plan')
  assert.equal(account.planId,'commandcode')
  assert.equal(account.source,'route')
  assert.equal(account.plan.percent,undefined)
  const model = accountDetailModel({account})
  assert.equal(model.headline,'剩余 $65.55')
  assert.deepEqual(model.sections[0].rows,[{label:'剩余额度',value:'$65.55'}])
  assert.equal(resolveAccount({plans:{providers:[plans.providers[0]]}}).kind,'plan')
})
check('account metadata wraps long identities and signed-in source is not mislabeled as a custom API endpoint', () => {
  const model = accountDetailModel({account:{kind:'balance',source:'route',text:'¥1.00',route:{provider:'a-very-long-provider-name'},payload:{source:'account',official:false,account:{name:'a-very-long-account-name'},wallets:[{currency:'CNY',total:1}],bonusWallets:[],balances:[{currency:'CNY',total:1}]}}})
  assert.equal(model.badge,'官方账户')
  const info = model.sections.find((section)=>section.label==='查询信息')
  assert.equal(info.rows.find((row)=>row.label==='账号').wrap,true)
  assert.equal(info.rows.find((row)=>row.label==='模型来源').wrap,true)
})
console.log(`\n${passed} dock detail checks passed`)
