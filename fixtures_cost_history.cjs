const vm=require('vm'),fs=require('fs'),assert=require('assert');
const source=fs.readFileSync(require('path').join(__dirname,'js/cost_history.js'),'utf8');
async function test(initial,allowed=true){
 const rows=structuredClone(initial), calls=[], elements={};
 for(const id of ['code','value','date','vat','reason','save','lookup','form','status','product'])elements[id]={value:'',textContent:'',addEventListener(){}};
 Object.assign(elements.code,{value:'TEST'});elements.value.value='100';elements.date.value='2026-10-01';elements.vat.value='EXCLUDED';elements.reason.value='test confirmed evidence';
 const client={auth:{getUser:async()=>({data:{user:{id:'staff'}}})},from(table){const q={select(){return q},eq(){return q},order(){return Promise.resolve({data:rows})},single(){return Promise.resolve({data:table==='profiles'?{approver:allowed}:{id:'p',code:'TEST',name:'test',is_set:false}})}};return q},async rpc(name,args){calls.push(name);if(name.includes('propose')){rows.push({...args.p,id:'new',status:'DRAFT'});return {data:'new'}}rows.find(r=>r.id===args.p_id).status='CONFIRMED';return {data:null}}};
 const ctx=vm.createContext({window:{supabase:{createClient:()=>client}},document:{getElementById:id=>elements[id]},console});vm.runInContext(source,ctx);await elements.lookup.onclick();await elements.form.onsubmit({preventDefault(){}});return {rows,calls,elements};
}
(async()=>{
 let t=await test([]);assert.equal(t.calls.length,2);assert.equal(t.rows[0].status,'CONFIRMED');
 t=await test(t.rows);assert.equal(t.calls.length,0);
 t=await test([{id:'old',value:200,vat_basis:'EXCLUDED',unit:'PER_UNIT',effective_from:'2026-09-01',effective_to:null,status:'CONFIRMED'}]);assert.equal(t.calls.length,0);
 t=await test([],false);assert.equal(t.calls.length,0);
 t=await test([{id:'draft',value:100,vat_basis:'EXCLUDED',unit:'PER_UNIT',effective_from:'2026-10-01',effective_to:null,status:'DRAFT',evidence_ref:'test confirmed evidence'}]);assert.deepEqual(t.calls,['fn_confirm_product_cost_rate']);
 console.log('5 cases passed: new, duplicate, overlap, permission, resume');
})();
