// fixtures_briefing_not_collected.mjs
// ------------------------------------------------
// 2026-09-16 브리핑 화면: 원천 미수집(NULL)은 ₩0 이 아니라 '미수집'으로 보여요(네트워크 0건).
//   1) 정상 브리핑 카드는 운영 화면(c555413)과 글자 하나까지 같아야 함(기존 표시 불변)
//   2) 미수집 행(gross_qty·gross_amount·cancel_qty·net_qty·net_amount = null)은 '미수집' · ₩0 없음 · 안내 문구
//   3) 채널별 표의 미수집 채널도 '미수집'
//   4) loadDailySalesBriefing: 미수집이면 '생성 이후 변경' 오해 문구를 띄우지 않음
import { readFileSync } from "fs";
import vm from "vm";

const NEW = new URL("./js/app.js", import.meta.url).pathname;
import { execSync } from "child_process";
import { writeFileSync } from "fs";
// 비교 기준 = 지금 운영 중인 커밋의 화면 코드(HEAD)
const BASE = "/tmp/_app_head_briefing.js";
writeFileSync(BASE, execSync("git show HEAD:js/app.js", { maxBuffer: 1e9 }));
let n = 0; const fails = [];
const check = (label, got, want) => {
  n++; const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { console.log(`        기대=${JSON.stringify(want)}\n        실제=${JSON.stringify(got)}`); fails.push(label); }
};

function load(path) {
  const app = readFileSync(path, "utf8");
  const grabFn = name => {
    const m = app.match(new RegExp(`\\n(async )?function ${name}\\([\\s\\S]*?\\n}`));
    if (!m) throw new Error(`${name} 없음 (${path})`);
    return m[0];
  };
  const grabLine = re => { const m = app.match(re); if (!m) throw new Error(String(re)); return m[0]; };
  const ctx = { console, JSON, Object, Number, Math, String, Array, Date, sbCalls: [] };
  vm.createContext(ctx);
  vm.runInContext(`
    ${grabLine(/\nconst fmt = .*/).trim()}
    ${grabLine(/const esc = .*/)}
    ${grabLine(/const RG_CHANNEL_NAME = .*/)}
    ${grabFn("productSalesTableHtml")}
    ${grabFn("rgAdjustmentNotCollectedHtml")}
    ${grabFn("briefingCardHtml")}
    ${grabFn("loadDailySalesBriefing")}
    globalThis.__api = { card: (b, d, o) => briefingCardHtml(b, d, o), load: loadDailySalesBriefing };
  `, ctx);
  return ctx;
}

const OK_ROW = {
  date: "2026-09-14", status: "DATA_CHECK_NEEDED", data_quality_flags: ["UNMATCHED_ITEMS: 1건"],
  gross_qty: 57, gross_amount: 973040, cancel_qty: 6, return_qty: 0, net_qty: 51, net_amount: 849730,
  cancel_return_rate: 0.105, dod_change_pct: -20.6, channel_breakdown: { "쿠팡 로켓그로스": 849730 },
  top5: [], unmatched_count: 1, includes_estimated: false, adjustment_summary: null, adjustment_display_error: null,
};
const NOT_COLLECTED = {
  date: "2026-09-15", status: "DATA_CHECK_NEEDED",
  data_quality_flags: ["RG_DATA_CHECK_NEEDED: 로켓그로스 판매통계 DATA_CHECK_NEEDED (SESSION_EXPIRED) - 매출 0원이 아니라 미수집입니다"],
  gross_qty: null, gross_amount: null, cancel_qty: null, return_qty: 0, net_qty: null, net_amount: null,
  cancel_return_rate: null, dod_change_pct: null, channel_breakdown: { "쿠팡 로켓그로스": null },
  top5: [], unmatched_count: 0, includes_estimated: false, adjustment_summary: null, adjustment_display_error: null,
};

const base = load(BASE), now = load(NEW);

console.log("\n[1] 기존 정상 브리핑 표시 불변");
for (const detailed of [false, true]) {
  check(`정상 행 카드가 운영 화면과 동일(detailed=${detailed})`,
        now.__api.card(OK_ROW, "2026-09-14", { detailed }) === base.__api.card(OK_ROW, "2026-09-14", { detailed }), true);
}
check("브리핑 없음 안내도 동일", now.__api.card(null, "2026-09-15", {}) === base.__api.card(null, "2026-09-15", {}), true);
check("정상 행에는 '미수집' 글자 없음", now.__api.card(OK_ROW, "2026-09-14", { detailed: true }).includes("미수집"), false);

console.log("\n[2] 미수집 행");
const html = now.__api.card(NOT_COLLECTED, "2026-09-15", { detailed: true });
check("총 판매수량·순판매수량·취소가 '미수집'", (html.match(/미수집/g) || []).length >= 5, true);
check("0개·₩0 으로 보이지 않음", [/>0개</.test(html), /₩0</.test(html)], [false, false]);
check("안내 문구", html.includes("판매통계를 아직 받지 못해 '미수집'으로 표시합니다"), true);
check("채널별 표의 미수집 채널도 '미수집'", /쿠팡 로켓그로스<\/td><td class="num"><span[^>]*>미수집/.test(html), true);
check("옛 화면 코드는 같은 행을 ₩0 으로 보여줌(바뀐 점 확인)", /₩0</.test(base.__api.card(NOT_COLLECTED, "2026-09-15", { detailed: true })), true);
check("상태 배지는 '데이터 확인 필요'", html.includes("데이터 확인 필요"), true);

console.log("\n[3] 조회 단계(loadDailySalesBriefing)");
const fakeSb = row => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) });
for (const [label, row, wantErr] of [["미수집 행", NOT_COLLECTED, null], ["정상 행", { ...OK_ROW, cancel_qty: 6 }, "취소·반품 내역이 브리핑 생성 이후 변경되었습니다. 유형별 금액은 재집계가 필요합니다."]]) {
  now.sb = fakeSb(row);
  now.loadSalesAdjustments = async () => ({ cancel_amount: 111, return_amount: 0, cancel_qty: 9, return_qty: 0 });
  const got = await now.__api.load("2026-09-15");
  check(`${label}: 조정 비교 문구`, got.adjustment_display_error, wantErr);
}

console.log(fails.length ? `\n실패 ${fails.length}/${n}: ${fails.join(", ")}` : `\n전부 통과 ${n}/${n}`);
process.exit(fails.length ? 1 : 0);
