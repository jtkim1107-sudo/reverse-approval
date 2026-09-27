/* WING 직접입고 최종수량 정정 - 2026-09-27 [대표 지시] (서버: Rebirth-ops PR #85, 20260927e)
   WING 과착 회송·과입고·표시만 남은 '입고중' 때문에 WING 미러 값이 실제와 다를 때, 승인 권한자가 SKU 별 최종 입고수량을
   확정하고(원본 WING 기록은 그대로) 필요하면 ERP 발주 입고수량 조정 기록을 남기는 화면이에요.
   - 먼저 읽기 전용 미리보기: 원본 WING 관측값 · 입력한 확정값 · 차이 · 발주 조정값 · VAT 별도 금액 영향 · 문의메일 후보 가능성.
   - 실행은 두 단계로 분리: [1. 확정 기록] [2. 발주 조정 기록]. 각각 확인창에서 사유를 적고 승인자가 최종 버튼을 눌러야 해요.
   - 서버가 전부 다시 확인: 승인자 본인 세션 · 미러 지문(미리보기 뒤 WING 값이 바뀌면 거부) · 요청 키 멱등(같은 내용 = 이미 적용,
     다른 내용 = 거부) · 한 SKU 라도 막히면 전부 안 씀. 화면은 요청 키를 내용으로 만들어 탭 2개가 같은 내용을 보내면 하나만 적용돼요.
   - 되돌리기: [조정 취소] → [확정 취소] 순서만(조정이 걸린 확정은 서버가 거부). 취소도 읽기 전용 미리보기·사유·CAS·멱등·전부-또는-없음.
   - 문의메일 안전장치: 이 화면은 SMTP·WING 을 부르지 않아요. 확정·조정·취소를 하면 서버가 같은 트랜잭션에서 '문의메일 보류'를 걸고,
     운영 문의메일 단계는 보류가 있으면 SMTP 전에 멈춰요. 이 화면은 운영 단계가 운영 코드로 계산해 기록한 후보 스냅샷만 보여 주고
     (따로 계산하지 않음), 정정 뒤 다시 계산된 재고 캐시의 스냅샷이 후보 0건이거나 후보 목록을 확인했을 때만 보류를 풀 수 있어요.
     실행 전에도 30분 안의 정확한 스냅샷(게이트 통과)이 있어야 실행 버튼이 열려요. */
(function (root) {
  "use strict";

  const ROUTE = "wingreceiptfix";
  const TITLE = "WING 직접입고 최종수량 정정";
  const PREVIEW_RPC = "fn_preview_wing_direct_receipts";
  const CONFIRM_RPC = "fn_confirm_wing_direct_receipts";
  const ADJUST_RPC = "fn_record_po_receipt_adjustments";
  const REVOKE_ADJ_RPC = "fn_revoke_po_receipt_adjustments";
  const REVOKE_CONF_RPC = "fn_revoke_wing_direct_receipt_confirmations";
  const MAIL_STATE_RPC = "fn_preview_restock_inquiry_mail_state";
  const RELEASE_RPC = "fn_release_restock_inquiry_mail_hold";
  const SNAPSHOT_MAX_AGE_MIN = 30, CLOCK_SKEW_MIN = 5;
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
    ALREADY_REVOKED: "이미 취소됨",
    VALUE_DRIFT: "화면이 본 값과 서버 값이 다름 - 다시 불러와 확인하세요",
    ACTIVE_PO_ADJUSTMENT_EXISTS: "순서 위반 - 발주 조정을 먼저 취소하세요",
    NOT_FOUND: "기록을 찾지 못함",
    SNAPSHOT_NOT_AFTER_HOLD: "정정 뒤 다시 계산된 재고 캐시의 후보 스냅샷이 아직 없음",
    CANDIDATES_NOT_ACKNOWLEDGED: "후보가 있어 목록 확인이 필요함",
    SNAPSHOT_GATE_BLOCKED: "스냅샷이 게이트에 막혀 정확한 후보가 아님",
    SNAPSHOT_NOT_LATEST: "최신 스냅샷이 아님 - 다시 불러오세요",
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
      const ac = r.active_confirmation || null;
      // 입력칸이 비어 있으면(화면을 다시 연 경우 등) 서버의 유효 확정값을 그대로 써요 - 빈칸을 '다른 값'으로 보지 않음.
      // 사용자가 실제로 값을 넣었을 때만 그 값과 확정값을 비교해요.
      const raw = (inputs || {})[r.vendor_item_id];
      const typed = String(raw ?? "").replace(/[,\s]/g, "") !== "";
      const q = !typed && ac ? { value: ac.confirmed_received_qty, error: null } : parseQty(raw);
      const qtySource = typed ? "INPUT" : ac ? "CONFIRMED" : null;
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
        checkedAt: r.source_checked_at, fingerprint: r.fingerprint, qty: q.value, qtyError: q.error, qtySource,
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

  /** 실행 전 문의메일 안전 확인: 운영 문의메일 단계가 운영 코드로 계산해 기록한 최신 스냅샷이 30분 안·게이트 통과여야 실행 가능. */
  function mailGate(mailState, nowMs) {
    const snap = ((mailState && mailState.snapshots) || [])[0] || null;
    if (!mailState) return { ok: false, snapshot: null, why: "문의메일 상태를 읽지 못했어요 - 실행할 수 없어요" };
    if (!snap) return { ok: false, snapshot: null, why: "운영 문의 후보 스냅샷이 없어요 - VM 에서 문의메일 미리보기(--preview-only)를 먼저 실행해야 해요" };
    if (snap.gate) return { ok: false, snapshot: snap, why: `최신 스냅샷이 게이트(${snap.gate})에 막혀 정확한 후보가 아니에요` };
    const age = (nowMs - new Date(snap.computed_at).getTime()) / 60000;
    if (!(age >= -CLOCK_SKEW_MIN && age <= SNAPSHOT_MAX_AGE_MIN)) return { ok: false, snapshot: snap, why: age < 0 ? `스냅샷 시각이 이 PC 시계보다 ${Math.round(-age)}분 앞서요 - PC 시계를 확인해 주세요` : `최신 스냅샷이 ${Math.round(age)}분 전이라 오래됐어요(${SNAPSHOT_MAX_AGE_MIN}분 안이어야 함)` };
    return { ok: true, snapshot: snap, why: "" };
  }

  /** 보류 해제 가능 여부(서버가 다시 확인): 최신 스냅샷이 보류 뒤 계산·보류 뒤 재계산된 캐시·게이트 통과. 후보가 있으면 목록 확인 필요. */
  function holdReleaseState(hold, snap) {
    const deny = why => ({ enabled: false, needsAck: false, why });
    if (!snap) return deny("스냅샷 없음");
    if (snap.gate) return deny(`게이트(${snap.gate}) 막힘`);
    const h = new Date(hold.created_at).getTime();
    if (!(new Date(snap.computed_at).getTime() > h)) return deny("보류 뒤에 계산된 스냅샷이 아직 없어요");
    if (!snap.cache_calculated_at || !(new Date(snap.cache_calculated_at).getTime() > h)) return deny("정정 뒤 재고 캐시가 아직 다시 계산되지 않았어요");
    return { enabled: true, needsAck: snap.candidate_count > 0, why: "" };
  }

  /** 되돌리기 대상: 조정 취소(활성 조정 전부) / 확정 취소(활성 조정이 하나도 없을 때만). */
  function revokeItems(plan, kind) {
    if (kind === "revoke_adj") {
      const rows = plan.rows.filter(r => r.activeAdjustment);
      return { items: rows.map(r => ({ id: r.activeAdjustment.id, expected_qty: r.activeAdjustment.adjusted_received_qty })),
               keyOf: Object.fromEntries(rows.map(r => [String(r.activeAdjustment.id), r.vid])),
               why: rows.length ? "" : "취소할 발주 조정이 없어요" };
    }
    const withAdj = plan.rows.filter(r => r.activeAdjustment);
    if (withAdj.length) return { items: [], keyOf: {}, why: `순서: 발주 조정 ${withAdj.length}건을 먼저 취소해야 확정을 취소할 수 있어요` };
    const rows = plan.rows.filter(r => r.activeConfirmation);
    return { items: rows.map(r => ({ id: r.activeConfirmation.id, expected_qty: r.activeConfirmation.confirmed_received_qty })),
             keyOf: Object.fromEntries(rows.map(r => [String(r.activeConfirmation.id), r.vid])),
             why: rows.length ? "" : "취소할 확정 기록이 없어요" };
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
    if (st === "REVOKED") {
      sentKeys.forEach(k => { out[k] = { state: "APPLIED", text: `취소됨 · 취소 묶음 ${data.revocation_batch_id}` }; });
      return { ok: true, perKey: out, batchId: data.revocation_batch_id || null, message: `취소 묶음 ${data.revocation_batch_id} · 문의메일 보류 ${data.inquiry_mail_hold_id || "-"}` };
    }
    if (st === "ALREADY_REVOKED") {
      all("ALREADY", "이미 취소됨(같은 내용 재요청 - 변경 없음)");
      return { ok: true, perKey: out, batchId: data.revocation_batch_id || null, message: "이미 취소된 요청이에요(변경 없음)" };
    }
    if (st === "CONFIRMED" || st === "RECORDED") {
      sentKeys.forEach(k => { out[k] = { state: "APPLIED", text: "적용됨" }; });
      (data.items || []).forEach(x => {
        const k = String(kind === "confirm" ? x.vendor_item_id : x.po_item_id);
        out[k] = { state: "APPLIED", text: kind === "confirm" ? `적용됨 · 확정 ID ${x.confirmation_id}` : `적용됨 · ${x.original}→${x.adjusted} (${won(Number(x.amount_delta))})` };
      });
      return { ok: true, perKey: out, batchId: data.batch_id || null,
               message: (st === "CONFIRMED" ? `확정 묶음 ${data.batch_id}` : `금액 차이 합계 ${won(Number(data.amount_delta_total))}`) + ` · 문의메일 보류 ${data.inquiry_mail_hold_id || "-"}` };
    }
    if (st === "ALREADY_CONFIRMED" || st === "ALREADY_RECORDED") {
      all("ALREADY", "이미 적용됨(같은 내용 재요청 - 변경 없음)");
      return { ok: true, perKey: out, batchId: data.batch_id || null, message: "이미 적용된 요청이에요(변경 없음)" };
    }
    if (st === "BLOCKED") {
      all("FAILED", "적용 안 됨 - 같은 요청의 다른 SKU 가 막혀 전부 취소(부분 적용 없음)");
      (data.blockers || []).forEach(b => {
        const k = String(kind === "confirm" ? b.vendor_item_id : kind === "adjust" ? b.po_item_id || "" : b.id || "");
        const state = /DRIFT/.test(b.reason) ? "DRIFT" : /ALREADY_ACTIVE|ACTIVE_PO_ADJUSTMENT_EXISTS/.test(b.reason) ? "CONFLICT"
          : b.reason === "ALREADY_REVOKED" ? "ALREADY" : "FAILED";
        if (k) out[k] = { state, text: reasonText(b.reason) };
      });
      return { ok: false, perKey: out, batchId: null, message: "서버가 막았어요 - 아무것도 바꾸지 않았어요" };
    }
    all("FAILED", `알 수 없는 응답(${st || "없음"})`);
    return { ok: false, perKey: out, batchId: null, message: "알 수 없는 응답" };
  }

  // ── 데이터 ───────────────────────────────────────────────────────────────
  const S = { sb: null, me: null, inbound: "", poNo: "", preview: null, loadError: null, inputs: {}, mail: null, mailError: null,
              lastConfirm: null, lastAdjust: null, lastRevoke: null, loadedAt: null, ack: {}, now: () => Date.now() };

  async function loadPreview() {
    S.loadError = null;
    if (!/^\d{6,30}$/.test(S.inbound)) { S.preview = null; S.loadError = "입고 ID(숫자)를 넣어 주세요"; return; }
    const { data, error } = await S.sb.rpc(PREVIEW_RPC, S.poNo ? { p_wing_inbound_id: S.inbound, p_po_no: S.poNo } : { p_wing_inbound_id: S.inbound });
    if (error) { S.preview = null; S.loadError = error.message || String(error); return; }
    S.preview = data || { rows: [] };
    await loadMailState();
    S.loadedAt = new Date().toISOString();
  }
  async function loadMailState() {
    const { data, error } = await S.sb.rpc(MAIL_STATE_RPC, {});
    S.mail = error ? null : data || null;
    S.mailError = error ? (error.message || String(error)) : null;
  }

  const STATE_BADGE = { APPLIED: ["approved", "적용"], ALREADY: ["ok", "이미 적용"], CONFLICT: ["check", "충돌"], DRIFT: ["error", "원본 drift"], FAILED: ["error", "실패"] };
  const stateBadge = s => s ? UI().badge(STATE_BADGE[s.state][0], { text: STATE_BADGE[s.state][1], title: s.text }) + `<div style="font-size:11px">${esc(s.text)}</div>` : "";

  function tableHtml(plan) {
    const confLabel = r => {
      const q = num((r.activeConfirmation || {}).confirmed_received_qty);
      return { NEW: "미확정", SAME: `확정 완료 ${q}`, CONFLICT: `⚠ 확정값과 다름(확정 ${q} · 입력 ${num(r.qty)})`, DRIFT: "확정 뒤 WING 값 바뀜" }[r.confState];
    };
    const adjLabel = r => ({ NEW: "", SAME: "조정 완료", CONFLICT: `⚠ 조정값과 다름(조정 ${num((r.activeAdjustment || {}).adjusted_received_qty)})`, NO_PO_ITEM: "발주 품목 없음", MULTIPLE_PO_ITEMS: "발주 품목 여러 개" }[r.adjState]);
    const body = plan.rows.map(r => `<tr data-vid="${esc(r.vid)}">
      <td><b>${esc(r.code)}</b><div style="font-size:11px">${esc(r.name)}</div><code style="font-size:11px">${esc(r.vid)}</code></td>
      <td class="num">${num(r.requested)}</td><td class="num">${num(r.mirrorReceived)}</td><td class="num">${num(r.stowed)}</td>
      <td style="font-size:11px">${esc(r.wingStatus)}<br>확인 ${esc(fmtKst(r.checkedAt))}</td>
      <td><input class="pi-in" style="width:64px" inputmode="numeric" data-erp-key="wrf-qty-${esc(r.vid)}" value="${esc((S.inputs || {})[r.vid] ?? (r.qtySource === "CONFIRMED" ? String(r.qty) : ""))}"
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

  function mailHtml() {
    const g = mailGate(S.mail, S.now());
    const snap = g.snapshot;
    const cands = snap ? (snap.candidates || []) : [];
    const candHtml = cands.length
      ? `<table class="rg-detail"><tbody>${cands.map(c => `<tr><td>${esc(c.product_code || c.product_id)}</td><td>${esc(c.supplier_name || "")}</td>
          <td class="num">${num(c.recommended_order_qty_ea)}EA</td></tr>`).join("")}</tbody></table>` : "<p style=\"margin:4px 0\">후보 0건</p>";
    const holds = (S.mail && S.mail.active_holds) || [];
    const holdRows = holds.map(h => {
      const st = holdReleaseState(h, snap);
      const ack = st.needsAck ? `<label style="font-size:12px;display:block;margin-bottom:4px"><input type="checkbox" data-erp-key="wrf-ack-${esc(h.id)}" ${S.ack[h.id] ? "checked" : ""}
          onchange="WingReceiptFix.setAck('${esc(h.id)}', this.checked)"> 위 후보 ${num(snap.candidate_count)}건에 문의 메일이 나가도 됨을 확인</label>` : "";
      return `<tr><td style="font-size:12px">${esc(fmtKst(h.created_at))}<br>${esc(h.source_kind)}</td><td style="font-size:12px">${esc(h.reason)}<br><code>${esc(h.id)}</code></td>
        <td>${ack}<button class="btn sm" data-erp-key="wrf-release-${esc(h.id)}" ${st.enabled && (!st.needsAck || S.ack[h.id]) ? "" : "disabled"}
          onclick="WingReceiptFix.release('${esc(h.id)}')">보류 해제</button>${st.enabled ? "" : `<div class="rg-muted" style="font-size:11px">${esc(st.why)}</div>`}</td></tr>`;
    }).join("");
    return `<div class="card" style="border:2px solid var(--amber)"><h3 style="margin:0 0 6px">⚠ 문의메일 안전장치 - 운영 문의메일 단계의 정확한 후보</h3>
      <p style="margin:0 0 6px;font-size:13px">이 화면은 SMTP·WING 을 부르지 않아요. <b>확정·조정·취소를 하면 서버가 문의메일 보류를 걸고</b>, 운영 문의메일 단계는 보류가 있으면
      SMTP 전에 멈춰요. 아래 후보는 운영 문의메일 단계가 운영 코드로 계산해 기록한 스냅샷 그대로예요(화면이 따로 계산하지 않음).</p>
      ${S.mailError ? `<p style="color:var(--red)">문의메일 상태를 읽지 못했어요: ${esc(S.mailError)}</p>` : ""}
      ${snap ? `<p style="margin:0 0 4px;font-size:12px">최신 스냅샷 ${esc(fmtKst(snap.computed_at))} (${esc(snap.source)}) · 재고 캐시 ${esc(fmtKst(snap.cache_calculated_at))}
        · 게이트 ${esc(snap.gate || "통과")} · 후보 <b>${num(snap.candidate_count)}</b>건 · 차단 ${num(snap.blocked_count)}건 · <code>${esc(snap.id)}</code></p>${candHtml}` : ""}
      ${g.ok ? "" : `<p style="color:var(--red);margin:6px 0 0"><b>실행 막힘: ${esc(g.why)}</b></p>`}
      <h4 style="margin:10px 0 4px">활성 문의메일 보류 ${num(holds.length)}건</h4>
      ${holds.length ? `<table class="rg-detail"><tbody>${holdRows}</tbody></table>
        <p class="rg-muted" style="font-size:12px;margin:4px 0 0">해제 조건: 정정 뒤 재고 캐시가 다시 계산되고(06:20 또는 [새로고침]) 그 캐시로 운영 문의메일 단계가 만든 최신 스냅샷이
        후보 0건이거나, 후보 목록을 확인했을 때. 조건이 안 되면 보류가 그대로라 메일이 나가지 않아요.</p>` : `<p class="rg-muted" style="margin:0">보류 없음</p>`}
      ${S.lastReleaseMeta ? `<p style="font-size:12px">최근 해제: ${esc(S.lastReleaseMeta)}</p>` : ""}</div>`;
  }

  function rollbackHtml(plan) {
    const ra = revokeItems(plan, "revoke_adj"), rc = revokeItems(plan, "revoke_conf");
    const res = S.lastRevoke || {};
    const rows = plan.rows.filter(r => r.activeAdjustment || r.activeConfirmation || res[r.vid]).map(r => `<tr><td>${esc(r.code)} <code>${esc(r.vid)}</code></td>
      <td style="font-size:12px">${r.activeAdjustment ? `조정 ${num(r.poOriginal)}→${num(r.activeAdjustment.adjusted_received_qty)} → 취소 시 원본 ${num(r.poOriginal)}` : "조정 없음"}</td>
      <td style="font-size:12px">${r.activeConfirmation ? `확정 ${num(r.activeConfirmation.confirmed_received_qty)} → 취소 시 WING 원본 판정으로` : "확정 없음"}</td>
      <td>${stateBadge(res[r.vid])}</td></tr>`).join("");
    return `<div class="card"><h3 style="margin:0 0 6px">되돌리기(읽기 전용 미리보기 → 조정 취소 → 확정 취소)</h3>
      ${rows ? `<table class="rg-detail"><tbody>${rows}</tbody></table>` : `<p class="rg-muted">되돌릴 기록이 없어요.</p>`}
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
        <div><button class="btn sm secondary" data-erp-key="wrf-revoke-adj" ${ra.items.length ? "" : "disabled"} onclick="WingReceiptFix.revokeAdjustments()">A. 조정 취소 (${ra.items.length}건)</button>
          ${ra.why ? `<div class="rg-muted" style="font-size:12px">${esc(ra.why)}</div>` : ""}</div>
        <div><button class="btn sm secondary" data-erp-key="wrf-revoke-conf" ${rc.items.length ? "" : "disabled"} onclick="WingReceiptFix.revokeConfirmations()">B. 확정 취소 (${plan.rows.filter(r => r.activeConfirmation).length}건)</button>
          ${rc.why ? `<div class="rg-muted" style="font-size:12px">${esc(rc.why)}</div>` : ""}</div></div>
      ${S.lastRevokeMeta ? `<p class="rg-muted" style="font-size:12px">최근 취소: ${esc(S.lastRevokeMeta)}</p>` : ""}</div>`;
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
    const gate = mailGate(S.mail, S.now());
    const poInfo = S.preview.po ? `발주 ${esc(S.preview.po.po_no)} (${esc(S.preview.po.status)})` :
      `발주번호를 넣으면 조정 미리보기가 보여요 · 이 입고 상품이 든 발주: ${esc((S.preview.candidate_po_nos || []).join(", ") || "없음")}`;
    return head + `<div class="card"><h3 style="margin:0 0 6px">미리보기 - 입고 ${esc(S.preview.wing_inbound_id)} · ${poInfo}</h3>${tableHtml(plan)}</div>` +
      mailHtml() +
      `<div class="card"><h3 style="margin:0 0 6px">실행(각각 확인창에서 사유 입력 후 최종 버튼)</h3>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div><button class="btn sm danger" data-erp-key="wrf-confirm" ${ci.items.length && gate.ok ? "" : "disabled"} onclick="WingReceiptFix.confirm()">1. 확정 기록 (${ci.items.length}개 SKU)</button>
            ${ci.why || !gate.ok ? `<div class="rg-muted" style="font-size:12px">${esc(ci.why || gate.why)}</div>` : ""}</div>
          <div><button class="btn sm danger" data-erp-key="wrf-adjust" ${ai.items.length && gate.ok ? "" : "disabled"} onclick="WingReceiptFix.adjust()">2. 발주 조정 기록 (${ai.items.length}개 품목)</button>
            ${ai.why || !gate.ok ? `<div class="rg-muted" style="font-size:12px">${esc(ai.why || gate.why)}</div>` : ""}</div></div>
        <p class="rg-muted" style="font-size:12px;margin:8px 0 0">권장: 6개 확정 + 6개 조정. 발주 조정은 원본 발주·매입을 바꾸지 않는 기록이고, 발주 잔량·공헌이익 원가 계산에는 쓰지 않아요.
        ${S.lastConfirmMeta ? `<br>최근 확정: ${esc(S.lastConfirmMeta)}` : ""}${S.lastAdjustMeta ? `<br>최근 조정: ${esc(S.lastAdjustMeta)}` : ""}</p></div>` +
      rollbackHtml(plan);
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

  const KIND = {
    confirm: { rpc: CONFIRM_RPC, prefix: "wdr", label: "확정 기록", title: "WING 최종 입고수량 확정 기록" },
    adjust: { rpc: ADJUST_RPC, prefix: "pra", label: "조정 기록", title: "발주 입고수량 조정 기록" },
    revoke_adj: { rpc: REVOKE_ADJ_RPC, prefix: "rva", label: "조정 취소", title: "발주 입고수량 조정 취소(되돌리기 1단계)" },
    revoke_conf: { rpc: REVOKE_CONF_RPC, prefix: "rvc", label: "확정 취소", title: "WING 확정 기록 취소(되돌리기 2단계)" },
  };

  function run(kind) {
    const K = KIND[kind];
    const isRevoke = kind.startsWith("revoke");
    let pre = null;
    return UI().run({
      key: `wrf-${kind}-${S.inbound}`, allowed: !!(S.me && S.me.approver),
      deniedText: "승인 권한자만 처리할 수 있어요 - 읽기 전용이에요",
      precheck: async () => {
        await loadPreview(); rerender();
        if (S.loadError || !S.preview) return { ok: false, message: S.loadError || "미리보기를 먼저 불러와 주세요" };
        const plan = buildPlan(S.preview, S.inputs);
        if (!isRevoke) {
          const g = mailGate(S.mail, S.now());
          if (!g.ok) return { ok: false, message: g.why };
        }
        const x = kind === "confirm" ? confirmItems(plan) : kind === "adjust" ? adjustItems(plan) : revokeItems(plan, kind);
        if (!x.items.length) return { ok: false, message: x.why };
        if (kind === "adjust" && !S.preview.po) return { ok: false, message: "발주번호를 넣고 다시 불러와 주세요" };
        pre = { plan, ...x };
        return { ok: true };
      },
      confirm: () => {
        const rows = kind === "confirm"
          ? pre.plan.rows.filter(r => r.confState === "NEW").map(r => [esc(`${r.code} (${r.vid})`), `WING 원본 입고 ${num(r.mirrorReceived)} → 확정 <b>${num(r.qty)}</b> (차이 ${r.diff > 0 ? "+" : ""}${num(r.diff)})`])
          : kind === "adjust"
            ? pre.plan.rows.filter(r => r.adjState === "NEW").map(r => [esc(`${r.code} (${r.vid})`), `발주 입고 ${num(r.poOriginal)} → <b>${num(r.poAdjusted)}</b> · ${won(r.amountDelta)}`])
            : pre.plan.rows.filter(r => kind === "revoke_adj" ? r.activeAdjustment : r.activeConfirmation).map(r => [esc(`${r.code} (${r.vid})`),
                kind === "revoke_adj" ? `조정 ${num(r.activeAdjustment.adjusted_received_qty)} 취소 → 원본 ${num(r.poOriginal)}` : `확정 ${num(r.activeConfirmation.confirmed_received_qty)} 취소 → WING 원본 판정`]);
        const notes = {
          confirm: ["원본 WING 기록은 바꾸지 않고 확정 기록만 추가해요. 서버가 미리보기 뒤 WING 값이 바뀌었으면 거부하고, 한 SKU 라도 막히면 전부 안 써요.",
                    "실행과 동시에 문의메일 보류가 걸려요 - 재고 캐시 재계산 뒤 운영 후보 스냅샷을 확인하고 보류를 풀어야 문의 메일이 다시 나가요."],
          adjust: [`원본 발주·매입은 바꾸지 않고 조정 기록만 추가해요. 금액 영향 합계(VAT 별도) ${won(pre.plan && pre.plan.amountTotal)} - 공급처 청구와 대조 필요.`,
                   "발주 잔량·공헌이익 원가 계산에는 쓰지 않아요. 실행과 동시에 문의메일 보류가 걸려요."],
          revoke_adj: ["조정 기록을 취소(REVOKED)해요 - 기록은 남고 유효 입고수량은 원본으로 돌아가요. 확정 취소는 이 단계 뒤에만 가능해요.",
                       "서버가 화면이 본 조정값과 같을 때만 취소하고, 하나라도 막히면 전부 안 해요. 실행과 동시에 문의메일 보류가 걸려요."],
          revoke_conf: ["확정 기록을 취소(REVOKED)해요 - 기록은 남고 재고 판단은 WING 원본 판정(격리·장기 지연 경고)으로 돌아가요.",
                        "서버가 화면이 본 확정값과 같을 때만, 걸린 발주 조정이 없을 때만 취소해요. 실행과 동시에 문의메일 보류가 걸려요."],
        }[kind];
        return { title: K.title, actionLabel: K.label, danger: true, rows, notes,
                 reason: { label: "사유", required: true, minLength: 5, placeholder: isRevoke ? "예) 공급처 청구 확인 결과 수량 재검토 필요" : "예) 대표 확인 - WING 판매개시·과착 회송 화면과 공급처 출고 수량 기준" } };
      },
      exec: async reason => {
        const r0 = reason.trim();
        const payload = kind === "adjust" ? { batch: pre.batchId, po: S.preview.po.po_no, items: pre.items, reason: r0 } : { kind, items: pre.items, reason: r0 };
        const key = await idemKey(K.prefix, S.inbound, payload);
        const args = kind === "confirm" ? { p_wing_inbound_id: S.inbound, p_items: pre.items, p_reason: r0, p_idempotency_key: key }
          : kind === "adjust" ? { p_confirmation_batch_id: pre.batchId, p_po_no: S.preview.po.po_no, p_items: pre.items, p_reason: r0, p_idempotency_key: key }
          : { p_items: pre.items, p_reason: r0, p_idempotency_key: key };
        const { data, error } = await S.sb.rpc(K.rpc, args);
        const sent = pre.items.map(x => String(kind === "confirm" ? x.vendor_item_id : kind === "adjust" ? x.po_item_id : x.id));
        const r = interpretResult(kind, sent, data, error);
        const meta = `${r.message} · 요청 키 ${key}`;
        if (kind === "confirm") { S.lastConfirm = r.perKey; S.lastConfirmMeta = meta; }
        else if (kind === "adjust") { S.lastAdjust = r.perKey; S.lastAdjustMeta = meta; }
        else { S.lastRevoke = Object.fromEntries(Object.entries(r.perKey).map(([id, v]) => [pre.keyOf[id] || id, v])); S.lastRevokeMeta = `${K.label} · ${meta}`; }
        return { ok: r.ok, message: r.message, data };
      },
      successText: res => (res && res.message) || "처리했어요",
      refresh: reload,
    });
  }

  function release(holdId) {
    let hold = null, snap = null, st = null;
    return UI().run({
      key: `wrf-release-${holdId}`, allowed: !!(S.me && S.me.approver),
      deniedText: "승인 권한자만 처리할 수 있어요 - 읽기 전용이에요",
      precheck: async () => {
        await loadMailState(); rerender();
        hold = ((S.mail && S.mail.active_holds) || []).find(h => String(h.id) === String(holdId)) || null;
        if (!hold) return { ok: false, message: "활성 보류가 아니에요(이미 해제됐을 수 있어요)" };
        snap = ((S.mail && S.mail.snapshots) || [])[0] || null;
        st = holdReleaseState(hold, snap);
        if (!st.enabled) return { ok: false, message: st.why };
        if (st.needsAck && !S.ack[holdId]) return { ok: false, message: `후보 ${snap.candidate_count}건 확인 체크가 필요해요` };
        return { ok: true };
      },
      confirm: () => ({
        title: "문의메일 보류 해제", actionLabel: "보류 해제", danger: st.needsAck,
        rows: [["보류", `${esc(hold.reason)} <code>${esc(hold.id)}</code>`], ["근거 스냅샷", `${esc(fmtKst(snap.computed_at))} · 캐시 ${esc(fmtKst(snap.cache_calculated_at))} · <code>${esc(snap.id)}</code>`],
               ["후보", st.needsAck ? `<b>${num(snap.candidate_count)}건 - 해제하면 다음 문의메일 단계에서 이 공급처들에 실제 메일이 나갈 수 있어요</b>` : "0건"]],
        notes: ["서버가 다시 확인해요: 최신 스냅샷·보류 뒤 계산·보류 뒤 재계산된 재고 캐시·게이트 통과·(후보가 있으면) 같은 후보 목록."],
        reason: { label: "해제 사유", required: true, minLength: 5, placeholder: "예) 정정 뒤 운영 후보 0건 확인" },
      }),
      exec: async reason => {
        const { data, error } = await S.sb.rpc(RELEASE_RPC, { p_hold_id: holdId, p_snapshot_id: snap.id,
          p_acknowledged_candidates_fp: st.needsAck ? snap.candidates_fp : null, p_reason: reason.trim() });
        const ok = !error && data && (data.status === "RELEASED" || data.status === "ALREADY_RELEASED");
        const msg = error ? (error.message || String(error)) : data && data.status === "BLOCKED" ? reasonText(data.reason) : `${data && data.status} · 보류 ${holdId} · 스냅샷 ${snap.id}`;
        S.lastReleaseMeta = msg;
        return { ok, message: msg, data };
      },
      successText: res => (res && res.message) || "처리했어요",
      refresh: reload,
    });
  }

  root.WingReceiptFix = {
    ROUTE, TITLE, view, reload, confirm: () => run("confirm"), adjust: () => run("adjust"),
    revokeAdjustments: () => run("revoke_adj"), revokeConfirmations: () => run("revoke_conf"), release,
    setInbound: v => { S.inbound = String(v || "").trim(); }, setPo: v => { S.poNo = String(v || "").trim(); },
    setQty: (vid, v) => { S.inputs[String(vid)] = v; rerender(); }, setAck: (id, v) => { S.ack[String(id)] = !!v; rerender(); },
    parseQty, buildPlan, confirmItems, adjustItems, revokeItems, mailGate, holdReleaseState, idemKey, interpretResult, _state: S,
  };
})(typeof window !== "undefined" ? window : globalThis);
