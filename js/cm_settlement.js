/* cm_settlement.js
 * -------------------------------------------------------------------------
 * 2026-09-14 정산자료 기준 공헌이익(새 계산) 표시 - 계산은 서버(cm_settlement_calc.py), 이 파일은 보여 주기만(쓰기 0).
 *
 *   · 스위치: settings 의 key 'cm_settlement_v2' 값이 {"enabled": true} 일 때만 켜져요. 행이 없으면 꺼짐(기본 OFF).
 *     꺼져 있으면 결과 표를 읽지도 않고 아무것도 그리지 않아요 - 공헌이익·대시보드 화면의 금액·항목·순서가 지금과 같아요.
 *   · 2026-09-15 켜져 있으면 정산자료 계산(MAIN 최신 성공 결과)이 공헌이익·대시보드의 주 결과예요. 기존 운영 계산은
 *     '기존 계산과 비교'(기본 접힘) 안의 참고값으로만. 스위치·결과 조회가 실패하면 '정산자료 계산 조회 실패'를 보여 주고
 *     기존 계산을 주 결과로 대신 쓰지 않아요.
 *   · 결과: cm_settlement_current 뷰(월·기준별 마지막 성공 계산). 실패한 계산은 뷰에 나오지 않아서 이전 값이 그대로 보여요.
 *   · 메인 = 취소 처리월 기준. 코호트(원주문월)는 접힌 분석 칸에만 - 메인 숫자와 섞지 않아요.
 *   · 쿠팡 수익 현황의 '이익'(상품원가 차감 전 쿠팡 정산 잔액 · 부가세 포함)은 별도 참고 칸에만, 공헌이익이라 부르지 않아요.
 *   · 2026-09-16 환불은 정산취소 전체를 한 줄로 한 번만. 주문 취소/반품 나눔은 참고 추정 - 저장된 확정 자료 아님.
 *     취소·반품 원가는 환불 때 원판매 원가를 자동 환입(v2.7). 회수 확인 기록(js/cm_recovery.js)이 승인되면 미회수분만 반품 손실,
 *     확인 전은 '회수·손실 확인 대기'(손실 우선 0원 · 잠정). 확정 자료 입력 목록을 카드 위쪽에 보여 줘요.
 *   · 2026-09-14 v2.5 계산 내역 줄마다 출처(API · 정산파일 · ERP · 대표 확정 · 수동 입력)와 확정/잠정 상태. 취소·반품 세부 구분은 '참고 추정'.
 *   · 2026-09-14 화면 명칭(쿠팡 수익 현황과 같게): 입고비 → 입출고비, 풀필먼트비 → 배송비 · 쿠팡 '이익' → 상품원가 차감 전 쿠팡 정산 잔액 ·
 *     계산 시각은 저장 시각(UTC)을 Asia/Seoul 로 바꿔 KST 로. 저장된 결과는 그대로 두고 보여 줄 때만 이름을 바꿔요.
 */
(function (global) {
  "use strict";

  const SETTING_KEY = "cm_settlement_v2";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => Math.round(Number(n || 0)).toLocaleString("ko-KR");
  const won = n => (Number(n) < 0 ? "−₩" : "₩") + fmt(Math.abs(Number(n || 0)));
  const signed = n => (Number(n) > 0 ? "+" : Number(n) < 0 ? "−" : "") + fmt(Math.abs(Number(n || 0)));
  // 쿠팡 수익 현황과 같은 비용 이름(서버 결과의 입고비 = 쿠팡 입출고비, 풀필먼트비 = 쿠팡 배송비 - 금액은 같고 이름만)
  const costName = t => String(t ?? "").replace(/풀필먼트비/g, "배송비").replace(/입고비/g, "입출고비");
  /** 저장 시각(UTC 등 시간대 포함 ISO) → Asia/Seoul 'YYYY-MM-DD HH:mm KST'. 시간대 표시가 없으면 UTC 로 봐요. */
  function kstTime(iso) {
    const s = String(iso || "");
    if (!s) return "";
    const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z");
    if (isNaN(d)) return s.slice(0, 16).replace("T", " ");
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} KST`;
  }

  // 상태 7종(+광고 청구 미확인) → 배지 종류·문구. 색만으로 말하지 않게 아이콘·문구를 같이 써요.
  const STATUS = {
    CONFIRMED: { kind: "ok", text: "확정" },
    CYCLE_OPEN: { kind: "awaiting", text: "정산 진행 중" },
    ESTIMATED: { kind: "info", text: "예상" },
    COST_UNREGISTERED: { kind: "check", text: "비용 미등록" },
    VAT_UNCONFIRMED: { kind: "check", text: "VAT 미확인" },
    COST_UNCONFIRMED: { kind: "check", text: "원가 미확정" },
    RECOVERY_CANDIDATE: { kind: "approval", text: "회수·손실 확인 대기" },
    ACCRUED: { kind: "check", text: "청구 미확인(ACCRUED)" },
    NOTICE_MISSING: { kind: "check", text: "프로모션 공지 미확인" },
    BILLING_UNCONFIRMED: { kind: "check", text: "청구 미확인(ACCRUED)" },
    // 2026-09-16 기여액 카드 - 월 공통비를 못 구한 이유(코드가 그대로 보이지 않게)
    COST_SUMMARY_MISSING: { kind: "check", text: "월 공통비 없음" },
    COST_SUMMARY_STALE: { kind: "check", text: "월 공통비 조회 시점 문제" },
    MONTHLY_COST_DATA_CHECK: { kind: "check", text: "월 공통비 확인 필요" },
  };
  function chip(status, opts = {}) {
    const s = STATUS[status] || { kind: "info", text: status };
    const UI = global.ErpUi;
    if (UI && UI.badge) return UI.badge(s.kind, { text: opts.text || s.text, small: true, title: opts.title || "" });
    return `<span class="erp-badge erp-badge--sm">${esc(opts.text || s.text)}</span>`;
  }

  /** 스위치 상태 - "ON"({"enabled": true} 하나뿐) · "OFF"(행 없음·그 밖의 값) · "ERROR"(읽기 실패).
   *  2026-09-15 읽기 실패를 꺼짐으로 보지 않아요 - 켜진 운영에서 기존 계산이 몰래 주 결과로 돌아오지 않게. */
  async function switchState(sb) {
    try {
      const { data, error } = await sb.from("settings").select("value").eq("key", SETTING_KEY).maybeSingle();
      if (error) return "ERROR";
      if (!data) return "OFF";
      const v = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
      return v && v.enabled === true ? "ON" : "OFF";
    } catch (e) {
      return "ERROR";
    }
  }

  /** 스위치 - 켜짐은 {"enabled": true} 하나뿐. 오류·없음·그 밖의 값은 모두 꺼짐. */
  async function isEnabled(sb) {
    return (await switchState(sb)) === "ON";
  }

  /** 그 달의 현재 결과 {MAIN, COHORT} - 없음이면 null, 읽기 실패면 {error}.
   *  cm_settlement_current 뷰 = (월·기준)마다 결과 사슬 끝의 성공(SUCCEEDED) 결과. 화면에서도 성공 결과만, 기준마다 id 가 가장 큰 행 하나만 써요. */
  async function loadCurrent(sb, month) {
    try {
      const { data, error } = await sb.from("cm_settlement_current")
        .select("id,run_status,month,basis,period_start,period_end,as_of,cm_status,calc_assessment,confirmed,confirmed_at,cm,revenue,reasons,result,created_at,calc_version")
        .eq("month", month);
      if (error) return { error: error.message || String(error) };
      const out = {};
      (data || []).filter(r => r.month === month && (r.run_status == null || r.run_status === "SUCCEEDED")).forEach(r => {
        if (!out[r.basis] || Number(r.id || 0) > Number(out[r.basis].id || 0)) out[r.basis] = r;
      });
      return out.MAIN ? out : null;
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  }

  /** 운영 계산(app.js computeCmOfMonth) 결과에서 비교에 쓰는 구성만 뽑아요. rgRevenue/mpRevenue 는 호출하는 쪽이 채널별로 넘겨요. */
  function prodParts(m, byChannel) {
    const rg = byChannel["쿠팡 로켓그로스"] || { revenue: 0 };
    const mp = byChannel["쿠팡 판매자배송"] || { revenue: 0 };
    return { revenue: m.t.revenue, rg_revenue: rg.revenue, mp_revenue: mp.revenue, cost: m.t.cost, fee: m.t.fee, logi: m.t.logi,
             ship: m.t.ship, inFreight: m.t.inFreight, ads: m.adTotal, cmNet: m.cmNet };
  }

  /** 운영 → 새 계산 차이를 항목별로(서버 compare_with_production 과 같은 항목). 합 = 신규 − 운영. */
  function compare(main, prod) {
    const r = main.result || main;
    const rp = r.revenue_parts, a = r.ads;
    const items = [
      ["매출 인식 기준(주문일 → 쿠팡 매출인식일)", rp.rg_gross - prod.rg_revenue],
      ["판매자 부담 쿠폰 차감", -rp.rg_coupon],
      ["취소·환불 반영", rp.rg_cancel],
      ["판매자배송 매출", rp.mp - prod.mp_revenue],
      ["상품원가(매출 인식 기준·매핑 반영)", -(r.cost - prod.cost)],
      ["판매수수료(실제 정산값)", -(r.fee.total - prod.fee)],
      ["기존 개당 물류비(unit_fee) 빼지 않음", prod.logi],
      ["기존 출고배송비 빼지 않음", prod.ship || 0],
      ["로켓그로스 월 비용(입출고·배송·보관·세이버)", -r.monthly_costs.total],
      ["광고비: 집행액 → 실제 청구액", -(a.cm_amount - prod.ads)],
      ["입고 트럭 운송비", -((r.inbound_freight || 0) - (prod.inFreight || 0))],
      ["취소·반품 원가환입(자동)", r.cost_recovery.confirmed || 0],
      ["반품 손실", -(r.cost_recovery.loss || 0)],
      ["판매자배송 취소·반품(조회 자료)", (r.mp_refunds && r.mp_refunds.supply) || 0],
    ].map(([label, amount]) => ({ label, amount }));
    const diff = r.cm - prod.cmNet;
    const rest = diff - items.reduce((s, x) => s + x.amount, 0);
    if (Math.abs(rest) > 0.5) items.push({ label: "반올림", amount: rest });
    return { production: prod.cmNet, next: r.cm, diff, items: items.filter(x => Math.abs(x.amount) >= 0.5) };
  }

  const tone = v => (v < 0 ? "cmv2-neg" : "cmv2-pos");

  function reasonsHtml(reasons) {
    if (!reasons || !reasons.length) return chip("CONFIRMED", { text: "사유 없음" });
    const seen = new Set();
    return reasons.filter(z => !seen.has(z.status) && seen.add(z.status)).map(z => chip(z.status, { title: costName(z.text) })).join(" ");
  }

  /** 비용 출처(서버 줄의 source: API · 정산파일 · ERP · 대표 확정 · 수동 입력). 출처가 둘 이상이면 출처별 금액을 작게. 옛 결과(출처 없음)는 '—' */
  function sourceHtml(ln) {
    if (!ln.source) return `<span class="cmv2-none">—</span>`;
    const parts = Object.entries(ln.source_amounts || {}).filter(([, v]) => Math.abs(Number(v || 0)) >= 0.5);
    return `<span class="cmv2-src">${esc(ln.source)}</span>${parts.length > 1 ? `<br><small>${parts.map(([k, v]) => `${esc(k)} ${won(v)}`).join(" · ")}</small>` : ""}`;
  }

  /** 줄 상태 - 확정이면 '확정', 아니면 '잠정' + 이유 배지(정산 진행 중·예상·비용 미등록 등) */
  const lineStatusHtml = st => (st === "CONFIRMED" ? chip("CONFIRMED") : `<span class="cmv2-prov">잠정</span> ${chip(st)}`);

  function linesHtml(r) {
    const row = ln => `<tr${ln.code === "CM_TOTAL" ? ' class="cmv2-total"' : ""}>
        <th scope="row">${esc(costName(ln.label))}${ln.orders ? ` <small>${fmt(ln.orders)}건 · ${fmt(ln.qty)}개</small>` : ""}</th>
        <td class="num">${ln.amount == null ? `<span class="cmv2-none">금액 없음</span>` : won(ln.amount)}</td>
        <td class="cmv2-srccol">${sourceHtml(ln)}</td>
        <td class="cmv2-st">${lineStatusHtml(ln.status)}</td></tr>`;
    const rev = r.lines.filter(x => x.code.startsWith("REVENUE"));
    const rest = r.lines.filter(x => !x.code.startsWith("REVENUE"));
    return `<div class="table-wrap"><table class="cmv2-lines">
      <thead><tr><th>항목</th><th class="num">금액(공급가액)</th><th>출처</th><th>상태</th></tr></thead>
      <tbody>
        ${rev.map(row).join("")}
        <tr class="cmv2-sub"><th scope="row">= 순매출</th><td class="num"><b>${won(r.revenue)}</b></td><td></td><td></td></tr>
        ${rest.map(row).join("")}
        <tr class="cmv2-total"><th scope="row">= 공헌이익 <small>메인 · 취소 처리월 기준</small></th>
          <td class="num"><b class="${tone(r.cm)}">${won(r.cm)}</b></td><td></td>
          <td class="cmv2-st">${r._confirmed ? chip("CONFIRMED") : `<span class="cmv2-prov">${r._ready ? "승인 대기" : "잠정"}</span>`}</td></tr>
      </tbody></table></div>`;
  }

  function adsHtml(a) {
    if (a.billed == null) {
      return `<p class="cmv2-note">${chip("ACCRUED")} 이 기간과 맞는 로켓그로스 정산 광고비 자료가 없어 집행액 ${won(a.cm_amount)} 전체를 미리 잡았어요.</p>`;
    }
    return `<dl class="cmv2-ads">
      <div><dt>광고 성과용 집행액 <small>WING 일별 합계</small></dt><dd>${won(a.performance_spend)}</dd></div>
      <div><dt>공헌이익용 실제 청구액</dt><dd><b>${won(a.cm_amount)}</b></dd></div>
      <div class="cmv2-ads-parts">
        <span>로켓그로스 정산 청구액 ${won(a.billed)} ${chip(a.billed_status)}</span>
        ${a.outside_billed ? `<span>정산 밖 광고비 실제 청구 ${won(a.outside_billed)} ${chip("CONFIRMED")}${(a.invoices_used || []).length ? ` <small>계정 전체 청구 ${a.invoices_used.length}건</small>` : ""}</span>` : ""}
        ${(a.evidence_linked || []).length ? `<span><small>증빙(캠페인 청구서·카드 명세서·세금계산서) ${a.evidence_linked.length}건은 저장만 - 비용에 쓰지 않아요</small></span>` : ""}
        ${(a.billing_unreconciled || []).length ? `<span>${chip("ACCRUED")} 계정 전체 청구로 대사되지 않은 광고 문서 ${a.billing_unreconciled.length}건(PARTIAL_BILLING_UNRECONCILED) - 세지 않았어요</span>` : ""}
        ${(a.billing_held || []).length ? `<span>${chip("ACCRUED")} 보류한 계정 청구 ${a.billing_held.length}건(기간 겹침·일별 ACCRUED 없음) - 세지 않았어요</span>` : ""}
        ${a.outside_accrued ? `<span>정산 밖 광고비 ${won(a.outside_accrued)} ${chip("ACCRUED")} <small>청구 확인 전이라 미리 잡아 뒀어요 - 실제 청구 기록이 들어오면 그 금액으로 바뀌어요(더하지 않음)</small></span>` : ""}
        <span>빼는 것: 예산 초과 미청구 ${won(a.over_budget)} · 일별 합계 반올림 ${won(a.rounding)}</span>
      </div></dl>`;
  }

  const INPUT_STATUS = { NEEDED: ["check", "입력 필요"], PENDING_APPROVAL: ["approval", "승인 대기"], DONE: ["ok", "완료"] };
  const range = (lo, hi) => lo == null && hi == null ? "금액 미정" : lo == null ? `? ~ ${signed(hi)}` : hi == null ? `${signed(lo)} ~ ?` :
    Math.round(lo) === Math.round(hi) ? signed(lo) : `${signed(lo)} ~ ${signed(hi)}`;

  /** 월 확정 전에 넣어야 할 확정 자료 목록(서버 required_inputs) - 영향은 최종 공헌이익에 더해질 범위 */
  function requiredInputsHtml(list) {
    if (!list || !list.length) return "";
    const UI = global.ErpUi;
    const b = (st) => { const [k, t] = INPUT_STATUS[st] || ["info", st]; return UI && UI.badge ? UI.badge(k, { text: t, small: true }) : `<span class="erp-badge erp-badge--sm">${esc(t)}</span>`; };
    return `<details class="cmv2-inputs" open><summary>확정 자료 입력 목록 · ${list.filter(x => x.status !== "DONE").length}건 남음 <small>모두 끝나야 월 확정 가능</small></summary>
      <div class="table-wrap"><table class="cmv2-lines cmv2-inputs-t">
        <thead><tr><th>자료</th><th>상태</th><th class="num">최종 금액 영향(범위)</th><th>입력 방법</th></tr></thead>
        <tbody>${list.map(x => `<tr><th scope="row">${esc(costName(x.label))}<br><small>${esc(costName(x.impact_note || ""))}</small></th><td>${b(x.status)}</td>
          <td class="num">${range(x.impact_low, x.impact_high)}</td><td><small>${esc(x.how || "")}</small></td></tr>`).join("")}</tbody></table></div></details>`;
  }

  /** 환불 세부 구분(주문 취소/반품) - 공헌이익은 환불 전체를 한 번만 빼고, 세부 구분은 '참고 추정'으로만 보여 줘요 */
  function refundsRefHtml(rf) {
    if (!rf || !rf.total_rows) return "";
    const parts = Object.entries(rf.by_class || {}).map(([, v]) => `${esc(v.label)} ${fmt(v.rows)}건 ${won(v.supply)}`).join(" · ");
    const how = rf.estimated_rows === 0 ? "쿠팡 취소·반품 조회 자료와 맞춘 구분이지만" : "결제 뒤 경과일(0~1일 주문 취소 · 2일 이상 반품) 또는 쿠팡 취소·반품 조회 자료로 나눈 값이라";
    return `<p class="cmv2-note">환불(정산취소 전체) ${fmt(rf.total_rows)}건 ${won(rf.total_supply)}은 위에서 한 번만 뺐어요.
      <span class="cmv2-ref-tag">참고 추정</span> 세부 구분: ${parts} - ${how} 확정 자료가 아니고 원가환입 근거로 쓰지 않아요.</p>`;
  }

  /** 상태 문구 - 확정은 DB 판정 + 승인 권한자 로그인 승인(뷰의 confirmed)만. 계산 결과 안의 status 는 쓰지 않아요 */
  const stateText = main => (main.confirmed === true ? "확정" : main.calc_assessment === "READY_FOR_APPROVAL" ? "승인 대기" : "잠정");
  const periodText = main => `${String(main.period_start).slice(0, 10)}~${String(main.period_end).slice(5, 10)}`;
  const rateText = r => (r.cm_rate == null ? "—" : `${Number(r.cm_rate).toFixed(2)}%`);

  /** 출처 한 줄 - 계산 내역 줄의 출처(정산파일 · API · ERP · 대표 확정 · 수동 입력) + 쿠팡 차감 합계 조회 파일 */
  function sourceLine(r) {
    const srcs = [...new Set((r.lines || []).flatMap(l => String(l.source || "").split(" · ")).map(s => s.trim()).filter(Boolean))];
    const cs = r.cost_summary_used;
    return `${srcs.length ? srcs.map(esc).join(" · ") : "—"}${cs && cs.file
      ? ` · 쿠팡 차감 합계 ${esc(cs.range || "")} <code class="cmv2-file" title="SHA-256 ${esc(cs.sha256 || "")}">${esc(cs.file)}</code>` : ""}`;
  }

  /** 잠정 사유 - 배지(같은 종류는 하나) + 사유 문장 전부 */
  function whyHtml(reasons) {
    const list = reasons || [];
    return `<div class="cmv2-why">
      <div class="cmv2-reasons">${reasonsHtml(list)}</div>
      ${list.length ? `<ul class="cmv2-list cmv2-why-list">${list.map(z => `<li><b>${esc((STATUS[z.status] || {}).text || z.label || z.status)}</b> ${esc(costName(z.text))}</li>`).join("")}</ul>` : ""}
    </div>`;
  }

  /** 계산 내역·광고비·원가환입·코호트·쿠팡 잔액 - 주 결과 카드의 아래쪽 */
  function bodyHtml(cur, { month, recovery } = {}) {
    const main = cur.MAIN, cohort = cur.COHORT && cur.COHORT.result;
    const r = { ...main.result, _confirmed: main.confirmed === true, _ready: main.calc_assessment === "READY_FOR_APPROVAL" };
    const rec = r.cost_recovery || {};
    const cd = r.coupang_display;
    const fee = r.fee;
    return `
      ${requiredInputsHtml(r.required_inputs)}

      <h3 class="cmv2-h3">계산 내역</h3>
      ${linesHtml(r)}
      ${refundsRefHtml(r.refunds_reference)}
      ${r.revenue_rg_by_state ? `<p class="cmv2-note">로켓그로스 순매출 ${won(r.revenue_rg)} = 정산 확정 ${won(r.revenue_rg_by_state.SETTLED_ACTUAL)} ·
        정산 진행 중 ${won(r.revenue_rg_by_state.CYCLE_OPEN)} · 예상(정산 행 없음) ${won(r.revenue_rg_by_state.ESTIMATED)}</p>` : ""}
      <p class="cmv2-note">판매수수료 합계 ${won(fee.total)} = 정산 확정 ${won(fee.settled)} · 정산 진행 중 ${won(fee.cycle_open)} · 예상 ${won(fee.estimated)}
        (정산 행이 없는 주문만 예상).${fee.unknown_rate_rows ? ` 요율을 몰라 계산하지 못한 주문 ${fmt(fee.unknown_rate_rows)}건은 0원으로 두지 않고 잠정으로 표시해요.` : ""}
        수수료 VAT ${won(fee.vat_total)}는 매입세액이라 공헌이익에서 빼지 않고 부가세 화면에서 한 번만 잡아요.</p>

      <h3 class="cmv2-h3">광고비 - 두 값을 따로</h3>
      ${adsHtml(r.ads)}

      ${r.cost_fallback && r.cost_fallback.length ? `<h3 class="cmv2-h3">현재 상품 원가로 계산한 판매 ${chip("COST_UNCONFIRMED")} <small>판매일 원가 이력·판매 행 원가 없음 - 이 달은 확정할 수 없어요</small></h3>
        <div class="table-wrap"><table class="cmv2-lines cmv2-two"><tbody>
          ${r.cost_fallback.map(f => `<tr><th scope="row">${esc(f.product_code)} <small>${fmt(f.rows)}줄 · ${fmt(f.qty)}개</small></th><td class="num">${won(f.amount)}</td></tr>`).join("")}
        </tbody></table></div>` : ""}

      ${r.mp_unregistered && r.mp_unregistered.length ? `<h3 class="cmv2-h3">등록되지 않은 비용 ${chip("COST_UNREGISTERED")}</h3>
        <ul class="cmv2-list">${r.mp_unregistered.map(u => `<li>${esc(u.product_code)} · ${esc(u.label)} · ${fmt(u.orders)}건 ${fmt(u.qty)}개 - 금액을 몰라 빼지 않았어요(0원 확정 아님)</li>`).join("")}</ul>` : ""}

      <div class="cmv2-ref">
        <h3 class="cmv2-h3">취소·반품 원가환입 <small>환불 때 원판매 원가 자동 환입 · 회수 확인 뒤 미회수분만 반품 손실</small></h3>
        ${rec.auto_qty == null ? `<p class="cmv2-note">이 결과는 자동 원가환입 전(v2.5) 계산이에요 - 다음 계산부터 자동 원가환입·회수 확인이 반영돼요.</p>` : `
        <dl class="cmv2-ads cmv2-recov">
          <div><dt>자동 원가환입액 <small>환불 수량 × 원판매 원가</small></dt><dd>${won(rec.confirmed || 0)} <small>${fmt(rec.auto_rows)}건 · ${fmt(rec.auto_qty)}개</small></dd></div>
          <div><dt>실제 회수 확인 수량 <small>승인된 회수 확인 기록</small></dt><dd>${fmt(rec.recovered_qty)}개 <small>확인 완료 ${fmt(rec.confirmed_rows)}건</small></dd></div>
          <div><dt>반품 손실 <small>(환불 − 회수) × 원판매 원가</small></dt><dd>${won(-(rec.loss || 0))}</dd></div>
          <div><dt>회수·손실 확인 대기 ${rec.check_pending_qty > 0 ? chip("RECOVERY_CANDIDATE") : ""}</dt><dd>${fmt(rec.check_pending_qty)}개 <small>원가 ${won(rec.check_pending_amount || 0)} · 손실 우선 0원</small></dd></div>
        </dl>
        ${rec.check_pending_qty > 0 ? `<p class="cmv2-note"><span class="cmv2-prov">잠정</span> 회수·손실 확인 전 금액이에요. 확인되면 미회수분만 반품 손실로 빠져요(전량 미회수면 최대 ${won(-(rec.check_pending_amount || 0))}).</p>` : ""}
        ${(rec.check_needed || []).length ? `<p class="cmv2-note">${chip("COST_UNCONFIRMED", { text: "확인 필요" })} 원주문·원판매 원가를 찾지 못한 취소·반품 ${fmt(rec.check_needed.length)}건은 환입하지 않았어요.</p>` : ""}`}
        ${(rec.invalid || []).length ? `<p class="cmv2-note">${chip("COST_UNCONFIRMED", { text: "확인 필요" })} 정산 원본과 맞지 않는 회수 확인 기록 ${fmt(rec.invalid.length)}건 - 반품 손실 근거로 쓰지 않았어요.</p>` : ""}
        ${(rec.candidates || []).length ? `<p class="cmv2-note">반품 재판매 판매분(${rec.candidates.map(c => `${esc(c.vendor_item_id)} ${fmt(c.qty)}개`).join(" · ")})은 환불 때 원가를 환입했으니 판매 원가로 다시 비용이에요.</p>` : ""}
        ${recovery && global.CmRecovery ? global.CmRecovery.panelHtml(recovery) : ""}
      </div>

      ${cohort ? `<details class="cmv2-cohort"><summary>코호트(원주문월 기준) - 분석용 · 메인 공헌이익과 섞지 않음</summary>
        <p>${esc(month)} 주문의 취소를 원주문월에 붙이면 <b class="${tone(cohort.cm)}">${won(cohort.cm)}</b> (순매출 ${won(cohort.revenue)} · 취소 ${fmt(cohort.cancel.qty)}개).
          ${esc(String(cur.COHORT.as_of))}까지 처리된 취소 기준이라 이후 취소로 계속 바뀌어요.</p></details>` : ""}

      ${cd ? `<aside class="cmv2-coupang" aria-label="상품원가 차감 전 쿠팡 정산 잔액(참고)">
        <h3 class="cmv2-h3">상품원가 차감 전 쿠팡 정산 잔액 <small>쿠팡 수익 현황의 '이익' · 참고 · 공헌이익 아님</small></h3>
        <p><b>${won(cd.amount)}</b> = 환불 반영 판매액 ${won(cd.sales_with_refund)} − 쿠팡 차감 ${won(cd.deductions)}</p>
        <p class="cmv2-note">쿠팡이 할인·수수료·광고·물류·구독을 뺀 뒤의 금액이에요(부가세 포함, 상품원가 미반영). 공헌이익과 다른 지표라 비교하지 않아요.</p>
      </aside>` : ""}`;
  }

  /** 2026-09-15 공헌이익 화면 맨 위 주 결과 카드 - 스위치 ON + 성공 MAIN 결과가 있을 때. controls = 월 선택·버튼(app.js 가 넘김) */
  function primaryHtml(cur, { month, recovery, controls = "" } = {}) {
    const main = cur.MAIN;
    const r = main.result || {};
    const rec = r.cost_recovery || {};
    const st = stateText(main);
    const v27 = rec.auto_qty != null;
    return `
    <section class="card cmv2 cmv2-primary" id="cmv2" aria-labelledby="cmv2-h" data-snapshot-id="${esc(main.id ?? "")}">
      <div class="card-head"><h2 id="cmv2-h">${esc(month)} 공헌이익 <span class="cmv2-tag">정산자료 기준</span></h2>
        ${controls ? `<div class="cmv2-controls">${controls}</div>` : ""}</div>
      <p class="cmv2-meta">기간 <b>${esc(periodText(main))}</b> · 쿠팡 매출인식일 기준 · 메인(취소 처리월) · 상태 <b class="cmv2-prov">${st}</b>
        · 계산 ${esc(kstTime(main.created_at))}${main.id != null ? ` · 결과 #${esc(main.id)}` : ""}${main.calc_version ? ` · ${esc(String(main.calc_version).replace("cm_settlement_", ""))}` : ""}</p>
      <div class="grid-stats cmv2-stats">
        <div class="stat cmv2-stat-main"><div class="stat-label">공헌이익 <span class="cmv2-prov">${st}</span></div>
          <div class="stat-value${Number(main.cm) < 0 ? " red" : ""}">${won(main.cm)}</div><div class="cmv2-stat-sub">공헌이익률 ${rateText(r)}</div></div>
        <div class="stat"><div class="stat-label">순매출 <small>공급가액</small></div><div class="stat-value">${won(r.revenue)}</div></div>
        ${v27 ? `
        <div class="stat"><div class="stat-label">자동 원가환입</div><div class="stat-value">${won(rec.confirmed || 0)}</div>
          <div class="cmv2-stat-sub">${fmt(rec.auto_rows)}건 · ${fmt(rec.auto_qty)}개 · 환불 수량 × 원판매 원가</div></div>
        <div class="stat"><div class="stat-label">회수·손실 확인 대기</div><div class="stat-value${rec.check_pending_qty > 0 ? " amber" : ""}">${fmt(rec.check_pending_qty)}개</div>
          <div class="cmv2-stat-sub">${fmt(rec.check_pending_rows)}건 · 원가 ${won(rec.check_pending_amount || 0)} · 손실 우선 0원</div></div>
        <div class="stat"><div class="stat-label">반품 손실</div><div class="stat-value">${won(-(rec.loss || 0))}</div>
          <div class="cmv2-stat-sub">실제 회수 확인 ${fmt(rec.recovered_qty)}개 · 확인 완료 ${fmt(rec.confirmed_rows)}건</div></div>` : ""}
      </div>
      ${whyHtml(main.reasons)}
      <p class="cmv2-note cmv2-src-line">출처: ${sourceLine(r)}</p>
      ${bodyHtml(cur, { month, recovery })}
    </section>`;
  }

  /** 기존 운영 계산과 같은 기간 비교(참고) - '기존 계산과 비교' 접힌 칸 안. 기존 계산은 초록색 강조 없이 참고값으로만 */
  function compareHtml(cur, prod) {
    if (!cur || !cur.MAIN || !prod) return "";
    const main = cur.MAIN;
    const cmp = compare(main, prod);
    const pe = String(main.period_end).slice(5, 10), ps = String(main.period_start).slice(5, 10);
    return `
    <section class="card cm-cmp" aria-labelledby="cm-cmp-h">
      <h2 id="cm-cmp-h">같은 기간 비교 <span class="cmv2-ref-tag">참고</span></h2>
      <div class="cm-cmp-grid" role="group" aria-label="기존 운영 계산과 정산자료 계산 비교(같은 기간)">
        <div class="cmv2-vs-col"><span class="cmv2-vs-label">기존 운영 계산(참고) <small>${esc(ps)}~${esc(pe)} 같은 기간 · 주문 기준</small></span>
          <b class="cm-ref-amt">${won(cmp.production)}</b></div>
        <div class="cmv2-vs-col cmv2-vs-new"><span class="cmv2-vs-label">정산자료 기준 <small>주 결과 · ${stateText(main)}</small></span>
          <b>${won(main.cm)}</b></div>
        <div class="cmv2-vs-col"><span class="cmv2-vs-label">차이 <small>정산자료 − 기존</small></span>
          <b class="cm-ref-amt">${signed(cmp.diff)}</b></div>
      </div>
      <details class="cmv2-diff"><summary>차이 구성 (금액이 큰 순)</summary>
        <div class="table-wrap"><table class="cmv2-lines cmv2-two"><tbody>
          ${[...cmp.items].sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)).map(x => `<tr><th scope="row">${esc(x.label)}</th>
            <td class="num">${signed(x.amount)}</td></tr>`).join("")}
          <tr class="cmv2-total"><th scope="row">= 차이</th><td class="num"><b>${signed(cmp.diff)}</b></td></tr>
        </tbody></table></div></details>
    </section>`;
  }

  /** 주 결과가 없을 때 맨 위 카드 - kind: "ERROR"(조회 실패) · "EMPTY"(이 달 결과 없음). 기존 계산을 대신 주 결과로 보여 주지 않아요 */
  function noticeHtml(kind, { month, error, controls = "" } = {}) {
    const UI = global.ErpUi;
    const b = (k, t) => (UI && UI.badge ? UI.badge(k, { text: t, small: true }) : `<span class="erp-badge erp-badge--sm">${esc(t)}</span>`);
    const body = kind === "ERROR"
      ? `<p class="cmv2-fail" role="alert">${b("error", "정산자료 계산 조회 실패")} 정산자료 기준 공헌이익을 불러오지 못했어요${error ? ` (${esc(error)})` : ""}.
          기존 운영 계산을 대신 주 결과로 보여 주지 않아요 - 기존 계산은 아래 '기존 계산과 비교'에 참고값으로만 있어요. 잠시 뒤 새로고침해 주세요.</p>`
      : `<p class="cmv2-note">${b("info", "결과 없음")} ${esc(month || "")} 정산자료 기준 계산 결과가 아직 없어요. 기존 운영 계산은 아래 '기존 계산과 비교'에 참고값으로만 있어요.</p>`;
    return `
    <section class="card cmv2 cmv2-primary${kind === "ERROR" ? " cmv2-failed" : ""}" id="cmv2" aria-labelledby="cmv2-h">
      <div class="card-head"><h2 id="cmv2-h">${esc(month || "")} 공헌이익 <span class="cmv2-tag">정산자료 기준</span></h2>
        ${controls ? `<div class="cmv2-controls">${controls}</div>` : ""}</div>
      ${body}
    </section>`;
  }

  /** 대시보드 공헌이익 칸의 주 결과(공헌이익 화면 맨 위 카드와 같은 값·기간·상태) */
  function dashboardMainHtml(cur) {
    const main = cur.MAIN;
    const r = main.result || {};
    const rec = r.cost_recovery || {};
    return `<div class="cmv2-dmain" aria-label="정산자료 기준 공헌이익(주 결과)">
      <div class="cmv2-dmain-top">
        <span class="cmv2-dmain-label">공헌이익 <small>정산자료 기준 · ${esc(periodText(main))}</small></span>
        <b class="cmv2-dmain-amt${Number(main.cm) < 0 ? " cmv2-neg" : ""}">${won(main.cm)}</b>
        <span class="cmv2-prov">${stateText(main)}</span>
        <span class="cmv2-dmain-rate">공헌이익률 <b>${rateText(r)}</b></span>
      </div>
      <dl class="cmv2-dmain-kv">
        <div><dt>순매출</dt><dd>${won(r.revenue)}</dd></div>
        ${rec.auto_qty != null ? `
        <div><dt>자동 원가환입</dt><dd>${won(rec.confirmed || 0)} <small>${fmt(rec.auto_rows)}건 · ${fmt(rec.auto_qty)}개</small></dd></div>
        <div><dt>회수·손실 확인 대기</dt><dd>${fmt(rec.check_pending_qty)}개 <small>${fmt(rec.check_pending_rows)}건 · 손실 우선 0원</small></dd></div>
        <div><dt>반품 손실</dt><dd>${won(-(rec.loss || 0))}</dd></div>` : ""}
      </dl>
      <div class="cmv2-dash-chips">${reasonsHtml(main.reasons)}</div>
    </div>`;
  }

  /** 대시보드 - 주 결과가 없을 때(조회 실패 · 결과 없음) */
  function dashboardNoticeHtml(kind, error) {
    const UI = global.ErpUi;
    const b = (k, t) => (UI && UI.badge ? UI.badge(k, { text: t, small: true }) : `<span class="erp-badge erp-badge--sm">${esc(t)}</span>`);
    return kind === "ERROR"
      ? `<p class="cmv2-fail" role="alert">${b("error", "정산자료 계산 조회 실패")} 정산자료 기준 공헌이익을 불러오지 못했어요${error ? ` (${esc(error)})` : ""}.
          아래 기존 운영 계산은 참고값이에요(주 결과 아님).</p>`
      : `<p class="cmv2-note">${b("info", "결과 없음")} 이 달 정산자료 기준 계산 결과가 아직 없어요. 아래 기존 운영 계산은 참고값이에요.</p>`;
  }

  /** 대시보드 '기존 계산과 비교' 안의 같은 기간 한 줄 */
  function dashboardCompareHtml(cur, prod) {
    if (!cur || !cur.MAIN || !prod) return "";
    const cmp = compare(cur.MAIN, prod);
    return `<p class="cmv2-note">같은 기간(${esc(periodText(cur.MAIN))}) 기존 운영 계산 ${won(cmp.production)} → 정산자료 ${won(cur.MAIN.cm)} · 차이 ${signed(cmp.diff)}
      <a class="dash-link" href="#/profit">차이 구성 ›</a></p>`;
  }


  /* ───────── 2026-09-16 최신 자료 기여액(월 공통비 차감 전) ─────────
     월 확정 공헌이익은 정산 원천 '월 비용 조회'가 있는 구간까지만 계산돼요(지금 09-13).
     그 뒤 날짜는 매출·정산 파일이 들어와 있어도 월 공통비가 없어서 공헌이익을 만들 수 없습니다.
     그래서 최신 자료로는 **월 공통비를 빼기 전 기여액**만 따로 보여 줘요 - 이름도 표도 확정 공헌이익과 다릅니다.
     자료: sync_job_status('cm_contribution_latest') 의 고정 크기 요약(백엔드 run_cm_contribution_snapshot 이 하루 1회 기록). */
  const CONTRIB_JOB = "cm_contribution_latest";
  const MISSING_TEXT = {
    COST_SUMMARY_MISSING: "정산 원천 월 비용 조회가 이 기간에 아직 없어요",
    COST_SUMMARY_STALE: "월 비용 조회 시각이 기간이 끝나기 전이라 쓰지 않아요",
    MONTHLY_COST_DATA_CHECK: "월 비용 항목에 확인할 점이 있어 쓰지 않아요",
  };

  /** 최신 기여액 스냅샷 - null(아직 없음) · {error} · {detail, lastSuccessAt, lastAttemptAt, lastError, failures} */
  async function loadContribution(sb) {
    try {
      const { data, error } = await sb.from("sync_job_status")
        .select("job_name,last_success_at,last_attempt_at,last_error,error_kind,consecutive_failures,detail")
        .eq("job_name", CONTRIB_JOB).maybeSingle();
      if (error) return { error: error.message || String(error) };
      if (!data) return null;
      const d = typeof data.detail === "string" ? JSON.parse(data.detail || "{}") : (data.detail || {});
      if (!d || d.version !== 1 || !d.period_end) return { error: "기여액 요약 형식을 알 수 없어요" };
      return { detail: d, lastSuccessAt: data.last_success_at, lastAttemptAt: data.last_attempt_at,
               lastError: data.last_error, failures: Number(data.consecutive_failures || 0) };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  /** 마지막 시도가 실패했는지(성공 시각보다 뒤에 실패한 시도가 있으면) - 값은 직전 성공분 그대로 보여 주고 사실만 알려요 */
  function contribStale(c) {
    if (!c || !c.detail) return null;
    if (c.lastError && (!c.lastSuccessAt || String(c.lastAttemptAt || "") > String(c.lastSuccessAt))) {
      return `마지막 갱신 시도가 실패했어요(${c.failures || 1}회 연속) - 아래 값은 ${kstTime(c.lastSuccessAt)} 마지막 성공분이에요`;
    }
    return null;
  }

  function contribLinesHtml(d) {
    const p = d.provisional_cm && d.provisional_cm.is_confirmed === false ? d.provisional_cm : null;
    const row = ln => `<tr>
        <th scope="row">${esc(costName(ln.label))}</th>
        <td class="num">${won(ln.amount)}</td>
        <td class="cmv2-srccol">${ln.source ? `<span class="cmv2-src">${esc(ln.source)}</span>` : `<span class="cmv2-none">—</span>`}</td>
        <td class="cmv2-st">${lineStatusHtml(ln.status)}</td></tr>`;
    const rev = (d.lines || []).filter(x => String(x.code).startsWith("REVENUE"));
    const rest = (d.lines || []).filter(x => !String(x.code).startsWith("REVENUE"));
    const m = d.monthly_cost || {};
    return `<div class="table-wrap"><table class="cmv2-lines">
      <thead><tr><th>항목</th><th class="num">금액(공급가액)</th><th>출처</th><th>상태</th></tr></thead>
      <tbody>
        ${rev.map(row).join("")}
        ${rest.map(row).join("")}
        <tr class="cmv2-total"><th scope="row">= 월 공통비 차감 전 기여액 <small>공헌이익 아님</small></th>
          <td class="num"><b class="${Number(d.subtotal_before_monthly) < 0 ? "cmv2-neg" : ""}">${won(d.subtotal_before_monthly)}</b></td>
          <td></td><td class="cmv2-st"><span class="cmv2-prov">잠정</span></td></tr>
        <tr><th scope="row">− 월 공통비 <small>입출고비 · 배송비 · 보관비 · 세이버/구독</small></th>
          <td class="num">${m.available ? won(-Number(m.total || 0)) : `<span class="cmv2-none">금액 없음</span>`}</td>
          <td class="cmv2-srccol">${m.available ? `<span class="cmv2-src">정산파일</span>` : `<span class="cmv2-none">—</span>`}</td>
          <td class="cmv2-st">${m.available ? lineStatusHtml("CYCLE_OPEN") : chip("COST_UNREGISTERED", { text: "자료 없음", title: esc(m.reason || "") })}</td></tr>
        ${p && Number(p.inbound_freight || 0) ? `<tr><th scope="row">− 입고 운반비 <small>판매된 수량에 배분</small></th>
          <td class="num">${won(-Number(p.inbound_freight))}</td>
          <td class="cmv2-srccol"><span class="cmv2-src">운송비 명세서</span></td>
          <td class="cmv2-st">${lineStatusHtml("CYCLE_OPEN")}</td></tr>` : ""}
        ${p ? `<tr class="cmv2-total"><th scope="row">= 최신 잠정 공헌이익 <small>확정 아님</small></th>
          <td class="num"><b class="${Number(p.amount) < 0 ? "cmv2-neg" : ""}">${won(p.amount)}</b></td>
          <td></td><td class="cmv2-st"><span class="cmv2-prov">잠정</span></td></tr>` : ""}
      </tbody></table></div>`;
  }

  /** 공헌이익 화면 - 확정 카드 아래 '최신 자료 기여액' 카드. confirmed = cm_settlement_current 의 MAIN(있으면) */
  function contributionHtml(c, { confirmed = null } = {}) {
    if (!c) return `<section class="card cmv2 cmv2-contrib" aria-labelledby="cmc-h">
      <div class="card-head"><h2 id="cmc-h">최신 자료 기여액</h2></div>
      <p class="cmv2-note">${chip("COST_UNREGISTERED", { text: "결과 없음" })} 아직 기여액 스냅샷이 없어요(06:20 통합수집 뒤 하루 1회 계산).</p></section>`;
    if (c.error) return `<section class="card cmv2 cmv2-contrib" aria-labelledby="cmc-h">
      <div class="card-head"><h2 id="cmc-h">최신 자료 기여액</h2></div>
      <p class="cmv2-fail" role="alert">${chip("COST_UNREGISTERED", { text: "조회 실패" })} 기여액을 불러오지 못했어요 (${esc(c.error)}).
        확정 공헌이익 값을 대신 쓰지 않아요.</p></section>`;
    const d = c.detail;
    const m = d.monthly_cost || {};
    const stale = contribStale(c);
    // 2026-09-16 최신 잠정 공헌이익 - 월 공통비까지 뺀 값이지만 *확정이 아니에요*.
    // 저장된 스냅샷(confirmed_cm)과 다른 칸에 따로 보여 주고, 확정으로 읽히지 않게 표시해요.
    const p = (d.provisional_cm && d.provisional_cm.is_confirmed === false) ? d.provisional_cm : null;
    const confPeriod = confirmed ? `${String(confirmed.period_start).slice(5)}~${String(confirmed.period_end).slice(5)}` : null;
    return `
    <section class="card cmv2 cmv2-contrib" id="cmv2-contrib" aria-labelledby="cmc-h" data-period-end="${esc(d.period_end)}">
      <div class="card-head"><h2 id="cmc-h">최신 자료 공헌이익 <span class="cmv2-tag">${p ? "잠정 · 확정 전" : "월 공통비 차감 전"}</span></h2></div>
      <p class="cmv2-meta">기간 <b>${esc(d.period_start)} ~ ${esc(d.period_end)}</b> · 최신 자료 기준일 <b>${esc(d.latest_data_date)}</b>
        · 갱신 ${esc(kstTime(c.lastSuccessAt))}${d.run_id ? ` · 실행 ${esc(String(d.run_id).slice(0, 8))}` : ""}</p>
      ${stale ? `<p class="cmv2-fail" role="alert">${chip("COST_UNREGISTERED", { text: "갱신 실패" })} ${esc(stale)}</p>` : ""}
      <div class="grid-stats cmv2-stats">
        ${p ? `
        <div class="stat cmv2-stat-main"><div class="stat-label">최신 잠정 공헌이익 <span class="cmv2-prov">확정 아님</span></div>
          <div class="stat-value${Number(p.amount) < 0 ? " red" : ""}">${won(p.amount)}</div>
          <div class="cmv2-stat-sub">${esc(p.period_start)}~${esc(p.period_end)} · 월 확정(승인) 전이에요</div></div>` : ""}
        <div class="stat${p ? "" : " cmv2-stat-main"}"><div class="stat-label">월 공통비 차감 전 기여액 <span class="cmv2-prov">잠정</span></div>
          <div class="stat-value${Number(d.subtotal_before_monthly) < 0 ? " red" : ""}">${won(d.subtotal_before_monthly)}</div>
          <div class="cmv2-stat-sub">${esc(d.period_start)}~${esc(d.period_end)} · 공헌이익이 아니에요</div></div>
        <div class="stat"><div class="stat-label">월 확정 공헌이익 <small>저장된 확정 계산</small></div>
          <div class="stat-value">${confirmed ? won(confirmed.cm) : d.confirmed_cm ? won(d.confirmed_cm.cm) : `<span class="cmv2-none">없음</span>`}</div>
          <div class="cmv2-stat-sub">${confPeriod ? esc(confPeriod) : d.confirmed_cm ? `~${esc(String(d.confirmed_cm.period_end).slice(5))}` : "—"} 기준 · 이 카드가 덮어쓰지 않아요</div></div>
        <div class="stat"><div class="stat-label">월 공통비</div>
          <div class="stat-value${m.available ? "" : " amber"}">${m.available ? won(m.total) : "자료 없음"}</div>
          <div class="cmv2-stat-sub">${esc(m.range || "")}${m.available ? "" : ` · ${esc(MISSING_TEXT[m.status] || m.status || "")}`}</div></div>
      </div>
      ${p ? `
      <p class="cmv2-note"><b>위 금액은 아직 확정이 아닙니다.</b> ${esc(p.period_start)}~${esc(p.period_end)} 자료로 월 공통비(${won(p.monthly_cost)})와 판매분 입고 운반비(${won(p.inbound_freight || 0)})를 뺀
        <b>잠정</b> 공헌이익이에요. 월 마감 승인(월 확정)을 거치지 않았고, 저장된 공헌이익 스냅샷을 덮지도 않아요.
        ${p.settlement_closed ? "" : `아직 정산이 끝나지 않은 날(${(p.open_cycle_days || []).map(esc).join(", ")})이 있어 수수료가 더 바뀔 수 있어요.`}</p>
      <p class="cmv2-note">확정으로 쓰려면 남은 확인이 필요해요: ${(p.confirm_blocked_reasons || []).map(esc).join(" · ") || "-"}</p>` : `
      <p class="cmv2-note"><b>이 금액은 공헌이익이 아닙니다.</b> 월 공통비(입출고비·배송비·보관비·세이버/구독)를 아직 빼지 않은 금액이에요.
        빠진 자료를 0원으로 만들거나 하루 평균으로 나눠 채우지 않아요 - 월 공통비 조회가 들어오면 그때 확정 공헌이익이 ${esc(d.period_end)} 까지 늘어납니다.</p>`}
      ${whyHtml(d.reasons)}
      <details class="cmv2-det"><summary>계산 내역 (${fmt((d.rows || {}).orders)}건 주문 · ${fmt((d.rows || {}).cancels)}건 취소)</summary>
        ${contribLinesHtml(d)}
        <p class="cmv2-note">정산 마감 ${d.settlement_closed ? "완료" : `진행 중${(d.open_cycle_days || []).length ? ` (${(d.open_cycle_days || []).map(esc).join(", ")})` : ""}`}
          · 계산 ${esc(d.calc_version || "")} / ${esc(d.contrib_version || "")}${d.inputs_hash ? ` · 입력 ${esc(String(d.inputs_hash).slice(0, 12))}` : ""}
          ${d.artifacts ? `· 보관 <code class="cmv2-file">${esc(d.artifacts)}</code>` : ""}</p>
      </details>
    </section>`;
  }

  /** 대시보드 공헌이익 칸 - 확정값 아래 한 줄로 '기여액 기준일'을 같이 보여 줘요(두 기준일이 한눈에) */
  function dashboardContributionHtml(c) {
    if (!c) return "";
    if (c.error) return `<p class="cmv2-note">${chip("COST_UNREGISTERED", { text: "기여액 조회 실패" })} 최신 자료 기여액을 불러오지 못했어요.</p>`;
    const d = c.detail;
    const m = d.monthly_cost || {};
    const stale = contribStale(c);
    const p = (d.provisional_cm && d.provisional_cm.is_confirmed === false) ? d.provisional_cm : null;
    return `<div class="cmv2-dcontrib">
      <div class="cmv2-dmain-top">
        <span class="cmv2-dmain-label">${p ? "최신 잠정 공헌이익" : "월 공통비 차감 전 기여액"}
          <small>최신 자료 ${esc(d.latest_data_date)} 까지 · ${p ? "확정 아님" : "공헌이익 아님"}</small></span>
        <b class="cmv2-dmain-amt${Number(p ? p.amount : d.subtotal_before_monthly) < 0 ? " cmv2-neg" : ""}">${won(p ? p.amount : d.subtotal_before_monthly)}</b>
        <span class="cmv2-prov">${p ? "확정 전" : "잠정"}</span>
      </div>
      <p class="cmv2-note">${p ? `월 공통비 ${won(p.monthly_cost)} · 판매분 입고 운반비 ${won(p.inbound_freight || 0)} 반영 · 기여액 ${won(p.subtotal_before_monthly)}`
        : (m.available ? `월 공통비 ${won(m.total)} 반영 가능` : `월 공통비 자료 없음 - ${esc(MISSING_TEXT[m.status] || m.status || "")}`)}
        · 갱신 ${esc(kstTime(c.lastSuccessAt))}${stale ? ` · <b>${esc(stale)}</b>` : ""}</p>
    </div>`;
  }

  /** 대시보드 칸 제목 아래 설명 */
  function dashboardMeta(cur) {
    const m = cur.MAIN;
    return `정산자료 기준 · ${periodText(m)} · ${stateText(m)} · 계산 ${kstTime(m.created_at)}${m.id != null ? ` · 결과 #${m.id}` : ""}`;
  }

  global.CmSettlement = { SETTING_KEY, STATUS, switchState, isEnabled, loadCurrent, prodParts, compare, primaryHtml, compareHtml, noticeHtml,
                          dashboardMainHtml, dashboardNoticeHtml, dashboardCompareHtml, dashboardMeta, chip, requiredInputsHtml, refundsRefHtml,
                          costName, kstTime,
                          CONTRIB_JOB, loadContribution, contributionHtml, dashboardContributionHtml, contribStale };
})(typeof window !== "undefined" ? window : globalThis);
