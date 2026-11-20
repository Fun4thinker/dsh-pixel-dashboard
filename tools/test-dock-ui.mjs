/** Real React structural regressions; --layout adds an offline Chromium geometry check. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'
const root=[process.env.DSH_CHECKOUT,'E:/deepseek-harness','D:/deepseek-harness'].filter(Boolean).find((path)=>existsSync(join(path,'node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')))
if(!root) throw new Error('Set DSH_CHECKOUT to React 18.3.1 test dependencies')
const base=join(root,'node_modules/.pnpm')
const react=pathToFileURL(join(base,'react@18.3.1/node_modules/react/index.js')).href
const dom=pathToFileURL(join(base,'react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js')).href
register(`data:text/javascript,${encodeURIComponent(`const aliases=new Map(${JSON.stringify([['react',react],['react-dom',dom]])});export async function resolve(s,c,n){const url=aliases.get(s);return url?{url,shortCircuit:true}:n(s,c)}`)}`,import.meta.url)
const React=(await import(react)).default
const {renderToStaticMarkup}=await import(pathToFileURL(join(base,'react-dom@18.3.1_react@18.3.1/node_modules/react-dom/server.js')).href)
const source=process.argv.includes('--built')?'lib/client':'src/client'
const {SessionCostView,CostDetailPanel,detailPanelPlacement}=await import(pathToFileURL(resolve(source,'SessionCost.js')).href)
const {accountDetailModel,timeDetailModel}=await import(pathToFileURL(resolve(source,'dockDetail.js')).href)
let passed=0
function check(name,fn){try{fn();passed++;console.log(`  ✓ ${name}`)}catch(error){process.exitCode=1;console.error(`  ✗ ${name}: ${error.message}`)}}
check('account beside the fee estimate is a real independent card trigger, not a bare native tooltip',()=>{
 const html=renderToStaticMarkup(React.createElement(SessionCostView,{cost:{standard:1,peak:1,idle:0},showTokens:false,account:{kind:'balance',label:'余额',text:'¥115.00',payload:{balances:[{currency:'CNY',total:115}]}}}))
 assert.ok(/<button[^>]*aria-label="余额 ¥115.00，展开账户详情"/.test(html))
 assert.match(html,/<span class="px-pill-label">余额<\/span><b class="px-pill-value">¥115\.00<\/b>/)
 assert.equal((html.match(/aria-expanded="false"/g)??[]).length,2)
 assert.ok(!html.includes('px-detail-anchor'),'closed cards must not occupy the dock layout')
})
check('composer quota badge keeps the remaining descriptor with the provider and the value numeric',()=>{
 const render=(window)=>renderToStaticMarkup(React.createElement(SessionCostView,{cost:{standard:1,peak:1,idle:0},showTokens:false,account:{kind:'plan',label:'CC',plan:{window}}}))
 const percent=render({usedPercent:28})
 assert.match(percent,/<button[^>]*aria-label="CC剩余 72%，展开账户详情"/)
 assert.match(percent,/<span class="px-pill-label">CC剩余<\/span><b class="px-pill-value">72%<\/b>/)
 assert.match(render({remaining:65.55,unit:'$'}),/<span class="px-pill-label">CC剩余<\/span><b class="px-pill-value">\$65\.55<\/b>/)
 const over=render({usedPercent:140})
 assert.match(over,/<span class="px-pill-label">CC<\/span><b class="px-pill-value">已超限<\/b>/)
 assert.match(over,/class="px-pill-dot px-tone-bg-red"/)
})
check('quota popover fills the meter by the remaining percentage, not the used percentage',()=>{
 const window={label:'5 小时',used:28,total:100,unit:'$'}
 const model=accountDetailModel({account:{kind:'plan',label:'CC',plan:{window}}})
 const html=renderToStaticMarkup(React.createElement(CostDetailPanel,{model}))
 assert.match(html,/class="px-detail-headline">剩余 72%</)
 assert.match(html,/class="px-detail-meter-fill[^"\n]*" style="width:72%"/)
 assert.ok(html.includes('剩余比例') && html.includes('剩余额度') && !html.includes('已用'))
})
check('fee card defaults to cost while its secondary time tab renders completed timing',()=>{
 const model={title:'本次会话',tone:'pink',headline:'¥9.00',sections:[{label:'分时计价',rows:[]}],notes:[],empty:false}
 const timeModel={title:'本会话时间',tone:'green',headline:'2s',sections:[{label:'已完成执行',rows:[{label:'等待用户（近似）',value:'1h'}]}],notes:[],empty:false}
 const cost=renderToStaticMarkup(React.createElement(CostDetailPanel,{model,timeModel}))
 assert.equal((cost.match(/role="tab"/g)??[]).length,2)
 assert.ok(cost.includes('分时计价') && !cost.includes('等待用户（近似）'))
 const time=renderToStaticMarkup(React.createElement(CostDetailPanel,{model,timeModel,initialTab:'time'}))
 assert.ok(time.includes('本会话时间') && time.includes('等待用户（近似）') && !time.includes('分时计价'))
 assert.ok(/aria-selected="true"[^>]*>时间</.test(time))
})
check('a tall account card does not flip below the anchor and clip beyond a short viewport',()=>{
 const style=detailPanelPlacement({rect:{top:180,bottom:204,left:100,width:100},panelHeight:400,viewportWidth:800,viewportHeight:500})
 assert.equal(style.top,'12px')
 const narrow=detailPanelPlacement({rect:{top:400,bottom:424,left:300,width:20},panelHeight:200,viewportWidth:320,viewportHeight:600})
 assert.equal(narrow.width,'296px')
 assert.equal(narrow.left,'12px')
})
if (process.argv.includes('--layout')) {
  const { STYLES } = await import(pathToFileURL(resolve(source, 'theme.js')).href)
  check('the cost and quota stay on the native dock row as available width shrinks and grows', () => {
    const browser = [process.env.DSH_TEST_BROWSER,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/chromium', '/usr/bin/google-chrome',
    ].find((path) => path && existsSync(path))
    assert.ok(browser, 'Set DSH_TEST_BROWSER to a Chromium executable')
    const html = renderToStaticMarkup(React.createElement(SessionCostView, {
      cost: { standard: 4.33 }, showTokens: false, unpriced: ['fixture'],
      account: { kind: 'plan', label: 'Codex', plan: { window: { usedPercent: 39 } } },
    }))
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dock-layout-'))
    try {
      const page = join(dir, 'dock.html')
      // Mirror only the layout contract of DSH's InputBar / StatsPills, not their application state.
      writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>
        ${STYLES.map(([, css]) => css).join('\n')}
        body { font-family: 'Microsoft YaHei', sans-serif; }
        #composer { display:flex; flex-direction:column; align-items:center; }
        #dock { display:flex; align-items:center; justify-content:center; gap:12px; max-width:100%; }
        .stat { display:inline-flex; min-width:0; font-size:12px; line-height:20px; }
        .reading { display:inline-flex; gap:6px; box-sizing:border-box; max-width:100%; padding:1px 8px; white-space:nowrap; }
        .reading i { width:14px; flex:none; }
        .reading span { min-width:0; overflow:hidden; text-overflow:ellipsis; }
        #meter { flex:none; padding:1px 8px; font-size:12px; line-height:20px; }
        </style><div id="composer"><div id="dock">
          <span class="stat"><span class="reading"><i></i><span>24 轮 218 步 · 128.4 tok/s</span></span></span>
          <span class="stat"><span class="reading"><i></i><span>50M tok · 缓存命中 84%</span></span></span>
          ${html}<span id="meter">◔ 77%</span>
        </div></div><output id="layout"></output><script>
        const nodes = [...document.querySelectorAll('.px-pill-group > .px-pill')];
        const group = document.querySelector('.px-pill-group');
        const dock = document.getElementById('dock');
        document.getElementById('layout').textContent = JSON.stringify([860, 686, 500, 360, 860].map(width => {
          document.getElementById('composer').style.width = width + 'px';
          const boxes = nodes.map(node => node.getBoundingClientRect());
          const dockBox = dock.getBoundingClientRect();
          const groupBox = group.getBoundingClientRect();
          const siblings = [...dock.children].map(node => node.getBoundingClientRect());
          const fits = (rects, parent) => rects.every((box, i) => box.left >= parent.left - 1
            && box.right <= parent.right + 1 && box.width > 0 && (i === 0 || box.left >= rects[i - 1].right - 1));
          return { width, rows: new Set(boxes.map(box => Math.round(box.top))).size,
            height: dockBox.height, groupWidth: groupBox.width,
            fits: fits(boxes, groupBox) && fits(siblings, dockBox) && dock.scrollWidth <= Math.ceil(dockBox.width),
            labelsClipped: nodes.some(node => node.querySelector('.px-pill-label').scrollWidth > node.querySelector('.px-pill-label').clientWidth),
            readable: nodes.every((node, i) => {
              const value = node.querySelector('.px-pill-value');
              const indicators = [...node.querySelectorAll('.px-pill-value, .px-pill-tag, .px-pill-caret')];
              return value.scrollWidth <= value.clientWidth && indicators.every(indicator => {
                const rect = indicator.getBoundingClientRect();
                return rect.width > 0 && rect.left >= boxes[i].left && rect.right <= boxes[i].right;
              });
            }),
          };
        }));
        </script>`, 'utf8')
      const result = spawnSync(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
        '--disable-background-networking', '--no-default-browser-check', '--window-size=1000,480',
        `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', pathToFileURL(page).href,
      ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
      assert.ifError(result.error)
      const output = /<output id="layout">(\[[^<]+\])<\/output>/.exec(result.stdout)
      assert.ok(output, `Chromium did not return dock measurements (exit ${result.status})`)
      const measurements = JSON.parse(output[1])
      const [wide, sidebarOpen, , tight, expandedAgain] = measurements
      assert.ok(sidebarOpen.readable, 'the reference sidebar width must preserve both values, the estimate badge, and carets')
      for (const sample of measurements) {
        assert.equal(sample.rows, 1, `composer ${sample.width}px: badges span ${sample.rows} rows (${sample.height}px tall)`)
        assert.equal(sample.height, wide.height, `composer ${sample.width}px: dock height changed`)
        assert.ok(sample.fits, `composer ${sample.width}px: badges overflow their group or overlap other readings`)
      }
      assert.ok(tight.groupWidth < wide.groupWidth && tight.labelsClipped, 'narrow layout should shrink and truncate text')
      assert.ok(!wide.labelsClipped && !expandedAgain.labelsClipped, 'wide layout should restore full text')
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })
}

const liveBase=process.argv.find((value)=>value.startsWith('--live-base='))?.slice('--live-base='.length)
if(liveBase){
 const load=async(path)=>{const response=await fetch(liveBase+path,{signal:AbortSignal.timeout(60_000)});if(!response.ok)throw new Error(`Live card fixture HTTP ${response.status}`);return response.json()}
 const [data,balance,plans]=await Promise.all(['/dsh-pixel/data','/dsh-pixel/balance','/dsh-pixel/plans'].map(load))
 const {resolveAccount}=await import(pathToFileURL(resolve(source,'account.js')).href)
 const {providerById}=await import(pathToFileURL(resolve(source,'plans.js')).href)
 check('cards render real current service data without missing-number text or exceptions',()=>{
  const account=resolveAccount({balance,plans})
  const accountModel=accountDetailModel({account,provider:providerById(plans,account.planId),timezone:data.timezone})
  const team=data.teams?.[0]
  const row=data.sessions?.find((session)=>session.id===team?.leadId) ?? data.sessions?.[0]
  for(const model of [accountModel,timeDetailModel({row,team,sessions:data.sessions})]){
   const html=renderToStaticMarkup(React.createElement(CostDetailPanel,{model}))
   assert.ok(!/NaN|Infinity|undefined/.test(html))
   if(!model.empty) assert.ok(html.includes('role="dialog"'))
  }
 })
}
console.log(`\n${passed} dock UI checks passed (${source})`)
