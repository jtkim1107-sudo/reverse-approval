// fixtures_bank_statement_upload_ui.mjs - js/bank_statement_upload.js (자금일보 통장 파일 올리기) 로컬 검증. 네트워크 없음.
//   node fixtures_bank_statement_upload_ui.mjs
import fs from "node:fs";
import vm from "node:vm";
const ctx = { console, FormData, Blob };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL("./js/bank_statement_upload.js", import.meta.url), "utf8"), ctx);
const B = ctx.BankStatementUpload;
let n = 0, fail = 0;
const check = (label, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n       기대=${JSON.stringify(want)}\n       실제=${JSON.stringify(got)}`}`); };

const PV = { status: "PREVIEW", new: 3, matched: 19, bank_balance: 17123456, bank_as_of: "2026-10-01T15:20:00", paid_plans_to_close: 1, plans_to_review: 0, source_sha256: "a".repeat(64) };
const file = new Blob(["x"]); file.name = "거래내역조회_입출식 예금20261002.xlsx";
const fakeFetch = (responses, log) => async (url, opt) => { const mode = opt.body.get("mode"); log.push([url, mode, opt.body.get("expect_sha256"), opt.headers.Authorization]);
  const [code, body] = responses[mode]; return { status: code, json: async () => body }; };

console.log("[1] 확인 문장");
const t = B.previewText(PV);
check("기준 시각·잔액·새 거래·정리 계획", [t.includes("2026-10-01 15:20:00"), t.includes("₩17,123,456"), t.includes("3건을 추가"), t.includes("1건을 정리")], [true, true, true, true]);
check("새 거래·정리할 계획이 없으면 확인 없이 '이미 최신'", [B.previewText({ ...PV, new: 0, paid_plans_to_close: 0 }), B.resultText({ ...PV, new: 0, paid_plans_to_close: 0 }, 200).startsWith("이미 최신")], [null, true]);
check("거절 사유는 서버 문장 그대로", B.resultText({ status: "REJECTED", message: "ERP에 있지만 통장 파일에는 없는 실제 거래가 있습니다" }, 409), "ERP에 있지만 통장 파일에는 없는 실제 거래가 있습니다");
check("401 → 로그인 필요", B.resultText(null, 401), "ERP 로그인이 필요합니다");

console.log("[2] 흐름 - 미리보기 → 확인 → 같은 파일 SHA 로 반영");
let log = [];
let r = await B.run(file, { base: "https://vm", token: "jwt", fetchFn: fakeFetch({ preview: [200, PV], apply: [200, { ...PV, status: "APPLIED", written: true }] }, log), confirmFn: () => true });
check("두 번 호출(preview, apply) · apply 는 preview SHA · Bearer", log.map(x => [x[0], x[1], x[2], x[3]]),
      [["https://vm/api/bank-statement/import", "preview", null, "Bearer jwt"], ["https://vm/api/bank-statement/import", "apply", "a".repeat(64), "Bearer jwt"]]);
check("반영 결과", [r.applied, r.text.includes("3건 반영")], [true, true]);
log = [];
r = await B.run(file, { base: "https://vm", token: "jwt", fetchFn: fakeFetch({ preview: [200, PV], apply: [200, {}] }, log), confirmFn: () => false });
check("취소하면 반영 호출 없음", [log.length, r.applied, r.text], [1, false, "반영하지 않았습니다"]);
log = [];
r = await B.run(file, { base: "https://vm", token: "jwt", fetchFn: fakeFetch({ preview: [409, { status: "REJECTED", message: "통장 파일의 날짜·입출금·잔액 형식이 달라졌습니다" }] }, log), confirmFn: () => true });
check("미리보기 거절이면 반영 없음", [log.length, r.applied, r.text], [1, false, "통장 파일의 날짜·입출금·잔액 형식이 달라졌습니다"]);

const idx = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("./js/app.js", import.meta.url), "utf8");
check("index.html 에 모듈이 app.js 보다 먼저", idx.indexOf("js/bank_statement_upload.js") > 0 && idx.indexOf("js/bank_statement_upload.js") < idx.indexOf("js/app.js"), true);
check("자금일보에 '통장 파일 올리기' 버튼", [app.includes('id="bank-upload-btn"'), app.includes("async function uploadBankStatement(")], [true, true]);
console.log(`\n${n - fail}/${n} 통과`);
process.exit(fail ? 1 : 0);
