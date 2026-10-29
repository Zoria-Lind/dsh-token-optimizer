// Exact installed Cordis getter; other context collaborators remain explicit test fixtures.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import vm from 'node:vm'
import {join} from 'node:path'
const manifest=join(process.env.DSH_TO03_STATE,'../../../../_evidence/TO-03-feedback1/host-guard.json')
const row=JSON.parse(readFileSync(manifest,'utf8')),bytes=readFileSync(row.copy)
assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256)
const source=bytes.toString('utf8'),start=source.indexOf('\t\tget: (target, prop, ctx) => {',source.indexOf('var ReflectService = class')),end=source.indexOf('\n\t\tset:',start)
assert.ok(start>=0&&end>start)
const symbols={isolate:Symbol('isolate'),shadow:Symbol('shadow'),receiver:Symbol('receiver')}
const get=vm.runInNewContext('({'+source.slice(start,end)+'}).get',{Reflect,Error,symbols,isSpecialProperty:p=>typeof p==='symbol',getTraceable:(_ctx,value)=>value,enhanceError:e=>e})
export function restrictSessionService(base){
 const parent={[symbols.isolate]:{},fiber:{runtime:null,inject:{}}}
 const target={...base,reflect:{props:{}},events:{waterfall(_n,_ctx,_prop,_err,end){return end()}},fiber:{runtime:{},store:{},inject:{},parent},[symbols.isolate]:parent[symbols.isolate]}
 delete target.sessions
 return new Proxy(target,{get})
}
