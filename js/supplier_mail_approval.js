/* 공급처 메일 발송 승인 - 2026-09-28 [대표 지시, migration 20260928b]
   승인 필요 공급처(서버 규칙 표 - supplier_mail_approval_rules)로 나가는 모든 메일(첫 재입고 문의·합적 문의·물류정보 문의·수량 재확인·WING 입고 확정 안내·
   입고지시·입고 취소 안내·WING 직접입고 입고지시, 재시도 포함)은 자동으로 나가지 않고 여기 발송 초안으로 쌓여요.
   대표님(승인 권한자)이 수신자·발신자·제목·본문 전체·첨부파일명·관련 상품/수량/출고일·생성 사유를 보고 [발송 승인]해야만 보낼 수 있어요.
   - 승인 버튼은 누르기 직전 서버에서 이 초안을 다시 읽어, 확인창에 보인 그 내용의 지문으로만 승인해요(그 사이 내용이 바뀌면 서버가 거부).
   - 승인 뒤 내용이 한 글자라도 바뀌면 서버가 승인을 무효로 하고 새 초안을 만들어요(다시 승인 필요).
   - 이 화면은 메일을 보내지 않아요(SMTP 없음). 발송은 승인된 초안만 기존 발송 러너가 정확히 1번 해요.
   - 서버가 로그인 세션으로 승인 권한자를 다시 확인해요(사용자 ID 를 보내지 않음). 자동화 계정은 승인할 수 없어요. */
(function (root) {
  "use strict";

  const ROUTE = "suppliermailapproval";
  const TITLE = "공급처 메일 발송 승인";
  const PREVIEW_RPC = "fn_preview_supplier_mail_drafts";
  const APPROVE_RPC = "fn_approve_supplier_mail_draft";
  const REJECT_RPC = "fn_reject_supplier_mail_draft";
  const UI = () => root.ErpUi;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => (n === null || n === undefined || n === "") ? "—" : Number(n).toLocaleString("ko-KR");
  const fmtKst = ts => {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }).slice(0, 16);
  };

  const KIND_TEXT = {
    RESTOCK_INQUIRY: "재입고 사전 문의(수량·출고 가능일)", LOGISTICS_DISCOVERY_INQUIRY: "물류정보(포장·MOQ) 확인 문의",
    QUANTITY_RECONFIRMATION: "공급처 수량 재확인", WING_CONFIRMATION: "WING 입고 확정 안내", INBOUND_INSTRUCTION: "입고지시(쿠팡 물류센터 입고 요청)",
    INBOUND_CANCEL_NOTICE: "입고 취소 안내", WING_DIRECT_INBOUND_INSTRUCTION: "WING 직접입고 입고지시",
  };
  const STATUS_TEXT = {
    PENDING_APPROVAL: "승인 대기", APPROVED: "승인됨(발송 대기)", SENDING: "발송 중", SENT: "발송 완료", FAILED: "발송 실패(확정)",
    SEND_UNKNOWN: "결과 불명(사람 확인)", REJECTED: "거부", EXPIRED: "기한 지남", CANCELLED: "원천 취소", INVALIDATED: "내용 변경으로 무효",
  };
  const CONTEXT_LABEL = {
    supplier_name: "공급처", truck: "차량", product_name: "상품", product_code: "상품 코드", product_id: "상품 ID", base_product_id: "기준상품 ID",
    original_ea: "원래 수량(EA)", revised_ea: "새 수량(EA)", confirmed_quantity_ea: "확정 수량(EA)", request_quantity: "신청 수량",
    request_unit: "신청 단위", center_name: "입고 센터", center: "입고 센터", inbound_date: "입고일", coupang_shipment_id: "WING 입고 번호",
    coupang_inbound_plan_id: "WING 입고계획", attempt_no: "시도 번호", item_count: "품목 수", force_resend: "사람 재발송 요청", linked_po_no: "연결 발주번호",
  };

  // ── 순수 함수(테스트 대상) ────────────────────────────────────────────────
  function actionState(d, ctx = {}) {
    if (!ctx.isApprover) return { enabled: false, why: "승인 권한자만" };
    if (!d) return { enabled: false, why: "초안을 찾지 못했어요" };
    if (d.status !== "PENDING_APPROVAL") return { enabled: false, why: `${STATUS_TEXT[d.status] || d.status} - 승인할 수 없는 상태` };
    if (d.expired) return { enabled: false, why: "승인 기한이 지났어요 - 다음 발송 시도가 새 초안을 만들어요" };
    if (!d.content_fingerprint) return { enabled: false, why: "서버 지문이 없어요" };
    return { enabled: true, why: "" };
  }

  function itemsText(items) {
    return (items || []).map(i => `${esc(i.product_name || i.product_id || "상품")} · ${num(i.quantity ?? i.qty)}${esc(i.unit || "")}`).join("<br>");
  }

  function contextRows(ctx) {
    const c = ctx || {};
    const rows = [];
    if (Array.isArray(c.items) && c.items.length) rows.push(["관련 상품·수량", itemsText(c.items)]);
    for (const [k, v] of Object.entries(c)) {
      if (k === "items" || k === "attachments" || v === null || v === undefined || v === "") continue;
      rows.push([esc(CONTEXT_LABEL[k] || k), esc(typeof v === "object" ? JSON.stringify(v) : String(v))]);
    }
    return rows;
  }

  function detailRows(d) {
    const att = (d.attachments || []).map(a => `${esc(a.filename)} <small class="rg-muted">(${num(a.size)}B · ${esc(String(a.sha256 || "").slice(0, 12))})</small>`).join("<br>") || "없음";
    return [
      ["종류", esc(KIND_TEXT[d.mail_kind] || d.mail_kind)],
      ["공급처", esc(d.supplier_name)],
      ["수신자", `<b>${esc(d.recipient)}</b>`],
      ["발신자", esc(d.sender)],
      ["제목", `<b>${esc(d.subject)}</b>`],
      ["첨부파일", att],
      ...contextRows(d.context),
      ["생성 사유", esc(d.reason)],
      ["Message-ID", `<code>${esc(d.message_id || "—")}</code>${d.in_reply_to ? ` · 답장 대상 <code>${esc(d.in_reply_to)}</code>` : ""}`],
      ["상태", `${esc(STATUS_TEXT[d.status] || d.status)} · 만든 시각 ${esc(fmtKst(d.created_at))} · 승인 기한 ${esc(fmtKst(d.expires_at))}`],
      ["내용 지문", `<code>${esc(String(d.content_fingerprint || "").slice(0, 16))}</code>`],
      ...(d.approved_at ? [["승인", `${esc(d.approved_by_name || d.approved_by)} · ${esc(fmtKst(d.approved_at))}`]] : []),
      ...(d.decision_note ? [["메모·사유", esc(d.decision_note)]] : []),
    ];
  }

  function bodyHtml(d) {
    return `<pre class="sma-body" style="white-space:pre-wrap;word-break:break-word;border:1px solid var(--border,#ddd);padding:10px;border-radius:6px;max-height:420px;overflow:auto">${esc(d.body_text)}</pre>`;
  }

  function interpretRpc(data, error) {
    if (error) return { ok: false, message: error.message || error.code || String(error) };
    const st = data && data.status;
    if (st === "APPROVED") return { ok: true, message: "발송 승인했어요 - 다음 발송 실행이 이 내용 그대로 정확히 1번 보내요" };
    if (st === "ALREADY_APPROVED") return { ok: true, message: "이미 같은 내용으로 승인된 초안이에요(변경 없음)" };
    if (st === "REJECTED") return { ok: true, message: "거부했어요 - 이 내용으로는 보내지 않아요" };
    if (st === "STALE_FINGERPRINT") return { ok: false, message: "그 사이 초안 내용이 바뀌었어요 - 승인하지 않았어요. 새 내용을 확인한 뒤 다시 눌러 주세요" };
    if (st === "EXPIRED") return { ok: false, message: "승인 기한이 지났어요 - 승인하지 않았어요" };
    if (st === "BLOCKED") return { ok: false, message: `서버가 거부했어요: ${(data.reasons || []).join(", ")}${data.draft_status ? ` (상태 ${data.draft_status})` : ""}` };
    return { ok: false, message: data ? `알 수 없는 응답(${st || "상태 없음"})` : "서버 응답이 비어 있어요" };
  }

  // ── 데이터 ───────────────────────────────────────────────────────────────
  const S = { sb: null, me: null, drafts: [], loadError: null, loadedAt: null };

  async function preview(draftId) {
    const { data, error } = await S.sb.rpc(PREVIEW_RPC, draftId ? { p_draft_id: draftId, p_include_finished: true } : { p_draft_id: null, p_include_finished: true });
    if (error) throw new Error(error.message || error.code || "미리보기 실패");
    return (data && data.drafts) || [];
  }

  async function refreshState() {
    S.loadError = null;
    try { S.drafts = await preview(null); } catch (e) { S.loadError = e.message || String(e); S.drafts = []; }
    S.loadedAt = new Date().toISOString();
  }

  function cardHtml(d) {
    const act = actionState(d, { isApprover: !!(S.me && S.me.approver) });
    const rows = detailRows(d).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
    const events = (d.events || []).map(e => `${esc(fmtKst(e.at))} ${esc(STATUS_TEXT[e.from] || e.from || "생성")} → ${esc(STATUS_TEXT[e.to] || e.to)}${e.by_approver ? " (승인자)" : ""}${e.note ? ` · ${esc(e.note)}` : ""}`).join("<br>");
    const pending = d.status === "PENDING_APPROVAL";
    return `<div class="card sma-row" data-draft="${esc(d.id)}">
      <h3 style="margin:0 0 8px">${esc(KIND_TEXT[d.mail_kind] || d.mail_kind)} <small class="rg-muted">→ ${esc(d.recipient)}</small>
        ${UI().badge(pending ? "info" : "excluded", { text: STATUS_TEXT[d.status] || d.status })}</h3>
      <table class="rg-detail"><tbody>${rows}</tbody></table>
      <div style="margin-top:8px"><div class="rg-muted" style="font-size:12px;margin-bottom:4px">본문 전체(이대로 보내요)</div>${bodyHtml(d)}</div>
      ${events ? `<details style="margin-top:6px"><summary class="rg-muted" style="font-size:12px">감사 이력</summary><div style="font-size:12px">${events}</div></details>` : ""}
      ${pending ? `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" data-erp-key="sma-approve-${esc(d.id)}" ${act.enabled ? "" : "disabled"} title="${esc(act.why)}" onclick="SupplierMailApproval.approve('${esc(d.id)}')">발송 승인</button>
        <button class="btn sm danger" data-erp-key="sma-reject-${esc(d.id)}" ${act.enabled || (S.me && S.me.approver && !d.expired) ? "" : "disabled"} onclick="SupplierMailApproval.reject('${esc(d.id)}')">거부</button>
        ${act.enabled ? "" : `<div class="rg-muted" style="font-size:12px">${esc(act.why)}</div>`}</div>` : ""}</div>`;
  }

  function pageHtml() {
    const head = `<div class="card"><h2 style="margin:0 0 6px">✉️ ${TITLE}</h2>
      <p class="rg-muted" style="margin:0">서버 규칙상 승인이 필요한 공급처로 나가는 메일은 자동으로 나가지 않아요. 아래 초안의 <b>수신자·제목·본문 전체·첨부</b>를 확인하고
      <b>[발송 승인]</b>을 눌러야 발송 러너가 그 내용 그대로 1번 보내요. 승인 뒤 내용이 바뀌면 승인이 무효가 되고 새 초안이 올라와요. 이 화면은 메일을 보내지 않아요.</p>
      <p class="rg-muted" style="margin:6px 0 0;font-size:12px">서버 상태 읽음 ${esc(fmtKst(S.loadedAt))}
        <button class="btn sm secondary" data-erp-key="sma-reload" onclick="SupplierMailApproval.reload()">새로고침</button></p></div>`;
    if (S.loadError) return head + `<div class="card" style="border:2px solid var(--red)"><b>불러오지 못했어요</b><p class="rg-muted">${esc(S.loadError)}</p></div>`;
    const pending = S.drafts.filter(d => d.status === "PENDING_APPROVAL");
    const others = S.drafts.filter(d => d.status !== "PENDING_APPROVAL").slice(0, 30);
    const list = pending.length ? pending.map(cardHtml).join("") : `<div class="card rg-muted">승인 대기 중인 공급처 메일 초안이 없어요.</div>`;
    const done = others.length ? `<h3 style="margin:16px 0 8px">최근 초안(승인됨·발송·거부·무효 등)</h3>${others.map(cardHtml).join("")}` : "";
    return head + list + done;
  }

  async function view(sb, me) {
    S.sb = sb; S.me = me;
    if (!(me && me.approver)) {
      return `<div class="card"><h2>✉️ ${TITLE}</h2><p>승인 권한자만 볼 수 있는 화면이에요.</p></div>`;
    }
    await refreshState();
    return pageHtml();
  }

  function rerender() {
    const el = root.document && root.document.getElementById("content");
    if (el && String((root.location || {}).hash || "").startsWith(`#/${ROUTE}`)) el.innerHTML = pageHtml();
  }
  async function reload() { await refreshState(); rerender(); }

  async function freshOne(draftId) {
    const list = await preview(draftId);
    return list.find(d => d.id === draftId) || null;
  }

  function approve(draftId) {
    let d = null;
    return UI().run({
      key: `sma-approve-${draftId}`, allowed: !!(S.me && S.me.approver),
      deniedText: "승인 권한자만 처리할 수 있어요 - 읽기 전용이에요",
      precheck: async () => {
        try { d = await freshOne(draftId); } catch (e) { return { ok: false, message: e.message || String(e) }; }
        await refreshState(); rerender();
        const a = actionState(d, { isApprover: true });
        return a.enabled ? { ok: true } : { ok: false, message: a.why };
      },
      confirm: () => ({
        title: "공급처 메일 발송 승인", actionLabel: "이 내용으로 발송 승인",
        rows: [...detailRows(d), ["본문 전체", bodyHtml(d)]],
        notes: ["승인하면 다음 발송 실행이 <b>위 수신자에게 위 제목·본문·첨부 그대로 정확히 1번</b> 보내요(이 화면은 보내지 않아요).",
                "승인 뒤 내용이 바뀌면 승인이 무효가 되고 새 초안으로 다시 승인받아야 해요.",
                "결과가 불명확하면 자동으로 다시 보내지 않고 사람 확인으로 남겨요."],
        reason: { label: "승인 메모(선택)", required: false, minLength: 0, placeholder: "예) 수량·출고일 문구 확인" },
      }),
      exec: async note => {
        const { data, error } = await S.sb.rpc(APPROVE_RPC, { p_draft_id: draftId, p_expected_fingerprint: d.content_fingerprint, p_note: note || null });
        const r = interpretRpc(data, error);
        return { ok: r.ok, message: r.message, data };
      },
      successText: res => interpretRpc(res.data, null).message,
      refresh: reload,
    });
  }

  function reject(draftId) {
    let d = null;
    return UI().run({
      key: `sma-reject-${draftId}`, allowed: !!(S.me && S.me.approver),
      deniedText: "승인 권한자만 처리할 수 있어요 - 읽기 전용이에요",
      precheck: async () => {
        try { d = await freshOne(draftId); } catch (e) { return { ok: false, message: e.message || String(e) }; }
        await refreshState(); rerender();
        return d && ["PENDING_APPROVAL", "APPROVED"].includes(d.status) ? { ok: true } : { ok: false, message: "거부할 수 없는 상태예요" };
      },
      confirm: () => ({
        title: "공급처 메일 발송 거부", actionLabel: "거부", danger: true,
        rows: detailRows(d),
        notes: ["거부하면 이 내용으로는 보내지 않아요(SMTP 0).", "첫 재입고 문의는 발송 전 취소로 정리돼요 - 필요하면 다음 주기가 새 문의·새 초안을 만들어요."],
        reason: { label: "거부 사유", required: true, minLength: 5, placeholder: "예) 수량 문구 수정 필요" },
      }),
      exec: async reason => {
        const { data, error } = await S.sb.rpc(REJECT_RPC, { p_draft_id: draftId, p_note: reason });
        const r = interpretRpc(data, error);
        return { ok: r.ok, message: r.message, data };
      },
      successText: res => interpretRpc(res.data, null).message,
      refresh: reload,
    });
  }

  root.SupplierMailApproval = { ROUTE, TITLE, view, reload, approve, reject, actionState, detailRows, contextRows, interpretRpc, _state: S };
})(typeof window !== "undefined" ? window : globalThis);
