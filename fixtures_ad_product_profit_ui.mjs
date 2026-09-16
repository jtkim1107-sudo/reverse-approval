// fixtures_ad_product_profit_ui.mjs
// 2026-09-16 상품별 광고·이익 화면(js/ad_product_profit.js) 격리 검증. 네트워크 없음.
//   입력: fixtures_ad_product_profit_summary.json - 백엔드 make_ad_product_profit_contract_sample.py 가 실제 summarize() 경로로 만든 표본
//   · 계약: 화면이 읽는 필드가 표본에 모두 있음(백엔드 fixtures_ad_product_profit_dryrun [16] 과 같은 목록)
//   · 값 없음은 '—' + 사유(₩0 아님) · 광고 후 이익 '최종 순이익 아님' 문구 · RG/MP/미매핑 구분 · 대사 차이 표시
//   · 이익 대기(PENDING)·매핑표 없음·보고서 없음 상태 · 광고 조작(입찰·예산·켜기/끄기) 버튼 없음 · 같은 기간 다른 파일은 '계산에 안 씀'
import fs from "node:fs";
import vm from "node:vm";

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok && extra !== undefined) console.log("   ", JSON.stringify(extra).slice(0, 400));
}

const ctx = { window: {}, console };
vm.createContext(ctx);
for (const f of ["./js/erp_ui.js", "./js/ad_product_profit.js"]) vm.runInContext(fs.readFileSync(new URL(f, import.meta.url), "utf8"), ctx);
const A = ctx.window.AdProductProfit;
const S = JSON.parse(fs.readFileSync(new URL("./fixtures_ad_product_profit_summary.json", import.meta.url), "utf8"));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// ── 1. 계약(화면이 읽는 필드) ─────────────────────────────────────────────
export const CONTRACT = [
  "status", "generated_at", "period.start", "period.end", "source.report.file_name", "source.report.extracted_at", "source.report.extracted_at_source",
  "source.report.imported_at", "source.report.extracted_at_verified", "source.report.provenance_history", "source.report.original_extracted_at",
  "source.report.original_extracted_at_source", "source.margin_bundle", "attribution.status",
  "attribution.window_elapses_after", "attribution.extraction_time_verified", "report_coverage.status",
  "mapping.status", "margin.status", "margin.reason", "margin.open_cycle_days", "buckets.RG.spend", "buckets.RG.options_all", "buckets.MP.spend",
  "buckets.UNMAPPED.spend", "buckets.AMBIGUOUS.spend", "buckets.MAPPING_UNKNOWN.spend", "reconciliation.report_totals.spend",
  "reconciliation.report_totals.rev_14d", "reconciliation.checks", "reconciliation.product_erp_totals.status", "cross_option.rows",
  "cross_option.rev_14d", "cross_option.spend", "products", "unallocated_costs.statement", "unallocated_costs.rg_monthly_common",
  "unallocated_costs.inbound_freight", "unallocated_costs.mp_parcel_packaging", "unallocated_costs.ad", "other_files_same_period", "invariant_failures",
];
const PRODUCT_CONTRACT = ["bucket", "key", "product_code", "set_parent_code", "ad", "ad_spend.allocated_billed_estimate", "margin", "after_ad.scope",
  "after_ad.performance_basis", "after_ad.accounting_basis", "after_ad.is_final_net_profit", "bep_roas.excluding_recovery", "bep_roas.including_provisional_recovery"];
const has = (o, path) => path.split(".").reduce((x, k) => (x != null && Object.prototype.hasOwnProperty.call(x, k) ? x[k] : undefined), o) !== undefined;
check(CONTRACT.every((p) => has(S.complete, p)), "계약 필드 - 완전 요약", CONTRACT.filter((p) => !has(S.complete, p)));
check(S.complete.products.every((r) => PRODUCT_CONTRACT.every((p) => has(r, p))), "계약 필드 - 상품 행");
check(["status", "period.start", "margin.status", "mapping.status"].every((p) => has(S.pending, p)), "계약 필드 - 이익 대기 요약");
check(S.reports.reports.every((r) => ["active", "start", "end", "campaigns", "extracted_at", "extracted_at_verified", "confirmations", "original_extracted_at", "decision"].every((k) => k in r)), "계약 필드 - 보고서 목록");

// ── 2. 완전 요약 화면 ─────────────────────────────────────────────────────
const html = A.summaryPageHtml(S.complete, { filter: "ALL" });
const t = text(html);
check(t.includes("₩990"), "보고서 광고비 합계 표시");
check(/로켓그로스/.test(t) && /판매자배송/.test(t) && /미매핑/.test(t) && /매핑 모호/.test(t), "RG·MP·미매핑·모호 구분 표시");
check(t.includes("최종 순이익이 아니에요") && t.includes("차감 전"), "광고 후 이익 범위 문구(최종 순이익 아님)");
check(/잠정|14일 창 지남/.test(t), "14일 전환 상태 표시");
check(t.includes("차이 있음(보정 안 함)"), "대사 차이 그대로 표시");
check(t.includes("같은 기간 다른 파일(계산에 안 씀)") && t.includes("일부 캠페인 파일 · 보관만"), "같은 기간 다른 파일은 계산에 안 씀");
check(t.includes("상품에 배분하지 않은 비용") && t.includes("입고 트럭 운송비"), "미배분 비용 카드");
check(!/입찰|예산 변경|일시중지|광고 켜기|광고 끄기|캠페인 수정/.test(t) && !/onclick="[^"]*(bid|budget|pause|campaign)/i.test(html), "광고 조작 버튼 없음");
const missingBlocks = html.match(/<span class="adp-missing"[^>]*>—<small>[^<]*<\/small><\/span>/g) || [];
check(missingBlocks.length > 0 && missingBlocks.every((m) => !m.includes("₩0") && /<small>[^<]+<\/small>/.test(m)), "값 없음은 — + 사유(₩0 아님)", missingBlocks.slice(0, 3));

const rowOf = (key) => S.complete.products.findIndex((r) => r.key === key);
const rowHtml = (key) => A.productRowHtml(S.complete.products[rowOf(key)], rowOf(key));
const m = text(rowHtml("M-1"));
check(m.includes("수수료 요율 미확인") && !/₩8,000|₩7,940/.test(m), "원가·수수료 누락 상품: 이익·광고 후 이익 숫자 없음 + 사유", m.slice(0, 300));
const a = text(rowHtml("A-1"));
check(a.includes("₩2,500") && a.includes("₩2,469") && a.includes("₩3,000"), "A: 광고 전 3,000 · 성과 2,500 · 회계 2,469", a.slice(0, 400));
check(text(rowHtml("B-1")).includes("−₩11,200"), "손실은 음수 그대로");
check(text(rowHtml("A-1-S2")).includes("세트 · 기준 A-1"), "세트 SKU 는 자기 행 + 기준 상품 표시");
const u = text(rowHtml("UNMAPPED 9007"));
check(u.includes("ERP 상품 매핑 없음") && u.includes("배분 없음"), "미매핑 행: 이익 대상 아님 · 배분 없음");
const det = text(A.detailHtml(S.complete.products[rowOf("A-1")]));
check(det.includes("₩3,000 − ₩500 = ₩2,500") && det.includes("최종 순이익 아님"), "상세: 계산식 · 범위 문구");
check(det.includes("자기 광고") && det.includes("다른 상품 광고"), "상세: 전체 판매와 광고 전환 분리");
const mp = A.summaryPageHtml(S.complete, { filter: "MP" });
check((mp.match(/class="adp-row" data-bucket="([^"]+)"/g) || []).every((x) => x.includes('"MP"')), "판매자배송 필터는 MP 행만");

// ── 3. 대기·없음 상태 ─────────────────────────────────────────────────────
const p = text(A.summaryPageHtml(S.pending, { filter: "ALL" }));
check(p.includes("이익 대기") && p.includes("매핑표 없음"), "이익 원천 없음 → 이익 대기 · 매핑표 없음 표시");
const cell = (rowHtmlStr, label) => ((rowHtmlStr.match(new RegExp(`data-label="${label.replace(/[()]/g, "\\$&")}"><div class="adp-v">([\\s\\S]*?)</div></td>`)) || [])[1] || "");
const pendRows = S.pending.products.map((r, i) => A.productRowHtml(r, i));
check(pendRows.length > 0 && pendRows.every((h) => !/₩/.test(cell(h, "광고 전 이익(률)")) && !/₩/.test(cell(h, "광고 후 · 성과 기준")) && !/₩/.test(cell(h, "광고 후 · 회계 기준"))),
  "이익 대기: 광고 전·후 이익 칸에 금액 없음", pendRows.slice(0, 1).map((h) => cell(h, "광고 전 이익(률)")));
check(cell(A.productRowHtml(S.complete.products[rowOf("A-1")], 0), "광고 전 이익(률)").includes("₩3,000"), "칸 읽기 자체는 동작(대조군)");
check(S.pending.products.every((r) => r.margin.cm_before_ads_and_common == null && r.after_ad.performance_basis.value == null), "이익 대기 표본: 이익·광고 후 값 없음");
check(text(A.summaryPageHtml(S.no_report, {})).includes("보고서 없음"), "보고서 없음 상태");
check(text(A.summaryPageHtml({ status: "ERROR", message: "HTTP 500" }, {})).includes("조회 실패"), "조회 실패 상태");
const inv = text(A.summaryPageHtml({ ...S.complete, invariant_failures: ["X"] }, { filter: "ALL" }));
check(inv.includes("검산 실패"), "검산 실패면 경고");

// ── 4. 보조 함수 ───────────────────────────────────────────────────────────
check(A.reasonText("FEE_INCOMPLETE: 수수료 요율 미확인 1줄") === "수수료 요율 미확인 1줄", "사유 코드 떼기");
check(A.reasonText("NO_SPEND") === "광고비 0원 · 전환만 받은 옵션", "코드만 오면 우리말");
check(/^2026-09-16T21:08:29[+-]\d{2}:\d{2}$/.test(A.toIso("2026-09-16T21:08:29")), "추출 시각 → 시간대 포함 ISO", A.toIso("2026-09-16T21:08:29"));
check(/^2026-09-16T21:08:00[+-]\d{2}:\d{2}$/.test(A.toIso("2026-09-16T21:08")), "초 없는 입력도 ISO");
check(A.toIso("bad") === null, "잘못된 시각은 null");
const page = A.pageHtml({ filter: "ALL", reports: S.reports.reports, summary: S.complete, start: "2026-09-01", end: "2026-09-02" });
check(page.includes('accept=".xlsx"') && page.includes('type="datetime-local"') && page.includes('id="adp-start"'), "기간 선택·보고서 올리기 폼");
check((page.match(/<option value="[^"]+~[^"]+"/g) || []).length === S.reports.reports.filter((r) => r.active).length, "기간 목록은 활성 보고서만");

// ── 5. 추출 시각 - 파일 수정 시각 자동 사용 안 함 ─────────────────────────────
const U = (x) => JSON.parse(JSON.stringify(A.uploadFields(x)));
check(JSON.stringify(U({ extractedLocal: "", unknown: false })) === JSON.stringify({ ok: false, message: "실제 추출(다운로드) 시각을 넣거나 '추출 시각을 모름'을 골라 주세요" }),
  "시각도 '모름'도 없으면 올리지 않음", U({ extractedLocal: "", unknown: false }));
const conf = U({ extractedLocal: "2026-09-16T21:08:29", unknown: false });
check(conf.ok && conf.extracted_at_source === "MANUAL_CONFIRMED" && /^2026-09-16T21:08:29[+-]/.test(conf.extracted_at), "확인한 시각 → MANUAL_CONFIRMED", conf);
const unk = U({ extractedLocal: "", unknown: true });
check(unk.ok && unk.extracted_at === null && unk.extracted_at_source === "UNKNOWN", "모름 → 시각 없이 UNKNOWN", unk);
check(U({ extractedLocal: "2026-09-16T21:08", unknown: true }).ok === false, "시각과 '모름'이 같이 있으면 막음");
check(!Object.values(conf).includes("BROWSER_FILE_LAST_MODIFIED") && !/BROWSER_FILE_LAST_MODIFIED/.test(fs.readFileSync(new URL("./js/ad_product_profit.js", import.meta.url), "utf8")),
  "화면 코드에 파일 수정 시각 출처 없음");
// fileChosen: 가짜 DOM - 추출 시각 칸 값은 그대로, 참고 문구만
const els = { "adp-extracted": { value: "" }, "adp-file-hint": { textContent: "" }, "adp-extracted-unknown": { checked: false } };
ctx.window.document = { getElementById: (id) => els[id] || null };
A.fileChosen({ files: [{ name: "x.xlsx", lastModified: Date.parse("2026-09-17T09:00:00+09:00") }] });
check(els["adp-extracted"].value === "" && /수정 시각/.test(els["adp-file-hint"].textContent) && /쓰지 않아요/.test(els["adp-file-hint"].textContent),
  "파일 선택해도 추출 시각 칸은 비어 있음(수정 시각은 참고 문구만)", els);
els["adp-extracted-unknown"].checked = true; els["adp-extracted"].value = "2026-09-16T21:08";
A.timeTyped();
check(els["adp-extracted-unknown"].checked === false, "시각을 입력하면 '모름' 해제");
A.unknownToggled({ checked: true });
check(els["adp-extracted"].value === "", "'모름'을 고르면 시각 칸 비움");
const up = text(A.uploadHtml({}));
check(!/required[^>]*adp-extracted|adp-extracted"[^>]*required/.test(A.uploadHtml({})) && up.includes("추출 시각을 모름") && up.includes("자동으로 쓰지 않아요"), "올리기 폼: 확인한 시각 또는 모름 선택 · 안내 문구");
check(text(A.uploadHtml({ uploadResult: { ok: true, status: "UNVERIFIED_TIME_NOT_ACTIVATED", message: "x" } })).includes("기존 보고서 대체 안 함"),
  "미확인 파일 결과: 대체 안 함 안내");
const uv = text(A.summaryPageHtml(S.unverified, { filter: "ALL" }));
check(uv.includes("추출 시각 미확인") && uv.includes("추출 모름") && uv.includes("창 경과 여부 모름") && !uv.includes("14일 창 지남"),
  "미확인 요약: 미확인 배지 · 시각 모름 · 14일 전환 확정 안 함");
check(!/₩0/.test((A.productRowHtml(S.unverified.products.find((r) => r.key === "N-1"), 0).match(/data-label="광고비\(실제\)"><div class="adp-v">([\s\S]*?)<\/div>/) || [])[1] || "x"),
  "미확인 요약: 행 없는 상품 광고비를 ₩0 으로 안 보여줌");

// ── 6. 추출 시각 나중에 확인 ────────────────────────────────────────────────
const cf = S.confirmed;
check(cf && cf.source.report.extracted_at_verified === true && cf.source.report.provenance_history.length === 2 && cf.source.report.original_extracted_at === null,
  "확인 표본: 원래 모름 → 확인 1회", cf && cf.source.report);
const ct = text(A.summaryPageHtml(cf, { filter: "ALL" }));
check(ct.includes("추출 시각 나중에 확인") && ct.includes("처음 모름(UNKNOWN)") && ct.includes("원본 파일 그대로") && !ct.includes("추출 시각 미확인"),
  "확인 뒤 화면: 나중에 확인 배지 · 처음 값 · 미확인 배지 없음");
check(ct.includes("14일 창 지남"), "확인 뒤 14일 창 경과 표시(확인 시각이 창 종료 뒤)");
check(text(A.summaryPageHtml(S.unverified, { filter: "ALL" })).includes("같은 파일을 실제 추출 시각과 함께 다시 올리면"), "미확인 화면: 확인 방법 안내");
check(text(A.uploadHtml({ uploadResult: { ok: true, status: "PROVENANCE_CONFIRMED", message: "m" } })).includes("추출 시각 확인 기록 추가(원본 그대로)"), "확인 결과 문구");
const rej = A.uploadHtml({ uploadResult: { ok: false, status: "PROVENANCE_CONFLICT", message: "PROVENANCE_CONFLICT: 같은 파일이 이미 확인됐어요" } });
check(text(rej).includes("올리지 못함") && text(rej).includes("같은 파일이 이미 확인됐어요") && rej.includes("erp-badge--error"), "충돌 거부(409)는 오류로 표시");
check(text(A.pageHtml({ filter: "ALL", reports: S.confirmed_reports.reports, summary: cf, start: "2026-09-01", end: "2026-09-02" })).includes("(나중에 확인)"),
  "기간 목록에 나중에 확인 표시");

const withOther = { ...cf, other_files_same_period: [{ file_name: "a.xlsx", decision: "UNVERIFIED_TIME_NOT_ACTIVATED", extracted_at: "2026-09-14T17:55:00+09:00",
  extracted_at_verified: true, confirmations: 1, campaigns: 1, spend: 650, counted: false }] };
const ot = text(A.summaryPageHtml(withOther, { filter: "ALL" }));
check(ot.includes("(나중에 확인)") && ot.includes("확인 뒤에도 활성 조건 아님") && !ot.includes("추출 시각 미확인 · 기존 보고서 대체 안 함"),
  "다른 파일 목록: 나중에 확인된 보관 파일을 미확인으로 보여주지 않음");
check(!/\(나중에 확인\)|확인 뒤에도/.test(text(A.summaryPageHtml({ ...cf, other_files_same_period: [{ ...withOther.other_files_same_period[0], confirmations: 0, extracted_at_verified: false }] }, { filter: "ALL" }))),
  "확인 안 된 보관 파일은 그대로 미확인 표시");

console.log(failures ? `\n실패 ${failures}건` : "\n전부 통과");
process.exit(failures ? 1 : 0);
