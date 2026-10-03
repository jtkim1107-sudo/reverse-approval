// fixtures_router_deeplink.mjs - 2026-09-27 라우터 deep link(#/화면?id=…) 회귀 검증(네트워크·DB 0)
//   app.js route() 가 쓰는 '라우트 이름·param 뽑기' 식을 그대로 꺼내 평가해요.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./js/app.js", import.meta.url), "utf-8");
let pass = 0, fail = 0;
const check = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(got)}, 기대=${JSON.stringify(want)})`}`);
};

const m = src.match(/const \[name, param\] = (hash[^;]*);/);
check(!!m, true, "route() 의 이름·param 식을 찾음");
const parse0 = new Function("hash", `return ${m[1]};`);
const parse = h => { const [a, b] = parse0(h); return [a, b ?? null]; };
const rawHash = h => h.replace(/^#\//, "") || "dashboard";

check(parse(rawHash("#/wingreceiptfix?id=1096696429834932224")), ["wingreceiptfix", null], "[핵심] deep link 쿼리는 이름에서 떼요");
check(parse(rawHash("#/wingreceiptfix?id=1096696429834932224&po=%EB%A6%AC")), ["wingreceiptfix", null], "id·po 둘 다 있어도 같은 화면");
check(parse(rawHash("#/wingreceiptfix")), ["wingreceiptfix", null], "메뉴 진입(쿼리 없음)");
check(parse(rawHash("#/stockflow/stock")), ["stockflow", "stock"], "기존 param 라우트 그대로");
check(parse(rawHash("#/doc/abc-123")), ["doc", "abc-123"], "문서 상세 param 그대로");
check(parse(rawHash("#/stockflow/stock?x=1")), ["stockflow", "stock"], "param 뒤 쿼리도 param 에서 떼요");
check(parse(rawHash("")), ["dashboard", null], "빈 hash → 대시보드");
check(parse(rawHash("#/restockinquiryclose")), ["restockinquiryclose", null], "다른 새 화면 그대로");

// 라우트 표에 화면이 등록돼 있어야 deep link 가 대시보드로 떨어지지 않아요
check(/\n\s*wingreceiptfix: \{ title: "WING 직접입고 최종수량 정정"/.test(src), true, "routes 에 wingreceiptfix 등록");
// 화면 모듈은 location.hash 에서 id·po 를 읽어요(라우터가 hash 를 바꾸지 않아야 함)
const wrf = readFileSync(new URL("./js/wing_direct_receipt_fix.js", import.meta.url), "utf-8");
check(/hash\.match\(\/\[\?&\]id=/.test(wrf) && /hash\.match\(\/\[\?&\]po=/.test(wrf), true, "화면이 hash 의 id·po 를 읽음");
const idx = readFileSync(new URL("./index.html", import.meta.url), "utf-8");
check(/js\/app\.js\?v=\d+/.test(idx), true, "app.js 캐시 버전 표시(숫자는 배포마다 올라감)");

console.log(`\n${fail ? "FAIL" : "ALL PASS"} PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
