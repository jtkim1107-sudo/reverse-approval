// fixtures_admin_nav_gating.mjs
// ------------------------------------------------
// 2026-09-28 사이드바 관리자 도구 이동·게이팅 검증(네트워크 0건, DOM 은 가짜).
//   1) index.html: 3개 도구(재입고 WING 복구·재입고 문의 테스트 종료·WING 직접입고 최종수량 정정)는
//      '시스템 · 관리자 도구' 아래, nav-admin + hidden(기본 숨김). '재입고 후보 승인'은 기준 정보에 nav-admin 없이 유지.
//   2) 라우트/기능은 삭제 안 됨(app.js 라우트·스크립트 태그 유지).
//   3) app.js applyAdminNav(): me.approver 만 .nav-admin 의 hidden 을 해제. renderUserBox 가 이를 호출.
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
let fails = 0, passes = 0;
const check = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(got)}, 기대=${JSON.stringify(want)})`}`);
  if (ok) passes++; else fails++;
};

const index = read("./index.html"), app = read("./js/app.js");
const ADMIN = ["restockrecovery", "restockinquiryclose", "wingreceiptfix"];

console.log("[1] index.html - 3개 도구는 nav-admin + hidden");
for (const r of ADMIN) {
  const m = index.match(new RegExp(`<a href="#/${r}" data-route="${r}" class="([^"]*)"`));
  check(!!m && /\bnav-admin\b/.test(m[1]) && /\bhidden\b/.test(m[1]), true, `${r}: nav-admin + hidden`);
}
check(/<div class="nav-label nav-admin nav-admin-label hidden">[^<]*관리자 도구<\/div>/.test(index), true, "'시스템 · 관리자 도구' 라벨(nav-admin, 기본 hidden)");

console.log("[2] '재입고 후보 승인'은 기준 정보 유지(nav-admin 아님), 3개 도구는 시스템 뒤로 이동");
const mApp = index.match(/<a href="#\/restockapproval" data-route="restockapproval" class="([^"]*)"/);
check(!!mApp && !/nav-admin/.test(mApp[1]) && /\bnav-item\b/.test(mApp[1]), true, "restockapproval: nav-item (nav-admin 아님)");
const iBase = index.indexOf('기준 정보'), iSys = index.indexOf('>시스템<'), iApproval = index.indexOf('data-route="restockapproval"');
check(iBase < iApproval && iApproval < iSys, true, "restockapproval 은 기준 정보~시스템 사이(기준 정보 그룹)");
for (const r of ADMIN) check(index.indexOf(`data-route="${r}"`) > iSys, true, `${r} 은 시스템 라벨 뒤(기준 정보 밖)`);

console.log("[3] 라우트/스크립트/기능 유지(삭제 아님)");
for (const r of ADMIN) check(new RegExp(`${r}: \\{ title:`).test(app), true, `app.js 라우트 ${r} 유지`);
for (const s of ["restock_wing_recovery.js", "restock_inquiry_close.js", "wing_direct_receipt_fix.js"])
  check(index.includes(`js/${s}?v=`), true, `index.html 스크립트 ${s} 유지`);

console.log("[4] app.js applyAdminNav(): me.approver 로 .nav-admin hidden 토글 + renderUserBox 호출");
check(/function applyAdminNav\(\)/.test(app), true, "applyAdminNav 정의됨");
check(/renderUserBox[\s\S]{0,300}applyAdminNav\(\)/.test(app), true, "renderUserBox 가 applyAdminNav 호출");
// 동작: applyAdminNav 를 가짜 DOM 으로 실행 - approver 면 hidden 해제, 아니면 hidden 유지
const body = app.match(/function applyAdminNav\(\)\s*\{([\s\S]*?)\n\}/)[1];
function runToggle(approver) {
  const nodes = [{ hidden: true }, { hidden: true }, { hidden: true }].map(n => ({
    classList: { toggle: (c, on) => { if (c === "hidden") n.hidden = !!on; } }, _n: n }));
  const sandbox = { me: approver ? { approver: true } : { approver: false },
    document: { querySelectorAll: sel => (sel === ".nav-admin" ? nodes : []) } };
  vm.runInNewContext(body, sandbox);
  return nodes.map(x => x._n.hidden);
}
check(runToggle(true), [false, false, false], "승인 권한자: .nav-admin 노출(hidden=false)");
check(runToggle(false), [true, true, true], "비-승인자: .nav-admin 숨김(hidden=true)");

console.log(`\n${fails ? "FAIL" : "ALL PASS"} ${passes} / FAIL ${fails}`);
process.exit(fails ? 1 : 0);
