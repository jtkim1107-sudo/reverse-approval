/* erp_dashboard.js - ERP 메인 대시보드 화면 부품 (2026-09-13 대시보드 정리)
 * -------------------------------------------------------------------------
 * 숫자를 새로 계산하지 않아요. app.js 가 기존 공통 함수(SalesMonthlySummary · computeCmOfMonth ·
 * adMonthState · /api/inventory/decisions · InboundApproval)로 만든 값을 받아 "모델"로 모으고 그리기만 해요.
 * DB·네트워크 호출이 없고, 쓰기 버튼도 없어요(이동·새로고침·안내 보기만).
 *
 *   statusModel / statusHtml    A. 운영 상태(정상이면 한 줄, 문제면 원인과 이동)
 *   todoModel   / todoHtml      B. 오늘 해야 할 일(0건은 접어서 한 줄)
 *   salesModel  / salesHtml     C. 매출 요약(오늘 또는 최신 확정일) · fitKpis 금액 칸 맞춤(글자 크기·3+2 배치만)
 *   profitModel / profitHtml    D+G. 이번 달 공헌이익 · 광고비(광고비 줄은 한 번만)
 *   stockModel  / stockHtml     E. 재고·발주(위험 상품 5개)
 *   inboundModel/ inboundHtml   F. 입고·운송(가까운 일정부터)
 *   shellHtml / loadingHtml / errorHtml  카드 틀 · 불러오는 중 · 불러오지 못함(마지막 정상값 유지)
 *
 * 상태 색: 정상 초록 · 확인 필요 주황 · 긴급 오류 빨강 · 승인 필요 보라 · 입고대기 파랑 · 정보 없음 회색 -
 * 색만으로 말하지 않고 ErpUi 배지(아이콘 + 문구)를 써요. 기술 코드는 화면에 쓰지 않아요(CODE_TEXT).
 */
(function (root) {
  "use strict";

  const UI = () => root.ErpUi;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TONE_KIND = { ok: "ok", check: "check", error: "error", approval: "approval", awaiting: "awaiting", none: "muted", info: "info" };
  const TONE_RANK = { error: 5, check: 4, approval: 3, awaiting: 2, none: 1, info: 1, ok: 0 };
  const worstTone = tones => (tones.filter(Boolean).sort((a, b) => (TONE_RANK[b] || 0) - (TONE_RANK[a] || 0))[0]) || "ok";

  // 기술 코드 → 사람이 읽는 말(모르는 코드는 코드 대신 '확인 필요')
  const CODE_TEXT = {
    MISSING_PROCUREMENT_DATA: "발주·물류정보 미완성", SESSION_EXPIRED: "WING 로그인 필요", RELOGIN_REQUIRED: "WING 로그인 필요",
    AUTH_BLOCKED: "WING 로그인 필요", DATA_CHECK_NEEDED: "데이터 확인 필요", RECOVERY_NEEDED: "복구 확인 필요",
    PO_OVERDUE: "입고예정일 경과", COLLECTION_BUSY: "다른 수집이 진행 중", PARTIAL_FAILED: "일부 실패", FAILED: "실패",
    UNDETERMINED: "미확정", MAIL_FAILED: "메일 발송 실패", MAIL_SEND_UNKNOWN: "메일 발송 결과 불명", MAIL_SENT_RECORD_FAILED: "발송 기록 실패",
    MAIL_DATA_CHECK_NEEDED: "메일 데이터 확인 필요", MAIL_LEGACY_REVIEW: "예전 요청 메일 확인", NEEDS_REVIEW: "검토 필요",
    VOID_PENDING_REBUILD: "무효 · 재작성 대기", TIMEOUT: "시간 초과", API_ERROR: "외부 API 오류", OTHER: "기타 오류",
  };
  const codeText = code => CODE_TEXT[code] || "확인 필요";
  // 기술 코드가 섞인 문장에서 코드를 사람 말로 바꾸고, 남은 대문자 코드는 지워요.
  const humanize = text => String(text || "")
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, m => CODE_TEXT[m] || "")
    .replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/^[\s:·-]+/, "").trim();

  // 이유 문구에서 제목과 같은 말(코드를 바꾼 결과 포함)을 지워 두 번 쓰지 않아요.
  const reason = (text, title) => {
    let t = humanize(text);
    if (title) t = t.split(title).join("");
    return t.replace(/\(\s*\)/g, "").replace(/^[\s:·-]+|[\s:·-]+$/g, "").replace(/\s{2,}/g, " ").trim();
  };
  const badge = (tone, text, opts = {}) => UI().badge(TONE_KIND[tone] || "muted", { text, small: opts.small, title: opts.title });
  const link = (href, label, opts = {}) =>
    `<a class="dash-link${opts.primary ? " dash-link--primary" : ""}" href="${esc(href)}">${esc(label)} ›</a>`;
  const hm = d => {
    if (!d) return "-";
    const t = d instanceof Date ? d : new Date(d);
    if (isNaN(t)) return "-";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(t).map(x => [x.type, x.value]));
    return `${parts.month}-${parts.day} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
  };
  const md = s => (s ? String(s).slice(5) : "-");

  // 대시보드의 유일한 새로고침 - 지금 API·DB 상태를 다시 읽기만(WING 수집·저장 없음)
  const refreshBtn = `<button type="button" class="btn sm secondary dash-refresh" onclick="dashboardRefresh()" title="지금 저장된 값을 다시 읽어요(WING 수집·저장 없음)">화면 새로고침</button>`;

  // ── 카드 틀 ─────────────────────────────────────────────────────────────
  function shellHtml({ id, title, meta = "", actions = "", body = "", tone = null, cls = "" }) {
    return `<section class="card dash-card ${cls}${tone && tone !== "ok" ? ` dash-card--${tone}` : ""}" id="${esc(id)}" aria-labelledby="${esc(id)}-h">
      <div class="dash-head"><h2 id="${esc(id)}-h">${esc(title)}</h2>${actions ? `<div class="dash-actions">${actions}</div>` : ""}</div>
      ${meta ? `<div class="dash-meta">${meta}</div>` : ""}
      ${body}</section>`;
  }
  function loadingHtml(id, title) {
    return shellHtml({ id, title, body: `<p class="dash-loading" aria-busy="true">${badge("none", "불러오는 중…", { small: true })}</p>` });
  }
  /** 불러오지 못함. last 가 있으면 마지막 정상값을 그대로 두고 위에 오류만 알려요(0 으로 바꾸지 않음). */
  function errorHtml(id, title, error, last) {
    const why = humanize(error) || "알 수 없는 오류";
    // 제목 줄(dash-head)이 없는 마지막 화면(운영 상태 한 줄)은 오류를 붙일 곳이 없어 새 오류 카드로 - 조회 실패를 숨기지 않아요
    if (last && last.html && last.html.includes('<div class="dash-head">')) {
      return last.html.replace(/(<div class="dash-head">[\s\S]*?<\/div>)/,
        `$1<div class="dash-stale" role="alert">${badge("check", "새로고침 실패", { small: true })} ${esc(why)} · 아래는 마지막 정상값(${esc(hm(last.at))})이에요</div>`);
    }
    return shellHtml({ id, title, tone: "check",
      body: `<p class="dash-empty" role="alert">${badge("check", "불러오지 못했어요", { small: true })} ${esc(why)} · 0 이 아니라 확인하지 못한 상태예요. ${refreshBtn}</p>` });
  }
  const noDataHtml = text => `<p class="dash-empty">${badge("none", "데이터 없음", { small: true })} ${esc(text)}</p>`;

  // ── A. 운영 상태 ─────────────────────────────────────────────────────────
  const RISK_TEXT = { OK: ["ok", "다음 06:20 수집 가능(추정)"], WATCH: ["check", "다음 06:20 수집 주의 - 자동 연장 실패 중"],
    AT_RISK: ["check", "다음 06:20 수집 전 로그인 갱신 권장"], EXPIRED: ["error", "다음 06:20 수집 불가 - WING 로그인 필요"],
    UNKNOWN: ["check", "다음 06:20 수집 확인 필요"] };
  // WING 경고 판정은 상단 경고와 같은 함수(SalesRefresh.sessionDisplay). 없으면(옛 스크립트) 서버 level 그대로 - 빨강은 안전한 쪽.
  const sessionView = s => {
    if (root.SalesRefresh && root.SalesRefresh.sessionDisplay) return root.SalesRefresh.sessionDisplay(s);
    const lv = s.level || (s.needs_renewal ? "alert" : s.warning ? "warn" : "ok");
    if (lv === "alert") return { kind: "expired", tone: "error", title: "WING 로그인 필요", reason: s.message || "" };
    if (lv === "warn") return { kind: "check", tone: "check", title: "WING 세션 확인 필요", reason: s.message || "" };
    return { kind: "ok", tone: "ok", title: "", reason: "" };
  };
  const POLLER_KEYS = ["mail", "poller"];   // 실행 상태를 기록하지 않는 폴러('정보 없음'일 때만 판정 제외 - 메일 발송 실패는 그대로 확인 필요)
  const MAIL_BAD = ["MAIL_FAILED", "MAIL_SEND_UNKNOWN", "MAIL_SENT_RECORD_FAILED", "MAIL_DATA_CHECK_NEEDED", "MAIL_LEGACY_REVIEW"];

  /** in = { health, dataDate, today, yesterday, dayState(어제 매출 수집 이력 요약), adYesterday(광고비 어제 상태),
   *        jobs(sync_job_status 행), plans(inbound_plans), healthError } */
  function statusModel(inp) {
    const items = [];
    const s = inp.health && inp.health.session;
    // WING 실제 인증
    if (inp.healthError || !inp.health) items.push({ key: "wing", tone: "none", text: "WING 상태 확인 불가", why: humanize(inp.healthError) || "상태 API 응답 없음" });
    // 상태 API 가 실패해도 loadHealth 는 session 없이 돌아와요 - 이것도 '확인 불가'(정상 아님)
    else if (!s) items.push({ key: "wing", tone: "none", text: "WING 상태 확인 불가", why: "WING 상태 API 응답이 없거나 실패했어요" });
    else {
      const a = s.auth || {};
      const d = sessionView(s);
      if (d.kind === "ok") {
        items.push({ key: "wing", tone: "ok", text: "WING 인증 정상", sub: a.checked_at ? `${hm(a.checked_at)} 확인` : "" });
        const nc = s.next_collection;
        if (nc && nc.risk) {
          const [tone, text] = RISK_TEXT[nc.risk] || ["check", "다음 06:20 수집 확인 필요"];
          items.push({ key: "next", tone, text, guide: tone !== "ok" });
        }
      } else {
        // 2026-09-15 [사용자 지시] WING 경고는 한 줄로 합쳐요(인증 상태 + 다음 06:20) - 자세한 시각은 같은 줄 아래.
        // 대시보드에서는 화면 맨 위 WING 경고를 따로 그리지 않아요(SalesRefresh.renderTopBanner).
        const detail = root.SalesRefresh && root.SalesRefresh.sessionDetailHtml ? root.SalesRefresh.sessionDetailHtml(s) : "";
        items.push({ key: "wing", tone: d.tone, text: d.title, why: reason(d.reason, d.title) || (d.kind === "expired" ? "WING 실제 인증이 안 돼요" : ""),
          guide: true, detail });
      }
    }
    // 마지막 정상 수집 · 데이터 기준일
    const last = inp.health && inp.health.last_success_at;
    const lastAgeH = last ? (Date.now() - new Date(last).getTime()) / 3600000 : null;
    items.push(last ? { key: "last", tone: lastAgeH > 26 ? "check" : "ok", text: `마지막 정상 수집 ${hm(last)}`, why: lastAgeH > 26 ? "하루 넘게 새 수집이 없어요" : "" }
                    : { key: "last", tone: "none", text: "마지막 정상 수집 기록 없음" });
    if (inp.dataDate) {
      const old = inp.dataDate < inp.yesterday;
      items.push({ key: "date", tone: old ? "check" : "ok", text: `데이터 기준일 ${md(inp.dataDate)}${inp.dataDate === inp.today ? "(오늘)" : " (최신 확정일)"}`,
        why: old ? "어제 판매통계가 아직 없어요" : "" });
    }
    // 06:20 수집 결과(어제 판매통계 · 광고비)
    const ds = inp.dayState;
    if (ds && ds.latest && ds.latest.status !== "OK") {
      const has = !!ds.last_check;
      items.push({ key: "sales0620", tone: has ? "check" : "error", text: has ? "최신 매출 수집 확인 필요" : "06:20 매출 수집 실패",
        why: `${hm(ds.latest.collected_at)} · ${humanize(root.SalesRefresh && root.SalesRefresh.reasonText ? root.SalesRefresh.reasonText(ds.latest.error) : ds.latest.error)}`,
        href: "#/sales", collect: true });
    }
    if (inp.adYesterday && inp.adYesterday.status === "UNDETERMINED") {
      items.push({ key: "ad0620", tone: "check", text: "어제 광고비 수집 누락", why: humanize(inp.adYesterday.lastError) || "정상 수집 기록 없음", href: "#/profit", collect: true });
    }
    // 다른 자동 작업(재고판단 캐시 · 고객문의 수집) 실패
    const JOB = { inventory_decisions_cache: ["재고판단 계산", "#/stockflow/stock"], cs_inquiry_collect: ["고객문의 수집", "#/voc/inquiries"] };
    (inp.jobs || []).forEach(j => {
      const def = JOB[j.job_name];
      if (!def) return;
      const ok = j.last_success_at ? new Date(j.last_success_at).getTime() : 0;
      const tried = j.last_attempt_at ? new Date(j.last_attempt_at).getTime() : 0;
      if (j.last_error && tried > ok) {
        items.push({ key: `job-${j.job_name}`, tone: "check", text: `${def[0]} 실패`, why: `${hm(j.last_attempt_at)} · ${humanize(codeText(j.error_kind)) || "확인 필요"} · 마지막 정상 ${hm(j.last_success_at)}`,
          href: def[1], collect: true });
      }
    });
    // 입고 메일 · 자동입고 폴러(상태를 따로 기록하지 않아서 흔적만)
    const plans = inp.plans;
    if (Array.isArray(plans)) {
      const bad = plans.filter(p => MAIL_BAD.includes(p.mail_status) && p.internal_status !== "CANCELLED");
      const sending = plans.filter(p => p.mail_status === "MAIL_SENDING");
      const sent = plans.map(p => p.mail_sent_at).filter(Boolean).sort().pop();
      // 2026-09-13 [사용자 지시] 폴러는 실행 상태를 저장하지 않아요 - 최근 기록으로 '정상'이라고 추정하지 않고 '정보 없음'.
      // 실제로 실패가 기록된 요청(메일 발송 실패 등)만 '확인 필요'로 올려요.
      if (bad.length) items.push({ key: "mail", tone: "check", text: `입고 메일 확인 필요 ${bad.length}건`, why: [...new Set(bad.map(p => codeText(p.mail_status)))].join(" · "), href: "#/stockflow/rginbound" });
      else items.push({ key: "mail", tone: "none", text: "입고 메일 폴러 정보 없음", sub: sending.length ? `발송 중 ${sending.length}건` : sent ? `마지막 발송 ${hm(sent)}` : "",
        why: "폴러가 실행 상태를 저장하지 않아요 - 최근 발송 기록은 참고만(정상 판단 아님)" });
      const lastPlan = plans.map(p => p.created_at).filter(Boolean).sort().pop();
      items.push({ key: "poller", tone: "none", text: "자동입고 폴러 정보 없음", sub: lastPlan ? `최근 입고 요청 ${hm(lastPlan)}` : "",
        why: "폴러가 실행 상태를 저장하지 않아요 - 최근 입고 요청 시각은 참고만(정상 판단 아님)" });
    } else {
      items.push({ key: "mail", tone: "none", text: "입고 메일 폴러 정보 없음" });
      items.push({ key: "poller", tone: "none", text: "자동입고 폴러 정보 없음" });
    }
    const problems = items.filter(i => ["error", "check"].includes(i.tone));
    return { items, problems, tone: worstTone(problems.map(p => p.tone)), collectErrors: items.filter(i => i.collect) };
  }

  function statusHtml(m, { at } = {}) {
    const chip = i => `<span class="dash-status-item">${badge(i.tone, i.text, { small: true, title: i.why || "" })}${i.sub ? `<small>${esc(i.sub)}</small>` : ""}</span>`;
    // 2026-09-15 [사용자 지시] 운영 카드는 상태와 관계없이 맨 위에 항상 - 문제가 없으면 '운영 상태' 한 줄(새로고침 유지).
    // 상태를 확인하지 못한 항목(WING 상태 확인 불가 등)이 있으면 정상으로 보지 않고 회색 '상태 확인 필요 N건'.
    // 입고 메일·자동입고 폴러는 원래 실행 상태를 기록하지 않아요 - 건수·정상/오류 판정에서 빼고 아래 작은 회색 글자로만.
    const untracked = m.items.filter(i => i.tone === "none" && POLLER_KEYS.includes(i.key));
    const note = untracked.length ? `<small class="dash-status-note">입고·자동입고 폴러 상태 기록 없음</small>` : "";
    if (!m.problems.length) {
      const unknown = m.items.filter(i => i.tone === "none" && !untracked.includes(i));
      const okText = i => `<span class="dash-okitem${i.tone === "none" ? " dash-okitem--none" : ""}"${i.why ? ` title="${esc(i.why)}"` : ""}>${esc(i.text)}${i.sub ? ` <small>${esc(i.sub)}</small>` : ""}</span>`;
      const lead = unknown.length
        ? badge("none", `상태 확인 필요 ${unknown.length}건`, { small: true, title: "상태를 확인하지 못한 항목이에요 - 정상으로 보지 않아요" })
        : badge("ok", "확인된 문제 없음", { small: true });
      return `<section class="dash-status dash-status--${unknown.length ? "unknown" : "ok"}" id="dash-status" role="status" aria-label="운영 상태">
        <h2 class="dash-status-title">운영 상태</h2>
        <span class="dash-status-lead">${lead}</span>
        <span class="dash-oklist">${[...unknown, ...m.items.filter(i => i.tone !== "none")].map(okText).join('<span class="dash-sep" aria-hidden="true"> · </span>')}</span>
        ${note}<small class="dash-status-at">갱신 ${esc(hm(at))}</small>
        ${refreshBtn}</section>`;
    }
    const others = m.items.filter(i => !m.problems.includes(i) && !untracked.includes(i));
    const guide = m.problems.some(p => p.guide);
    // 확인할 문제가 있으면 제목은 '운영 확인 필요' - 빨강(실제 만료·실패)과 노랑(확인 필요)은 테두리·배지 색으로 나눠요
    return `<section class="card dash-status dash-status--${m.tone}" id="dash-status" role="${m.tone === "error" ? "alert" : "status"}" aria-label="운영 상태">
      <div class="dash-head"><h2>운영 확인 필요 <small>${m.problems.length}건</small></h2>
        <div class="dash-actions">${guide ? `<button type="button" class="btn sm secondary" onclick="dashboardWingGuide()">WING 로그인 갱신 방법 보기</button>` : ""}
          ${refreshBtn}</div></div>
      <ul class="dash-problems">${m.problems.map(p => `<li>${badge(p.tone, p.text)}
        ${p.why ? `<span class="dash-why">${esc(p.why)}</span>` : ""}${p.href ? link(p.href, "해당 화면") : ""}
        ${p.detail ? `<div class="dash-wing-detail" style="flex:1 1 100%;min-width:0;color:var(--text-sub);overflow-wrap:anywhere">${p.detail}</div>` : ""}</li>`).join("")}</ul>
      <div class="dash-status-rest">${others.map(chip).join("")}${note}<small class="dash-status-at">갱신 ${esc(hm(at))}</small></div>
    </section>`;
  }

  // ── B. 오늘 해야 할 일 ──────────────────────────────────────────────────────
  /** in: 각 항목 { count(null=확인 불가), sub } */
  function todoModel(inp) {
    const row = (key, label, tone, href, v, sub) => ({ key, label, tone, href, count: v == null ? null : Number(v) || 0, sub: sub || "" });
    const rows = [
      row("docs", "승인 대기 · 지출결의", "approval", "#/inbox", inp.docs),
      row("po", "승인 대기 · 발주서", "approval", "#/po", inp.po),
      row("inbound", "승인 대기 · 입고 요청", "approval", "#/stockflow/rginbound", inp.inbound),
      row("reinbound", "재입고 승인 필요", "approval", "#/po", inp.reinbound, "WING 취소 뒤 보류된 발주서"),
      row("exclusion", "재입고 제외 확인", "check", "#/procurement", inp.exclusion, inp.exclusionSub),
      row("logistics", "물류정보 입력 필요", "check", "#/procurement", inp.logistics, "채울 때까지 추천 발주·자동 발주가 막혀요"),
      row("stockcheck", "재고 확인 필요", "check", "#/stockflow/stock", inp.stockCheck, inp.stockCheckSub),
      row("collect", "수집 오류", inp.collectTone || "error", inp.collectHref || "#/sales", inp.collect, inp.collectSub),
      row("cs", "고객문의 답변", inp.csUrgent ? "error" : "check", "#/voc/inquiries", inp.cs, inp.csSub),
      row("tasks", "받은 업무", "info", "#/tasks", inp.tasks),
    ];
    return { rows, active: rows.filter(r => r.count), zero: rows.filter(r => r.count === 0), unknown: rows.filter(r => r.count == null) };
  }

  function todoHtml(m, { at } = {}) {
    const body = m.active.length
      ? `<ul class="dash-todo">${m.active.map(r => `<li><a class="dash-todo-row" href="${esc(r.href)}">
          ${badge(r.tone, `${r.count}건`, { small: true })}<span class="dash-todo-label">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ""}</span>
          <span class="dash-go" aria-hidden="true">›</span></a></li>`).join("")}</ul>`
      : `<p class="dash-empty">${badge("ok", "처리할 일 없음", { small: true })} 지금 확인이 필요한 항목이 없어요.</p>`;
    const zero = m.zero.length ? `<p class="dash-zero">0건: ${m.zero.map(r => esc(r.label.replace("승인 대기 · ", ""))).join(" · ")}</p>` : "";
    const unknown = m.unknown.length ? `<p class="dash-zero">${badge("none", "확인 불가", { small: true })} ${m.unknown.map(r => esc(r.label)).join(" · ")} - 불러오지 못해 건수를 모름(0 아님)</p>` : "";
    return shellHtml({ id: "dash-todo", title: "오늘 해야 할 일", meta: `갱신 ${esc(hm(at))} · 누르면 해당 화면으로 이동만 해요(자동 처리 없음)`,
      body: body + zero + unknown, cls: "dash-todo-card" });
  }

  // ── C. 매출 요약 ───────────────────────────────────────────────────────────
  function salesModel(summary, today, forDate) {
    if (!summary || !summary.has_rg_statistics) return { empty: true };
    const dates = summary.collected_dates || [];
    const shown = dates.includes(today) ? today : (dates[dates.length - 1] || null);
    if (!shown) return { empty: true };
    const day = forDate(summary, shown, { rgOnly: true });
    const prevDate = dates.filter(d => d < shown).pop() || null;
    const prev = prevDate ? forDate(summary, prevDate, { rgOnly: true }) : null;
    const dod = prev && prev.net_amount ? ((day.net_amount - prev.net_amount) / prev.net_amount) * 100 : null;
    return { empty: false, shown, isToday: shown === today, day, prevDate, prev, dod,
      month: summary.total, rg: summary.rocket_growth, mp: summary.marketplace, coverage: dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : "" };
  }

  function salesHtml(m, { fmt, at, statusLine = "", detail = "", error = null } = {}) {
    const won = v => `₩${fmt(v)}`;
    if (m.empty) {
      return shellHtml({ id: "dash-sales", title: "매출 요약", actions: link("#/sales", "매출 상세"),
        body: statusLine + noDataHtml("이번 달 로켓그로스 판매통계가 아직 없어요 - 0원이 아니라 미수집이에요.") + detail });
    }
    const d = m.day;
    const dod = m.dod == null ? `<span class="dash-sub">비교 없음</span>`
      : `<span class="${m.dod >= 0 ? "dash-up" : "dash-down"}">${m.dod >= 0 ? "▲" : "▼"} ${Math.abs(m.dod).toFixed(1)}%</span>`;
    const basis = m.isToday ? badge("ok", `오늘 ${md(m.shown)}`, { small: true })
      : badge("info", `최신 확정일 기준 ${md(m.shown)}`, { small: true, title: "오늘 판매통계는 아직 수집 전이에요" });
    return shellHtml({ id: "dash-sales", title: "매출 요약", actions: link("#/sales", "매출 상세"),
      meta: `${basis} 로켓그로스 판매통계 기준 · 갱신 ${esc(hm(at))}`,
      body: `${statusLine}
      <div class="dash-kpis">
        <div class="dash-kpi dash-kpi--main"><span>순매출</span><b>${won(d.net_amount)}</b><small>${fmt(d.net_qty)}개</small></div>
        <div class="dash-kpi"><span>전체 거래액</span><b>${won(d.gross_amount)}</b></div>
        <div class="dash-kpi"><span>취소·반품</span><b>${won(d.cancel_amount)}</b><small>${fmt(d.cancel_qty)}개</small></div>
        <div class="dash-kpi"><span>주문 수량</span><b>${fmt(d.gross_qty)}개</b></div>
        <div class="dash-kpi"><span>전일 대비</span><b>${dod}</b><small>${m.prevDate ? `${md(m.prevDate)} ${won(m.prev.net_amount)}` : ""}</small></div>
      </div>
      <div class="dash-month"><span>이번 달 순매출</span><b>${won(m.month.net_amount)}</b></div>
      ${error ? `<p class="dash-stale">${badge("check", "일부 확인 필요", { small: true })} ${esc(humanize(error))}</p>` : ""}
      ${detail}` });
  }

  /** 2026-09-15 [사용자 지시] 매출 요약 금액 칸 맞춤(화면 표시만 - 값·문구는 그대로).
   *  1) 원래 크기(16px · 순매출 20px)로 칸에 들어가면 그대로
   *  2) 안 들어가는 칸 중 7자리 이상 금액만 필요한 만큼 줄임(최소 14px) - 짧은 값은 줄이지 않음
   *  3) 그래도 안 되면 PC 5칸 배치에서만 3개 + 2개 두 줄(.dash-kpis--wrap)로 바꾸고 1)·2) 다시
   *  4) 마지막 안전장치(9자리 이상 등): 넘치지 않을 만큼만 줄임 - 숫자는 어떤 경우에도 가르거나 칸 밖으로 넘기지 않음
   *  scope 안의 .dash-kpis 하나를 맞추고 배치("row" | "wrap" | "row-shrunk" | "wrap-shrunk")를 돌려줘요. */
  function fitKpis(scope) {
    const box = scope && scope.querySelector ? scope.querySelector(".dash-kpis") : null;
    if (!box || typeof getComputedStyle !== "function") return null;
    const bs = [...box.querySelectorAll(".dash-kpi b")];
    const textW = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; };
    const room = el => { const c = el.parentElement, cs = getComputedStyle(c); return c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); };
    const longAmount = el => (el.textContent.match(/\d/g) || []).length >= 7;
    const pass = floor => {
      bs.forEach(b => { b.style.fontSize = ""; });
      let ok = true;
      bs.forEach(b => {
        const need = textW(b), have = room(b);
        if (need <= have + 0.5) return;
        if (floor > 0 && !longAmount(b)) { ok = false; return; }
        const base = parseFloat(getComputedStyle(b).fontSize);
        b.style.fontSize = `${Math.max(floor, Math.floor(base * have / need * 10) / 10)}px`;
        if (textW(b) > have + 0.5) ok = false;
      });
      return ok;
    };
    box.classList.remove("dash-kpis--wrap");
    const canWrap = getComputedStyle(box).gridTemplateColumns.split(" ").length === 5;
    if (pass(14)) return "row";
    if (canWrap) {
      box.classList.add("dash-kpis--wrap");
      if (pass(14)) return "wrap";
    }
    pass(0);
    return canWrap ? "wrap-shrunk" : "row-shrunk";
  }

  // ── D+G. 공헌이익 · 광고비 ──────────────────────────────────────────────────
  function profitModel(cm, adInfo, { month }) {
    const t = cm.t;
    const undet = adInfo && adInfo.state === "UNDETERMINED";
    const days = (adInfo && adInfo.days) || [];
    const lastAd = days.filter(x => x.auto && x.status === "OK").slice(-1)[0] || null;
    const adRate = t.revenue ? (cm.adTotal / t.revenue) * 100 : null;
    const adNotes = [];
    if (undet) adNotes.push({ tone: "check", text: `광고비 미확정 ${adInfo.undeterminedDays.length}일`, why: "정상 수집이 없는 날이 있어 공헌이익은 잠정이에요" });
    else if (adInfo && adInfo.state === "ROUNDING_DIFFERENCE") adNotes.push({ tone: "info", text: `잠정 · 쿠팡 기간 합계와 ${Math.abs(adInfo.recon.diff)}원 차이` });
    else if (adInfo && adInfo.state === "PENDING_RECON") adNotes.push({ tone: "info", text: "잠정 · 기간 합계 대사 전" });
    else if (adInfo && adInfo.state === "MANUAL_ONLY") adNotes.push({ tone: "none", text: "수동 입력 기준" });
    else if (adInfo) adNotes.push({ tone: "ok", text: "정상 수집 · 대사 일치" });
    if (adInfo && adInfo.reconciliationNeeded && adInfo.reconciliationNeeded.length) adNotes.push({ tone: "check", text: `수동 입력 확인 필요 ${adInfo.reconciliationNeeded.length}건` });
    if (adInfo && adInfo.lastFailure) adNotes.push({ tone: "check", text: `최근 수집 실패 ${md(adInfo.lastFailure.date)}` });
    return { month, t, adTotal: cm.adTotal, cmNet: cm.cmNet, cmRate: cm.cmRate, undet, lastAd, adRate, adNotes, empty: !t.revenue && !cm.adTotal };
  }

  /** 정산자료 계산이 켜진 대시보드는 최신 잠정 공헌이익 내역을 펼쳐 보여 준다. */
  function profitHtml(m, { fmt, at, settlement = null } = {}) {
    const won = v => `₩${fmt(v)}`;
    const t = m.t;
    const ref = !!settlement;
    const rate = v => (m.t.revenue ? `${(v / m.t.revenue * 100).toFixed(1)}%` : "0%");
    const line = (label, v, sub = "") => `<tr><th scope="row">${label}${sub ? `<small>${sub}</small>` : ""}</th><td class="num">− ${won(v)}</td><td class="num dash-sub">${rate(v)}</td></tr>`;
    const neg = !m.undet && m.cmNet < 0;
    const cmCell = m.undet ? `<b class="dash-amber">미확정</b><small>잠정 ${won(m.cmNet)}</small>`
      : `<b class="${ref ? "dash-ref" : neg ? "dash-down" : "dash-up"}">${won(m.cmNet)}</b>`;
    const table = `
      <table class="dash-cm" aria-label="${esc(m.month)} 공헌이익 요약${ref ? "(기존 운영 계산 · 참고)" : ""}">
        <tbody>
          <tr class="dash-cm-rev"><th scope="row">매출<small>부가세 제외 공급가액</small></th><td class="num"><b>${won(t.revenue)}</b></td><td class="num dash-sub">100%</td></tr>
          ${line("상품원가", t.cost)}
          ${line("판매수수료", t.fee, "쿠팡 등 채널 수수료")}
          ${t.logi > 0 ? line("물류비", t.logi, "로켓그로스 등") : ""}
          ${t.ship > 0 ? line("출고배송비", t.ship) : ""}
          ${t.inFreight > 0 ? line("입고 트럭 운송비", t.inFreight, "판매분 배부") : ""}
          <tr class="dash-cm-ad"><th scope="row">광고비<small>이번 달 누적 · 공급가액</small></th><td class="num">− ${m.undet ? `미확정 <small>(확인된 ${won(m.adTotal)})</small>` : won(m.adTotal)}</td><td class="num dash-sub">${rate(m.adTotal)}</td></tr>
          <tr class="dash-cm-total"><th scope="row">${ref ? "공헌이익(기존 운영 계산 · 참고)" : "공헌이익"}${neg && !ref ? ` ${badge("error", "적자", { small: true })}` : ""}</th><td class="num">${cmCell}</td><td class="num"><b>${m.undet ? "—" : `${m.cmRate.toFixed(1)}%`}</b></td></tr>
        </tbody></table>`;
    const adRow = `
      <div class="dash-ad">
        <span>최신일 광고비 ${m.lastAd ? `<b>${won(m.lastAd.auto.net)}</b> <small>${md(m.lastAd.date)} · 공급가액</small>` : `<b>기록 없음</b>`}</span>
        <span>매출 대비 광고비율 <b>${m.adRate == null ? "—" : `${m.adRate.toFixed(1)}%`}</b></span>
        <span class="dash-ad-notes">${m.adNotes.map(n => badge(n.tone, n.text, { small: true, title: n.why || "" })).join(" ")}</span>
      </div>`;
    if (ref) {
      const body = `${settlement.mainHtml}
      ${adRow}
      ${settlement.breakdownHtml || ""}`;
      return shellHtml({ id: "dash-profit", title: `${m.month} 공헌이익 · 광고비`, actions: link("#/profit", "상세 계산 보기"),
        tone: settlement.tone || null, body });
    }
    const body = m.empty ? noDataHtml(`${m.month} 매출·광고비 기록이 아직 없어요.`) : `${table}${adRow}`;
    return shellHtml({ id: "dash-profit", title: `${m.month} 공헌이익 · 광고비`, actions: link("#/profit", "상세 계산 보기"),
      meta: `공헌이익 화면과 같은 계산 · 이번 달 1일~오늘 · 갱신 ${esc(hm(at))}`, tone: m.empty ? null : neg ? "error" : m.undet ? "check" : null, body });
  }

  // ── E. 재고·발주 ──────────────────────────────────────────────────────────
  const RISK_ORDER = { ORDER_NOW: 0, ORDER_SOON: 1, DATA_CHECK: 2 };
  // opts.blocked: 서버가 공유재고 묶음 기준으로 센 자동화 막힘 수(있으면 그 값 - 세트만 막힌 묶음도 셈)
  function stockModel(decisions, opts = {}) {
    const list = decisions || [];
    const c = k => list.filter(d => d.decision === k).length;
    const blocked = list.filter(d => d.automation_blocked && d.decision !== "RESTOCK_EXCLUDED");
    const risk = list.filter(d => d.decision in RISK_ORDER)
      .sort((a, b) => (RISK_ORDER[a.decision] - RISK_ORDER[b.decision]) || ((a.days_of_stock_now ?? 999) - (b.days_of_stock_now ?? 999)) || ((a.live_stock ?? 1e9) - (b.live_stock ?? 1e9)));
    return { total: list.length, orderNow: c("ORDER_NOW"), awaiting: c("AWAITING_INBOUND"), soon: c("ORDER_SOON"), dataCheck: c("DATA_CHECK"),
      blocked: typeof opts.blocked === "number" ? opts.blocked : blocked.length, logistics: blocked.filter(d => /물류정보/.test(d.automation_label || "")).length, top: risk.slice(0, 5), riskTotal: risk.length };
  }

  function stockHtml(m, { at, calculatedAt, stockText, outlookText, nameOf } = {}) {
    const stat = (tone, label, v, sub) => `<div class="dash-stat dash-stat--${tone}">${badge(tone, label, { small: true })}<b>${v}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
    const body = !m.total ? noDataHtml("재고 판단 결과가 없어요.") : `
      <div class="dash-stats">
        ${stat(m.orderNow ? "error" : "none", "품절·임박", m.orderNow, "지금 발주")}
        ${stat(m.awaiting ? "awaiting" : "none", "입고대기", m.awaiting)}
        ${stat(m.soon ? "check" : "none", "발주 검토", m.soon, "곧 발주")}
        ${stat(m.blocked ? "check" : "none", "자동화 차단", m.blocked, m.logistics ? "물류정보 입력 필요 포함" : "")}
      </div>
      ${m.top.length ? `<ol class="dash-risk">${m.top.map(d => `<li><a href="#/stockflow/stock">
          <span class="dash-risk-name">${esc(nameOf(d))}${d.option_name ? `<small>${esc(d.option_name)}</small>` : ""}</span>
          <span class="dash-risk-num">${esc(stockText(d))} · ${esc(outlookText(d))}</span>
          ${UI().decisionBadge(d, { noReason: true })}</a></li>`).join("")}</ol>` : `<p class="dash-empty">${badge("ok", "위험 상품 없음", { small: true })}</p>`}
      ${m.riskTotal > 5 ? `<p class="dash-zero">위험 상품 ${m.riskTotal}개 중 5개만 보여요.</p>` : ""}`;
    return shellHtml({ id: "dash-stock", title: "재고·발주", actions: link("#/stockflow/stock", "전체 보기"),
      meta: `재고 판단 계산 ${esc(hm(calculatedAt))} · 갱신 ${esc(hm(at))}`, body });
  }

  // ── F. 입고·운송 ──────────────────────────────────────────────────────────
  /** plans·itemsByPlan 과 app.js 의 쿠팡 입고관리 요약 규칙(countPlan)으로 같은 건수를 내요. */
  function inboundModel({ plans, itemsByPlan, counts, freightReview, today, statusOf }) {
    const upcoming = (plans || [])
      .filter(p => p.internal_status !== "CANCELLED" && p.approval_status !== "REJECTED" && (itemsByPlan[p.id] || []).length && p.inbound_date && p.inbound_date >= today)
      .sort((a, b) => `${a.inbound_date} ${a.inbound_time || ""}`.localeCompare(`${b.inbound_date} ${b.inbound_time || ""}`));
    return { counts, freightReview, upcoming: upcoming.slice(0, 5), upcomingTotal: upcoming.length, next: upcoming[0] || null, statusOf };
  }

  function inboundHtml(m, { at, fmt, itemsLabel, qtySum, palletSum, centerText, itemsByPlan } = {}) {
    const c = m.counts;
    const stat = (tone, label, v, sub) => `<div class="dash-stat dash-stat--${tone}">${badge(tone, label, { small: true })}<b>${v}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
    const fr = m.freightReview || [];
    const body = `
      <div class="dash-stats">
        ${stat(c.wing ? "awaiting" : "none", "쿠팡 제출 완료", c.wing)}
        ${stat(m.next ? "awaiting" : "none", "예정 입고일", m.next ? md(m.next.inbound_date) : "없음", m.next ? `${String(m.next.inbound_time || "").slice(0, 5)} · ${centerText(m.next)}` : "")}
        ${stat(fr.length ? "check" : "none", "운송비 확인 필요", fr.length, fr.length ? [...new Set(fr.map(x => codeText(x.status)))].join(" · ") : "")}
        ${stat(c.failed || c.block ? "check" : "none", "취소·복구 필요", c.failed + c.block, [c.failed ? `제출 실패 ${c.failed}` : "", c.block ? `적재 보완 ${c.block}` : ""].filter(Boolean).join(" · "))}
      </div>
      ${m.upcoming.length ? `<ol class="dash-sched">${m.upcoming.map(p => {
        const items = itemsByPlan[p.id] || [];
        const st = m.statusOf(p);
        return `<li><a href="#/stockflow/rginbound"><span class="dash-sched-date">${esc(md(p.inbound_date))} ${esc(String(p.inbound_time || "").slice(0, 5))}</span>
          <span class="dash-sched-name">${esc(itemsLabel(items))}<small>${fmt(qtySum(items))}개 · ${fmt(palletSum(items))}PLT · ${esc(centerText(p))}</small></span>
          ${badge(st.tone, st.text, { small: true })}</a></li>`;
      }).join("")}</ol>` : `<p class="dash-empty">${badge("none", "예정된 입고 없음", { small: true })}</p>`}
      ${m.upcomingTotal > 5 ? `<p class="dash-zero">예정 ${m.upcomingTotal}건 중 가까운 5건만 보여요.</p>` : ""}`;
    return shellHtml({ id: "dash-inbound", title: "입고·운송", actions: link("#/stockflow/rginbound", "전체 보기"),
      meta: `가까운 일정부터 · 승인·재입고 건수는 '오늘 해야 할 일'에 · 갱신 ${esc(hm(at))}`, body });
  }

  root.ErpDashboard = {
    CODE_TEXT, codeText, humanize, worstTone, hm,
    shellHtml, loadingHtml, errorHtml, noDataHtml,
    statusModel, statusHtml, todoModel, todoHtml, salesModel, salesHtml, fitKpis,
    profitModel, profitHtml, stockModel, stockHtml, inboundModel, inboundHtml,
  };
})(typeof window !== "undefined" ? window : globalThis);
