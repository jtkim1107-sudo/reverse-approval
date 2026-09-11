/* cs_inquiries.js
 * -------------------------------------------------------------------------
 * 2026-09-11 고객문의: GCP 가 수집·AI 분석·답변 초안까지 만들어 두면, ERP 가 그것을 보여주고 알려요.
 * 사용자 지시: "AI 답변을 쿠팡에 자동 전송하지 마", "새 문의가 없다는 것과 수집 실패를 구분".
 *
 *   · 읽는 곳: coupang_cs(문의 원본) · cs_inquiry_insights(분석·초안·처리 상태) ·
 *             sync_job_status 'cs_inquiry_collect'(수집 성공/실패)
 *   · 쓰는 곳: cs_inquiry_insights 의 처리 상태만(확인 완료 / WING 에서 답변함). DB 가 그 열만 허용해요.
 *   · 쿠팡으로 보내는 버튼은 없습니다. 초안 복사 + WING 문의 화면 바로가기만 제공해요.
 *   · 이 파일에는 키·쿠키가 없어요.
 */
(function (global) {
  "use strict";

  // WING 화면 캡처에서 확인한 실제 메뉴 경로(추측한 주소 아님)
  const WING_LINKS = {
    product_qna: "https://wing.coupang.com/tenants/cs/product/inquiries",
    callcenter: "https://wing.coupang.com/tenants/cs/csinquiry",
  };
  const TYPE_LABEL = { DELIVERY: "배송", STOCK: "재고", SPEC: "사양", DEFECT: "불량·파손", RETURN: "반품·교환",
    USAGE: "사용법", UNKNOWN: "기타" };
  const URGENCY = { HIGH: ["긴급", "rejected"], MEDIUM: ["보통", "progress"], LOW: ["낮음", "waiting"] };
  const SENTIMENT = { NEGATIVE: ["부정", "rejected"], NEUTRAL: ["중립", "waiting"], POSITIVE: ["긍정", "approved"] };
  const REVIEW = { NEW: ["새 문의", "rejected"], ACKNOWLEDGED: ["확인 완료", "progress"], ANSWERED: ["답변함", "approved"] };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const chip = ([label, tone]) => `<span class="chip ${tone}">${esc(label)}</span>`;
  const keyOf = (r) => `${r.source}|${r.inquiry_id}`;

  function kst(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return String(ts);
    return `${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false }).format(d)} KST`;
  }
  // 쿠팡 문의 시각은 KST 문자열("2026-09-11 09:12:00")로 와요.
  function hoursSince(inquiryAt, now = Date.now()) {
    if (!inquiryAt) return null;
    const s = String(inquiryAt).replace(" ", "T");
    const t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}+09:00`).getTime();
    return Number.isFinite(t) ? Math.max(0, (now - t) / 3600000) : null;
  }

  /* 원본 + 분석을 합쳐 화면용 행으로. 미처리 = 미답변이면서 처리 상태가 NEW(또는 아직 분석 전). */
  function merge(csRows, insights) {
    const byKey = new Map((insights || []).map((i) => [keyOf(i), i]));
    return (csRows || []).map((r) => {
      const ins = byKey.get(keyOf(r)) || null;
      const answered = r.status === "answered" || ins?.review_status === "ANSWERED";
      const review = answered ? "ANSWERED" : (ins?.review_status || "NEW");
      return { ...r, insight: ins, review, answered, pending: !answered && review === "NEW" };
    });
  }

  function summary(rows, now = Date.now()) {
    const open = rows.filter((r) => !r.answered);
    const cc = open.filter((r) => r.source === "callcenter");
    const oldest = open.reduce((m, r) => Math.max(m, hoursSince(r.inquiry_at, now) || 0), 0);
    return { total: rows.length, unanswered: open.length, pending: rows.filter((r) => r.pending).length,
      urgent: open.filter((r) => r.insight?.urgency === "HIGH").length,
      callcenterDue: cc.filter((r) => (hoursSince(r.inquiry_at, now) || 0) >= 12).length, oldestHours: Math.round(oldest) };
  }

  /* 수집 상태 - "새 문의 없음"과 "수집 실패"를 구분해요. */
  function statusInfo(st, now = Date.now()) {
    if (st === undefined) return { state: "UNKNOWN", text: "수집 상태를 확인할 수 없습니다(상태 표를 읽지 못함). 아래 목록이 최신인지 보장할 수 없어요." };
    if (!st) return { state: "NONE", text: "고객문의 자동수집 기록이 아직 없습니다. 첫 수집 뒤에 표시돼요." };
    const okAt = st.last_success_at ? new Date(st.last_success_at).getTime() : 0;
    const tryAt = st.last_attempt_at ? new Date(st.last_attempt_at).getTime() : 0;
    const d = st.detail || {};
    if (st.last_error && tryAt > okAt) {
      return { state: "FAILED", text: `수집 실패 (${kst(st.last_attempt_at)}) — ${String(st.last_error).slice(0, 120)}.
        아래 문의·초안은 마지막 정상 수집(${st.last_success_at ? kst(st.last_success_at) : "없음"}) 기준이며 지우지 않았어요.` };
    }
    const stale = now - okAt > 3 * 3600000;
    const range = Array.isArray(d.range) ? `${d.range[0]}~${d.range[1]}` : "";
    const found = Number(d.found || 0);
    const body = found === 0 ? "쿠팡에 문의가 없습니다(조회 성공 · 0건)" : `문의 ${found}건 확인 · 미답변 ${d.unanswered ?? "?"}건`;
    return { state: stale ? "STALE" : "OK",
      text: `수집 정상 · 마지막 확인 ${kst(st.last_success_at)} · ${body}${range ? ` · 조회 범위 ${range}` : ""}
        · 분류·초안 ${d.ai_backend === "claude_api" ? `AI(외부 호출 ${d.ai_calls ?? "?"}건)` : "규칙 기반(외부 AI 호출 없음)"}${stale ? " · 3시간 넘게 확인이 없어요" : ""}` };
  }

  function bannerHtml(info) {
    const tone = info.state === "OK" ? "var(--green)" : info.state === "FAILED" ? "var(--red)" : "var(--amber)";
    return `<div class="card cs-banner" style="border-left:4px solid ${tone};padding:10px 14px;margin-bottom:12px">
      <b style="font-size:13px">${info.state === "OK" ? "고객문의 자동수집 정상" : info.state === "FAILED" ? "고객문의 수집 실패" : "고객문의 수집 확인 필요"}</b>
      <div style="font-size:12.5px;color:var(--text-sub);margin-top:4px">${esc(info.text)}</div></div>`;
  }

  function cardHtml(r, now = Date.now()) {
    const ins = r.insight;
    const age = hoursSince(r.inquiry_at, now);
    const ccLeft = r.source === "callcenter" && !r.answered && age != null ? Math.max(0, 24 - age) : null;
    const facts = ins?.facts_used && typeof ins.facts_used === "object" ? Object.entries(ins.facts_used) : [];
    const needs = Array.isArray(ins?.needs_check) ? ins.needs_check : [];
    const draft = ins?.draft_answer;
    const k = esc(keyOf(r));
    return `
      <div class="cs-item" data-key="${k}" style="border-top:1px solid var(--line);padding:12px 0">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
          ${chip(REVIEW[r.review] || ["?", "waiting"])}
          ${chip([r.answered ? "답변완료" : "미답변", r.answered ? "approved" : "waiting"])}
          <span class="chip progress">${r.source === "callcenter" ? "콜센터" : "상품 Q&A"}</span>
          ${ins?.inquiry_type && ins.draft_source !== "ai" ? `<span style="font-size:11.5px;color:var(--text-sub)">규칙 기반 분류:</span>` : ""}
          ${ins?.inquiry_type ? chip([TYPE_LABEL[ins.inquiry_type] || ins.inquiry_type, "mine"]) : ""}
          ${ins?.urgency ? chip(URGENCY[ins.urgency]) : ""}
          ${ins?.sentiment ? chip(SENTIMENT[ins.sentiment]) : ""}
          <span style="font-size:12px;color:var(--text-sub)">${esc(String(r.inquiry_at || "").slice(0, 16))}${age != null ? ` · ${Math.round(age)}시간 전` : ""}</span>
          <span style="font-size:12px;color:var(--text-sub)">${esc(r.product_name || ins?.facts_used?.["상품명"] || r.vendor_item_id || "")}</span>
        </div>
        ${ccLeft != null ? `<div style="font-size:12px;color:var(--red);margin-bottom:4px">콜센터 문의 - 약 ${Math.round(ccLeft)}시간 안에 답하지 않으면 쿠팡이 자동 답변 처리해요</div>` : ""}
        ${ins?.summary ? `<div style="font-size:12.5px;color:var(--text-sub);margin-bottom:2px">요약: ${esc(ins.summary)}</div>` : ""}
        <div style="font-size:13.5px;white-space:pre-wrap">${esc(r.content || "")}</div>
        ${draft ? `
        <div class="cs-draft" style="margin-top:8px;background:var(--gray-bg);border-radius:8px;padding:10px 12px">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">
            <b style="font-size:12.5px">${ins.draft_source === "ai" ? "AI 답변 초안" : "규칙 기반 초안"}${ins.draft_source === "ai" && ins.ai_model ? ` <small class="cs-sub">(${esc(ins.ai_model)})</small>` : ""}</b>
            <span class="cs-sub" style="font-size:11.5px">쿠팡으로 자동 전송하지 않아요 · 검토 후 WING 에서 직접 등록</span>
          </div>
          <div class="cs-draft-text" style="font-size:13px;white-space:pre-wrap;margin-top:6px">${esc(draft)}</div>
          ${needs.length ? `<div style="font-size:12px;color:var(--amber);margin-top:6px">확인 필요: ${needs.map(esc).join(" · ")}</div>` : ""}
          ${facts.length ? `<div style="font-size:11.5px;color:var(--text-sub);margin-top:4px">근거 사실: ${facts.map(([a, b]) => `${esc(a)} ${esc(b)}`).join(" · ")}</div>` : ""}
          ${ins.analysis_note ? `<div style="font-size:11.5px;color:var(--text-sub);margin-top:2px">${esc(ins.analysis_note)}</div>` : ""}
        </div>` : (!r.answered ? `<div style="font-size:12px;color:var(--text-sub);margin-top:6px">답변 초안이 아직 없어요(다음 수집 때 분석돼요).</div>` : "")}
        ${!r.answered ? `
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
          ${draft ? `<button type="button" class="btn sm secondary" onclick="CsInquiries.copyDraft('${k}')">초안 복사</button>` : ""}
          <a class="btn sm secondary" href="${WING_LINKS[r.source] || WING_LINKS.product_qna}" target="_blank" rel="noopener noreferrer">WING 문의 화면 열기</a>
          ${ins && r.review === "NEW" ? `<button type="button" class="btn sm secondary" onclick="CsInquiries.setStatus('${k}','ACKNOWLEDGED')">확인 완료</button>` : ""}
          ${ins ? `<button type="button" class="btn sm" onclick="CsInquiries.setStatus('${k}','ANSWERED')">WING 에서 답변함</button>` : ""}
        </div>` : ""}
      </div>`;
  }

  let lastRows = [];
  let userName = "";              // app.js 의 me 는 let 이라 window 에 없어서 화면이 넘겨줘요
  function setUser(name) { userName = name || ""; }

  function tabHtml({ rows, statusRow, insightsError, now = Date.now() }) {
    lastRows = rows;
    const info = statusInfo(statusRow, now);
    const s = summary(rows, now);
    const open = rows.filter((r) => !r.answered)
      .sort((a, b) => (b.pending - a.pending) || ((b.insight?.urgency === "HIGH") - (a.insight?.urgency === "HIGH"))
        || String(a.inquiry_at).localeCompare(String(b.inquiry_at)));
    const done = rows.filter((r) => r.answered);
    const insNote = insightsError ? `<div class="card" style="border-left:4px solid var(--amber);padding:10px 14px;margin-bottom:12px;font-size:12.5px">
      AI 분석·답변 초안을 불러오지 못했어요(${esc(String(insightsError.message || insightsError).slice(0, 80))}). 문의 원본만 보여줍니다.</div>` : "";
    if (!rows.length) {
      return `${bannerHtml(info)}${insNote}
        <div class="card"><div class="card-head"><h2>고객문의</h2></div>
          <p class="empty">${info.state === "OK" ? "새 문의가 없습니다." : "표시할 문의가 없습니다."}</p>
          <p style="font-size:12.5px;color:var(--text-sub)">${info.state === "OK"
            ? "위 수집 상태처럼 쿠팡 조회는 정상이고, 조회 범위에 문의가 0건이에요."
            : "수집이 정상이 아니면 이 0건은 \"문의가 없다\"는 뜻이 아니라 \"확인하지 못했다\"는 뜻이에요."}
            새 문의가 들어오면 GCP 가 매시 40분에 가져와 규칙으로 분류하고 규칙 기반 초안을 만들어 여기와 사이드바에 알려요.
            쿠팡으로 답변을 자동 전송하지 않습니다.</p></div>`;
    }
    return `${bannerHtml(info)}${insNote}
      <div class="grid-stats">
        <div class="stat"><div class="stat-label">새 문의(미확인)</div><div class="stat-value ${s.pending ? "red" : ""}">${s.pending}건</div></div>
        <div class="stat"><div class="stat-label">미답변</div><div class="stat-value ${s.unanswered ? "amber" : ""}">${s.unanswered}건</div></div>
        <div class="stat"><div class="stat-label">긴급</div><div class="stat-value ${s.urgent ? "red" : ""}">${s.urgent}건</div></div>
        <div class="stat"><div class="stat-label">답변완료</div><div class="stat-value">${done.length}건</div></div>
      </div>
      ${open.length ? `<div class="card"><div class="card-head"><h2>미답변 문의 ${open.length}건</h2>
        <span style="font-size:12px;color:var(--text-sub)">초안은 검토용이에요 - 쿠팡으로 자동 전송하지 않습니다</span></div>
        ${open.map((r) => cardHtml(r, now)).join("")}</div>` : ""}
      ${done.length ? `<div class="card"><div class="card-head"><h2>답변완료 ${done.length}건</h2></div>
        ${done.slice(0, 50).map((r) => cardHtml(r, now)).join("")}</div>` : ""}`;
  }

  /* 사이드바·대시보드·브리핑이 같은 숫자를 쓰도록 한 곳에서 읽어요. 실패하면 null(0 으로 보이지 않게). */
  async function load(sb) {
    const [cs, ins, st] = await Promise.all([
      sb.from("coupang_cs").select("source,inquiry_id,vendor_item_id,product_name,content,status,inquiry_at,answered_at")
        .order("inquiry_at", { ascending: false }).limit(2000),
      sb.from("cs_inquiry_insights").select("source,inquiry_id,inquiry_type,urgency,sentiment,summary,draft_answer,draft_source,ai_model,facts_used,needs_check,analysis_note,review_status,reviewed_by,reviewed_at,answered_source,analyzed_at").limit(2000),
      sb.from("sync_job_status").select("*").eq("job_name", "cs_inquiry_collect").maybeSingle(),
    ]);
    if (cs.error) return { error: cs.error };
    return { rows: merge(cs.data || [], ins.error ? [] : ins.data), insightsError: ins.error || null,
      statusRow: st.error ? undefined : (st.data || null) };
  }

  function briefingLineHtml(data) {
    if (!data) return "";
    if (data.error) return `<div class="cs-brief" style="font-size:12.5px;color:var(--amber);margin-top:10px">고객문의를 불러오지 못했어요 - 고객문의 탭에서 확인하세요.</div>`;
    const info = statusInfo(data.statusRow);
    const s = summary(data.rows);
    const failed = info.state !== "OK";
    return `<div class="cs-brief" style="font-size:13px;margin-top:10px;padding-top:8px;border-top:1px dashed var(--line)">
      💬 고객문의: ${s.unanswered || s.pending ? `<b style="color:var(--red)">새 문의 ${s.pending}건 · 미답변 ${s.unanswered}건</b>${s.urgent ? ` · 긴급 ${s.urgent}건` : ""}${s.unanswered ? ` · 가장 오래된 미답변 ${s.oldestHours}시간` : ""}`
        : "새 문의·미답변 없음"}${failed ? ` <span style="color:var(--amber)">(수집 상태 확인 필요)</span>` : ""}
      <a onclick="location.hash='#/voc/inquiries'" style="color:var(--brand);cursor:pointer;margin-left:6px">고객문의 보기 →</a></div>`;
  }

  function dashboardAlertHtml(data) {
    if (!data || data.error) return "";
    const s = summary(data.rows);
    const info = statusInfo(data.statusRow);
    if (!s.pending && !s.unanswered && info.state === "OK") return "";
    return `<div class="card cs-alert" style="border-left:4px solid ${s.pending || s.urgent ? "var(--red)" : "var(--amber)"};padding:10px 14px;cursor:pointer"
      onclick="location.hash='#/voc/inquiries'">
      <b>💬 고객문의</b> ${s.pending ? `새 문의 ${s.pending}건` : ""}${s.unanswered ? ` · 미답변 ${s.unanswered}건` : ""}${s.urgent ? ` · 긴급 ${s.urgent}건` : ""}
      ${s.callcenterDue ? ` · 콜센터 자동답변 임박 ${s.callcenterDue}건` : ""}${info.state !== "OK" ? ` · 수집 확인 필요` : ""}
      <span style="font-size:12px;color:var(--text-sub)"> - ${data.statusRow?.detail?.ai_backend === "claude_api" ? "답변 초안" : "규칙 기반 초안"}을 확인하세요</span></div>`;
  }

  async function copyDraft(key) {
    const r = lastRows.find((x) => keyOf(x) === key);
    const text = r?.insight?.draft_answer || "";
    try {
      await navigator.clipboard.writeText(text);
      if (typeof global.toast === "function") global.toast("답변 초안을 복사했어요 - WING 에서 붙여넣고 확인 후 등록하세요");
    } catch (e) {
      if (typeof global.toast === "function") global.toast("복사하지 못했어요. 초안을 직접 선택해 복사해 주세요");
    }
  }

  async function setStatus(key, status) {
    const r = lastRows.find((x) => keyOf(x) === key);
    if (!r || !["ACKNOWLEDGED", "ANSWERED"].includes(status)) return;
    const sb = global.sb;
    const { error } = await sb.from("cs_inquiry_insights")
      .update({ review_status: status, reviewed_by: userName })
      .eq("source", r.source).eq("inquiry_id", r.inquiry_id);
    if (typeof global.toast === "function") global.toast(error ? "상태를 바꾸지 못했어요" : (status === "ANSWERED" ? "답변함으로 표시했어요" : "확인 완료로 표시했어요"));
    if (typeof global.updateBadge === "function") global.updateBadge();
    if (typeof global.route === "function") await global.route();
  }

  global.CsInquiries = { WING_LINKS, setUser, merge, summary, statusInfo, bannerHtml, cardHtml, tabHtml, load,
    briefingLineHtml, dashboardAlertHtml, copyDraft, setStatus, hoursSince };
})(typeof window !== "undefined" ? window : globalThis);
