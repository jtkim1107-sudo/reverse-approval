// fixtures_sales_csv_export.mjs
// 2026-09-11 매출 내역 CSV = 화면 집계(SalesMonthlySummary.build 의 entries) 그대로 - 네트워크 없음.
//   원인(수정 전): exportErpCSV('sales') 가 sales 주문 원장(erpRowsCache)을 주문별로 내보냄
//   → 로켓그로스 주문 원장이 섞이고, 판매통계 NET·취소·반품이 반영되지 않아 화면과 달랐음.
import fs from "node:fs";

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok && extra !== undefined) console.log("   ", JSON.stringify(extra));
}

const src = fs.readFileSync(new URL("./js/sales_monthly_summary.js", import.meta.url), "utf8");
const appSrc = fs.readFileSync(new URL("./js/app.js", import.meta.url), "utf8");
const win = {};
new Function("window", src)(win);
const S = win.SalesMonthlySummary;

const stats = [
  { sales_date: "2026-09-10", channel: "쿠팡 로켓그로스", option_id: "95928210719", product_id: "P1", product_name: "휴지통 7L", gross_qty: 15, gross_amount: 178500, cancel_qty: 4, cancel_amount: 47600, net_qty: 11, net_amount: 130900, mapping_status: "MATCHED", reconciliation_status: "NOT_COMPARED" },
  { sales_date: "2026-09-10", channel: "쿠팡 로켓그로스", option_id: "95928210720", product_id: "P1", product_name: "휴지통 7L 2개", gross_qty: 2, gross_amount: 23800, cancel_qty: 0, cancel_amount: 0, net_qty: 2, net_amount: 23800, mapping_status: "MATCHED", reconciliation_status: "NOT_COMPARED" },
  { sales_date: "2026-09-10", channel: "쿠팡 로켓그로스", option_id: "96020412319", product_id: null, product_name: "독서대, \"화이트\"", gross_qty: 0, gross_amount: 0, cancel_qty: 1, cancel_amount: 37280, net_qty: -1, net_amount: -37280, mapping_status: "UNMATCHED", reconciliation_status: "NOT_COMPARED" },
  { sales_date: "2026-09-09", channel: "쿠팡 로켓그로스", option_id: "95936822309", product_id: "P2", product_name: "EPP 발판", gross_qty: 1, gross_amount: 18810, cancel_qty: 1, cancel_amount: 19800, net_qty: 0, net_amount: -990, mapping_status: "MATCHED", reconciliation_status: "MATCH" },
];
const sales = [
  { id: "rg-order", date: "2026-09-10", channel: "쿠팡 로켓그로스", product_id: "P1", qty: 999, amount: 9999999, memo: "RG-주문-111" },
  { id: "m1", date: "2026-09-10", channel: "쿠팡 판매자배송", product_id: "P3", qty: 2, amount: 30000, memo: "주문번호-777" },
  { id: "m2", date: "2026-09-10", channel: "쿠팡 판매자배송", product_id: "P3", qty: 1, amount: 15000, memo: "주문번호-778" },
];
const adjustments = [
  { id: "rg-return", date: "2026-09-10", channel: "쿠팡 로켓그로스", product_id: "P1", qty: 10, used_amount: 100000 },
  { id: "mp-return", date: "2026-09-10", channel: "쿠팡 판매자배송", product_id: "P3", qty: 1, used_amount: 15000 },
];
const names = { P1: "모노플랫 휴지통", P2: "EPP 발판(그레이)", P3: "제습제, 500ml" };
const summary = S.build({ month: "2026-09", statisticsRows: stats, salesRows: sales, adjustmentRows: adjustments, productName: (id) => names[id] });
const codes = { P1: "1M1A-013-01", P2: "1M1A-020-01", P3: "1G1A-003-01" };
const rows = S.csvRows(summary, { productCode: (id) => codes[id] });
const text = S.toCsv(summary, { productCode: (id) => codes[id] });

// ── 1. 화면 집계와 같은 배열·같은 순서 ─────────────────────────────────────
check(JSON.stringify(rows[0]) === JSON.stringify(["판매일", "ERP 상품코드", "상품명", "채널", "전체수량", "취소·반품수량", "순판매수량",
  "전체매출", "취소·반품금액", "순매출", "데이터 원천", "쿠팡 옵션 ID", "매핑상태", "대사상태"]), "머리글 14열(요청 순서 그대로)", rows[0]);
const body = rows.slice(1, -1);
check(body.length === summary.entries.length, "데이터 행 수 = 화면 집계 행 수(일부가 아니라 전체)", [body.length, summary.entries.length]);
check(body.every((r, i) => r[0] === summary.entries[i].date && r[2] === summary.entries[i].product_name && r[3] === summary.entries[i].channel),
  "정렬 순서 = 화면(entries) 순서");
const keys = body.map((r) => `${r[0]}|${r[2]}|${r[3]}`);
check(new Set(keys).size === keys.length, "날짜·상품·채널 중복 행 없음");

// ── 2. 금액 기준 ────────────────────────────────────────────────────────
const rgP1 = body.find((r) => r[0] === "2026-09-10" && r[1] === "1M1A-013-01");
check(rgP1 && rgP1[4] === 17 && rgP1[5] === 4 && rgP1[6] === 13 && rgP1[7] === 202300 && rgP1[8] === 47600 && rgP1[9] === 154700,
  "여러 옵션이 한 ERP 상품이면 화면처럼 합산(RG NET 130,900+23,800)", rgP1);
check(rgP1 && rgP1[11] === "95928210719 95928210720", "쿠팡 옵션 ID 모두 표시", rgP1 && rgP1[11]);
check(!body.some((r) => r[9] === 9999999 || r[4] === 999), "RG 주문 원장(999개/9,999,999원)은 CSV 에 없음");
check(rgP1 && rgP1[9] === 154700, "RG NET 에 RG 조정(100,000원)을 다시 빼지 않음(이중 차감 없음)");
const mp = body.find((r) => r[3] === "쿠팡 판매자배송");
check(mp && mp[4] === 3 && mp[5] === 1 && mp[6] === 2 && mp[7] === 45000 && mp[8] === 15000 && mp[9] === 30000 && mp[10] === "주문 − 취소·반품",
  "판매자배송 = 주문 − 취소·반품(두 주문을 상품별 한 행)", mp);
check(mp && mp[13] === "해당 없음(판매자배송)", "판매자배송 대사상태는 해당 없음");
const un = body.find((r) => r[11] === "96020412319");
check(un && un[1] === "" && un[2] === "독서대, \"화이트\"" && un[9] === -37280 && un[12] === "미매핑",
  "미매핑 옵션도 화면과 같은 이름·금액(음수 그대로)·미매핑 상태로 포함", un);
check(body.find((r) => r[1] === "1M1A-020-01")?.[13] === "일치" && rgP1?.[13] === "비교 전(정산 엑셀 없음)", "대사상태 표시");
check(body.find((r) => r[1] === "1M1A-020-01")?.[9] === -990, "순매출 음수(−990) 부호 보존");

// ── 3. 합계 행 ────────────────────────────────────────────────────────────
const tot = rows[rows.length - 1];
check(tot[0] === "합계" && tot[9] === summary.total.net_amount && tot[6] === summary.total.net_qty,
  "합계 행 순매출·순수량 = 화면 합계", [tot, summary.total]);
check(tot[7] === summary.rocket_growth.gross_amount + summary.marketplace.gross_amount
  && tot[8] === summary.rocket_growth.cancel_amount + summary.marketplace.cancel_amount, "합계 행 전체매출·취소금액");

// ── 4. 파일 형식 ──────────────────────────────────────────────────────────
check(text.charCodeAt(0) === 0xfeff, "UTF-8 BOM");
check(text.includes("\r\n") && text.endsWith("\r\n"), "CRLF 줄바꿈");
const dataLine = text.split("\r\n").find((l) => l.startsWith("2026-09-10,1M1A-013-01"));
check(dataLine && dataLine.includes(",17,4,13,202300,47600,154700,"), "금액·수량은 쉼표·원 기호 없는 숫자", dataLine);
check(!/₩/.test(text), "원 기호 없음");
check(text.includes('"독서대, ""화이트"""') && text.includes('"제습제, 500ml"'), "쉼표·따옴표가 든 이름은 CSV 규칙대로 감쌈");
check(!/주문번호|RG-주문|적요/.test(text), "주문번호·적요는 넣지 않음(상품별 집계)");
const lines = text.replace(/^﻿/, "").trim().split("\r\n");
check(lines.length === summary.entries.length + 2, "머리글 + 전체 행 + 합계 행");

// ── 5. 월 필터: 다른 달 자료 없음 ────────────────────────────────────────
const aug = S.build({ month: "2026-08", statisticsRows: [...stats, { ...stats[0], sales_date: "2026-08-31", net_amount: 5000, gross_amount: 5000, cancel_amount: 0, gross_qty: 1, cancel_qty: 0, net_qty: 1 }],
  salesRows: sales, adjustmentRows: adjustments, productName: (id) => names[id] });
const augRows = S.csvRows(aug).slice(1, -1);
check(augRows.length === 1 && augRows[0][0] === "2026-08-31", "8월을 고르면 8월 자료만", augRows.map((r) => r[0]));

// ── 6. 실패하면 내려받지 않음 · 화면 스냅샷만 사용 ─────────────────────────
const grab = (name) => {
  const i = appSrc.indexOf(`function ${name}(`);
  let depth = 0, j = appSrc.indexOf("{", i);
  for (let k = j; k < appSrc.length; k++) {
    if (appSrc[k] === "{") depth++;
    else if (appSrc[k] === "}" && --depth === 0) return appSrc.slice(i, k + 1);
  }
  return "";
};
const fnSrc = grab("salesCsvBlockReason") + "\n" + grab("exportMonthlySalesCSV");
function runExport(snapshot, month) {
  const calls = { downloads: [], alerts: [] };
  const f = new Function("SalesMonthlySummary", "erpProducts", "downloadFile", "alert", "ctx",
    `let salesCsvSnapshot = ctx.snap; let erpMonth = ctx.month;\n${fnSrc}\nreturn exportMonthlySalesCSV();`);
  const ret = f(S, [{ id: "P1", code: "1M1A-013-01" }], (c, n) => calls.downloads.push({ c, n }), (m) => calls.alerts.push(m),
    { snap: snapshot, month });
  return { ret, ...calls };
}
const okSnap = { month: "2026-09", summary, statisticsError: null, adjustmentError: null, loadedAt: "2026-09-11T00:00:00Z" };
let r = runExport(okSnap, "2026-09");
check(r.downloads.length === 1 && /^리버스_매출내역_2026-09_\d{8}-\d{6}\.csv$/.test(r.downloads[0].n), "정상: 1개 파일, 파일명에 조회 월·다운로드 시각", r.downloads.map((d) => d.n));
check(r.downloads[0]?.c === S.toCsv(summary, { productCode: (id) => ({ P1: "1M1A-013-01" }[id] || "") }), "내용 = 화면 스냅샷 집계의 공통 직렬화 결과");
for (const [label, snap, month] of [
  ["스냅샷 없음(화면 로딩 전)", null, "2026-09"],
  ["화면 월 ≠ 선택 월", okSnap, "2026-08"],
  ["판매통계 조회 실패", { ...okSnap, statisticsError: new Error("HTTP 500") }, "2026-09"],
  ["취소·반품 조회 실패", { ...okSnap, adjustmentError: new Error("timeout") }, "2026-09"],
  ["그 달 판매통계 없음", { ...okSnap, summary: { ...summary, has_rg_statistics: false } }, "2026-09"],
]) {
  r = runExport(snap, month);
  check(r.downloads.length === 0 && r.alerts.length === 1, `${label} → 다운로드 0건 + 오류 표시`, r.alerts);
}

// ── 7. 화면과 CSV 연결 ────────────────────────────────────────────────────
check(appSrc.includes(`onclick="exportMonthlySalesCSV()"`) && !appSrc.includes(`onclick="exportErpCSV('sales')"`), "매출 내역 CSV 버튼 → 화면 집계 CSV");
check(/salesCsvSnapshot = \{\s*month: erpMonth, summary: monthlySummary/.test(appSrc) && appSrc.includes("monthlySalesRowsHtml(monthlySummary)"),
  "CSV 스냅샷 = 표를 그린 바로 그 monthlySummary(새로고침하면 route()→viewSales 로 같이 바뀜)");
check(/function exportErpCSV\(table\) \{\s*if \(table === "sales"\) return exportMonthlySalesCSV\(\);/.test(appSrc), "옛 매출 CSV 경로도 화면 집계로 연결(주문 원장 CSV 없음)");
check(!/sb\.from|erpRowsCache|loadErpBase|fetch\(/.test(fnSrc), "CSV 함수는 다시 조회하지 않음(sb·주문 원장·API 재호출 없음)");
check(appSrc.includes("mapping_status,reconciliation_status\")"), "판매통계 조회에 대사상태 열 포함(화면과 같은 한 번의 조회)");

console.log(failures ? `\n실패 ${failures}건` : "\n전부 통과");
process.exit(failures ? 1 : 0);
