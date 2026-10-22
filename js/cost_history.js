/* Authenticated staff RPCs only. No service key, direct writes or embedded business data. */
"use strict";
const costClient = window.supabase.createClient("https://lqdgoqlkfckifqyjhnon.supabase.co", "sb_publishable_MV6Ph9WOrv0nzVIvseXlLw_O5WhfQPv");
const el = id => document.getElementById(id);
let selected = null, busy = false, approver = false;
const message = value => { el("status").textContent = value; };
async function checked(query) { const {data,error} = await query; if(error) throw new Error(error.message); return data; }
async function authenticate() {
  const user = await checked(costClient.auth.getUser());
  if (!user?.user) throw new Error("먼저 ERP에 로그인하세요.");
  const profile = await checked(costClient.from("profiles").select("id,approver").eq("id",user.user.id).single());
  approver = profile.approver === true;
  if(!approver) throw new Error("원가 이력 확정 권한이 있는 계정으로 로그인하세요.");
}
async function history(pid) {
  return await checked(costClient.from("product_cost_rates").select("id,value,unit,vat_basis,effective_from,effective_to,status,evidence_ref")
    .eq("product_id",pid).eq("channel","*").eq("cost_type","PRODUCT_UNIT_COST").order("effective_from"));
}
async function lookup() {
  selected=null; el("save").disabled=true;
  await authenticate();
  const p = await checked(costClient.from("products").select("id,code,name,is_set").eq("code",el("code").value.trim()).single());
  if(p.is_set) throw new Error("세트는 부모 상품의 원가 이력을 확인하세요. 여기서 별도 등록하지 않습니다.");
  const rows = await history(p.id);
  el("product").textContent = p.code+" · "+p.name+"\n"+JSON.stringify(rows,null,2);
  selected=p; el("save").disabled=!approver;
}
el("code").addEventListener("input",()=>{selected=null;el("save").disabled=true;});
el("lookup").onclick=async()=>{try{await lookup();message("상품과 이력을 확인했습니다.");}catch(e){message(e.message);}};
el("form").onsubmit=async event=>{
  event.preventDefault(); if(busy)return;
  busy=true;el("save").disabled=true;
  try {
    await authenticate();
    if(!selected || selected.code!==el("code").value.trim()) throw new Error("상품을 먼저 조회하세요.");
    const value=Number(el("value").value), date=el("date").value, vat=el("vat").value, reason=el("reason").value.trim();
    if(!el("value").value || !Number.isFinite(value)||value<0||!/^\d{4}-\d{2}-\d{2}$/.test(date)||reason.length<5) throw new Error("원가·적용일·근거를 확인하세요.");
    const rows=(await history(selected.id)).filter(r=>r.status!=="VOID");
    const overlapping=rows.filter(r=>!r.effective_to || r.effective_to>=date);
    const exact=overlapping.filter(r=>Number(r.value)===value&&r.vat_basis===vat&&r.unit==="PER_UNIT"&&r.effective_from===date&&!r.effective_to);
    if(overlapping.length && (exact.length!==1 || overlapping.length!==1)) throw new Error("적용 기간이 기존 이력과 겹칩니다. 기존 이력을 변경하지 않았습니다.");
    let id=exact[0]?.id;
    if(exact[0]?.status==="CONFIRMED") {message("동일한 확정 이력이 이미 있습니다. 중복 등록하지 않았습니다.");return;}
    if(exact[0] && (exact[0].status!=="DRAFT"||exact[0].evidence_ref!==reason)) throw new Error("기존 제안의 상태·근거가 다릅니다. 기존 제안을 먼저 확인하세요.");
    if(!id) id=await checked(costClient.rpc("fn_propose_product_cost_rate",{p:{product_id:selected.id,channel:"*",cost_type:"PRODUCT_UNIT_COST",value,unit:"PER_UNIT",vat_basis:vat,effective_from:date,effective_to:null,evidence_type:"OWNER_CONFIRMED",evidence_ref:reason,reason}}));
    message("제안 저장 완료. 승인자 권한으로 확정 중…");
    await checked(costClient.rpc("fn_confirm_product_cost_rate",{p_id:id,p_reason:reason}));
    const saved=(await history(selected.id)).find(r=>r.id===id);
    if(saved?.status!=="CONFIRMED") throw new Error("저장 상태를 다시 확인해야 합니다. 중복 등록하지 마세요.");
    message("확정 완료\n"+selected.code+" · "+selected.name+"\n"+JSON.stringify(saved,null,2));
    await lookup();
  }catch(e){message("처리 확인 필요: "+e.message+"\n이미 저장된 제안은 동일한 근거로 다시 실행하면 이어서 확정합니다.");}
  finally{busy=false;el("save").disabled=!selected||!approver;}
};
authenticate().then(()=>message("승인자 로그인 확인 완료. 상품을 조회하세요.")).catch(e=>message(e.message));
