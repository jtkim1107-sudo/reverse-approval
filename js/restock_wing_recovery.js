/* 재입고 WING 복구 - 2026-09-27 [대표 지시]
   재입고(공급처 문의 → 답장 → 후보 → 승인) 경로로 WING 에 제출된 택배(PARCEL) 입고신청을 취소하고 같은 근거로 다시 신청하는 화면이에요.
   (WING 직접입고 발주서의 [WING 취소](fn_decide_wing_direct_cancel·fn_cancel_wing_direct_po)와는 다른 화면·다른 데이터예요.)
   흐름(각 버튼은 서버 함수 1번 - 판정·권한·멱등은 DB 20260927a 가 최종):
     1. [취소 승인]        fn_approve_restock_wing_submission_cancel(제출, 사유) → CANCEL_APPROVED. WING 에는 아직 아무것도 안 보냄.
        실제 WING 취소는 자동화 명령(parcel-cancel)이 1번 - 결과가 WING_CANCELLED 로 기록돼야 다음 단계가 열려요.
     2. [대체 후보 만들기] fn_create_restock_replacement_candidate(취소, 기대 EA, 기대 유통기한, 근거) - WING_CANCELLED 뒤에만.
        서버가 수량·유통기한 정책·지금 재고 판단(ORDER_NOW·추천 EA)·재확인을 다시 확인하고 하나라도 다르면 만들지 않아요.
     3. [대체 후보 승인]/[거절] 기존 후보 승인·거절 함수(fn_approve_/fn_reject_restock_inquiry_wing_candidate).
   - 승인 권한자(profiles.approver)만 볼 수 있고 누를 수 있어요. 사용자 ID 는 보내지 않아요 - 서버가 로그인 세션(auth.uid())으로 판단.
   - 누르기 직전에 서버 상태를 다시 읽어요(이미 처리됐으면 멈춤) · 처리 중엔 다시 누를 수 없음 · 성공·실패 모두 서버 상태 다시 읽기. */
(function (root) {
  "use strict";

  const ROUTE = "restockrecovery";
  const TITLE = "재입고 WING 복구";
  const UI = () => root.ErpUi;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => (n === null || n === undefined || n === "") ? "—" : Number(n).toLocaleString("ko-KR");
  const short = id => (id ? String(id).slice(0, 8) : "—");
  const fmtKst = ts => {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }).slice(0, 16);
  };
  const wingUrl = ship => `https://wing.coupang.com/tenants/rfm-inbound/lightning/summary?id=${encodeURIComponent(ship)}`;

  // 취소 기록 상태 → [배지 종류, 문구, 다음 할 일]
  const CANCEL_STATE = {
    CANCEL_APPROVED: ["approval", "취소 승인됨 · WING 취소 대기", "자동화 명령(parcel-cancel)이 WING 취소를 1번 실행해요"],
    CANCEL_SENDING: ["check", "WING 취소 진행 중 · 결과 기록 대기", "결과 불명일 수 있어요 - 재조회(parcel-cancel-reconcile)로만 확정"],
    WING_CANCELLED: ["ok", "WING 취소 확인됨", "대체 후보를 만들 수 있어요"],
    CANCEL_FAILED: ["error", "WING 취소 실패", "WING 에서 취소되지 않았어요(최대 3회까지 다시 시도)"],
    CANCEL_UNKNOWN: ["check", "WING 취소 결과 불명", "다시 보내지 않아요 - 재조회(parcel-cancel-reconcile)로만 확정"],
  };
  const CAND_STATE = {
    PENDING_APPROVAL: ["pending", "승인 대기"], APPROVED: ["approved", "승인됨"], CLAIMED: ["awaiting", "제출 진행·완료"],
    REJECTED: ["rejected", "거절됨"], SUPERSEDED: ["muted", "대체됨(기록 보존)"], STALE_POLICY_CHANGED: ["muted", "정책 변경으로 멈춤"],
  };
  const SUB_STATE = { SUBMITTED: ["ok", "WING 신청됨"], SUBMITTING: ["check", "제출 중"], SUBMIT_UNKNOWN: ["check", "제출 결과 불명"], FAILED: ["error", "제출 실패"] };
  // 서버 거부 사유 → 사람 문구(모르는 코드는 코드 그대로 보여요)
  const REASON_TEXT = {
    SUBMISSION_NOT_FOUND: "제출 기록을 찾지 못했어요", SUBMISSION_NOT_SUBMITTED: "WING 에 신청된(SUBMITTED) 제출이 아니에요",
    NOT_PARCEL_LANE: "택배(PARCEL) 입고 상품이 아니에요", CONFIRM_MAIL_IN_FLIGHT: "확정 메일이 발송 중이거나 결과 불명이에요 - 먼저 해소해 주세요",
    CANCELLATION_NOT_FOUND: "취소 기록이 없어요", WING_CANCEL_NOT_CONFIRMED: "WING 취소가 아직 확인되지 않았어요",
    ORIGINAL_NOT_CLAIMED_SUBMITTED: "원 후보·제출 상태가 바뀌었어요", NOT_PARCEL_BOX_POLICY: "발주정보가 택배·BOX 정책이 아니에요",
    EXPECTED_EA_MISMATCH: "원래 수량과 기대 수량이 달라요", QTY_NOT_BOX_MULTIPLE: "수량이 박스 입수의 배수가 아니에요",
    EXPIRATION_POLICY_MISMATCH: "발주정보의 유통기한이 기대 날짜와 달라요", EXPIRATION_NOT_REQUIRED_BY_POLICY: "정책상 유통기한 관리 상품이 아니에요",
    RECONFIRMATION_NOT_CONFIRMED_SAME_EA: "공급처 수량 재확인이 같은 수량으로 확인된 상태가 아니에요",
    SHIP_DATE_MISSING_OR_PAST: "출고 가능일이 없거나 지났어요", REPLY_NOT_VERIFIED_MATCH: "공급처 답장 검증 상태가 바뀌었어요",
    INQUIRY_NOT_ACTIVE: "문의가 더 이상 진행 중이 아니에요", QTY_RECONFIRMATION_PENDING: "수량 재확인 답장을 기다리는 중이에요",
    CACHE_MISSING_OR_STALE: "재고 판단이 오래됐거나 없어요(36시간 이내 계산 필요)", DECISION_ROW_NOT_UNIQUE: "재고 판단 행이 하나가 아니에요",
    NOT_ORDER_NOW: "지금 재고 판단이 '지금 발주'가 아니에요", CURRENT_RECOMMENDATION_MISMATCH: "지금 추천 수량이 원래 수량과 달라요",
  };
  const reasonText = code => REASON_TEXT[code] ? `${REASON_TEXT[code]} (${code})` : String(code);

  // ── 순수 함수(테스트 대상) ────────────────────────────────────────────────
  /** 후보 → EA(BOX 면 박스 입수 곱). 모르면 null. */
  function expectedEa(cand, proc) {
    if (!cand) return null;
    const q = Number(cand.extracted_quantity);
    if (!Number.isInteger(q) || q <= 0) return null;
    if (cand.extracted_unit === "EA") return q;
    if (cand.extracted_unit === "BOX") {
      const upb = Number(proc && proc.units_per_box);
      return Number.isInteger(upb) && upb > 0 ? q * upb : null;
    }
    return null;
  }

  /** 지금 재고 판단이 대체 후보 조건(ORDER_NOW · 추천 EA = 원래 EA)과 맞는지. decision = /api/inventory/decisions 의 그 상품 행. */
  function decisionCheck(decision, ea, opts = {}) {
    if (opts.error) return { ok: null, text: `재고 판단을 읽지 못했어요: ${opts.error}` };
    if (!decision) return { ok: null, text: "재고 판단 행이 없어요" };
    const rec = decision.recommended_order_qty_ea;
    if (decision.decision !== "ORDER_NOW") return { ok: false, text: `지금 재고 판단: ${decision.decision}${decision.decision_reason ? ` - ${decision.decision_reason}` : ""}` };
    if (rec !== ea) return { ok: false, text: `지금 추천 ${num(rec)}EA ≠ 원래 ${num(ea)}EA` };
    return { ok: true, text: `지금 발주 · 추천 ${num(rec)}EA = 원래 수량` };
  }

  /** 데이터 묶음 → 제출별 행(원 제출·후보·취소·대체 후보·정책·입고계획). */
  function buildRows(d) {
    const byId = (list, key = "id") => Object.fromEntries((list || []).map(x => [String(x[key]), x]));
    const cands = byId(d.candidates);
    const canc = byId(d.cancellations, "submission_id");
    const procs = byId(d.procurements, "product_id");
    const prods = byId(d.products);
    const plans = byId(d.plans, "coupang_shipment_id");
    const replBy = {};
    (d.candidates || []).forEach(c => { if (c.replaces_candidate_id) replBy[String(c.replaces_candidate_id)] = c; });
    const events = {};
    (d.events || []).forEach(e => { (events[e.cancellation_id] = events[e.cancellation_id] || []).push(e); });
    return (d.submissions || []).map(s => {
      const cand = cands[String(s.candidate_id)] || null;
      const proc = procs[String(s.product_id)] || null;
      const c = canc[String(s.id)] || null;
      return {
        submission: s, candidate: cand, procurement: proc, product: prods[String(s.product_id)] || null,
        plan: s.wing_shipment_id ? plans[String(s.wing_shipment_id)] || null : null,
        cancellation: c, events: c ? (events[c.id] || []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))) : [],
        replacement: cand ? replBy[String(cand.id)] || null : null,
        lane: proc ? proc.inbound_shipment_mode || null : null,
        ea: expectedEa(cand, proc),
        policyExpiry: proc && proc.inbound_expiration_required ? proc.inbound_expiration_date || null : null,
        expiryRequired: !!(proc && proc.inbound_expiration_required),
      };
    });
  }

  /** 행 + 권한 + 재고 판단 → 버튼별 { enabled, why }. 화면 판정은 안내용이고 최종 판단은 서버가 다시 해요. */
  function actionState(row, ctx = {}) {
    const deny = why => ({ enabled: false, why });
    const ok = { enabled: true, why: "" };
    if (!ctx.isApprover) return { cancel: deny("승인 권한자만"), replace: deny("승인 권한자만"), approve: deny("승인 권한자만"), reject: deny("승인 권한자만") };
    const s = row.submission || {};
    const c = row.cancellation;
    const r = row.replacement;
    let cancel = ok;
    if (c) cancel = deny(`이미 취소 기록이 있어요(${(CANCEL_STATE[c.status] || [0, c.status])[1]})`);
    else if (s.status !== "SUBMITTED" || !s.wing_shipment_id) cancel = deny("WING 에 신청된(SUBMITTED) 제출만 취소할 수 있어요");
    else if (row.lane !== "PARCEL") cancel = deny("택배(PARCEL) 입고만 이 화면에서 취소해요");
    else if (!row.candidate || row.candidate.status !== "CLAIMED") cancel = deny("원 후보 상태가 제출 완료(CLAIMED)가 아니에요");
    let replace = ok;
    if (r) replace = deny("대체 후보가 이미 있어요(원 후보당 1개)");
    else if (!c || c.status !== "WING_CANCELLED") replace = deny("WING 취소 확인(WING_CANCELLED) 뒤에만 만들 수 있어요");
    else if (row.ea === null) replace = deny("원래 수량(EA)을 계산할 수 없어요");
    else if (row.expiryRequired && !row.policyExpiry) replace = deny("발주정보에 유통기한 날짜가 없어요");
    else if (ctx.decisionCheck && ctx.decisionCheck.ok === false) replace = deny(ctx.decisionCheck.text);
    const pending = r && r.status === "PENDING_APPROVAL";
    const approve = pending ? ok : deny(r ? `대체 후보 상태: ${(CAND_STATE[r.status] || [0, r.status])[1]}` : "대체 후보가 아직 없어요");
    return { cancel, replace, approve, reject: approve };
  }

  /** RPC 응답 해석 → { ok, idempotent, message }. 서버가 BLOCKED 로 돌려준 사유는 실패로 보여요. */
  function interpretRpc(fn, data, error) {
    if (error) return { ok: false, message: error.message || error.code || String(error) };
    const st = data && data.status;
    if (fn === "fn_approve_restock_wing_submission_cancel") {
      if (st === "CANCEL_APPROVED") return { ok: true, message: "취소 승인됨 - WING 에는 아직 아무것도 보내지 않았어요" };
      if (st && st.startsWith("ALREADY_")) return { ok: true, idempotent: true, message: `이미 취소 기록이 있어요(${st.replace("ALREADY_", "")}) - 새로 만들지 않았어요` };
    }
    if (fn === "fn_create_restock_replacement_candidate") {
      if (st === "PENDING_APPROVAL") return { ok: true, message: `대체 후보를 만들었어요(${num(data.ea)}EA · 유통기한 ${data.expiration_date || "—"}) - 승인해 주세요` };
      if (st === "ALREADY_CREATED") return { ok: true, idempotent: true, message: `대체 후보가 이미 있어요(${short(data.candidate_id)}) - 새로 만들지 않았어요` };
    }
    if (st === "BLOCKED") return { ok: false, message: (data.reasons || []).map(reasonText).join(" · ") || "서버가 거부했어요" };
    if (fn === "fn_approve_restock_inquiry_wing_candidate" && st === "APPROVED") return { ok: true, message: "대체 후보 승인됨 - 제출은 별도 실행이에요" };
    if (fn === "fn_reject_restock_inquiry_wing_candidate" && st === "REJECTED") return { ok: true, message: "대체 후보 거절됨(기록 보존)" };
    return data ? { ok: true, message: st ? `처리했어요(${st})` : "처리했어요" } : { ok: false, message: "서버 응답이 비어 있어요" };
  }

  // ── 데이터 읽기 ───────────────────────────────────────────────────────────
  const S = { sb: null, me: null, data: null, rows: [], loadedAt: null, loadError: null, decisions: null, decisionError: null, decisionAt: null };

  async function q(p) {
    const { data, error } = await p;
    if (error) throw new Error(error.message || error.code || "조회 실패");
    return data || [];
  }

  async function load(sb) {
    const submissions = await q(sb.from("restock_inquiry_wing_submissions").select("*").order("began_at", { ascending: false }));
    const candIds = [...new Set(submissions.map(s => s.candidate_id).filter(Boolean))];
    const prodIds = [...new Set(submissions.map(s => s.product_id).filter(Boolean))];
    const ships = [...new Set(submissions.map(s => s.wing_shipment_id).filter(Boolean))];
    const [origCands, replCands, cancellations, procurements, products, plans] = await Promise.all([
      candIds.length ? q(sb.from("restock_inquiry_wing_candidates").select("*").in("id", candIds)) : [],
      candIds.length ? q(sb.from("restock_inquiry_wing_candidates").select("*").in("replaces_candidate_id", candIds)) : [],
      q(sb.from("restock_wing_submission_cancellations").select("*")),
      prodIds.length ? q(sb.from("product_procurement").select("*").in("product_id", prodIds)) : [],
      prodIds.length ? q(sb.from("products").select("id,code,name").in("id", prodIds)) : [],
      ships.length ? q(sb.from("inbound_plans").select("id,coupang_shipment_id,internal_status,inbound_date,destination_center_raw").in("coupang_shipment_id", ships)) : [],
    ]);
    const cancIds = cancellations.map(c => c.id);
    const events = cancIds.length ? await q(sb.from("restock_wing_submission_cancellation_events").select("*").in("cancellation_id", cancIds)) : [];
    return { submissions, candidates: [...origCands, ...replCands], cancellations, procurements, products, plans, events };
  }

  async function loadDecisions() {
    const f = root.fetchInventoryDecisions;
    if (typeof f !== "function") return { error: "재고 판단 화면 함수를 찾지 못했어요" };
    const r = await f(false);
    return r && r.ok ? { decisions: r.decisions || [], at: r.calculatedAt || r.cacheUpdatedAt || null } : { error: (r && r.error) || "재고 판단을 읽지 못했어요" };
  }

  const decisionOf = productId => (S.decisions || []).find(d => String(d.product_id) === String(productId)
    && ((d.shared_inventory || {}).role || "base") !== "child" && ((d.resale_pool || {}).role || "") !== "resale") || null;

  async function refreshState() {
    S.loadError = null;
    try { S.data = await load(S.sb); S.rows = buildRows(S.data); } catch (e) { S.loadError = e.message || String(e); S.rows = []; }
    const dres = await loadDecisions().catch(e => ({ error: String(e && e.message || e) }));
    S.decisions = dres.decisions || null; S.decisionError = dres.error || null; S.decisionAt = dres.at || null;
    S.loadedAt = new Date().toISOString();
  }

  // ── 화면 ─────────────────────────────────────────────────────────────────
  const badge = (map, st) => { const v = map[st]; return v ? UI().badge(v[0], { text: v[1] }) : UI().badge("info", { text: st || "—" }); };

  function rowHtml(row, i) {
    const s = row.submission, c = row.cancellation, r = row.replacement, cand = row.candidate || {};
    const dc = decisionCheck(decisionOf(s.product_id), row.ea, { error: S.decisionError });
    const act = actionState(row, { isApprover: !!(S.me && S.me.approver), decisionCheck: dc });
    const btn = (label, key, fnName, a, extra = "") => `<button class="btn sm ${extra}" data-erp-key="${key}" ${a.enabled ? "" : "disabled"}
      title="${esc(a.why)}" onclick="RestockWingRecovery.${fnName}('${esc(s.id)}')">${esc(label)}</button>${a.enabled ? "" : `<div class="rg-muted" style="font-size:12px">${esc(a.why)}</div>`}`;
    const cs = c ? CANCEL_STATE[c.status] : null;
    return `
      <div class="card rwr-row" id="rwr-row-${i}" data-submission="${esc(s.id)}">
        <h3 style="margin:0 0 8px">${esc((row.product || {}).name || "상품")} <small class="rg-muted">${esc((row.product || {}).code || "")}</small></h3>
        <table class="rg-detail"><tbody>
          <tr><th>원 제출</th><td>${badge(SUB_STATE, s.status)} <code>${esc(short(s.id))}</code> · 멱등키 <code>${esc(s.idempotency_key || "—")}</code> · ${esc(fmtKst(s.began_at))}</td></tr>
          <tr><th>WING 신청</th><td>${s.wing_shipment_id ? `<b>${esc(s.wing_shipment_id)}</b> <a href="${wingUrl(s.wing_shipment_id)}" target="_blank" rel="noopener">WING 상세 열기</a>` : "—"}
            ${row.plan ? ` · ERP 입고계획 ${esc(row.plan.internal_status)} · ${esc(row.plan.destination_center_raw || "센터 —")} · 입고 ${esc(row.plan.inbound_date || "—")}` : ""}</td></tr>
          <tr><th>수량</th><td>${num(cand.extracted_quantity)}${esc(cand.extracted_unit || "")}${row.ea ? ` = <b>${num(row.ea)}EA</b>` : ""}
            ${row.procurement && row.procurement.units_per_box ? ` <small class="rg-muted">(박스 입수 ${num(row.procurement.units_per_box)})</small>` : ""} · 레인 ${esc(row.lane || "—")}</td></tr>
          <tr><th>유통기한</th><td>정책 <b>${esc(row.policyExpiry || (row.expiryRequired ? "없음(입력 필요)" : "관리 안 함"))}</b>
            · WING 에 기록된 값은 ERP 에 저장되지 않아요 - <a href="${s.wing_shipment_id ? wingUrl(s.wing_shipment_id) : "#"}" target="_blank" rel="noopener">WING 상세</a>에서 확인</td></tr>
          <tr><th>원 후보</th><td>${badge(CAND_STATE, cand.status)} <code>${esc(short(cand.id))}</code> · 출고 가능일 ${esc(cand.extracted_eta_date || "—")}</td></tr>
          <tr><th>취소 상태</th><td>${c ? `${UI().badge(cs ? cs[0] : "info", { text: cs ? cs[1] : c.status })} ${cs ? `<small class="rg-muted">${esc(cs[2])}</small>` : ""}
            <br><small class="rg-muted">시도 ${num(c.attempt_no)}/3 · 승인 ${esc(fmtKst(c.approved_at))} · WING 관측 ${esc(c.observed_wing_status || "—")}${c.failure_code ? ` · 실패 ${esc(c.failure_code)}` : ""}</small>
            ${row.events.length ? `<br><small class="rg-muted">이력: ${row.events.map(e => `${esc(e.to_status)}(${esc(fmtKst(e.created_at))})`).join(" → ")}</small>` : ""}` : "취소 기록 없음"}</td></tr>
          <tr><th>지금 재고 판단</th><td>${dc.ok === true ? UI().badge("urgent", { text: dc.text }) : UI().badge("check", { text: dc.text })}
            <small class="rg-muted">${S.decisionAt ? ` · 계산 ${esc(fmtKst(S.decisionAt))}` : ""}</small></td></tr>
          <tr><th>대체 후보</th><td>${r ? `${badge(CAND_STATE, r.status)} <code>${esc(short(r.id))}</code> · ${num(r.extracted_quantity)}${esc(r.extracted_unit)} · 새 멱등키 <code>restock-wing-submit:${esc(r.id)}</code>` : "없음"}</td></tr>
        </tbody></table>
        <div class="rwr-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:flex-start">
          <div>${btn("1. WING 신청 취소 승인", `rwr-cancel-${s.id}`, "approveCancel", act.cancel, "danger")}</div>
          <div>${btn("2. 대체 후보 만들기", `rwr-replace-${s.id}`, "createReplacement", act.replace)}</div>
          <div>${btn("3. 대체 후보 승인", `rwr-approve-${s.id}`, "approveReplacement", act.approve)}</div>
          <div>${btn("대체 후보 거절", `rwr-reject-${s.id}`, "rejectReplacement", act.reject, "secondary")}</div>
        </div>
      </div>`;
  }

  function pageHtml() {
    const head = `<div class="card"><h2 style="margin:0 0 6px">🔁 ${TITLE}</h2>
      <p class="rg-muted" style="margin:0">공급처 재입고 문의로 WING 에 낸 <b>택배 입고신청</b>을 취소하고 같은 근거로 다시 신청해요.
      WING 직접입고 발주서의 [WING 취소]와는 다른 기능이에요. 이 화면의 버튼은 WING 에 직접 보내지 않아요 - 실제 WING 취소·재신청은 자동화 명령이 1번씩 해요.</p>
      <p class="rg-muted" style="margin:6px 0 0;font-size:12px">서버 상태 읽음 ${esc(fmtKst(S.loadedAt))}
        <button class="btn sm secondary" data-erp-key="rwr-reload" onclick="RestockWingRecovery.reload()">새로고침</button></p></div>`;
    if (S.loadError) return head + `<div class="card" style="border:2px solid var(--red)"><b>불러오지 못했어요</b><p class="rg-muted">${esc(S.loadError)}</p></div>`;
    const rows = S.rows.filter(r => r.lane === "PARCEL" || r.cancellation);
    if (!rows.length) return head + `<div class="card rg-muted">복구할 재입고 택배 입고신청이 없어요.</div>`;
    return head + rows.map((r, i) => rowHtml(r, i)).join("");
  }

  async function view(sb, me) {
    S.sb = sb; S.me = me;
    if (!(me && me.approver)) {
      return `<div class="card"><h2>🔁 ${TITLE}</h2><p>승인 권한자만 볼 수 있는 화면이에요.</p>
        <p class="rg-muted">재입고 WING 신청 취소·대체 신청은 승인 권한자가 처리해요. 필요하면 장팀장에게 요청해 주세요.</p></div>`;
    }
    await refreshState();
    return pageHtml();
  }

  function rerender() {
    const el = root.document && root.document.getElementById("content");
    if (el && typeof root.location !== "undefined" && String(root.location.hash || "").startsWith(`#/${ROUTE}`)) el.innerHTML = pageHtml();
  }
  async function reload() { await refreshState(); rerender(); }

  // 누르기 직전 서버 상태 다시 읽기 → 그 제출의 최신 행
  async function freshRow(submissionId) {
    await refreshState();
    rerender();
    return S.rows.find(r => String(r.submission.id) === String(submissionId)) || null;
  }

  const baseRows = row => [
    ["상품", `${esc((row.product || {}).name || "—")} <small>${esc((row.product || {}).code || "")}</small>`],
    ["WING 신청 번호", `<b>${esc(row.submission.wing_shipment_id || "—")}</b>`],
    ["원 제출 · 후보", `<code>${esc(row.submission.id)}</code><br><code>${esc((row.candidate || {}).id || "—")}</code>`],
    ["수량", `${num((row.candidate || {}).extracted_quantity)}${esc((row.candidate || {}).extracted_unit || "")} = <b>${num(row.ea)}EA</b>`],
    ["정책 유통기한", `<b>${esc(row.policyExpiry || "—")}</b>`],
  ];

  function runAction({ submissionId, key, check, confirm, exec, fn }) {
    return UI().run({
      key, allowed: !!(S.me && S.me.approver), deniedText: "승인 권한자만 처리할 수 있어요 - 읽기 전용이에요",
      precheck: async () => {
        const row = await freshRow(submissionId);
        if (!row) return { ok: false, message: "이 제출을 다시 찾지 못했어요" };
        const why = check(row);
        return why ? { ok: false, title: "처리하지 않았어요 - 상태가 바뀌었어요", message: why, rows: baseRows(row) } : { ok: true, row };
      },
      confirm: pre => confirm(pre.row),
      exec: async reason => {
        const args = exec(reason);
        const { data, error } = await S.sb.rpc(fn, args);
        const r = interpretRpc(fn, data, error);
        return { ok: r.ok, message: r.message, data };
      },
      successText: res => interpretRpc(fn, res.data, null).message,
      refresh: reload,
    });
  }

  function approveCancel(submissionId) {
    return runAction({
      submissionId, key: `rwr-cancel-${submissionId}`, fn: "fn_approve_restock_wing_submission_cancel",
      check: row => { const a = actionState(row, { isApprover: true }); return a.cancel.enabled ? null : a.cancel.why; },
      confirm: row => ({
        title: "WING 입고신청 취소 승인", actionLabel: "취소 승인", danger: true, rows: baseRows(row),
        notes: ["지금은 <b>취소 승인 기록만</b> 남겨요. WING 에는 아직 아무것도 보내지 않아요.",
                "실제 WING 취소는 자동화 명령(parcel-cancel)이 1번 실행하고, WING 이 취소를 확인해야 다음 단계(대체 후보)가 열려요.",
                "원 제출·후보·답장·재확인 기록은 지우지 않아요. 확정 메일은 이 제출에 대해 막혀요."],
        reason: { label: "취소 사유", required: true, minLength: 5, placeholder: "예) 유통기한 2028-06-01 오기록(정책 2028-05-01) - WING 수정 불가로 취소 후 재신청" },
      }),
      exec: reason => ({ p_submission_id: submissionId, p_reason: reason }),
    });
  }

  function createReplacement(submissionId) {
    let snap = null;
    return runAction({
      submissionId, key: `rwr-replace-${submissionId}`, fn: "fn_create_restock_replacement_candidate",
      check: row => {
        const dc = decisionCheck(decisionOf(row.submission.product_id), row.ea, { error: S.decisionError });
        const a = actionState(row, { isApprover: true, decisionCheck: dc });
        if (!a.replace.enabled) return a.replace.why;
        snap = { cancellationId: row.cancellation.id, ea: row.ea, expiry: row.policyExpiry, dc };
        return null;
      },
      confirm: row => ({
        title: "대체 후보 만들기", actionLabel: "대체 후보 만들기",
        rows: [...baseRows(row), ["WING 취소", `${esc(row.cancellation.status)} · 관측 ${esc(row.cancellation.observed_wing_status || "—")}`],
               ["지금 재고 판단", esc(snap.dc.text)]],
        notes: [`서버가 원래 수량 <b>${num(snap.ea)}EA</b>·유통기한 <b>${esc(snap.expiry || "관리 안 함")}</b>·지금 재고 판단·수량 재확인을 다시 확인해요. 하나라도 다르면 만들지 않아요.`,
                "원 후보는 '대체됨'으로 남고(삭제 없음), 새 후보는 새 멱등키로 승인 대기가 돼요. 원 후보당 대체 후보는 1개뿐이에요."],
        reason: { label: "대체 근거", required: true, minLength: 5, value: "WING 취소 확인 - 같은 근거·정책 유통기한으로 재신청" },
      }),
      exec: reason => ({ p_cancellation_id: snap.cancellationId, p_expected_ea: snap.ea, p_expected_expiration_date: snap.expiry, p_note: reason }),
    });
  }

  function candidateAction(submissionId, approve) {
    let candId = null;
    const fn = approve ? "fn_approve_restock_inquiry_wing_candidate" : "fn_reject_restock_inquiry_wing_candidate";
    return runAction({
      submissionId, key: `rwr-${approve ? "approve" : "reject"}-${submissionId}`, fn,
      check: row => {
        const a = actionState(row, { isApprover: true });
        if (!a.approve.enabled) return a.approve.why;
        candId = row.replacement.id;
        return null;
      },
      confirm: row => ({
        title: approve ? "대체 후보 승인" : "대체 후보 거절", actionLabel: approve ? "승인" : "거절", danger: !approve,
        rows: [...baseRows(row), ["대체 후보", `<code>${esc(row.replacement.id)}</code> · ${num(row.replacement.extracted_quantity)}${esc(row.replacement.extracted_unit)}`]],
        notes: approve ? ["승인만 해요. WING 제출은 미리보기 확인 뒤 별도 실행(1번)이에요.", "택배 입고는 센터를 승인 때 고르지 않아요(WING 이 제출 때 추천)."]
                       : ["거절해도 기록은 남아요. 원 후보당 대체 후보는 1개라 다시 만들 수 없어요(새 근거는 새 문의로)."],
        reason: { label: approve ? "승인 근거" : "거절 사유", required: true, minLength: approve ? 2 : 5 },
      }),
      exec: reason => approve ? { p_candidate_id: candId, p_note: reason, p_destination_center_id: null } : { p_candidate_id: candId, p_note: reason },
    });
  }

  root.RestockWingRecovery = {
    ROUTE, TITLE, view, reload, approveCancel, createReplacement,
    approveReplacement: id => candidateAction(id, true), rejectReplacement: id => candidateAction(id, false),
    expectedEa, decisionCheck, buildRows, actionState, interpretRpc, reasonText, _state: S,
  };
})(typeof window !== "undefined" ? window : globalThis);
