/**
 * fixtures_wing_direct_po_cancel_dryrun.js
 * ------------------------------------------------
 * cancelWingDirectPO() 의 *** 실제 함수 경로 *** 회귀테스트(네트워크·브라우저 없음). 다른
 * fixtures_*.js 와 같은 원칙 - 손으로 만든 요약이 아니라 js/app.js 의 진짜 소스를 Node vm 으로
 * 그대로 실행해서(재구현 아님, 복붙 아님 - 드리프트 위험 없음) 그 실제 코드 경로를 태운다.
 *
 * 2026-09-19 [대표 지시] WING 직접입고 연결 PO 는 기존 cancelPO() 의 raw update 대신
 * fn_cancel_wing_direct_po RPC(사유 필수, 서버가 WING mirror/manifest 재검증)를 쓴다. 이 파일은
 * cancelWingDirectPO() 가 실제로 그 RPC 를 정확한 인자로 부르는지, 사유 검증이 RPC 호출 자체를
 *막는지, 서버 오류/idempotent 응답을 올바르게 구분해서 안내하는지를 검증한다.
 *
 * *** 로컬 실행만 - 이 파일은 index.html 에서 안 불러옴(운영 번들에 안 들어감, node 로만 실행) ***
 *   node js/fixtures_wing_direct_po_cancel_dryrun.js
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

const APP_JS_PATH = path.join(__dirname, "app.js");
const ERP_UI_JS_PATH = path.join(__dirname, "erp_ui.js");
const appSrcFull = fs.readFileSync(APP_JS_PATH, "utf8");
const CUT_MARKER = "/* ---------- 모바일 사이드바 ---------- */";
const cutIdx = appSrcFull.indexOf(CUT_MARKER);
if (cutIdx < 0) throw new Error(`app.js 에서 절단 지점을 못 찾음("${CUT_MARKER}") - 파일이 바뀌었으면 이 테스트도 같이 고쳐야 해요`);
const appSrc = appSrcFull.slice(0, cutIdx);
const erpUiSrc = fs.readFileSync(ERP_UI_JS_PATH, "utf8");

function makeFakeDocument() {
  return {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {} }),
    body: { appendChild() {}, style: {} }, addEventListener() {},
  };
}

function buildContext({ rpcResult }) {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.navigator = {};
  sandbox.document = makeFakeDocument();
  const rpcCalls = [];
  const fakeSb = {
    rpc(fnName, args) {
      rpcCalls.push({ fnName, args });
      return Promise.resolve(rpcResult());
    },
    from() {
      throw new Error("cancelWingDirectPO() 는 sb.from() 을 부르면 안 됨(RPC 만 씀) - 다른 경로를 탔을 가능성");
    },
  };
  sandbox.window.supabase = { createClient: () => fakeSb };
  const context = vm.createContext(sandbox);
  const trailer = `
    var __test = {
      getCancel: function () { return cancelWingDirectPO; },
      rpcCalls: ${JSON.stringify(rpcCalls)},  // placeholder, overwritten below via closure trick
    };
    route = async function () { __test.routeCalls = (__test.routeCalls || 0) + 1; };
    loadPOs = async function () { __test.loadPOsCalls = (__test.loadPOsCalls || 0) + 1; };
    closeModal = function () { __test.closeModalCalls = (__test.closeModalCalls || 0) + 1; };
    toast = function (msg) { __test.toasts = __test.toasts || []; __test.toasts.push(msg); };
  `;
  const combined = erpUiSrc + "\n" + appSrc + "\n" + trailer;
  new vm.Script(combined, { filename: "app-bundle.js" }).runInContext(context);
  context.__test.rpcCallsRef = rpcCalls;   // 실제 배열 참조를 직접 넘김(JSON 스냅샷이 아니라 실시간 반영)
  return context;
}

async function run(name, { promptReturn, rpcResult }, assertFn) {
  console.log(`\n=== ${name} ===`);
  const ctx = buildContext({ rpcResult });
  ctx.window.prompt = () => promptReturn;
  const cancelWingDirectPO = ctx.__test.getCancel();
  await cancelWingDirectPO("po-target-1");
  assertFn(ctx.__test, ctx.__test.rpcCallsRef);
}

(async () => {
  await run(
    "[핵심] prompt 취소(null) -> RPC 호출 자체를 안 함",
    { promptReturn: null, rpcResult: () => ({ data: null, error: null }) },
    (t, rpcCalls) => {
      check("RPC 호출 0번", rpcCalls.length, 0);
      check("toast 안 뜸", t.toasts, undefined);
    }
  );

  await run(
    "[핵심-빈틈] 사유 5자 미만(공백 제거 후) -> RPC 호출 안 함, 안내 메시지",
    { promptReturn: "짧음", rpcResult: () => ({ data: null, error: null }) },
    (t, rpcCalls) => {
      check("RPC 호출 0번", rpcCalls.length, 0);
      check("toast: 5자 이상 안내", t.toasts, ["사유를 5자 이상 입력해 주세요"]);
    }
  );

  await run(
    "[핵심-빈틈] 공백만 입력(trim 하면 0자) -> RPC 호출 안 함",
    { promptReturn: "     ", rpcResult: () => ({ data: null, error: null }) },
    (t, rpcCalls) => {
      check("RPC 호출 0번", rpcCalls.length, 0);
      check("toast: 5자 이상 안내", t.toasts, ["사유를 5자 이상 입력해 주세요"]);
    }
  );

  await run(
    "[핵심] 정상 사유 -> RPC 를 정확한 인자로 1번 호출(앞뒤 공백 제거된 사유)",
    { promptReturn: "  WING 취소 확인함  ", rpcResult: () => ({ data: { already_cancelled: false }, error: null }) },
    (t, rpcCalls) => {
      check("RPC 호출 1번", rpcCalls.length, 1);
      check("함수명 정확", rpcCalls[0].fnName, "fn_cancel_wing_direct_po");
      check("p_po_id 정확히 전달", rpcCalls[0].args.p_po_id, "po-target-1");
      check("p_reason 앞뒤 공백 제거돼서 전달", rpcCalls[0].args.p_reason, "WING 취소 확인함");
    }
  );

  await run(
    "[핵심] RPC 성공(신규 취소) -> '취소되었습니다' 안내 + closeModal + route",
    { promptReturn: "정상 취소 사유입니다", rpcResult: () => ({ data: { already_cancelled: false }, error: null }) },
    (t) => {
      check("toast: 신규 취소 안내", t.toasts, ["취소되었습니다(WING 재검증 통과)"]);
      check("closeModal 1번", t.closeModalCalls, 1);
      check("route 1번", t.routeCalls, 1);
    }
  );

  await run(
    "[핵심-11] RPC 성공(이미 취소됨, idempotent) -> '이미 취소된' 안내로 구분(신규 취소와 다른 문구)",
    { promptReturn: "재시도 호출입니다", rpcResult: () => ({ data: { already_cancelled: true }, error: null }) },
    (t) => {
      check("toast: 이미 취소됨 안내", t.toasts, ["이미 취소된 발주서예요"]);
      check("closeModal 1번(idempotent 응답도 정상 흐름으로 처리)", t.closeModalCalls, 1);
    }
  );

  await run(
    "[핵심-빈틈] RPC 가 서버 검증 실패(예: WING 아직 안 죽음, 22023)를 돌려줌 -> 오류 안내만, closeModal/route 안 부름(취소 안 됨)",
    { promptReturn: "아직 살아있는 상태 테스트", rpcResult: () => ({ data: null, error: { message: "이 shipment의 일부 SKU가 아직 CANCELLED/FAILED 상태가 아닙니다 - 취소하지 않습니다.", code: "22023" } }) },
    (t) => {
      check("toast 가 '취소하지 않았어요:' 접두어 + 서버 오류 메시지를 그대로 보여줌",
           t.toasts && t.toasts[0] === "취소하지 않았어요: 이 shipment의 일부 SKU가 아직 CANCELLED/FAILED 상태가 아닙니다 - 취소하지 않습니다.",
           true);
      check("closeModal 안 부름(취소 실패했으므로 모달 유지)", t.closeModalCalls, undefined);
      check("route 안 부름", t.routeCalls, undefined);
    }
  );

  await run(
    "[핵심-빈틈] RPC 가 권한 오류(42501)를 돌려줌 -> 오류 안내만, PO 안 바뀜(closeModal 안 부름)",
    { promptReturn: "권한 없는 사용자 테스트", rpcResult: () => ({ data: null, error: { message: "이 발주서를 취소할 권한이 없습니다(기안자·승인권자·자동화 계정만 가능합니다).", code: "42501" } }) },
    (t) => {
      check("toast 에 권한 오류 메시지 포함", t.toasts && t.toasts[0].includes("권한이 없습니다"), true);
      check("closeModal 안 부름", t.closeModalCalls, undefined);
    }
  );

  console.log(`\n${"=".repeat(70)}`);
  if (FAILS.length) {
    console.log(`${FAILS.length}건 실패`);
    process.exit(1);
  }
  console.log("모두 통과");
})();
