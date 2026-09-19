/**
 * fixtures_wing_direct_po_cancel_badge_dryrun.js
 * ------------------------------------------------
 * "입고 취소" 배지 + 취소 사유·시각 표시(loadWingDirectCancellations()/wingCancelChipHtml())의
 * *** 실제 함수 경로 *** 회귀테스트(네트워크·브라우저 없음). 다른 fixtures_*.js 와 같은 원칙 -
 * js/app.js 의 진짜 소스를 Node vm 으로 그대로 실행한다(재구현 아님).
 *
 * 2026-09-19 [대표 지시] wing_direct_po_cancellations(Rebirth-ops 레포, fn_cancel_wing_direct_po
 * 가 취소할 때만 쓰는 이력 테이블)에 이력이 있는 PO 에만 "🚫 입고 취소(WING)" 배지가 붙고, 상세
 * 모달엔 사유·확인 시각이 표시되는지 확인한다. 이 테이블이 아직 운영에 없어도(마이그레이션 미적용)
 * 목록 화면 전체가 깨지지 않아야 한다(loadPoHolds() 와 동일한 방어 원칙).
 *
 * 2026-09-19 [대표 재지적 - 2차 보완] "테이블 없음"(마이그레이션 미적용, 정상 상태)과 "다른 이유로
 * 조회 실패"(네트워크·권한 등, 이력이 있는데 조용히 안 보일 위험)를 구분해서, 후자는 loadWingDirect
 * Cancellations() 가 warning 문자열을 돌려주는지 확인한다(화면이 경고를 보여줘야 함 - 조용히 "이력
 * 없음"으로 표시하면 안 됨).
 *
 * *** 로컬 실행만 - 이 파일은 index.html 에서 안 불러옴 ***  node js/fixtures_wing_direct_po_cancel_badge_dryrun.js
 */
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const FAILS = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`        기대=${JSON.stringify(want)}  실제=${JSON.stringify(got)}`); FAILS.push(name); }
}
function checkIncludes(name, haystack, needle) {
  const ok = typeof haystack === "string" && haystack.includes(needle);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`        '${needle}' 를 포함해야 하는데 못 찾음: ${haystack}`); FAILS.push(name); }
}

const APP_JS_PATH = path.join(__dirname, "app.js");
const ERP_UI_JS_PATH = path.join(__dirname, "erp_ui.js");
const appSrcFull = fs.readFileSync(APP_JS_PATH, "utf8");
const CUT_MARKER = "/* ---------- 모바일 사이드바 ---------- */";
const cutIdx = appSrcFull.indexOf(CUT_MARKER);
if (cutIdx < 0) throw new Error(`app.js 에서 절단 지점을 못 찾음("${CUT_MARKER}")`);
const appSrc = appSrcFull.slice(0, cutIdx);
const erpUiSrc = fs.readFileSync(ERP_UI_JS_PATH, "utf8");

function makeFakeDocument() {
  return {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {} }),
    body: { appendChild() {}, style: {} }, addEventListener() {},
  };
}

function makeQueryBuilder(scriptFn, table) {
  const calls = [];
  const builder = {
    select(...a) { calls.push(["select", ...a]); return builder; },
    eq(...a) { calls.push(["eq", ...a]); return builder; },
    in(...a) { calls.push(["in", ...a]); return builder; },
    then(resolve, reject) { return Promise.resolve(scriptFn(table, calls)).then(resolve, reject); },
  };
  return builder;
}

function buildContext(scriptFn) {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.navigator = {};
  sandbox.document = makeFakeDocument();
  sandbox.window.supabase = { createClient: () => ({ from: table => makeQueryBuilder(scriptFn, table) }) };
  const context = vm.createContext(sandbox);
  const trailer = `
    var __test = {
      getLoadWingDirectCancellations: function () { return loadWingDirectCancellations; },
      getChipHtml: function () { return wingCancelChipHtml; },
    };
  `;
  const combined = erpUiSrc + "\n" + appSrc + "\n" + trailer;
  new vm.Script(combined, { filename: "app-bundle.js" }).runInContext(context);
  return context;
}

(async () => {
  console.log("=== [핵심] loadWingDirectCancellations() - 정상 응답 -> po_id 기준 맵으로 변환 ===");
  const ctx1 = buildContext((table) => {
    if (table !== "wing_direct_po_cancellations") throw new Error(`예상 밖 테이블: ${table}`);
    return {
      data: [
        { po_id: "po-1", wing_shipment_id: "ship-1", reason: "WING 에서 취소 확인", previous_status: "approved", confirmed_by: "u-1", confirmed_at: "2026-09-19T08:00:00+00:00" },
      ],
      error: null,
    };
  });
  const result1 = await ctx1.__test.getLoadWingDirectCancellations()();
  check("po-1 키로 조회됨", Object.keys(result1.map), ["po-1"]);
  check("reason 그대로 보존", result1.map["po-1"].reason, "WING 에서 취소 확인");
  check("정상 조회는 warning 없음", result1.warning, null);

  console.log("\n=== [핵심-빈틈] 테이블이 아직 없음(마이그레이션 미적용, PGRST205 응답) -> 조용히 빈 맵 + warning 없음(정상 상태) ===");
  const ctx2 = buildContext(() => ({ data: null, error: { message: "Could not find the table 'public.wing_direct_po_cancellations' in the schema cache", code: "PGRST205" } }));
  const result2 = await ctx2.__test.getLoadWingDirectCancellations()();
  check("빈 맵 반환(에러를 던지지 않음)", result2.map, {});
  check("마이그레이션 미적용은 warning 없음(정상 상태)", result2.warning, null);

  console.log("\n=== [핵심-대표재지적] 테이블은 있는데 다른 이유로 조회 실패(권한·RLS 등) -> 빈 맵이지만 warning 있음(화면에 경고 표시) ===");
  const ctx2b = buildContext(() => ({ data: null, error: { message: "permission denied for table wing_direct_po_cancellations", code: "42501" } }));
  const result2b = await ctx2b.__test.getLoadWingDirectCancellations()();
  check("빈 맵 반환", result2b.map, {});
  check("[핵심] warning 이 채워짐(조용히 '이력 없음'으로 표시 안 함)", typeof result2b.warning === "string" && result2b.warning.length > 0, true);
  checkIncludes("warning 에 오류 내용 포함", result2b.warning, "permission denied");

  console.log("\n=== [핵심-빈틈] sb 호출 자체가 예외를 던짐(네트워크 오류 등) -> 빈 맵 + warning 있음 ===");
  const ctx3 = buildContext(() => { throw new Error("network down"); });
  const result3 = await ctx3.__test.getLoadWingDirectCancellations()();
  check("빈 맵 반환(예외를 안 올림)", result3.map, {});
  check("[핵심] 네트워크 예외도 warning 으로 표시", typeof result3.warning === "string" && result3.warning.length > 0, true);

  console.log("\n=== [핵심] wingCancelChipHtml(null) -> 빈 문자열(이력 없는 PO 는 배지 자체가 안 붙음) ===");
  const ctxChip = buildContext(() => ({ data: [], error: null }));
  const chipEmpty = ctxChip.__test.getChipHtml()(null);
  check("빈 문자열", chipEmpty, "");

  console.log("\n=== [핵심] wingCancelChipHtml(이력 있음) -> 배지 HTML 에 사유/shipment id 가 title 로 포함 ===");
  const record = { po_id: "po-1", wing_shipment_id: "1104592096410472448", reason: "WING 에서 대표님이 직접 취소 확인", confirmed_at: "2026-09-19T08:00:00+00:00" };
  const chipHtml = ctxChip.__test.getChipHtml()(record);
  checkIncludes("배지 텍스트 '입고 취소' 포함", chipHtml, "입고 취소");
  checkIncludes("사유가 title 속성에 포함", chipHtml, "WING 에서 대표님이 직접 취소 확인");
  checkIncludes("shipment id 가 title 속성에 포함", chipHtml, "1104592096410472448");

  console.log(`\n${"=".repeat(70)}`);
  if (FAILS.length) {
    console.log(`${FAILS.length}건 실패`);
    process.exit(1);
  }
  console.log("모두 통과");
})();
