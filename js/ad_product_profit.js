/* ad_product_profit.js
 * -------------------------------------------------------------------------
 * 2026-09-16 상품별 광고·이익 화면 (계산은 서버 ad_product_profit.py - 이 파일은 보여 주기·보고서 올리기만).
 *
 *   · 원천: 쿠팡 광고센터 '상품광고 보고서(합계)' 파일을 올리면 서버 보관 폴더에 저장(운영 DB 쓰기 없음).
 *     같은 기간에는 활성 파일 하나만 계산에 써요(부분 캠페인·이른 추출 파일은 보관만, 더하지 않음).
 *   · 광고 관련 조작(입찰·예산·켜기/끄기)은 이 화면에 없어요. 조회와 파일 올리기만.
 *   · 값이 없으면 '—' + 사유(서버 reason). 0원으로 바꾸지 않아요.
 *   · 광고 후 이익은 두 가지 추정(성과 기준 = 보고서 광고비 / 회계 기준 = 정산 청구액 배분, 로켓그로스만)이고
 *     입출고비·배송비·보관비·세이버·입고 운송비·월 공통비 차감 전 - 최종 순이익이 아니에요.
 *   · ROAS = 전환매출(VAT 포함) ÷ 광고비(VAT 제외). 14일 전환은 창이 끝나기 전까지 잠정.
 *   · 2026-09-17 추출 시각: 파일 수정 시각(File.lastModified)은 복사·이동하면 바뀌어서 자동으로 쓰지 않아요(참고 표시만).
 *     사람이 확인한 실제 추출·다운로드 시각(MANUAL_CONFIRMED)을 넣거나 '모름'(UNKNOWN, 시각 없이)을 골라야 올릴 수 있어요.
 *     미확인 시각은 14일 전환을 확정하지 않고, 이미 활성인 보고서를 대체하지 않아요(판정은 서버).
 */
(function (global) {
  "use strict";

  const API_BASE = global.WING_SUBMIT_API_BASE || "https://34-30-248-218.sslip.io";
  const PREFIX = "/api/ad-product-profit";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const won = (v) => (isNum(v) ? (v < 0 ? "−₩" : "₩") + Math.abs(Math.round(v)).toLocaleString("ko-KR") : "—");
  const pct = (v) => (isNum(v) ? `${v.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%` : "—");
  const cnt = (v) => (isNum(v) ? Math.round(v).toLocaleString("ko-KR") : "—");
  const UI = () => global.ErpUi;
  const badge = (kind, text, reason) => (UI() ? UI().badge(kind, { text, reason, small: true })
    : `<span class="erp-badge erp-badge--${kind} erp-badge--sm">${esc(text)}${reason ? ` · ${esc(reason)}` : ""}</span>`);

  /** 서버 사유 'CODE: 설명' → 사람이 읽을 설명(코드만 오면 아래 표). */
  const REASON = {
    NO_SPEND: "광고비 0원 · 전환만 받은 옵션", MARGIN_SOURCE_MISSING: "같은 기간 상품 이익 원천 없음", CROSS_MONTH_UNSUPPORTED: "달을 넘는 기간",
    UNMAPPED: "ERP 상품 매핑 없음", MARGIN_NOT_AVAILABLE: "상품 이익 없음", COST_SUMMARY_MISSING: "같은 구간 월 비용 조회 없음",
  };
  function reasonText(r) {
    const s = String(r || "");
    if (!s) return "";
    const i = s.indexOf(":");
    const code = i > 0 ? s.slice(0, i).trim() : s.trim();
    const rest = i > 0 ? s.slice(i + 1).trim() : "";
    if (/^[A-Z][A-Z0-9_]+$/.test(code)) return rest || REASON[code] || code;
    return s;
  }
  const missing = (reason) => `<span class="adp-missing" title="${esc(reasonText(reason))}">—<small>${esc(reasonText(reason))}</small></span>`;
  /** { value, reason } 모양 값 → 표시 */
  const valOr = (o, f) => (o && o.value != null ? f(o.value) : missing(o && o.reason));

  const BUCKET = { RG: ["로켓그로스", "ok"], MP: ["판매자배송", "info"], UNMAPPED: ["미매핑", "check"], AMBIGUOUS: ["매핑 모호", "check"],
                   MAPPING_UNKNOWN: ["매핑표 없음", "error"] };
  const bucketBadge = (b) => badge((BUCKET[b] || [b, "muted"])[1], (BUCKET[b] || [b])[0]);
  const CHECK = { OK: ["ok", "일치"], MATCHED: ["ok", "일치"], DIFFERENT: ["check", "차이 있음(보정 안 함)"], FAIL: ["error", "불일치"],
                  SOURCE_MISSING: ["muted", "원천 없음"] };
  const MARGIN_STATUS = { AVAILABLE: ["ok", "같은 기간 이익"], AVAILABLE_PROVISIONAL: ["check", "같은 기간 이익 · 잠정"], PENDING: ["error", "이익 대기"] };
  const COVERAGE = { COMPLETE: ["ok", "전체 캠페인"], PARTIAL_CAMPAIGNS: ["check", "일부 캠페인"], PARTIAL_PRELIMINARY_EXTRACT: ["check", "끝날 전 부분 추출"],
                     UNVERIFIED: ["muted", "전체 캠페인 확인 불가"], EXTRACTION_TIME_UNVERIFIED: ["check", "추출 시각 미확인"] };
  const DECISION = { NEW: "새 보고서 · 활성", SUPERSEDES_SUBSET: "캠페인이 더 많은 파일로 대체(합산 안 함)", SUPERSEDES_REVISION: "더 늦게 받은 파일로 대체",
                     PARTIAL_SUBSET: "일부 캠페인 파일 · 보관만", STALE_REVISION: "더 이른 파일 · 보관만", CONFLICT_CAMPAIGN_SET: "캠페인 구성이 달라 보관만(확인 필요)",
                     DUPLICATE_FILE: "이미 올린 파일 · 변경 없음", DUPLICATE_CONTENT: "같은 내용 · 변경 없음",
                     UNVERIFIED_TIME_NOT_ACTIVATED: "추출 시각 미확인 · 기존 보고서 대체 안 함(보관만)",
                     PROVENANCE_CONFIRMED: "추출 시각 확인 기록 추가(원본 그대로)", PROVENANCE_CONFLICT: "이미 다른 시각으로 확인된 파일 · 바꾸지 않음",
                     PROVENANCE_REGRESSION: "확인 시각이 맞지 않음(되돌림·불가능한 시각) · 바꾸지 않음" };

  // 올리기 결과 → 배지 종류: 계산에 쓰임(ok) / 보관만·확인 필요(check) / 변경 없음(muted)
  const DECISION_KIND = { NEW: "ok", SUPERSEDES_SUBSET: "ok", SUPERSEDES_REVISION: "ok", PARTIAL_SUBSET: "check", STALE_REVISION: "check",
                          CONFLICT_CAMPAIGN_SET: "check", UNVERIFIED_TIME_NOT_ACTIVATED: "check", PROVENANCE_CONFIRMED: "ok", DUPLICATE_FILE: "muted", DUPLICATE_CONTENT: "muted" };
  const COST_BASIS = { HISTORY_OR_PURCHASE: "원가 이력·매입 기록", INCOMPLETE: "원가 모름(판매 일부)", "CURRENT_MASTER(원가 미확정)": "현재 상품 원가(원가 미확정)" };

  function kst(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    if (isNaN(d)) return String(ts);
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} KST`;
  }

  // ── 화면 조각(순수 함수 - 테스트 대상) ─────────────────────────────────────
  function metaHtml(s) {
    const r = s.source.report, mb = s.source.margin_bundle || {}, at = s.attribution, cov = s.report_coverage || {};
    const ms = MARGIN_STATUS[s.margin.status] || ["muted", s.margin.status];
    const cv = COVERAGE[cov.status] || ["muted", cov.status];
    return `<div class="adp-meta">
      <div><span>기간(광고 클릭일)</span><b>${esc(s.period.start)} ~ ${esc(s.period.end)}</b></div>
      <div><span>광고 보고서</span><b>${esc(r.file_name)}</b><small>추출 ${r.extracted_at ? esc(kst(r.extracted_at)) : "모름"} (${esc(r.extracted_at_source)}) · 가져옴 ${esc(kst(r.imported_at))}</small>
        ${r.extracted_at_verified
          ? ((r.provenance_history || []).length > 1
            ? badge("ok", "추출 시각 나중에 확인", `처음 ${r.original_extracted_at ? kst(r.original_extracted_at) : "모름"}(${r.original_extracted_at_source || "—"}) → 확인 ${(r.provenance_history || []).length - 1}회 · 원본 파일 그대로`)
            : "")
          : badge("check", "추출 시각 미확인", "14일 전환 확정·보고서 대체에 쓰지 않음 · 같은 파일을 실제 추출 시각과 함께 다시 올리면 확인으로 바뀌어요")}</div>
      <div><span>14일 전환</span>${at.status === "PROVISIONAL"
        ? badge("check", "잠정", at.extraction_time_verified === false ? "추출 시각 미확인 - 창 경과 여부 모름" : `${at.window_elapses_after} 이후 다시 받아야 확정에 가까움`)
        : badge("ok", "14일 창 지남")}</div>
      <div><span>상품 이익</span>${badge(ms[0], ms[1], s.margin.status === "PENDING" ? reasonText(s.margin.reason) : (s.margin.open_cycle_days || []).length ? `정산 진행 중 ${s.margin.open_cycle_days.join(", ")}` : "")}
        <small>원천 ${esc(mb.run_dir || "—")} · 생성 ${esc(kst(mb.generated_at))}</small></div>
      <div><span>보고서 범위</span>${badge(cv[0], cv[1], cov.reason || (cov.missing_in_report || []).join(", "))}</div>
      <div><span>옵션 매핑</span>${s.mapping && s.mapping.status === "OK" ? badge("ok", "ERP 매핑표(옵션 ID)") : badge("error", "매핑표 없음", "옵션을 미매핑으로 단정하지 않음")}</div>
    </div>`;
  }

  function statsHtml(s) {
    const b = s.buckets, t = s.reconciliation.report_totals;
    const items = [
      { label: "보고서 광고비(VAT 제외)", value: won(t.spend), kind: "info" },
      { label: "로켓그로스", value: won(b.RG.spend), kind: "ok", sub: `옵션 ${cnt(b.RG.options_all)}개` },
      { label: "판매자배송", value: won(b.MP.spend), kind: "info", sub: `옵션 ${cnt(b.MP.options_all)}개 · 정산 밖` },
      { label: "미매핑", value: won(b.UNMAPPED.spend), kind: b.UNMAPPED.spend ? "check" : "ok", sub: `옵션 ${cnt(b.UNMAPPED.options_all)}개 · 배분 안 함` },
      { label: "매핑 모호·매핑표 없음", value: won(b.AMBIGUOUS.spend + b.MAPPING_UNKNOWN.spend), kind: (b.AMBIGUOUS.spend + b.MAPPING_UNKNOWN.spend) ? "check" : "ok",
        hidden: !(b.AMBIGUOUS.options_all || b.MAPPING_UNKNOWN.options_all) },
      { label: "14일 전환매출(VAT 포함)", value: won(t.rev_14d), kind: s.attribution.status === "PROVISIONAL" ? "check" : "ok",
        sub: s.attribution.status === "PROVISIONAL" ? "잠정" : "" },
      { label: "다른 옵션으로 전환", value: won(s.cross_option.rev_14d), kind: "info", sub: `${cnt(s.cross_option.rows)}행 · 광고비 ${won(s.cross_option.spend)}` },
    ];
    return UI() ? UI().summaryHtml(items, { label: "광고 보고서 요약", compact: true })
      : items.filter((x) => !x.hidden).map((x) => `<div>${esc(x.label)} ${esc(x.value)}</div>`).join("");
  }

  const BUCKET_FILTERS = [["ALL", "전체"], ["RG", "로켓그로스"], ["MP", "판매자배송"], ["OTHER", "미매핑·모호"]];
  function inFilter(row, f) {
    if (f === "ALL") return true;
    if (f === "OTHER") return !["RG", "MP"].includes(row.bucket);
    return row.bucket === f;
  }

  const td = (label, html, cls = "") => `<td class="num ${cls}" data-label="${esc(label)}"><div class="adp-v">${html}</div></td>`;
  function toggleDetail(id, btn) {
    const row = global.document && global.document.getElementById(id);
    if (!row) return;
    const open = row.hidden;
    row.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.textContent = open ? "내역 접기" : "계산 내역";
  }

  function productRowHtml(r, i) {
    const a = r.ad || {}, m = r.margin || {}, aa = r.after_ad || {}, bp = r.bep_roas || {};
    const id = `adp-d-${i}`;
    const spend = a.spend != null ? won(a.spend) : missing(a.note);
    const alloc = r.ad_spend.allocated_billed_estimate != null ? won(r.ad_spend.allocated_billed_estimate)
      : `<span class="adp-muted">배분 없음</span>`;
    const roas = a.roas_14d_advertised != null ? pct(a.roas_14d_advertised) : missing(a.roas_reason || a.note);
    const before = m.cm_before_ads_and_common != null ? `${won(m.cm_before_ads_and_common)}<small>${pct(m.margin_rate_pct)}</small>`
      : missing(m.profit_withheld_reason || m.reason);
    const after = (o) => (o && o.value != null ? `<span class="${o.value < 0 ? "adp-neg" : ""}">${won(o.value)}</span><small>${o.margin_pct != null ? pct(o.margin_pct) : "이익률 —"}</small>` : missing(o && o.reason));
    const bep = (o) => (o && o.value != null ? `${pct(o.value)}${o.provisional ? " · 잠정" : ""}` : missing(o && o.reason));
    const name = r.product_code ? `<b>${esc(r.product_code)}</b>` : `<b>${esc(r.key)}</b>`;
    const setInfo = r.set_parent_code && r.set_parent_code !== r.product_code ? `<small>세트 · 기준 ${esc(r.set_parent_code)}</small>` : "";
    return `<tr class="adp-row" data-bucket="${esc(r.bucket)}">
      <td class="erp-card-head">${name}${setInfo}<div>${bucketBadge(r.bucket)}</div>
        <button type="button" class="erp-m-toggle" aria-expanded="false" onclick="ErpUi.toggleCard(this)">세부 보기</button>
        <button type="button" class="btn sm secondary adp-detail-btn" aria-expanded="false" aria-controls="${id}" onclick="AdProductProfit.toggleDetail('${id}', this)">계산 내역</button></td>
      ${td("광고비(실제)", spend)}
      ${td("청구 배분(추정)", alloc)}
      ${td("ROAS 14일(광고 기준)", roas)}
      ${td("전환매출 14일(전환 상품)", a.conv_rev_14d != null ? won(a.conv_rev_14d) : "—", "erp-m-detail")}
      ${td("순매출(공급가액)", m.revenue_supply != null ? won(m.revenue_supply) : missing(m.reason), "erp-m-detail")}
      ${td("광고 전 이익(률)", before)}
      ${td("광고 후 · 성과 기준", after(aa.performance_basis))}
      ${td("광고 후 · 회계 기준", after(aa.accounting_basis))}
      ${td("손익분기 ROAS(환입 제외 / 잠정 환입)", `<span class="adp-bep"><small>환입 제외</small>${bep(bp.excluding_recovery)}</span><span class="adp-bep"><small>잠정 환입 포함</small>${bep(bp.including_provisional_recovery)}</span>`, "erp-m-detail")}
    </tr>
    <tr id="${id}" class="adp-detail" hidden><td colspan="10">${detailHtml(r)}</td></tr>`;
  }

  function detailHtml(r) {
    const a = r.ad || {}, m = r.margin || {}, sw = r.sales_account_wide, sa = r.sales_ad_attributed, aa = r.after_ad || {};
    const kv = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
    const basis = (o, label) => (o && o.value != null
      ? kv(label, `${won(o.before_ad)} − ${won(o.ad_deducted)} = ${won(o.value)}${o.recovery_provisional ? ` · 잠정 환입 포함 ${won(o.with_provisional_recovery)}` : ""}`)
      : kv(label, missing(o && o.reason)));
    return `<div class="adp-kv">
      ${kv("전체 판매(ERP · 공급가액)", sw ? `${won(sw.revenue_supply)} · ${cnt(sw.qty)}개` : missing(m.reason))}
      ${kv("광고 전환(14일 · VAT 포함)", sa ? `${won(sa.conv_rev_14d_vat_incl)} · ${cnt(sa.conv_qty_14d)}개 (자기 광고 ${won(sa.from_own_ads)} · 다른 상품 광고 ${won(sa.from_other_ads)})` : "—")}
      ${kv("광고 기준 전환(14일)", a.adv_rev_14d != null ? `${won(a.adv_rev_14d)} (같은 옵션 ${won(a.adv_rev_14d_same_option)} · 다른 옵션 ${won(a.adv_rev_14d_cross)})` : "—")}
      ${kv("노출 · 클릭", a.impressions != null ? `${cnt(a.impressions)} · ${cnt(a.clicks)}` : "—")}
      ${kv("원가 · 수수료", `${m.cost != null ? won(m.cost) : missing(m.profit_withheld_reason || m.reason)} · ${m.fee != null ? won(m.fee) : missing(m.profit_withheld_reason || m.reason)}`)}
      ${kv("원가 기준", esc(COST_BASIS[m.cost_basis] || m.cost_basis || "—"))}
      ${kv("정산 진행 중 수수료", m.fee_cycle_open != null ? won(m.fee_cycle_open) : "—")}
      ${kv("취소·반품 원가환입(잠정)", m.recovery_auto_provisional != null ? `${won(m.recovery_auto_provisional)} · 회수 확인 대기 ${cnt(m.recovery_check_pending_qty)}개 ${m.recovery_check_pending_amount != null ? won(m.recovery_check_pending_amount) : missing("원가 모르는 대기 행 있음")}` : "—")}
      ${basis(aa.performance_basis, "광고 후 · 성과 기준(보고서 광고비)")}
      ${basis(aa.accounting_basis, "광고 후 · 회계 기준(정산 청구액 배분)")}
      ${kv("옵션 ID", esc((a.options || []).join(", ") || "—"))}
    </div>
    <p class="adp-note">${esc(aa.scope || "")}</p>`;
  }

  function productsHtml(s, filter) {
    const rows = s.products.filter((r) => inFilter(r, filter));
    const counts = Object.fromEntries(BUCKET_FILTERS.map(([k]) => [k, s.products.filter((r) => inFilter(r, k)).length]));
    const tabs = BUCKET_FILTERS.map(([k, label]) => `<button type="button" class="btn sm ${k === filter ? "" : "secondary"}" aria-pressed="${k === filter}"
      onclick="AdProductProfit.setFilter('${k}')">${esc(label)} ${counts[k]}</button>`).join("");
    return `<div class="card">
      <div class="card-head"><h2>상품별 광고·이익</h2><div class="adp-tabs" role="group" aria-label="채널 구분">${tabs}</div></div>
      <p class="adp-scope">광고 후 이익은 <b>추정</b>이에요 - 입출고비·배송비·보관비·세이버·입고 운송비·월 공통비 차감 <b>전</b>, 최종 순이익이 아니에요.
        성과 기준은 보고서 광고비, 회계 기준은 로켓그로스 정산 청구액을 캠페인 안 집행 비율로 나눈 값이에요. ROAS = 전환매출(VAT 포함) ÷ 광고비(VAT 제외).</p>
      <div class="erp-table-wrap"><table class="erp-table erp-cards adp-table">
        <thead><tr><th>상품</th><th class="num">광고비(실제)</th><th class="num">청구 배분(추정)</th><th class="num">ROAS 14일</th>
          <th class="num">전환매출 14일</th><th class="num">순매출(공급가액)</th><th class="num">광고 전 이익</th>
          <th class="num">광고 후 · 성과</th><th class="num">광고 후 · 회계</th><th class="num">손익분기 ROAS</th></tr></thead>
        <tbody>${rows.map((r) => productRowHtml(r, s.products.indexOf(r))).join("") || `<tr><td colspan="10">해당 상품 없음</td></tr>`}</tbody>
      </table></div></div>`;
  }

  function reconciliationHtml(s) {
    const rc = s.reconciliation, pt = rc.product_erp_totals || {};
    const line = (c) => {
      const st = CHECK[c.status] || ["muted", c.status];
      return `<tr><td class="erp-card-head">${esc(c.label)}</td>${td("상태", badge(st[0], st[1]), "adp-status")}
        ${td("왼쪽", won(c.left))}${td("오른쪽", c.right == null ? missing("원천 없음") : won(c.right))}${td("차이", c.diff == null ? "—" : won(c.diff))}</tr>`;
    };
    const d = pt.detail || {};
    return `<div class="card"><h2>대사 · 차이</h2>
      <p class="adp-note">다른 원천(계정 일별 합계·정산서)과의 차이는 맞추지 않고 그대로 보여 줘요.</p>
      <div class="erp-table-wrap"><table class="erp-table erp-cards"><thead><tr><th>항목</th><th>상태</th><th class="num">왼쪽</th><th class="num">오른쪽</th><th class="num">차이</th></tr></thead>
      <tbody>${rc.checks.map(line).join("")}</tbody></table></div>
      <p class="adp-note">상품 합계 ↔ 기존 기여액 계산: ${pt.status === "MATCHED" ? badge("ok", "일치", `매출 ${won(d.contribution && d.contribution.revenue)} · 원가 ${won(d.contribution && d.contribution.cost)} · 수수료 ${won(d.contribution && d.contribution.fee)}`)
        : pt.status === "PENDING" ? badge("error", "대기", reasonText(pt.reason)) : badge("check", pt.status || "—")}</p>
    </div>`;
  }

  function unallocatedHtml(s) {
    const u = s.unallocated_costs || {};
    const mc = u.rg_monthly_common, fr = u.inbound_freight, mp = u.mp_parcel_packaging, ad = u.ad || {};
    const rowsMc = !mc ? missing("원천 없음") : mc.available
      ? `${won(mc.total)} <small>${(mc.items || []).map((x) => `${esc(x.label)} ${won(x.amount)}`).join(" · ")}</small>`
      : `${missing(mc.reason || mc.status)}${(mc.other_ranges_not_used || []).length ? `<small>다른 구간(같은 기간 아님 · 쓰지 않음): ${esc(mc.other_ranges_not_used.join(", "))}</small>` : ""}`;
    return `<div class="card"><h2>상품에 배분하지 않은 비용</h2>
      <p class="adp-note">${esc(u.statement || "")}</p>
      <div class="adp-kv">
        <div><span>로켓그로스 입출고비·배송비·보관비·세이버 (${esc(mc ? mc.range : "")})</span><b>${rowsMc}</b></div>
        <div><span>입고 트럭 운송비</span><b>${fr ? (fr.amount != null ? won(fr.amount) : missing(fr.reason || fr.status)) : missing("원천 없음")}</b></div>
        <div><span>판매자배송 택배비·포장비</span><b>${mp ? (mp.status === "INCLUDED_IN_COGS" ? "상품원가에 포함(대표 확인)" : esc(mp.note || mp.status)) : "—"}</b></div>
        <div><span>광고비 · 판매자배송 / 미매핑 / 모호(보고서)</span><b>${won(ad.mp_spend_direct)} / ${won(ad.unmapped_spend_direct)} / ${won(ad.ambiguous_spend_direct)}</b></div>
        <div><span>기여액의 정산 밖 광고비(ACCRUED) · 예산 초과 미청구</span><b>${won(ad.outside_rg_accrued_in_contribution)} · ${won(ad.over_budget_not_billed)}</b></div>
      </div><p class="adp-note">${esc(ad.note || "")}</p></div>`;
  }

  function filesHtml(s) {
    const other = s.other_files_same_period || [];
    if (!other.length) return "";
    return `<div class="card"><h2>같은 기간 다른 파일(계산에 안 씀)</h2><ul class="erp-items">${other.map((f) =>
      `<li>${esc(f.file_name)} · 추출 ${f.extracted_at ? esc(kst(f.extracted_at)) : "모름"}${f.extracted_at_verified === false ? "(미확인)" : f.confirmations ? "(나중에 확인)" : ""} · 캠페인 ${cnt(f.campaigns)}개 · 광고비 ${won(f.spend)} · ${esc(
        f.confirmations && f.decision === "UNVERIFIED_TIME_NOT_ACTIVATED" ? "처음엔 미확인이라 보관 · 확인 뒤에도 활성 조건 아님" : (DECISION[f.decision] || f.decision))}</li>`).join("")}</ul></div>`;
  }

  function uploadHtml(state) {
    const msg = state.uploadResult;
    return `<div class="card adp-upload"><h2>광고 보고서 올리기</h2>
      <p class="adp-note">쿠팡 광고센터 › 광고 보고서 › 상품광고 · <b>합계</b> · 전체 캠페인으로 만든 파일을 이름 그대로 올려 주세요.
        추출 시각은 파일 안에 없어요 - 광고센터 '요청한 보고서'의 생성·다운로드 시각을 확인해 넣어 주세요. 파일 수정 시각은 복사하면 바뀌어서 자동으로 쓰지 않아요.
        '모름'으로 올린 보고서는 같은 파일(또는 같은 내용으로 다시 받은 파일)을 확인한 시각과 함께 다시 올리면 원본은 그대로 두고 확인 기록만 더해요.</p>
      <form class="adp-form" onsubmit="return AdProductProfit.upload(event)">
        <label>보고서 파일(.xlsx)<input type="file" id="adp-file" accept=".xlsx" required onchange="AdProductProfit.fileChosen(this)"></label>
        <label>실제 추출(다운로드) 시각 · 확인한 값<input type="datetime-local" id="adp-extracted" step="1" oninput="AdProductProfit.timeTyped()"></label>
        <label class="adp-check"><input type="checkbox" id="adp-extracted-unknown" onchange="AdProductProfit.unknownToggled(this)"> 추출 시각을 모름(미확인으로 올리기 - 14일 전환 확정·기존 보고서 대체에 안 씀)</label>
        <button type="submit" class="btn" id="adp-upload-btn" ${state.uploading ? "disabled" : ""}>${state.uploading ? "올리는 중…" : "올리기"}</button>
      </form>
      <p class="adp-note" id="adp-file-hint" aria-live="polite"></p>
      ${msg ? `<p class="adp-result" role="status">${badge(!msg.ok ? "error" : DECISION_KIND[msg.status] || "info", msg.ok ? (DECISION[msg.status] || msg.status) : "올리지 못함", reasonText(msg.message))}</p>` : ""}
    </div>`;
  }

  function periodHtml(state) {
    const opts = (state.reports || []).filter((x) => x.active).map((x) =>
      `<option value="${esc(x.start)}~${esc(x.end)}" ${state.start === x.start && state.end === x.end ? "selected" : ""}>${esc(x.start)} ~ ${esc(x.end)} · 캠페인 ${cnt(x.campaigns)}개 · 추출 ${x.extracted_at ? esc(kst(x.extracted_at)) : "모름"}${x.extracted_at_verified === false ? "(미확인)" : x.confirmations ? "(나중에 확인)" : ""}</option>`).join("");
    return `<div class="card adp-period"><form class="adp-form" onsubmit="return AdProductProfit.choosePeriod(event)">
      <label>올린 보고서 기간<select id="adp-report" onchange="AdProductProfit.pickReport(this.value)"><option value="">직접 입력</option>${opts}</select></label>
      <label>시작<input type="date" id="adp-start" value="${esc(state.start || "")}" required></label>
      <label>끝<input type="date" id="adp-end" value="${esc(state.end || "")}" required></label>
      <button type="submit" class="btn secondary">조회</button></form></div>`;
  }

  function summaryPageHtml(s, state) {
    if (!s) return `<div class="card"><p class="adp-note">기간을 고르면 보여 드려요.</p></div>`;
    if (s.status === "NO_REPORT") return `<div class="card">${badge("muted", "보고서 없음", s.message)}</div>`;
    if (s.status === "ERROR") return `<div class="card">${badge("error", "조회 실패", s.message)}</div>`;
    const inv = (s.invariant_failures || []).length ? `<div class="card">${badge("error", "검산 실패 - 숫자를 쓰지 마세요", s.invariant_failures.join(" · "))}</div>` : "";
    return `${inv}<div class="card">${metaHtml(s)}${statsHtml(s)}<p class="adp-note">화면 계산 시각 ${esc(kst(s.generated_at))}</p></div>
      ${productsHtml(s, state.filter || "ALL")}${unallocatedHtml(s)}${reconciliationHtml(s)}${filesHtml(s)}`;
  }

  function pageHtml(state) {
    return `<div class="adp-page">${periodHtml(state)}${uploadHtml(state)}<div id="adp-summary">${summaryPageHtml(state.summary, state)}</div></div>`;
  }

  // ── 서버 호출 ─────────────────────────────────────────────────────────────
  const state = { filter: "ALL", reports: [], summary: null, start: "", end: "", uploading: false, uploadResult: null };

  async function jwt() {
    const sb = global.sb;
    if (!sb || !sb.auth || typeof sb.auth.getSession !== "function") return null;
    try { const { data } = await sb.auth.getSession(); return (data && data.session && data.session.access_token) || null; } catch (e) { return null; }
  }
  async function api(path, opts = {}) {
    const token = await jwt();
    if (!token) return { status: 401, body: { status: "AUTH", message: "로그인 세션이 없어요. 다시 로그인해 주세요." } };
    try {
      const res = await fetch(`${API_BASE}${PREFIX}${path}`, { ...opts, credentials: "omit", headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      return { status: res.status, body: body || { status: "ERROR", message: `서버 응답을 읽지 못했어요(HTTP ${res.status})` } };
    } catch (e) {
      return { status: 0, body: { status: "ERROR", message: "서버에 연결하지 못했어요." } };
    }
  }

  async function loadReports() {
    const r = await api("/reports");
    state.reports = r.status === 200 && r.body.reports ? r.body.reports : [];
    return r;
  }
  async function loadSummary() {
    if (!state.start || !state.end) { state.summary = null; return; }
    const r = await api(`/summary?start=${encodeURIComponent(state.start)}&end=${encodeURIComponent(state.end)}`);
    state.summary = r.status === 200 ? r.body : { status: "ERROR", message: (r.body && r.body.message) || `HTTP ${r.status}` };
  }
  function paint() {
    const el = global.document && global.document.getElementById("content");
    if (el && el.querySelector(".adp-page")) el.innerHTML = pageHtml(state);
  }

  /** 활성 보고서 중 기본으로 보여 줄 것 하나. *** '가져온 순서'가 아니라 기간 끝날이 가장 최신인 걸
   * 고릅니다 *** - GET .../reports 는 가져온 순서(최근 가져온 게 먼저)로 와서, 지난달 재확인처럼
   * 과거 기간을 나중에 다시 가져오면(수집 자동화) 화면이 최신 달이 아니라 그 과거 기간을 기본으로
   * 보여 주는 사고가 있었어요(2026-09-17). 끝날이 같으면(드묾) 먼저 나온 걸 그대로 씀. */
  function pickDefaultReport(reports) {
    const active = (reports || []).filter((x) => x.active);
    if (!active.length) return null;
    return active.reduce((best, x) => (x.end > best.end ? x : best), active[0]);
  }

  async function view() {
    await loadReports();
    if (!state.start) {
      const act = pickDefaultReport(state.reports);
      if (act) { state.start = act.start; state.end = act.end; }
    }
    await loadSummary();
    return pageHtml(state);
  }

  async function choosePeriod(ev) {
    if (ev) ev.preventDefault();
    const d = global.document;
    state.start = d.getElementById("adp-start").value;
    state.end = d.getElementById("adp-end").value;
    if (state.start && state.end && state.start > state.end) { state.summary = { status: "ERROR", message: "시작이 끝보다 늦어요" }; paint(); return false; }
    state.summary = null;
    paint();
    await loadSummary();
    paint();
    return false;
  }
  function pickReport(v) {
    if (!v) return;
    const [s, e] = v.split("~");
    const d = global.document;
    d.getElementById("adp-start").value = s;
    d.getElementById("adp-end").value = e;
    choosePeriod(null);
  }
  function setFilter(f) { state.filter = f; paint(); }

  function localInput(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  /** 파일 선택 → 추출 시각 칸은 건드리지 않아요. 파일 수정 시각은 참고 문구로만(복사·이동하면 바뀌는 값이라 추출 시각이 아님). */
  function fileChosen(input) {
    const f = input.files && input.files[0];
    const d = global.document;
    const hint = d && d.getElementById("adp-file-hint");
    if (!f || !hint) return;
    hint.textContent = fileHintText(f.lastModified);
  }
  function fileHintText(lastModifiedMs) {
    return isNum(lastModifiedMs)
      ? `참고: 이 파일의 수정 시각 ${localInput(lastModifiedMs).replace("T", " ")} - 복사·이동하면 바뀌는 값이라 추출 시각으로 쓰지 않아요.`
      : "";
  }
  function timeTyped() {
    const d = global.document;
    const box = d.getElementById("adp-extracted-unknown");
    if (box && d.getElementById("adp-extracted").value) box.checked = false;
  }
  function unknownToggled(box) {
    const d = global.document;
    if (box.checked) d.getElementById("adp-extracted").value = "";
  }
  /** 올리기 폼 값 → 서버로 보낼 추출 시각·출처. 확인한 시각(MANUAL_CONFIRMED) 또는 모름(UNKNOWN, 시각 없음)만. */
  function uploadFields({ extractedLocal, unknown }) {
    const v = String(extractedLocal || "").trim();
    if (unknown && v) return { ok: false, message: "시각을 넣었으면 '모름'을 끄고, 모르면 시각 칸을 비워 주세요" };
    if (unknown) return { ok: true, extracted_at: null, extracted_at_source: "UNKNOWN" };
    if (!v) return { ok: false, message: "실제 추출(다운로드) 시각을 넣거나 '추출 시각을 모름'을 골라 주세요" };
    const iso = toIso(v);
    if (!iso) return { ok: false, message: "추출 시각 형식이 올바르지 않아요" };
    return { ok: true, extracted_at: iso, extracted_at_source: "MANUAL_CONFIRMED" };
  }
  /** datetime-local(브라우저 시간대) → 시간대 포함 ISO */
  function toIso(local) {
    const d = new Date(local);
    if (isNaN(d)) return null;
    const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", p = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
    return `${local.length === 16 ? `${local}:00` : local}${sign}${p(off / 60)}:${p(off % 60)}`;
  }

  async function upload(ev) {
    if (ev) ev.preventDefault();
    if (state.uploading) return false;
    const d = global.document;
    const f = d.getElementById("adp-file").files[0];
    const fields = uploadFields({ extractedLocal: d.getElementById("adp-extracted").value, unknown: d.getElementById("adp-extracted-unknown").checked });
    if (!f || !fields.ok) {
      const msg = !f ? "보고서 파일을 골라 주세요" : fields.message;
      const hint = d.getElementById("adp-file-hint");
      if (hint) hint.textContent = msg;                     // 폼 값(파일·시각)을 지우지 않게 다시 그리지 않고 안내만
      if (typeof global.toast === "function") global.toast(msg);
      return false;
    }
    const fd = new FormData();
    fd.append("file", f, f.name);
    if (fields.extracted_at) fd.append("extracted_at", fields.extracted_at);
    fd.append("extracted_at_source", fields.extracted_at_source);
    state.uploading = true;
    paint();
    const r = await api("/reports", { method: "POST", body: fd });
    state.uploading = false;
    const b = r.body || {};
    state.uploadResult = { ok: r.status === 200, status: b.status,
      message: [b.message, r.status === 200 && b.written && b.extracted_at_verified === false && !/미확인/.test(b.message || "") ? "추출 시각 미확인" : ""].filter(Boolean).join(" · ") };
    if (r.status === 200 && b.period) { state.start = b.period.start; state.end = b.period.end; }
    await loadReports();
    await loadSummary();
    paint();
    if (typeof global.toast === "function") global.toast(r.status === 200 ? (DECISION[b.status] || b.status) : (reasonText(b.message) || "올리지 못했어요"));
    return false;
  }

  global.AdProductProfit = { view, upload, fileChosen, choosePeriod, pickReport, setFilter, toIso, reasonText, pageHtml, summaryPageHtml,
                             productRowHtml, detailHtml, unallocatedHtml, reconciliationHtml, toggleDetail, uploadFields, fileHintText, timeTyped,
                             unknownToggled, uploadHtml, pickDefaultReport, _state: state };
})(typeof window !== "undefined" ? window : globalThis);
