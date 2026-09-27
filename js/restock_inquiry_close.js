/* 재입고 문의 테스트 종료 - 2026-09-27 [대표 지시]
   이미 공급처에 보낸(SENT/REPLIED) 재입고 문의가 테스트였을 때, 그 문의와 기다리는 공급처 수량 재확인을 함께 닫는 승인자 전용 화면이에요.
   닫으면 예약 파이프라인(후보 준비·보조 매칭)이 이 문의를 더는 보지 않아서 같은 재확인이 다시 생기지 않아요.
   - 버튼은 서버 함수 1번(fn_close_restock_inquiry_as_test) - 사용자 ID 를 보내지 않아요(서버가 로그인 세션으로 승인자 확인).
   - 누르기 직전 서버 미리보기(fn_preview_restock_inquiry_test_close)를 다시 읽어 상태 지문을 받고, 서버는 그 지문이 지금과 같을 때만 닫아요.
   - 이미 보낸 메일은 지우지 않고, 공급처에 새 메일(정정·사과)도 보내지 않아요. WING 호출도 없어요.
   - 진행 중 후보·WING 제출·발송 중 메일이 있으면 서버가 막아요(후보는 [재입고 후보 승인]에서 먼저 거절, 제출은 [재입고 WING 복구]에서 취소). */
(function (root) {
  "use strict";

  const ROUTE = "restockinquiryclose";
  const TITLE = "재입고 문의 테스트 종료";
  const PREVIEW_RPC = "fn_preview_restock_inquiry_test_close";
  const CLOSE_RPC = "fn_close_restock_inquiry_as_test";
  const UI = () => root.ErpUi;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => (n === null || n === undefined || n === "") ? "—" : Number(n).toLocaleString("ko-KR");
  const fmtKst = ts => {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false }).slice(0, 16);
  };

  const REASON_TEXT = {
    INQUIRY_NOT_FOUND: "문의를 찾지 못했어요",
    NOT_RESTOCK_INQUIRY: "재입고 문의가 아니에요(물류정보 문의는 이 화면 대상 아님)",
    RECONFIRM_MAIL_IN_FLIGHT: "재확인 메일을 보내는 중이거나 결과를 모르는 메일이 있어요 - 결과가 정해진 뒤에 닫을 수 있어요",
    ACTIVE_CANDIDATE: "진행 중인 WING 후보가 있어요 - [재입고 후보 승인]에서 먼저 거절해 주세요",
    ACTIVE_WING_SUBMISSION: "WING 에 낸 입고신청이 살아 있어요 - [재입고 WING 복구]에서 먼저 취소해 주세요",
  };
  const reasonText = code => {
    const c = String(code);
    if (c.startsWith("INQUIRY_NOT_ACTIVE:")) return `이미 닫혔거나 아직 보내지 않은 문의예요(상태 ${c.slice(19)}) (${c})`;
    return REASON_TEXT[c] ? `${REASON_TEXT[c]} (${c})` : c;
  };

  // ── 순수 함수(테스트 대상) ────────────────────────────────────────────────
  /** 미리보기 한 건 → { enabled, why }. 최종 판단은 서버. */
  function actionState(entry, ctx = {}) {
    if (!ctx.isApprover) return { enabled: false, why: "승인 권한자만" };
    if (!entry || !entry.inquiry) return { enabled: false, why: "문의를 찾지 못했어요" };
    if (entry.closure) return { enabled: false, why: `이미 종료됨(${fmtKst(entry.closure.closed_at)})` };
    const b = entry.blockers || [];
    if (b.length) return { enabled: false, why: b.map(reasonText).join(" · ") };
    if (!entry.fingerprint) return { enabled: false, why: "서버 상태 지문이 없어요" };
    return { enabled: true, why: "" };
  }

  function summary(entry) {
    const rcs = entry.reconfirmations || [], ms = entry.reconfirmation_mails || [];
    return {
      pendingReconfirmations: rcs.filter(r => r.status === "PENDING_SUPPLIER_CONFIRMATION").length,
      sentMails: ms.filter(m => m.status === "SENT").length,
      activeItems: (entry.items || []).filter(i => !["CANCELLED", "EXPIRED", "REJECTED", "CONFIRMED"].includes(i.status)).length,
    };
  }

  function interpretRpc(data, error) {
    if (error) return { ok: false, message: error.message || error.code || String(error) };
    const st = data && data.status;
    if (st === "CLOSED") {
      return { ok: true, message: `종료했어요 - 재확인 ${num(data.reconfirmations_cancelled)}건·문의 줄 ${num(data.items_cancelled)}건 닫음 · 보낸 메일 ${num(data.mails_preserved)}통은 기록 그대로` };
    }
    if (st === "ALREADY_CLOSED") return { ok: true, message: "이미 종료된 문의예요(변경 없음)" };
    if (st === "STALE_STATE") return { ok: false, message: "그 사이 서버 상태가 바뀌었어요 - 아무것도 바꾸지 않았어요. 다시 확인한 뒤 눌러 주세요" };
    if (st === "BLOCKED") return { ok: false, message: (data.reasons || []).map(reasonText).join(" · ") || "서버가 거부했어요" };
    return { ok: false, message: data ? `알 수 없는 응답(${st || "상태 없음"})` : "서버 응답이 비어 있어요" };
  }

  // ── 데이터 ───────────────────────────────────────────────────────────────
  const S = { sb: null, me: null, list: [], closures: [], loadError: null, loadedAt: null };

  async function preview(inquiryId) {
    const { data, error } = await S.sb.rpc(PREVIEW_RPC, inquiryId ? { p_inquiry_id: inquiryId } : {});
    if (error) throw new Error(error.message || error.code || "미리보기 실패");
    return data || {};
  }

  async function refreshState() {
    S.loadError = null;
    try {
      const d = await preview(null);
      S.list = d.inquiries || []; S.closures = d.recent_closures || [];
    } catch (e) { S.loadError = e.message || String(e); S.list = []; S.closures = []; }
    S.loadedAt = new Date().toISOString();
  }

  function detailRows(entry) {
    const inq = entry.inquiry || {};
    const items = (entry.items || []).map(i => `${esc(i.product_name)} · ${num(i.quantity)}${esc(i.unit)} · <small>${esc(i.status)}</small>`).join("<br>") || "—";
    const rcs = (entry.reconfirmations || []).map(r => `<code>${esc(String(r.id).slice(0, 8))}</code> ${esc(r.status)} · ${num(r.original_ea)}EA → ${num(r.revised_ea)}EA`).join("<br>") || "없음";
    const ms = (entry.reconfirmation_mails || []).map(m => `<code>${esc(String(m.id).slice(0, 8))}</code> ${esc(m.status)}${m.sent_at ? ` · 보냄 ${esc(fmtKst(m.sent_at))}` : ""}`).join("<br>") || "없음";
    const cands = (entry.candidates || []).map(c => `<code>${esc(String(c.id).slice(0, 8))}</code> ${esc(c.status)}${c.wing_cancelled ? " · WING 취소 확인" : ""}`).join("<br>") || "없음";
    return [
      ["공급처", esc(inq.supplier_name || "—")],
      ["제목", esc(inq.subject || "—")],
      ["문의 상태", `${esc(inq.status || "—")} · 보낸 시각 ${esc(fmtKst(inq.sent_at))}`],
      ["문의 줄", items],
      ["수량 재확인", rcs],
      ["재확인 메일", ms],
      ["WING 후보", cands],
      ["문의 ID", `<code>${esc(entry.inquiry_id)}</code>`],
    ];
  }

  function cardHtml(entry) {
    const inq = entry.inquiry || {};
    const act = actionState(entry, { isApprover: !!(S.me && S.me.approver) });
    const sm = summary(entry);
    const rows = detailRows(entry).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
    return `<div class="card ric-row" data-inquiry="${esc(entry.inquiry_id)}">
      <h3 style="margin:0 0 8px">${esc(inq.supplier_name || "공급처")} <small class="rg-muted">${esc(fmtKst(inq.sent_at))} 보냄</small>
        ${inq.is_rehearsal ? UI().badge("info", { text: "리허설" }) : ""}
        ${entry.closure ? UI().badge("excluded", { text: "종료됨" }) : ""}</h3>
      <table class="rg-detail"><tbody>${rows}</tbody></table>
      <p class="rg-muted" style="margin:8px 0 0;font-size:12px">닫으면: 대기 재확인 ${num(sm.pendingReconfirmations)}건·문의 줄 ${num(sm.activeItems)}건을 닫아요.
        보낸 메일 ${num(sm.sentMails)}통은 기록 그대로 두고, 공급처에 새 메일은 보내지 않아요.</p>
      <div style="margin-top:10px"><button class="btn sm danger" data-erp-key="ric-close-${esc(entry.inquiry_id)}" ${act.enabled ? "" : "disabled"}
        title="${esc(act.why)}" onclick="RestockInquiryClose.close('${esc(entry.inquiry_id)}')">테스트로 종료</button>
        ${act.enabled ? "" : `<div class="rg-muted" style="font-size:12px">${esc(act.why)}</div>`}</div></div>`;
  }

  function closureHtml(entry) {
    const inq = entry.inquiry || {}, c = entry.closure || {};
    return `<tr><td>${esc(fmtKst(c.closed_at))}</td><td>${esc(inq.supplier_name || "—")}</td><td>${esc(inq.subject || "—")}</td>
      <td>${esc(c.reason || "")}</td><td><code>${esc(String(entry.inquiry_id).slice(0, 8))}</code></td></tr>`;
  }

  function pageHtml() {
    const head = `<div class="card"><h2 style="margin:0 0 6px">🧹 ${TITLE}</h2>
      <p class="rg-muted" style="margin:0">공급처에 이미 보낸 재입고 문의가 <b>테스트</b>였을 때 문의와 기다리는 수량 재확인을 함께 닫아요.
      닫으면 예약 파이프라인이 이 문의로 재확인·후보를 다시 만들지 않아요. <b>이미 보낸 메일은 지우지 않고, 공급처에 정정·사과 메일도 보내지 않아요.</b> WING 호출 없음.</p>
      <p class="rg-muted" style="margin:6px 0 0;font-size:12px">서버 상태 읽음 ${esc(fmtKst(S.loadedAt))}
        <button class="btn sm secondary" data-erp-key="ric-reload" onclick="RestockInquiryClose.reload()">새로고침</button></p></div>`;
    if (S.loadError) return head + `<div class="card" style="border:2px solid var(--red)"><b>불러오지 못했어요</b><p class="rg-muted">${esc(S.loadError)}</p></div>`;
    const active = S.list.length ? S.list.map(cardHtml).join("") : `<div class="card rg-muted">보낸 뒤 열려 있는 재입고 문의가 없어요.</div>`;
    const done = S.closures.length ? `<div class="card"><h3 style="margin:0 0 8px">최근 테스트 종료</h3><table class="rg-detail"><thead><tr><th>종료</th><th>공급처</th><th>제목</th><th>사유</th><th>문의</th></tr></thead>
      <tbody>${S.closures.map(closureHtml).join("")}</tbody></table></div>` : "";
    return head + active + done;
  }

  async function view(sb, me) {
    S.sb = sb; S.me = me;
    if (!(me && me.approver)) {
      return `<div class="card"><h2>🧹 ${TITLE}</h2><p>승인 권한자만 볼 수 있는 화면이에요.</p></div>`;
    }
    await refreshState();
    return pageHtml();
  }

  function rerender() {
    const el = root.document && root.document.getElementById("content");
    if (el && String((root.location || {}).hash || "").startsWith(`#/${ROUTE}`)) el.innerHTML = pageHtml();
  }
  async function reload() { await refreshState(); rerender(); }

  function close(inquiryId) {
    let entry = null;
    return UI().run({
      key: `ric-close-${inquiryId}`, allowed: !!(S.me && S.me.approver),
      deniedText: "승인 권한자만 처리할 수 있어요 - 읽기 전용이에요",
      precheck: async () => {
        try { entry = await preview(inquiryId); } catch (e) { return { ok: false, message: e.message || String(e) }; }
        await refreshState(); rerender();
        const a = actionState(entry, { isApprover: true });
        return a.enabled ? { ok: true } : { ok: false, message: a.why };
      },
      confirm: () => ({
        title: "재입고 문의 테스트 종료", actionLabel: "테스트로 종료", danger: true,
        rows: detailRows(entry),
        notes: ["문의·문의 줄·기다리는 수량 재확인을 <b>종료(CANCELLED)</b>로 닫아요. 되돌리는 버튼은 없어요.",
                "이미 보낸 메일은 기록 그대로 둬요. 공급처에 정정·사과 메일은 보내지 않아요(필요하면 직접 연락).",
                "닫은 뒤에는 예약 파이프라인이 이 문의로 재확인·후보를 만들지 않아요. 공급처가 늦게 답장해도 자동 처리하지 않아요.",
                "서버가 지금 상태가 방금 확인한 것과 같을 때만 닫아요(달라졌으면 아무것도 안 바꿔요)."],
        reason: { label: "종료 사유", required: true, minLength: 5, placeholder: "예) 테스트 문의였음 - 대표 지시로 종료" },
      }),
      exec: async reason => {
        const { data, error } = await S.sb.rpc(CLOSE_RPC, { p_inquiry_id: inquiryId, p_expected_fingerprint: entry.fingerprint, p_reason: reason });
        const r = interpretRpc(data, error);
        return { ok: r.ok, message: r.message, data };
      },
      successText: res => interpretRpc(res.data, null).message,
      refresh: reload,
    });
  }

  root.RestockInquiryClose = { ROUTE, TITLE, view, reload, close, actionState, summary, interpretRpc, reasonText, _state: S };
})(typeof window !== "undefined" ? window : globalThis);
