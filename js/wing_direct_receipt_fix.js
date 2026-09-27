/* WING 직접입고 최종수량 정정 - 2026-09-27 [대표 지시] (서버: Rebirth-ops PR #85, 20260927e)
   WING 과착 회송·과입고·표시만 남은 '입고중' 때문에 WING 미러 값이 실제와 다를 때, 승인 권한자가 SKU 별 최종 입고수량을
   확정하고(원본 WING 기록은 그대로) 필요하면 ERP 발주 입고수량 조정 기록을 남기는 화면이에요.
   - 먼저 읽기 전용 미리보기: 원본 WING 관측값 · 입력한 확정값 · 차이 · 발주 조정값 · VAT 별도 금액 영향 · 문의메일 후보 가능성.
   - 실행은 두 단계로 분리: [1. 확정 기록] [2. 발주 조정 기록]. 각각 확인창에서 사유를 적고 승인자가 최종 버튼을 눌러야 해요.
   - 서버가 전부 다시 확인: 승인자 본인 세션 · 미러 지문(미리보기 뒤 WING 값이 바뀌면 거부) · 요청 키 멱등(같은 내용 = 이미 적용,
     다른 내용 = 거부) · 한 SKU 라도 막히면 전부 안 씀. 화면은 요청 키를 내용으로 만들어 탭 2개가 같은 내용을 보내면 하나만 적용돼요.
   - 이 화면은 SMTP·WING 을 부르지 않아요. 다만 정정 뒤 재고 판단이 바뀌어 막힘이 풀린 상품이 '지금 발주'가 되면
     문의 메일 자동 발송 단계가 공급처에 실제 메일을 보낼 수 있어요 - 실행 전 후보 가능성을 보여 주고 경고해요. */
(function (root) {
  "use strict";

  const ROUTE = "wingreceiptfix";
  const TITLE = "WING 직접입고 최종수량 정정";
  const PREVIEW_RPC = "fn_preview_wing_direct_receipts";
  const CONFIRM_RPC = "fn_confirm_wing_direct_receipts";
  const ADJUST_RPC = "fn_record_po_receipt_adjustments";
  const UI = () => root.ErpUi;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => (n === null || n === undefined || n === "") ? "—" : Number(n).toLocaleString("ko-KR");
  const won = n => (n === null || n === undefined) ? "—" : `${n > 0 ? "+" : ""}${Number(n).toLocaleString("ko-KR")}원`;
  const fmtKst = ts => {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }).slice(0, 16);
  };

  const REASON_TEXT = {
    MIRROR_DRIFT: "원본 WING 값이 미리보기 뒤에 바뀜 - 다시 불러와 확인하세요",
    ALREADY_ACTIVE_CONFIRMATION: "이미 확정 기록이 있음",
    MIRROR_ROW_NOT_FOUND: "WING 기록에 없는 SKU",
    MIRROR_ROW_NOT_ACTIVE: "취소·실패된 WING 기록",
    ORIGINAL_DRIFT: "발주 원본 입고수량이 미리보기 뒤에 바뀜",
    ALREADY_ACTIVE_ADJUSTMENT: "이미 조정 기록이 있음",
    NO_ACTIVE_CONFIRMATION_FOR_PRODUCT: "이 상품의 활성 확정 기록이 없음(확정 먼저)",
    PO_ITEM_NOT_IN_PO: "이 발주의 품목이 아님",
    PO_NOT_FOUND: "발주번호를 찾지 못함",
    CONFIRMATION_BATCH_NOT_FOUND: "확정 묶음을 찾지 못함",
  };
  const reasonText = c => REASON_TEXT[c] ? `${REASON_TEXT[c]} (${c})` : String(c);

  // ── 순수 함수(테스트 대상) ────────────────────────────────────────────────
  function parseQty(raw) {
    const s = String(raw ?? "").replace(/[,\s]/g, "");
    if (s === "") return { value: null, error: "확정 수량을 넣어 주세요" };
    if (!/^\d+$/.test(s)) return { value: null, error: "0 이상 정수만" };
    const n = Number(s);
    return n > 1000000 ? { value: null, error: "값이 너무 커요" } : { value: n, error: null };
  }

  /** 미리보기 + 입력 → SKU 별 계획(차이·확정 상태·발주 조정·금액). 판단은 서버가 다시 해요. */
  function buildPlan(preview, inputs) {
    const rows = ((preview && preview.rows) || []).map(r => {
      const q = parseQty((inputs || {})[r.vendor_item_id]);
      const ac = r.active_confirmation || null;
      let confState = "NEW";
      if (ac) {
        if (ac.fingerprint_matches === false) confState = "DRIFT";
        else if (q.value !== null && ac.confirmed_received_qty === q.value) confState = "SAME";
        else confState = "CONFLICT";
      }
      const pis = r.po_items || [];
      const pi = pis.length === 1 ? pis[0] : null;
      const adjusted = q.value;
      const unit = pi && pi.unit_cost !== null && pi.unit_cost !== undefined ? Number(pi.unit_cost) : null;
      const delta = pi && adjusted !== null ? adjusted - pi.received_qty : null;
      const aa = pi ? pi.active_adjustment || null : null;
      let adjState = pis.length === 0 ? "NO_PO_ITEM" : pis.length > 1 ? "MULTIPLE_PO_ITEMS" : "NEW";
      if (aa) adjState = adjusted !== null && aa.adjusted_received_qty === adjusted ? "SAME" : "CONFLICT";
      return {
        vid: String(r.vendor_item_id), code: r.product_code || "", name: r.product_name || "", productId: r.product_id,
        requested: r.requested_qty, mirrorReceived: r.received_qty, stowed: r.stowed_qty, wingStatus: r.wing_status,
        checkedAt: r.source_checked_at, fingerprint: r.fingerprint, qty: q.value, qtyError: q.error,
        diff: q.value === null ? null : q.value - (r.received_qty || 0), activeConfirmation: ac, confState,
        poItem: pi, poOriginal: pi ? pi.received_qty : null, poAdjusted: pi ? adjusted : null, poDelta: delta,
        unitCost: unit, amountDelta: delta !== null && unit !== null ? delta * unit : null, activeAdjustment: aa, adjState,
      };
    });
    const amountTotal = rows.reduce((s, r) => s + (r.adjState === "NEW" && r.amountDelta !== null ? r.amountDelta : 0), 0);
    return { rows, amountTotal, inputErrors: rows.filter(r => r.qtyError).map(r => r.vid) };
  }

  /** 확정 RPC 로 보낼 SKU(아직 확정 없는 것만). 충돌·drift 가 있으면 막음. */
  function confirmItems(plan) {
    const blocked = plan.rows.filter(r => r.confState === "CONFLICT" || r.confState === "DRIFT");
    if (plan.inputErrors.length) return { items: [], why: `확정 수량을 모두 넣어 주세요(${plan.inputErrors.length}개 SKU)` };
    if (blocked.length) return { items: [], why: `이미 다른 값으로 확정됐거나 WING 값이 바뀐 SKU 가 있어요: ${blocked.map(r => r.vid).join(", ")} - 확정 기록을 먼저 확인하세요` };
    const items = plan.rows.filter(r => r.confState === "NEW")
      .map(r => ({ vendor_item_id: r.vid, expected_fingerprint: r.fingerprint, confirmed_received_qty: r.qty }));
    return { items, why: items.length ? "" : "새로 확정할 SKU 가 없어요(모두 이미 같은 값으로 확정됨)" };
  }

  /** 발주 조정 RPC 로 보낼 품목 - 같은 값으로 확정이 끝난 SKU 만, 아직 조정 없는 것만. */
  function adjustItems(plan) {
    const notConfirmed = plan.rows.filter(r => r.confState !== "SAME");
    if (notConfirmed.length) return { items: [], batchId: null, why: `확정 기록이 먼저 있어야 해요(미확정 ${notConfirmed.length}개 SKU)` };
    const bad = plan.rows.filter(r => r.adjState === "NO_PO_ITEM" || r.adjState === "MULTIPLE_PO_ITEMS" || r.adjState === "CONFLICT");
    if (bad.length) return { items: [], batchId: null, why: `발주 품목이 없거나 여러 개이거나 다른 값으로 조정된 SKU: ${bad.map(r => r.vid).join(", ")}` };
    const items = plan.rows.filter(r => r.adjState === "NEW")
      .map(r => ({ po_item_id: r.poItem.id, expected_original_received_qty: r.poOriginal }));
    const batchId = (plan.rows.find(r => r.activeConfirmation) || {}).activeConfirmation?.batch_id || null;
    return { items, batchId, why: items.length ? "" : "새로 조정할 품목이 없어요(모두 이미 조정됨)" };
  }

  /** 문의 메일 자동 발송 후보 '가능성'(서버 후보 조건 중 꼭 필요한 조건만 - 하나라도 아니면 후보가 될 수 없음). */
  function mailCheck(decision, procurement) {
    if (!decision) return { possible: null, reasons: ["재고 판단 행 없음(판단 불가 - 실행 뒤 다시 확인)"] };
    const reasons = [];
    if (!String((procurement || {}).supplier_name || "").trim()) reasons.push("발주정보 공급처 없음");
    if (decision.logistics_status !== "COMPLETE") reasons.push(`물류정보 ${decision.logistics_status || "미완성"}`);
    if (decision.automation_blocked !== false) reasons.push(`자동화 막힘${decision.automation_label ? `(${decision.automation_label})` : ""}`);
    if (decision.auto_po_allowed !== true) reasons.push("자동 발주 불가");
    if (decision.decision !== "ORDER_NOW") reasons.push(`재고 판단 ${decision.decision || "없음"}`);
    return { possible: reasons.length === 0, reasons };
  }

  async function sha16(text) {
    const c = root.crypto || globalThis.crypto;
    const buf = await c.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }
  /** 요청 키 = 내용 지문(탭 2개가 같은 내용을 보내면 같은 키 → 서버가 하나만 적용). */
  async function idemKey(prefix, inbound, payload) {
    const canon = JSON.stringify(payload, Object.keys(payload).sort());
    return `${prefix}-${inbound}-${await sha16(JSON.stringify([inbound, payload]) + canon)}`;
  }

  /** RPC 결과 → SKU 별 {state: APPLIED|ALREADY|CONFLICT|DRIFT|FAILED, text} */
  function interpretResult(kind, sentKeys, data, error) {
    const out = {};
    const all = (state, text) => sentKeys.forEach(k => { out[k] = { state, text }; });
    if (error) {
      const msg = error.message || error.code || String(error);
      all("FAILED", /jwt|expired|token/i.test(msg) ? `로그인 세션이 만료됐어요 - 다시 로그인 후 새로고침하세요 (${msg})` : msg);
      return { ok: false, perKey: out, batchId: null, message: msg };
    }
    const st = data && data.status;
    if (st === "CONFIRMED" || st === "RECORDED") {
      sentKeys.forEach(k => { out[k] = { state: "APPLIED", text: "적용됨" }; });
      (data.items || []).forEach(x => {
        const k = String(kind === "confirm" ? x.vendor_item_id : x.po_item_id);
        out[k] = { state: "APPLIED", text: kind === "confirm" ? `적용됨 · 확정 ID ${x.confirmation_id}` : `적용됨 · ${x.original}→${x.adjusted} (${won(Number(x.amount_delta))})` };
      });
      return { ok: true, perKey: out, batchId: data.batch_id || null, message: st === "CONFIRMED" ? `확정 묶음 ${data.batch_id}` : `금액 차이 합계 ${won(Number(data.amount_delta_total))}` };
    }
    if (st === "ALREADY_CONFIRMED" || st === "ALREADY_RECORDED") {
      all("ALREADY", "이미 적용됨(같은 내용 재요청 - 변경 없음)");
      return { ok: true, perKey: out, batchId: data.batch_id || null, message: "이미 적용된 요청이에요(변경 없음)" };
    }
    if (st === "BLOCKED") {
      all("FAILED", "적용 안 됨 - 같은 요청의 다른 SKU 가 막혀 전부 취소(부분 적용 없음)");
      (data.blockers || []).forEach(b => {
        const k = String(kind === "confirm" ? b.vendor_item_id : b.po_item_id || "");
        const state = /DRIFT/.test(b.reason) ? "DRIFT" : /ALREADY_ACTIVE/.test(b.reason) ? "CONFLICT" : "FAILED";
        if (k) out[k] = { state, text: reasonText(b.reason) };
      });
      return { ok: false, perKey: out, batchId: null, message: "서버가 막았어요 - 아무것도 바꾸지 않았어요" };
    }
    all("FAILED", `알 수 없는 응답(${st || "없음"})`);
    return { ok: false, perKey: out, batchId: null, message: "알 수 없는 응답" };
  }

  // ── 데이터 ───────────────────────────────────────────────────────────────
  const S = { sb: null, me: null, inbound: "", poNo: "", preview: null, loadError: null, inputs: {}, decisions: null, decisionError: null,
              procurements: {}, lastConfirm: null, lastAdjust: null, loadedAt: null };

  async function loadPreview() {
    S.loadError = null;
    if (!/^\d{6,30}$/.test(S.inbound)) { S.preview = null; S.loadError = "입고 ID(숫자)를 넣어 주세요"; return; }
    const { data, error } = await S.sb.rpc(PREVIEW_RPC, S.poNo ? { p_wing_inbound_id: S.inbound, p_po_no: S.poNo } : { p_wing_inbound_id: S.inbound });
    if (error) { S.preview = null; S.loadError = error.message || String(error); return; }
    S.preview = data || { rows: [] };
    const pids = [...new Set((S.preview.rows || []).map(r => r.product_id).filter(Boolean))];
    S.procurements = {};
    if (pids.length) {
      const { data: pp } = await S.sb.from("product_procurement").select("product_id,supplier_name").in("product_id", pids);
      (pp || []).forEach(p => { S.procurements[String(p.product_id)] = p; });
    }
    const f = root.fetchInventoryDecisions;
    const r = typeof f === "function" ? await f(false).catch(e => ({ ok: false, error: String(e) })) : { ok: false, error: "재고 판단 함수를 찾지 못했어요" };
    S.decisions = r && r.ok ? r.decisions || [] : null;
    S.decisionError = r && r.ok ? null : (r && r.error) || "재고 판단을 읽지 못했어요";
    S.loadedAt = new Date().toISOString();
  }
  const decisionOf = pid => (S.decisions || []).find(d => String(d.product_id) === String(pid)
    && ((d.shared_inventory || {}).role || "base") !== "child") || null;

  const STATE_BADGE = { APPLIED: ["approved", "적용"], ALREADY: ["ok", "이미 적용"], CONFLICT: ["check", "충돌"], DRIFT: ["error", "원본 drift"], FAILED: ["error", "실패"] };
  const stateBadge = s => s ? UI().badge(STATE_BADGE[s.state][0], { text: STATE_BADGE[s.state][1], title: s.text }) + `<div style="font-size:11px">${esc(s.text)}</div>` : "";

  function tableHtml(plan) {
    const confLabel = r => {
      const q = num((r.activeConfirmation || {}).confirmed_received_qty);
      return { NEW: "미확정", SAME: `확정됨 ${q}`, CONFLICT: `다른 값 확정 ${q}`, DRIFT: "확정 뒤 WING 값 바뀜" }[r.confState];
    };
    const adjLabel = r => ({ NEW: "", SAME: "조정됨", CONFLICT: "다른 값 조정", NO_PO_ITEM: "발주 품목 없음", MULTIPLE_PO_ITEMS: "발주 품목 여러 개" }[r.adjState]);
    const body = plan.rows.map(r => `<tr data-vid="${esc(r.vid)}">
      <td><b>${esc(r.code)}</b><div style="font-size:11px">${esc(r.name)}</div><code style="font-size:11px">${esc(r.vid)}</code></td>
      <td class="num">${num(r.requested)}</td><td class="num">${num(r.mirrorReceived)}</td><td class="num">${num(r.stowed)}</td>
      <td style="font-size:11px">${esc(r.wingStatus)}<br>확인 ${esc(fmtKst(r.checkedAt))}</td>
      <td><input class="pi-in" style="width:64px" inputmode="numeric" data-erp-key="wrf-qty-${esc(r.vid)}" value="${esc((S.inputs || {})[r.vid] ?? "")}"
          onchange="WingReceiptFix.setQty('${esc(r.vid)}', this.value)" aria-label="확정 수량 ${esc(r.vid)}">
          ${r.qtyError ? `<div style="color:var(--red);font-size:11px">${esc(r.qtyError)}</div>` : ""}</td>
      <td class="num">${r.diff === null ? "—" : (r.diff > 0 ? "+" : "") + num(r.diff)}</td>
      <td style="font-size:12px">${esc(confLabel(r))}${stateBadge((S.lastConfirm || {})[r.vid])}</td>
      <td class="num">${r.poItem ? `${num(r.poOriginal)} → <b>${num(r.poAdjusted)}</b>` : "—"}</td>
      <td class="num">${r.poDelta === null ? "—" : (r.poDelta > 0 ? "+" : "") + num(r.poDelta)}</td>
      <td class="num">${won(r.amountDelta)}<div style="font-size:11px">단가 ${num(r.unitCost)}</div></td>
      <td style="font-size:12px">${esc(adjLabel(r))}${stateBadge(r.poItem ? (S.lastAdjust || {})[String(r.poItem.id)] : null)}</td></tr>`).join("");
    return `<div class="table-wrap"><table class="items-table"><thead><tr><th>SKU</th><th class="num">WING 요청</th><th class="num">WING 입고(원본)</th>
      <th class="num">적치</th><th>상태</th><th>확정 수량</th><th class="num">차이</th><th>확정 기록</th><th class="num">발주 입고 원본→조정</th>
      <th class="num">조정 차이</th><th class="num">금액 영향(VAT 별도)</th><th>조정 기록</th></tr></thead><tbody>${body}</tbody>
      <tfoot><tr><td colspan="10" style="text-align:right"><b>새 조정 금액 합계(VAT 별도)</b></td><td class="num"><b>${won(plan.amountTotal)}</b></td><td></td></tr></tfoot></table></div>`;
  }

  function mailHtml(plan) {
    const rows = plan.rows.map(r => {
      const m = mailCheck(decisionOf(r.productId), S.procurements[String(r.productId)]);
      const badge = m.possible === true ? UI().badge("urgent", { text: "후보 가능" }) : m.possible === false ? UI().badge("ok", { text: "후보 불가" }) : UI().badge("check", { text: "판단 불가" });
      return `<tr><td>${esc(r.code)}</td><td>${badge}</td><td style="font-size:12px">${esc(m.reasons.join(" · ") || "필수 조건 모두 충족 - 실행 뒤 공급처에 문의 메일이 나갈 수 있음")}</td></tr>`;
    }).join("");
    const any = plan.rows.some(r => mailCheck(decisionOf(r.productId), S.procurements[String(r.productId)]).possible !== false);
    return `<div class="card" style="border:2px solid var(--amber)"><h3 style="margin:0 0 6px">⚠ 실행 직후 공급처 메일이 나갈 수 있어요</h3>
      <p style="margin:0 0 6px;font-size:13px">이 화면은 SMTP·WING 을 부르지 않아요. 하지만 정정 뒤 재고 판단이 다시 계산되면, 막힘이 풀린 상품이 '지금 발주'일 때
      <b>문의 메일 자동 발송 단계</b>(켜져 있으면 10분마다)가 공급처에 실제 문의 메일을 보낼 수 있어요.</p>
      <p style="margin:0 0 6px;font-size:12px" class="rg-muted">아래는 서버 후보 조건 중 꼭 필요한 조건(발주정보 공급처·물류정보 완성·자동화 막힘 없음·자동 발주 허용·지금 발주)만 본
      '가능성'이에요. '후보 불가'는 확실히 안 나가고, '후보 가능'은 나갈 수 있다는 뜻이에요(최종 판단은 서버). 재고 판단 ${S.decisionError ? `읽기 실패: ${esc(S.decisionError)}` : "읽음"}.</p>
      <table class="rg-detail"><tbody>${rows}</tbody></table>
      ${any ? `<p style="margin:6px 0 0;color:var(--red);font-size:13px"><b>후보 가능 또는 판단 불가 상품이 있어요 - 실행 전에 문의 메일 단계를 끄거나 미리보기를 다시 확인하세요.</b></p>` : ""}</div>`;
  }

  function pageHtml() {
    const head = `<div class="card"><h2 style="margin:0 0 6px">🧮 ${TITLE}</h2>
      <p class="rg-muted" style="margin:0">WING 직접입고의 SKU 별 최종 입고수량을 확정하고(원본 WING 기록은 그대로) 필요하면 발주 입고수량 조정 기록을 남겨요.
      먼저 읽기 전용 미리보기를 확인하고, 실행은 [1. 확정 기록] → [2. 발주 조정 기록] 순서로 따로 눌러요. SMTP·WING 호출 없음.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center">
        <label>입고 ID <input class="pi-in" style="width:190px" data-erp-key="wrf-inbound" value="${esc(S.inbound)}" onchange="WingReceiptFix.setInbound(this.value)"></label>
        <label>발주번호 <input class="pi-in" style="width:190px" data-erp-key="wrf-po" value="${esc(S.poNo)}" onchange="WingReceiptFix.setPo(this.value)"></label>
        <button class="btn sm secondary" data-erp-key="wrf-load" onclick="WingReceiptFix.reload()">미리보기 불러오기</button>
        <span class="rg-muted" style="font-size:12px">읽음 ${esc(fmtKst(S.loadedAt))}</span></div></div>`;
    if (S.loadError) return head + `<div class="card" style="border:2px solid var(--red)"><b>불러오지 못했어요</b><p class="rg-muted">${esc(S.loadError)}</p></div>`;
    if (!S.preview) return head;
    if (!(S.preview.rows || []).length) return head + `<div class="card rg-muted">이 입고 ID 의 WING 기록이 없어요.</div>`;
    const plan = buildPlan(S.preview, S.inputs);
    const ci = confirmItems(plan), ai = adjustItems(plan);
    const poInfo = S.preview.po ? `발주 ${esc(S.preview.po.po_no)} (${esc(S.preview.po.status)})` :
      `발주번호를 넣으면 조정 미리보기가 보여요 · 이 입고 상품이 든 발주: ${esc((S.preview.candidate_po_nos || []).join(", ") || "없음")}`;
    return head + `<div class="card"><h3 style="margin:0 0 6px">미리보기 - 입고 ${esc(S.preview.wing_inbound_id)} · ${poInfo}</h3>${tableHtml(plan)}</div>` +
      mailHtml(plan) +
      `<div class="card"><h3 style="margin:0 0 6px">실행(각각 확인창에서 사유 입력 후 최종 버튼)</h3>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div><button class="btn sm danger" data-erp-key="wrf-confirm" ${ci.items.length ? "" : "disabled"} onclick="WingReceiptFix.confirm()">1. 확정 기록 (${ci.items.length}개 SKU)</button>
            ${ci.why ? `<div class="rg-muted" style="font-size:12px">${esc(ci.why)}</div>` : ""}</div>
          <div><button class="btn sm danger" data-erp-key="wrf-adjust" ${ai.items.length ? "" : "disabled"} onclick="WingReceiptFix.adjust()">2. 발주 조정 기록 (${ai.items.length}개 품목)</button>
            ${ai.why ? `<div class="rg-muted" style="font-size:12px">${esc(ai.why)}</div>` : ""}</div></div>
        <p class="rg-muted" style="font-size:12px;margin:8px 0 0">권장: 6개 확정 + 6개 조정. 발주 조정은 원본 발주·매입을 바꾸지 않는 기록이고, 발주 잔량·공헌이익 원가 계산에는 쓰지 않아요.
        ${S.lastConfirmMeta ? `<br>최근 확정: ${esc(S.lastConfirmMeta)}` : ""}${S.lastAdjustMeta ? `<br>최근 조정: ${esc(S.lastAdjustMeta)}` : ""}</p></div>`;
  }

  async function view(sb, me) {
    S.sb = sb; S.me = me;
    if (!(me && me.approver)) return `<div class="card"><h2>🧮 ${TITLE}</h2><p>승인 권한자만 볼 수 있는 화면이에요.</p></div>`;
    const hash = String((root.location || {}).hash || "");
    const m = hash.match(/[?&]id=(\d+)/);
    if (m && !S.inbound) S.inbound = m[1];
    const po = hash.match(/[?&]po=([^&]+)/);
    if (po && !S.poNo) S.poNo = decodeURIComponent(po[1]);
    if (S.inbound) await loadPreview();
    return pageHtml();
  }

  function rerender() {
    const el = root.document && root.document.getElementById("content");
    if (el && String((root.location || {}).hash || "").startsWith(`#/${ROUTE}`)) el.innerHTML = pageHtml();
  }
  async function reload() { await loadPreview(); rerender(); }

  function run(kind) {
    const isConfirm = kind === "confirm";
    let pre = null;
    return UI().run({
      key: `wrf-${kind}-${S.inbound}`, allowed: !!(S.me && S.me.approver),
      deniedText: "승인 권한자만 처리할 수 있어요 - 읽기 전용이에요",
      precheck: async () => {
        await loadPreview(); rerender();
        if (S.loadError || !S.preview) return { ok: false, message: S.loadError || "미리보기를 먼저 불러와 주세요" };
        const plan = buildPlan(S.preview, S.inputs);
        const x = isConfirm ? confirmItems(plan) : adjustItems(plan);
        if (!x.items.length) return { ok: false, message: x.why };
        if (!isConfirm && !S.preview.po) return { ok: false, message: "발주번호를 넣고 다시 불러와 주세요" };
        pre = { plan, ...x };
        return { ok: true };
      },
      confirm: () => ({
        title: isConfirm ? "WING 최종 입고수량 확정 기록" : "발주 입고수량 조정 기록", actionLabel: isConfirm ? "확정 기록" : "조정 기록", danger: true,
        rows: pre.plan.rows.filter(r => isConfirm ? r.confState === "NEW" : r.adjState === "NEW").map(r => [esc(`${r.code} (${r.vid})`),
          isConfirm ? `WING 원본 입고 ${num(r.mirrorReceived)} → 확정 <b>${num(r.qty)}</b> (차이 ${r.diff > 0 ? "+" : ""}${num(r.diff)})`
                    : `발주 입고 ${num(r.poOriginal)} → <b>${num(r.poAdjusted)}</b> · ${won(r.amountDelta)}`]),
        notes: isConfirm
          ? ["원본 WING 기록은 바꾸지 않고 확정 기록만 추가해요. 서버가 미리보기 뒤 WING 값이 바뀌었으면 거부하고, 한 SKU 라도 막히면 전부 안 써요.",
             "실행 뒤 재고 판단이 다시 계산되면 막힘이 풀린 상품의 문의 메일이 공급처에 나갈 수 있어요(위 후보 가능성 확인)."]
          : [`원본 발주·매입은 바꾸지 않고 조정 기록만 추가해요. 금액 영향 합계(VAT 별도) ${won(pre.plan.amountTotal)} - 공급처 청구와 대조 필요.`,
             "발주 잔량·공헌이익 원가 계산에는 쓰지 않아요."],
        reason: { label: "사유", required: true, minLength: 5, placeholder: "예) 대표 확인 - WING 판매개시·과착 회송 화면과 공급처 출고 수량 기준" },
      }),
      exec: async reason => {
        const payload = isConfirm ? { items: pre.items, reason: reason.trim() } : { batch: pre.batchId, po: S.preview.po.po_no, items: pre.items, reason: reason.trim() };
        const key = await idemKey(isConfirm ? "wdr" : "pra", S.inbound, payload);
        const args = isConfirm
          ? { p_wing_inbound_id: S.inbound, p_items: pre.items, p_reason: reason.trim(), p_idempotency_key: key }
          : { p_confirmation_batch_id: pre.batchId, p_po_no: S.preview.po.po_no, p_items: pre.items, p_reason: reason.trim(), p_idempotency_key: key };
        const { data, error } = await S.sb.rpc(isConfirm ? CONFIRM_RPC : ADJUST_RPC, args);
        const sent = pre.items.map(x => String(isConfirm ? x.vendor_item_id : x.po_item_id));
        const r = interpretResult(kind, sent, data, error);
        if (isConfirm) { S.lastConfirm = r.perKey; S.lastConfirmMeta = `${r.message} · 요청 키 ${key}`; }
        else { S.lastAdjust = r.perKey; S.lastAdjustMeta = `${r.message} · 요청 키 ${key}`; }
        return { ok: r.ok, message: r.message, data };
      },
      successText: res => (res && res.message) || "처리했어요",
      refresh: reload,
    });
  }

  root.WingReceiptFix = {
    ROUTE, TITLE, view, reload, confirm: () => run("confirm"), adjust: () => run("adjust"),
    setInbound: v => { S.inbound = String(v || "").trim(); }, setPo: v => { S.poNo = String(v || "").trim(); },
    setQty: (vid, v) => { S.inputs[String(vid)] = v; rerender(); },
    parseQty, buildPlan, confirmItems, adjustItems, mailCheck, idemKey, interpretResult, _state: S,
  };
})(typeof window !== "undefined" ? window : globalThis);
