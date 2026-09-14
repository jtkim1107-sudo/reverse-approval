/* cm_recovery.js
 * -------------------------------------------------------------------------
 * 2026-09-16 반품 원가환입 - 제안 · 승인 · 승인 취소 화면 (새 공헌이익 스위치가 켜졌을 때만 공헌이익 카드 안에 나와요)
 *
 *   · 후보 = 새 계산 결과의 정산취소 행(주문·옵션·환불일). 후보만으로는 공헌이익이 바뀌지 않아요.
 *   · 제안(직원) = WING 취소·반품 번호·상태·재입고 수량 + 근거 파일. 파일은 ERP DB 에 보관(fn_upload_cm_evidence_file - 해시는 DB 가 계산),
 *     브라우저 해시와 DB 해시가 다르면 제안하지 않아요. 직원은 자기가 올린 파일의 해시·메타정보만 보고, 다시 내려받지는 못해요.
 *   · SHA-256 은 '올린 뒤 바뀌지 않았다(업로드 후 무결성)'만 확인해요 - WING 에서 받은 원본이라는 증명이 아니에요.
 *     그래서 승인은 [승인 검토] 창에서 파일명·크기·올린 사람·올린 시각·해시·WING 번호를 보고, 파일을 내려받아(열람 이력 기록) 내용을 직접 확인한 뒤에만.
 *     화면·기록 어디에도 'WING 원본 인증 완료' 같은 표시를 하지 않아요.
 *     결제 뒤 경과일로 나눈 '주문 취소/반품(추정)'은 참고용이라 근거로 받지 않아요 - 유형은 WING 에서 확인한 값만.
 *   · 승인 · 승인 취소 = 승인 권한자 본인 로그인 + 사유. 기록은 지우지 않고 이력(제안→승인→승인 취소)으로 남아요.
 *   · 중복 승인·환입 초과는 DB 가 막아요(같은 정산취소 행 수량 합 ≤ 환불 수량, 같은 WING 번호 한 번). 화면도 남은 수량까지만 받아요.
 *   · 이 파일이 부르는 RPC 는 아래 6개뿐이에요(표 직접 쓰기·원본 표 직접 읽기 없음). 사용자 ID 는 보내지 않아요(DB 가 로그인 사용자로 기록).
 */
(function (global) {
  "use strict";

  const RPC = Object.freeze({ upload: "fn_upload_cm_evidence_file", meta: "fn_cm_evidence_meta", download: "fn_download_cm_evidence_file",
                              propose: "fn_propose_cost_recovery", approve: "fn_approve_cost_recovery", void: "fn_void_cost_recovery" });
  const INTEGRITY_NOTE = "SHA-256 일치는 올린 뒤 파일이 바뀌지 않았다는 확인(업로드 후 무결성)일 뿐, WING 에서 받은 원본이라는 증명이 아니에요. 파일을 열어 WING 취소·반품 번호와 수량을 직접 확인해 주세요.";
  const kb = n => n == null ? "—" : n >= 1048576 ? (n / 1048576).toFixed(2) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB";
  const dt = v => String(v || "").slice(0, 16).replace("T", " ");
  const MAX_BYTES = 5 * 1024 * 1024;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => Math.round(Number(n || 0)).toLocaleString("ko-KR");
  const won = n => (Number(n) < 0 ? "−₩" : "₩") + fmt(Math.abs(Number(n || 0)));
  const HEX64 = /^[0-9a-f]{64}$/;
  const TYPE_LABEL = { WING_CANCEL: "WING 주문 취소", WING_RETURN: "WING 반품" };
  const STATE_LABEL = { PENDING_APPROVAL: "승인 대기", APPROVED: "승인", VOID: "승인 취소·무효" };
  const EVENT_LABEL = { PROPOSED: "제안", APPROVED: "승인", VOIDED: "승인 취소" };
  const keyOf = c => `${c.order_id}|${c.option_id}|${c.refund_date}`;

  const S = { month: null, candidates: [], records: [], events: [], meta: {}, isApprover: false, products: {}, deps: null, reviewed: {} };

  /** 그 달 기록·이력 읽기(읽기 전용). 실패하면 빈 목록 + error */
  async function load(sb, month) {
    try {
      const { data: rec, error } = await sb.from("cm_cost_recoveries").select("*").eq("month", month).order("created_at");
      if (error) return { records: [], events: [], meta: {}, error: error.message || String(error) };
      const ids = (rec || []).map(r => r.id);
      let events = [], meta = {};
      if (ids.length) {
        const ev = await sb.from("cm_cost_recovery_events").select("recovery_id,event,actor,reason,created_at").in("recovery_id", ids).order("id");
        if (!ev.error) events = ev.data || [];
        // 근거 파일 메타정보(내용 없음) - 승인자는 전부, 직원은 자기가 올린 파일만 돌아와요
        const shas = [...new Set((rec || []).map(r => r.evidence_file_sha256).filter(Boolean))];
        const mt = await sb.rpc(RPC.meta, { p_sha256: shas });
        if (!mt.error) (mt.data || []).forEach(m => { meta[m.sha256] = m; });
      }
      return { records: rec || [], events, meta };
    } catch (e) {
      return { records: [], events: [], meta: {}, error: String(e && e.message || e) };
    }
  }

  /** 후보별 남은 수량(계산 결과 뒤에 생긴 제안·승인·취소까지 DB 기록으로 다시 셈) */
  function remaining(c, records) {
    const used = records.filter(r => keyOf(r) === keyOf(c) && (r.status === "PENDING_APPROVAL" || r.status === "APPROVED"))
      .reduce((s, r) => s + Number(r.qty || 0), 0);
    return Math.max(Number(c.refund_qty || 0) - used, 0);
  }

  /** 제안 입력 검사 - 비어 있으면 통과. 화면 검사는 편의일 뿐, 최종 판단은 DB 제약·트리거 */
  function validateProposal(f, c, records) {
    const bad = [];
    const qty = Number(f.qty);
    const rem = remaining(c, records || []);
    if (!Number.isInteger(qty) || qty < 1) bad.push("환입 수량은 1 이상 정수");
    else if (qty > rem) bad.push(`남은 수량 ${fmt(rem)}개보다 많아요(중복·초과 불가)`);
    if (!TYPE_LABEL[f.evidence_type]) bad.push("WING 에서 확인한 유형(주문 취소/반품)을 골라 주세요");
    if (String(f.wing_ref || "").trim().length < 4) bad.push("WING 취소·반품 번호");
    if (String(f.wing_status || "").trim().length < 2) bad.push("WING 처리 상태(예: 반품완료)");
    if (f.evidence_type === "WING_RETURN") {
      const rs = Number(f.wing_restock_qty);
      if (!(rs >= 0) || f.wing_restock_qty === "" || f.wing_restock_qty == null) bad.push("WING 재입고(재판매 가능) 수량");
      else if (qty > rs) bad.push("재입고 수량보다 많이 되돌릴 수 없어요");
    }
    if (String(f.source_file || "").trim().length < 3 || !HEX64.test(String(f.source_sha256 || ""))) bad.push("WING 원본 파일(이름·SHA-256)");
    if (String(f.reason || "").trim().length < 2) bad.push("사유");
    if (c.unit_cost == null) bad.push("원주문 판매일 원가를 몰라 제안할 수 없어요");
    return bad;
  }

  function buildProposal(f, c) {
    return {
      order_id: c.order_id, option_id: c.option_id, refund_date: c.refund_date, product_id: c.product_id, refund_qty: c.refund_qty,
      qty: Number(f.qty), unit_cost: Math.round(Number(c.unit_cost) * 100) / 100, cost_basis: c.cost_basis,
      evidence_type: f.evidence_type, wing_ref: String(f.wing_ref).trim(), wing_status: String(f.wing_status).trim(),
      wing_restock_qty: f.evidence_type === "WING_RETURN" ? Number(f.wing_restock_qty) : null,
      evidence: { source_file: String(f.source_file).trim(), source_sha256: f.source_sha256, entered_at: new Date().toISOString() },
      settlement_ref: { file_sha256: c.file_sha256, period: c.period, file: c.file }, reason: String(f.reason).trim(),
    };
  }

  function chip(text, kind) {
    const UI = global.ErpUi;
    return UI && UI.badge ? UI.badge(kind, { text, small: true }) : `<span class="erp-badge erp-badge--sm">${esc(text)}</span>`;
  }

  /** 공헌이익 카드 안 원가환입 칸 - state = {month, candidates(계산 결과 refund_candidates), records, events, isApprover, productCode(id→code)} */
  function panelHtml(st) {
    const recs = st.records || [], cands = st.candidates || [];
    const code = id => (st.productCode && st.productCode[id]) || "";
    const open = cands.map((c, i) => ({ c, i, rem: remaining(c, recs) }));
    const evBy = {};
    (st.events || []).forEach(e => { (evBy[e.recovery_id] = evBy[e.recovery_id] || []).push(e); });
    const row = ({ c, i, rem }) => `<tr>
        <td>${esc(c.refund_date)}</td><td><code>${esc(c.order_id)}</code><br><small>${esc(c.option_id)} · ${esc(code(c.product_id))}</small></td>
        <td class="num">${fmt(c.refund_qty)}</td><td class="num">${c.unit_cost == null ? "모름" : won(c.unit_cost)}</td>
        <td><small>${esc(c.est_label || "")}</small></td>
        <td class="num">${fmt(rem)}</td>
        <td>${rem > 0 ? `<button class="btn sm secondary" onclick="CmRecovery.openPropose(${i})">원가환입 제안</button>` : "—"}</td></tr>`;
    const meta = st.meta || {};
    const who = id => (st.userName ? st.userName(id) : "") || "—";
    const recRow = r => {
      const acts = st.isApprover && r.status === "PENDING_APPROVAL"
        ? `<button class="btn sm" onclick="CmRecovery.openApprove('${esc(r.id)}')">승인 검토</button> <button class="btn sm secondary" onclick="CmRecovery.voidRec('${esc(r.id)}')">무효</button>`
        : st.isApprover && r.status === "APPROVED" ? `<button class="btn sm secondary" onclick="CmRecovery.voidRec('${esc(r.id)}')">승인 취소</button>` : "";
      const m = meta[r.evidence_file_sha256];
      const hist = (evBy[r.id] || []).map(e => `${esc(EVENT_LABEL[e.event] || e.event)} ${esc(String(e.created_at || "").slice(5, 16).replace("T", " "))}${e.reason ? ` · ${esc(e.reason)}` : ""}`).join(" → ");
      return `<tr class="cmr-${esc(r.status.toLowerCase())}">
        <td>${chip(STATE_LABEL[r.status] || r.status, r.status === "APPROVED" ? "ok" : r.status === "VOID" ? "info" : "approval")}</td>
        <td><code>${esc(r.order_id)}</code> <small>${esc(r.refund_date)}</small></td>
        <td>${esc(TYPE_LABEL[r.evidence_type] || r.evidence_type)} <small>${esc(r.wing_ref)} · ${esc(r.wing_status)}${r.wing_restock_qty != null ? ` · 재입고 ${fmt(r.wing_restock_qty)}개` : ""}</small>
          <br><small>${m ? `${esc(m.file_name)} · ${kb(m.byte_size)} · ${esc(who(m.uploaded_by))} ${esc(dt(m.uploaded_at).slice(5))}` : "근거 파일 정보 없음(권한 밖)"} · SHA-256 <code title="${esc(r.evidence_file_sha256)}">${esc(String(r.evidence_file_sha256 || "").slice(0, 12))}…</code></small>
          ${r.integrity_checked_at ? `<br><small>업로드 후 무결성 확인(해시 일치) ${esc(dt(r.integrity_checked_at).slice(5))} · 승인자 파일 열람 ${esc(dt(r.content_reviewed_at).slice(5))}</small>` : ""}</td>
        <td class="num">${fmt(r.qty)} / ${fmt(r.refund_qty)}</td><td class="num">${won(r.amount)}</td>
        <td><small>${hist}</small></td><td>${acts}</td></tr>`;
    };
    return `<div class="cmr" id="cmr">
      <p class="cmv2-note">정산취소 행마다 WING 취소·반품 근거로 되돌릴 수량을 제안하고, 승인 권한자가 승인한 수량만 공헌이익에 들어가요.
        후보·승인 대기는 반영하지 않아요. '주문 취소/반품(추정)'은 결제 뒤 경과일로 본 참고값이라 근거가 아니에요.</p>
      ${open.length ? `<details class="cmr-cands"${open.some(x => x.rem > 0) && open.length <= 10 ? " open" : ""}><summary>원가환입 후보(정산취소 행) ${fmt(open.length)}건 · 남은 수량 ${fmt(open.reduce((s, x) => s + x.rem, 0))}개</summary>
        <div class="table-wrap"><table class="cmv2-lines"><thead><tr><th>환불 처리일</th><th>주문 · 옵션 · 상품</th><th class="num">환불 수량</th><th class="num">원주문 원가</th><th>참고(추정)</th><th class="num">남은 수량</th><th></th></tr></thead>
        <tbody>${open.map(row).join("")}</tbody></table></div></details>` : `<p class="cmv2-note">이 달 정산취소 행이 없어요.</p>`}
      ${recs.length ? `<h4 class="cmv2-h4">제안 · 승인 이력</h4><div class="table-wrap"><table class="cmv2-lines"><thead><tr><th>상태</th><th>주문 · 환불일</th><th>WING 근거</th><th class="num">수량/환불</th><th class="num">금액</th><th>이력</th><th></th></tr></thead>
        <tbody>${recs.map(recRow).join("")}</tbody></table></div>` : ""}
      ${st.error ? `<p class="cmv2-note">기록을 불러오지 못했어요: ${esc(st.error)}</p>` : ""}
    </div>`;
  }

  function set(st, deps) {
    Object.assign(S, st);
    S.deps = deps || S.deps;
  }

  /** 승인 검토 창 - 근거 파일 정보·해시·WING 번호를 보여 주고, 내려받아 연 뒤 '내용 확인'을 체크해야 승인 버튼이 켜져요 */
  function approveModalHtml(r, m, who) {
    return `<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><div class="modal cmr-approve">
      <h3>반품 원가환입 승인 검토</h3>
      <dl class="cmr-kv">
        <div><dt>주문 · 옵션 · 환불 처리일</dt><dd><code>${esc(r.order_id)}</code> · ${esc(r.option_id)} · ${esc(r.refund_date)}</dd></div>
        <div><dt>되돌릴 수량 / 환불 수량 · 금액</dt><dd>${fmt(r.qty)} / ${fmt(r.refund_qty)} · ${won(r.amount)}</dd></div>
        <div><dt>WING 유형 · 번호 · 상태</dt><dd>${esc(TYPE_LABEL[r.evidence_type] || r.evidence_type)} · <b>${esc(r.wing_ref)}</b> · ${esc(r.wing_status)}${r.wing_restock_qty != null ? ` · 재입고 ${fmt(r.wing_restock_qty)}개` : ""}</dd></div>
        <div><dt>근거 파일명 · 크기</dt><dd>${m ? `${esc(m.file_name)} · ${kb(m.byte_size)}` : "—"}</dd></div>
        <div><dt>올린 사람 · 올린 시각</dt><dd>${m ? `${esc(who(m.uploaded_by))} · ${esc(dt(m.uploaded_at))}` : "—"}</dd></div>
        <div><dt>SHA-256</dt><dd><code class="cmr-hash">${esc(r.evidence_file_sha256)}</code></dd></div>
      </dl>
      <p class="cmr-warn">${esc(INTEGRITY_NOTE)}</p>
      <div class="field"><button class="btn secondary" id="cmr-dl" onclick="CmRecovery.reviewDownload('${esc(r.id)}')">근거 파일 내려받기 <small>(열람 이력이 남아요)</small></button>
        <span id="cmr-dl-state" class="cmv2-note"></span></div>
      <label class="cmr-check"><input type="checkbox" id="cmr-reviewed" disabled> 내려받은 파일을 열어 WING 취소·반품 번호(${esc(r.wing_ref)})와 수량을 직접 확인했어요</label>
      <div class="field"><label>승인 사유 *</label><input id="cmr-approve-reason" type="text" placeholder="예: WING 반품 목록에서 번호·재입고 수량 확인"></div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">닫기</button>
        <button class="btn" id="cmr-approve-go" onclick="CmRecovery.submitApprove('${esc(r.id)}')">승인</button></div></div></div>`;
  }

  function openApprove(id) {
    const d = S.deps, r = S.records.find(x => x.id === id);
    if (!d || !r || !S.isApprover || r.status !== "PENDING_APPROVAL") return;
    S.reviewed[id] = false;
    d.modal(approveModalHtml(r, (S.meta || {})[r.evidence_file_sha256], x => (S.userName ? S.userName(x) : "") || "—"));
  }

  /** 승인 검토 중 내려받기 - 승인자 RPC(열람 이력 기록) · 받은 바이트 해시 다시 확인 → 확인 체크 켜기 */
  async function reviewDownload(id) {
    const d = S.deps, r = S.records.find(x => x.id === id);
    if (!d || !r) return;
    const ok = await downloadEvidence(r.evidence_file_sha256, { reason: "원가환입 승인 검토", recoveryId: id });
    if (!ok) return;
    S.reviewed[id] = true;
    const cb = d.doc.getElementById("cmr-reviewed"); if (cb) cb.disabled = false;
    const stEl = d.doc.getElementById("cmr-dl-state"); if (stEl) stEl.textContent = "내려받음 - 파일을 열어 내용을 확인한 뒤 체크해 주세요";
  }

  async function submitApprove(id) {
    const d = S.deps, r = S.records.find(x => x.id === id);
    if (!d || !r || !S.isApprover) return;
    const cb = d.doc.getElementById("cmr-reviewed");
    const reason = String((d.doc.getElementById("cmr-approve-reason") || {}).value || "").trim();
    if (!S.reviewed[id]) return d.toast("근거 파일을 먼저 내려받아 열어 주세요");
    if (!(cb && cb.checked)) return d.toast("파일 내용을 직접 확인했다는 체크가 필요해요");
    if (reason.length < 2) return d.toast("승인 사유를 적어 주세요");
    const { error } = await d.sb.rpc(RPC.approve, { p_id: id, p_reason: reason, p_content_reviewed: true });
    if (error) return d.toast("승인하지 못했어요: " + (error.message || ""));
    d.toast("승인했어요 - 다음 계산부터 공헌이익에 반영돼요");
    d.close(); await d.rerender();
  }

  async function fileSha256(file) {
    const buf = await file.arrayBuffer();
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf))).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function openPropose(i) {
    const c = S.candidates[i];
    const d = S.deps;
    if (!c || !d) return;
    const rem = remaining(c, S.records);
    d.modal(`<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><div class="modal">
      <h3>반품 원가환입 제안</h3>
      <p style="font-size:12.5px;color:var(--text-sub);line-height:1.7">주문 <code>${esc(c.order_id)}</code> · 옵션 ${esc(c.option_id)} · 환불 처리 ${esc(c.refund_date)} ·
        환불 ${fmt(c.refund_qty)}개 · 남은 ${fmt(rem)}개 · 원주문 원가 ${c.unit_cost == null ? "모름" : won(c.unit_cost)}. 승인 전에는 공헌이익에 반영하지 않아요.</p>
      <div class="form-grid">
        <div class="field"><label>WING 에서 확인한 유형 *</label><select id="cmr-type"><option value="">선택</option><option value="WING_CANCEL">주문 취소(출고 전·재고 복귀)</option><option value="WING_RETURN">반품(회수·재입고)</option></select></div>
        <div class="field"><label>WING 취소·반품 번호 *</label><input id="cmr-ref" type="text"></div>
        <div class="field"><label>WING 처리 상태 *</label><input id="cmr-status" type="text" placeholder="예: 취소완료 · 반품완료"></div>
        <div class="field"><label>재입고(재판매 가능) 수량 <small>반품이면 필수</small></label><input id="cmr-restock" type="number" min="0" step="1"></div>
        <div class="field"><label>되돌릴 수량 *</label><input id="cmr-qty" type="number" min="1" max="${rem}" step="1" value="${rem}"></div>
        <div class="field"><label>근거 파일(WING 에서 받은 취소·반품 파일) * <small>ERP 에 보관 · 5MB 이하 · 올린 뒤에는 승인 권한자만 내려받을 수 있어요</small></label><input id="cmr-file" type="file"></div>
        <div class="field" style="grid-column:1/-1"><label>사유 *</label><input id="cmr-reason" type="text" placeholder="예: WING 반품 입고 확인(재판매 가능 1개)"></div>
      </div>
      <div class="modal-actions"><button class="btn secondary" onclick="closeModal()">취소</button>
        <button class="btn" id="cmr-save" onclick="CmRecovery.submitPropose(${i})">제안 저장(승인 대기)</button></div></div></div>`);
  }

  async function submitPropose(i) {
    const c = S.candidates[i], d = S.deps;
    const v = id => (d.doc.getElementById(id) || {}).value;
    const fileEl = d.doc.getElementById("cmr-file");
    const file = fileEl && fileEl.files && fileEl.files[0];
    const f = { evidence_type: v("cmr-type"), wing_ref: v("cmr-ref"), wing_status: v("cmr-status"), wing_restock_qty: v("cmr-restock"),
                qty: v("cmr-qty"), reason: v("cmr-reason"), source_file: file ? file.name : "", source_sha256: file ? await d.sha(file) : "" };
    const bad = validateProposal(f, c, S.records);
    if (file && !(file.size > 0 && file.size <= MAX_BYTES)) bad.push("근거 파일은 1바이트 ~ 5MB");
    if (bad.length) return d.toast("확인해 주세요: " + bad.join(" · "));
    // 1) 원본 보관 - DB 가 계산한 해시가 브라우저 해시와 같아야 다음 단계로
    const up = await d.sb.rpc(RPC.upload, { p_file_name: f.source_file, p_content_base64: await d.b64(file) });
    if (up.error) return d.toast("근거 파일을 보관하지 못했어요: " + String(up.error.message || "").split(":")[0]);
    if (up.data !== f.source_sha256) return d.toast("보관된 파일의 SHA-256 이 이 파일과 달라요 - 제안하지 않았어요");
    // 2) 제안(승인 대기)
    const { error } = await d.sb.rpc(RPC.propose, { p: buildProposal(f, c) });
    if (error) return d.toast("제안하지 못했어요: " + (error.message || ""));
    d.toast("원가환입을 제안했어요(승인 대기 - 아직 공헌이익에 반영되지 않아요)");
    d.close(); await d.rerender();
  }

  async function fileBase64(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /** 근거 파일 내려받기 - 승인 권한자 전용 RPC(서버가 권한·무결성 확인, 열람 이력 기록). 받은 바이트의 해시도 다시 확인해요. 성공하면 true */
  async function downloadEvidence(sha, { reason = "원가환입 근거 확인", recoveryId = null } = {}) {
    const d = S.deps;
    if (!d || !S.isApprover || !HEX64.test(String(sha || ""))) return false;
    const { data, error } = await d.sb.rpc(RPC.download, { p_sha256: sha, p_reason: reason, p_recovery_id: recoveryId });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) { d.toast("근거 파일을 내려받지 못했어요" + (error ? ": " + String(error.message || "").split(":")[0] : "")); return false; }
    const bin = atob(String(row.content_base64 || ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const got = await d.sha(new Blob([bytes]));
    if (got !== sha) { d.toast("받은 파일의 SHA-256 이 기록과 달라요 - 승인하지 말고 확인이 필요해요"); return false; }
    d.save(new Blob([bytes]), row.file_name);
    d.toast("근거 파일을 내려받았어요(업로드 후 무결성 일치 · 열람 이력 기록)");
    return true;
  }

  async function act(kind, id) {
    const d = S.deps, r = S.records.find(x => x.id === id);
    if (!d || !r || !S.isApprover) return;
    if (kind === "approve") return openApprove(id);          // 승인은 검토 창에서만(내려받기·내용 확인 뒤)
    const what = r.status === "APPROVED" ? "승인 취소" : "무효";
    const reason = (d.prompt(`원가환입 ${what} 사유(2자 이상)`) || "").trim();
    if (reason.length < 2) return d.toast("사유를 적어 주세요");
    if (!d.confirm(`${r.order_id} · ${fmt(r.qty)}개 · ${won(r.amount)} 을 ${what}할까요? 기록은 지워지지 않고 이력으로 남아요.`)) return;
    const { error } = await d.sb.rpc(RPC.void, { p_id: id, p_reason: reason });
    if (error) return d.toast(`${what}하지 못했어요: ` + (error.message || ""));
    d.toast(`${what}했어요`);
    await d.rerender();
  }

  global.CmRecovery = { RPC, INTEGRITY_NOTE, load, remaining, validateProposal, buildProposal, panelHtml, approveModalHtml, set, openPropose, submitPropose,
                        openApprove, reviewDownload, submitApprove, fileSha256, fileBase64, downloadEvidence,
                        approve: id => act("approve", id), voidRec: id => act("void", id), _state: S };
})(typeof window !== "undefined" ? window : globalThis);
