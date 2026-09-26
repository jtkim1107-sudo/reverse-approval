/* 재입고 후보 승인 - 2026-09-27 [대표 지시]
   재입고 예약 파이프라인(공급처 답장 → 수량 재확인 → 출고 가능일 → 후보)이 만든 WING 입고 후보(PENDING_APPROVAL)를
   승인 권한자가 확인하고 승인·거절하는 화면이에요. 승인 전에는 어떤 후보도 WING 에 제출되지 않아요(제출 단계는 APPROVED 만 선점).
   - 택배(PARCEL) 후보: 승인 때 센터를 고르지 않아요(WING 이 제출 때 min_edd 이후 가장 이른 날짜의 센터를 추천) → [승인]/[거절].
   - 트럭 후보: 승인 때 목적지 센터를 골라야 해서 이 화면은 보기만(센터 선택 승인은 아직 화면 없음).
   - 버튼은 서버 함수 1번(fn_approve_/fn_reject_restock_inquiry_wing_candidate) - 사용자 ID 를 보내지 않아요(서버가 로그인 세션으로 판단).
   - 누르기 직전 서버 상태 다시 읽기(이미 처리됐으면 멈춤) · 처리 중 다시 누를 수 없음 · 성공·실패 모두 다시 읽기.
   - 지금 재고 판단(ORDER_NOW·추천 EA)이 후보 수량과 다르면 승인 버튼을 막고 이유를 보여요(서버도 제출 직전 다시 확인). */
(function (root) {
  "use strict";

  const ROUTE = "restockapproval";
  const TITLE = "재입고 후보 승인";
  const UI = () => root.ErpUi;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => (n === null || n === undefined || n === "") ? "—" : Number(n).toLocaleString("ko-KR");
  const fmtKst = ts => {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }).slice(0, 16);
  };

  // ── 순수 함수(테스트 대상) ────────────────────────────────────────────────
  function expectedEa(cand, proc) {
    const q = Number(cand && cand.extracted_quantity);
    if (!Number.isInteger(q) || q <= 0) return null;
    if (cand.extracted_unit === "EA") return q;
    if (cand.extracted_unit === "BOX") { const u = Number(proc && proc.units_per_box); return Number.isInteger(u) && u > 0 ? q * u : null; }
    if (cand.extracted_unit === "PLT") { const u = Number(proc && proc.units_per_plt); return Number.isInteger(u) && u > 0 ? q * u : null; }
    return null;
  }

  function decisionCheck(decision, ea, opts = {}) {
    if (opts.error) return { ok: null, text: `재고 판단을 읽지 못했어요: ${opts.error}` };
    if (!decision) return { ok: null, text: "재고 판단 행이 없어요" };
    if (decision.decision !== "ORDER_NOW") return { ok: false, text: `지금 재고 판단: ${decision.decision}${decision.decision_reason ? ` - ${decision.decision_reason}` : ""}` };
    if (decision.recommended_order_qty_ea !== ea) return { ok: false, text: `지금 추천 ${num(decision.recommended_order_qty_ea)}EA ≠ 후보 ${num(ea)}EA` };
    return { ok: true, text: `지금 발주 · 추천 ${num(decision.recommended_order_qty_ea)}EA = 후보 수량` };
  }

  /** 행 → { approve, reject } 각 { enabled, why }. 최종 판단은 서버. */
  function actionState(row, ctx = {}) {
    const deny = why => ({ enabled: false, why });
    if (!ctx.isApprover) return { approve: deny("승인 권한자만"), reject: deny("승인 권한자만") };
    const c = row.candidate || {};
    if (c.status !== "PENDING_APPROVAL") return { approve: deny(`후보 상태: ${c.status}`), reject: deny(`후보 상태: ${c.status}`) };
    const reject = { enabled: true, why: "" };
    if (row.lane !== "PARCEL") return { approve: deny("트럭 후보는 승인 때 목적지 센터를 골라야 해요 - 이 화면은 택배(PARCEL)만 승인"), reject };
    if (row.rehearsal) return { approve: deny("리허설 후보는 리허설 절차로만"), reject: deny("리허설 후보는 리허설 절차로만") };
    if (row.reconfirmPending) return { approve: deny("공급처 수량 재확인 답장을 기다리는 중이에요"), reject };
    if (row.ea === null) return { approve: deny("후보 수량(EA)을 계산할 수 없어요"), reject };
    if (row.expiryRequired && !row.policyExpiry) return { approve: deny("발주정보에 유통기한 날짜가 없어요"), reject };
    if (ctx.today && row.candidate.extracted_eta_date && row.candidate.extracted_eta_date < ctx.today) return { approve: deny("출고 가능일이 지났어요"), reject };
    if (ctx.decisionCheck && ctx.decisionCheck.ok === false) return { approve: deny(ctx.decisionCheck.text), reject };
    return { approve: { enabled: true, why: "" }, reject };
  }

  function interpretRpc(fn, data, error) {
    if (error) return { ok: false, message: error.message || error.code || String(error) };
    const st = data && data.status;
    if (fn === "fn_approve_restock_inquiry_wing_candidate" && st === "APPROVED") return { ok: true, message: "승인됨 - 예약 파이프라인의 제출 단계가 켜져 있으면 다음 사이클에 제출돼요" };
    if (fn === "fn_reject_restock_inquiry_wing_candidate" && st === "REJECTED") return { ok: true, message: "거절됨(기록 보존)" };
    return data ? { ok: true, message: st ? `처리했어요(${st})` : "처리했어요" } : { ok: false, message: "서버 응답이 비어 있어요" };
  }

  function buildRows(d) {
    const by = (list, k = "id") => Object.fromEntries((list || []).map(x => [String(x[k]), x]));
    const procs = by(d.procurements, "product_id"), prods = by(d.products), inqs = by(d.inquiries), rcs = by(d.reconfirmations);
    const pendingRc = new Set((d.reconfirmations || []).filter(r => r.status === "PENDING_SUPPLIER_CONFIRMATION").map(r => String(r.inquiry_item_id)));
    return (d.candidates || []).map(c => {
      const proc = procs[String(c.product_id)] || null;
      const inq = inqs[String(c.inquiry_id)] || {};
      return {
        candidate: c, procurement: proc, product: prods[String(c.product_id)] || null, inquiry: inq,
        reconfirmation: c.quantity_reconfirmation_id ? rcs[String(c.quantity_reconfirmation_id)] || null : null,
        lane: proc ? proc.inbound_shipment_mode || "TRUCK" : null, rehearsal: inq.is_rehearsal === true,
        reconfirmPending: pendingRc.has(String(c.inquiry_item_id)),
        ea: expectedEa(c, proc), expiryRequired: !!(proc && proc.inbound_expiration_required),
        policyExpiry: proc && proc.inbound_expiration_required ? proc.inbound_expiration_date || null : null,
      };
    });
  }

  // ── 데이터 ───────────────────────────────────────────────────────────────
  const S = { sb: null, me: null, rows: [], loadError: null, decisions: null, decisionError: null, decisionAt: null, loadedAt: null };
  async function q(p) { const { data, error } = await p; if (error) throw new Error(error.message || error.code || "조회 실패"); return data || []; }

  async function load(sb) {
    const candidates = await q(sb.from("restock_inquiry_wing_candidates").select("*").eq("status", "PENDING_APPROVAL").order("created_at", { ascending: true }));
    const pids = [...new Set(candidates.map(c => c.product_id))], iids = [...new Set(candidates.map(c => c.inquiry_id))];
    const itemIds = [...new Set(candidates.map(c => c.inquiry_item_id))];
    const [procurements, products, inquiries, reconfirmations] = await Promise.all([
      pids.length ? q(sb.from("product_procurement").select("*").in("product_id", pids)) : [],
      pids.length ? q(sb.from("products").select("id,code,name").in("id", pids)) : [],
      iids.length ? q(sb.from("restock_supplier_inquiries").select("id,supplier_name,is_rehearsal,status,sent_at").in("id", iids)) : [],
      itemIds.length ? q(sb.from("restock_quantity_reconfirmations").select("id,status,inquiry_item_id,confirmed_ea,revised_ea").in("inquiry_item_id", itemIds)) : [],
    ]);
    return { candidates, procurements, products, inquiries, reconfirmations };
  }

  const decisionOf = pid => (S.decisions || []).find(d => String(d.product_id) === String(pid)
    && ((d.shared_inventory || {}).role || "base") !== "child" && ((d.resale_pool || {}).role || "") !== "resale") || null;

  async function refreshState() {
    S.loadError = null;
    try { S.rows = buildRows(await load(S.sb)); } catch (e) { S.loadError = e.message || String(e); S.rows = []; }
    const f = root.fetchInventoryDecisions;
    const r = typeof f === "function" ? await f(false).catch(e => ({ ok: false, error: String(e) })) : { ok: false, error: "재고 판단 화면 함수를 찾지 못했어요" };
    S.decisions = r && r.ok ? r.decisions || [] : null; S.decisionError = r && r.ok ? null : (r && r.error) || "재고 판단을 읽지 못했어요";
    S.decisionAt = r && r.ok ? r.calculatedAt || null : null;
    S.loadedAt = new Date().toISOString();
  }

  const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  function rowHtml(row) {
    const c = row.candidate;
    const dc = decisionCheck(decisionOf(c.product_id), row.ea, { error: S.decisionError });
    const act = actionState(row, { isApprover: !!(S.me && S.me.approver), decisionCheck: dc, today: todayKst() });
    const btn = (label, key, fn, a, cls = "") => `<div><button class="btn sm ${cls}" data-erp-key="${key}" ${a.enabled ? "" : "disabled"} title="${esc(a.why)}"
      onclick="RestockCandidateApproval.${fn}('${esc(c.id)}')">${esc(label)}</button>${a.enabled ? "" : `<div class="rg-muted" style="font-size:12px">${esc(a.why)}</div>`}</div>`;
    return `<div class="card rca-row" data-candidate="${esc(c.id)}">
      <h3 style="margin:0 0 8px">${esc((row.product || {}).name || "상품")} <small class="rg-muted">${esc((row.product || {}).code || "")}</small>
        ${row.rehearsal ? UI().badge("info", { text: "리허설" }) : ""}</h3>
      <table class="rg-detail"><tbody>
        <tr><th>후보</th><td>${UI().badge("pending", { text: "승인 대기" })} <code>${esc(String(c.id).slice(0, 8))}</code> · 만든 시각 ${esc(fmtKst(c.created_at))}</td></tr>
        <tr><th>공급처</th><td>${esc(row.inquiry.supplier_name || "—")}</td></tr>
        <tr><th>입고 방식</th><td>${esc(row.lane === "PARCEL" ? "택배(PARCEL) - 센터는 WING 이 제출 때 추천" : (row.lane || "—"))}</td></tr>
        <tr><th>수량</th><td>${num(c.extracted_quantity)}${esc(c.extracted_unit)}${row.ea ? ` = <b>${num(row.ea)}EA</b>` : ""}
          ${row.reconfirmation ? ` · 공급처 재확인 ${esc(row.reconfirmation.status)} ${num(row.reconfirmation.confirmed_ea)}EA` : ""}</td></tr>
        <tr><th>출고 가능일</th><td>${esc(c.extracted_eta_date || "—")} <small class="rg-muted">(공급처 답장 - 쿠팡 입고일은 제출 때 WING 슬롯으로)</small></td></tr>
        <tr><th>유통기한</th><td>${esc(row.policyExpiry || (row.expiryRequired ? "없음(발주정보 입력 필요)" : "관리 안 함"))}</td></tr>
        <tr><th>답장 근거</th><td><small>${esc(String(c.extraction_evidence || "").slice(0, 300))}</small></td></tr>
        <tr><th>지금 재고 판단</th><td>${dc.ok === true ? UI().badge("urgent", { text: dc.text }) : UI().badge("check", { text: dc.text })}
          ${S.decisionAt ? `<small class="rg-muted"> · 계산 ${esc(fmtKst(S.decisionAt))}</small>` : ""}</td></tr>
      </tbody></table>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
        ${btn("승인", `rca-approve-${c.id}`, "approve", act.approve)}${btn("거절", `rca-reject-${c.id}`, "reject", act.reject, "secondary")}
      </div></div>`;
  }

  function pageHtml() {
    const head = `<div class="card"><h2 style="margin:0 0 6px">✅ ${TITLE}</h2>
      <p class="rg-muted" style="margin:0">예약 파이프라인이 공급처 답장으로 만든 WING 입고 후보예요. <b>승인 전에는 WING 에 제출되지 않아요.</b>
      승인해도 이 화면은 WING 에 보내지 않아요 - 제출은 파이프라인 제출 단계(스위치)가 1건씩 해요. WING 신청 취소·재신청은 [재입고 WING 복구] 화면이에요.</p>
      <p class="rg-muted" style="margin:6px 0 0;font-size:12px">서버 상태 읽음 ${esc(fmtKst(S.loadedAt))}
        <button class="btn sm secondary" data-erp-key="rca-reload" onclick="RestockCandidateApproval.reload()">새로고침</button></p></div>`;
    if (S.loadError) return head + `<div class="card" style="border:2px solid var(--red)"><b>불러오지 못했어요</b><p class="rg-muted">${esc(S.loadError)}</p></div>`;
    if (!S.rows.length) return head + `<div class="card rg-muted">승인 대기 중인 재입고 후보가 없어요.</div>`;
    return head + S.rows.map(rowHtml).join("");
  }

  async function view(sb, me) {
    S.sb = sb; S.me = me;
    if (!(me && me.approver)) {
      return `<div class="card"><h2>✅ ${TITLE}</h2><p>승인 권한자만 볼 수 있는 화면이에요.</p></div>`;
    }
    await refreshState();
    return pageHtml();
  }

  function rerender() {
    const el = root.document && root.document.getElementById("content");
    if (el && String((root.location || {}).hash || "").startsWith(`#/${ROUTE}`)) el.innerHTML = pageHtml();
  }
  async function reload() { await refreshState(); rerender(); }

  function run(candidateId, approve) {
    const fn = approve ? "fn_approve_restock_inquiry_wing_candidate" : "fn_reject_restock_inquiry_wing_candidate";
    let row = null;
    return UI().run({
      key: `rca-${approve ? "approve" : "reject"}-${candidateId}`, allowed: !!(S.me && S.me.approver),
      deniedText: "승인 권한자만 처리할 수 있어요 - 읽기 전용이에요",
      precheck: async () => {
        await refreshState(); rerender();
        row = S.rows.find(r => String(r.candidate.id) === String(candidateId)) || null;
        if (!row) return { ok: false, message: "승인 대기 목록에 없어요(이미 처리됐을 수 있어요)" };
        const dc = decisionCheck(decisionOf(row.candidate.product_id), row.ea, { error: S.decisionError });
        const a = actionState(row, { isApprover: true, decisionCheck: dc, today: todayKst() })[approve ? "approve" : "reject"];
        return a.enabled ? { ok: true, dc } : { ok: false, message: a.why };
      },
      confirm: pre => ({
        title: approve ? "재입고 후보 승인" : "재입고 후보 거절", actionLabel: approve ? "승인" : "거절", danger: !approve,
        rows: [["상품", esc((row.product || {}).name || "—")], ["공급처", esc(row.inquiry.supplier_name || "—")],
               ["수량", `${num(row.candidate.extracted_quantity)}${esc(row.candidate.extracted_unit)} = <b>${num(row.ea)}EA</b>`],
               ["출고 가능일", esc(row.candidate.extracted_eta_date || "—")], ["유통기한", esc(row.policyExpiry || "관리 안 함")],
               ["지금 재고 판단", esc(pre.dc.text)], ["후보", `<code>${esc(row.candidate.id)}</code>`]],
        notes: approve ? ["승인만 해요. 이 화면은 WING 에 보내지 않아요.", "제출 단계가 켜져 있으면 다음 사이클에 이 후보 1건을 제출해요(제출 직전 서버가 수량·유통기한·재고 판단·출고일을 다시 확인)."]
                       : ["거절해도 기록은 남아요. 이 후보는 제출되지 않아요."],
        reason: { label: approve ? "승인 근거" : "거절 사유", required: true, minLength: approve ? 2 : 5 },
      }),
      exec: async reason => {
        const args = approve ? { p_candidate_id: candidateId, p_note: reason, p_destination_center_id: null } : { p_candidate_id: candidateId, p_note: reason };
        const { data, error } = await S.sb.rpc(fn, args);
        const r = interpretRpc(fn, data, error);
        return { ok: r.ok, message: r.message, data };
      },
      successText: res => interpretRpc(fn, res.data, null).message,
      refresh: reload,
    });
  }

  root.RestockCandidateApproval = {
    ROUTE, TITLE, view, reload, approve: id => run(id, true), reject: id => run(id, false),
    expectedEa, decisionCheck, actionState, interpretRpc, buildRows, _state: S,
  };
})(typeof window !== "undefined" ? window : globalThis);
