/* fixtures_automation_hold_split_dryrun.js - 2026-09-28 [대표 지시] 의도적 보류(계절·입고 미정)를 '자동화 막힘'과 분리.
 * node js/fixtures_automation_hold_split_dryrun.js  (index.html 에서 안 불러옴 - 로컬 전용) */
const fs = require("fs"), path = require("path"), vm = require("vm");
const FAILS = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log("        기대=" + JSON.stringify(want) + "\n        실제=" + JSON.stringify(got)); FAILS.push(name); }
}
const ctx = { window: {}, console };
ctx.window.window = ctx.window;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "inventory_display.js"), "utf8"), ctx);
const I = ctx.window.InventoryDisplay;

// 화면 11개(대표 행 기준) 재현: 계절 2 · 입고미정 2 · 발주정보없음 6 · BigQuery 1
function row(status, label, blocked = true, decision = "DATA_CHECK") {
  return { automation_status: status, automation_label: label, automation_blocked: blocked, decision };
}
const rows = [
  row("SEASONAL_HOLD", "계절 상품 보류"), row("SEASONAL_HOLD", "계절 상품 보류"),
  row("INBOUND_UNDECIDED", "입고 미정"), row("INBOUND_UNDECIDED", "입고 미정"),
  ...Array(6).fill(0).map(() => row("NO_PROCUREMENT", "발주정보 없음")),
  row("BQ_SYNC_REQUIRED", "BigQuery 동기화 필요"),
  // 대조군: 자동화 정상·재입고 제외는 세지 않음
  row(null, null, false, "OK"), row("RESTOCK_EXCLUDED", "재입고 제외", true, "RESTOCK_EXCLUDED"),
];

console.log("[1] isDeliberateHold - status 또는 label 로 인식");
check("SEASONAL_HOLD(status) -> 보류", I.isDeliberateHold(row("SEASONAL_HOLD", null)), true);
check("[핵심] INBOUND_UNDECIDED(status만, label 다름) -> 보류", I.isDeliberateHold({ automation_status: "INBOUND_UNDECIDED", automation_label: "기타" }), true);
check("[핵심] SEASONAL_HOLD(status만, label 없음) -> 보류", I.isDeliberateHold({ automation_status: "SEASONAL_HOLD" }), true);
check("입고 미정(label만) -> 보류", I.isDeliberateHold({ automation_label: "입고 미정" }), true);
check("계절 상품 보류(label만) -> 보류", I.isDeliberateHold({ automation_label: "계절 상품 보류" }), true);
check("NO_PROCUREMENT -> 보류 아님", I.isDeliberateHold(row("NO_PROCUREMENT", "발주정보 없음")), false);
check("BQ_SYNC_REQUIRED -> 보류 아님", I.isDeliberateHold(row("BQ_SYNC_REQUIRED", "BigQuery 동기화 필요")), false);
check("SUPPLY_HOLD_STATUS_UNKNOWN(보류 확인 불가)은 보류 아님(조치 필요)", I.isDeliberateHold(row("SUPPLY_HOLD_STATUS_UNKNOWN", "공급 보류 확인 불가")), false);
check("null -> 보류 아님", I.isDeliberateHold(null), false);

console.log("\n[2] blockedSplit - 서버 총계 11을 보류/조치필요로 나눔");
const s = I.blockedSplit(rows, 11);
check("[핵심] total 11 · 보류 4 · 조치필요 7", { total: s.total, held: s.held, actionable: s.actionable }, { total: 11, held: 4, actionable: 7 });
check("자동화 정상·재입고 제외는 막힘에서 제외(합 11)", s.total, 11);
const s2 = I.blockedSplit(rows);  // 서버 총계 없으면 행에서 셈
check("서버 총계 없으면 대표 행에서 계산(11/4/7)", { total: s2.total, held: s2.held, actionable: s2.actionable }, { total: 11, held: 4, actionable: 7 });
check("빈 목록 -> 0/0/0", I.blockedSplit([], 0), { held: 0, actionable: 0, total: 0 });
check("[핵심] 보류만 있으면 조치필요 0", I.blockedSplit([row("SEASONAL_HOLD", "계절 상품 보류")], 1), { held: 1, actionable: 0, total: 1 });

console.log("\n[3] app.js KPI - 보류/자동화 막힘 분리(소스 확인)");
const app = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
check("[핵심] blockedCount = 조치필요만(blockedSplit.actionable)", app.includes("const blockedCount = blockedSplit.actionable;"), true);
check("[핵심] '보류' KPI 칩 추가(heldCount)", /label: "보류", value: heldCount/.test(app), true);
check("대시보드도 조치필요/보류 분리 전달", app.includes("blocked: dashSplit.actionable, held: dashSplit.held"), true);

const dash = fs.readFileSync(path.join(__dirname, "erp_dashboard.js"), "utf8");
check("대시보드 stockModel held 필드", /held: typeof opts.held === "number"/.test(dash), true);
check("대시보드 '보류' stat", /stat\("hold", "보류"/.test(dash), true);
check("대시보드 global 미참조(root 사용)", dash.includes("global.InventoryDisplay"), false);

console.log(`\n${FAILS.length ? FAILS.length + "건 실패: " + JSON.stringify(FAILS) : "모두 통과"}`);
process.exit(FAILS.length ? 1 : 0);
