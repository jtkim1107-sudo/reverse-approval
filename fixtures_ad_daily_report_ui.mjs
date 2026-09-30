// fixtures_ad_daily_report_ui.mjs
// 2026-09-30 일일 광고 보고서 카드(js/ad_product_profit.js) 격리 검증. 네트워크 없음.
//   · 상태 3종(정상/확인 필요/생성 실패) 표시 · 실패는 버튼 비활성(이전 보고서 대체 없음) · 사유 노출
//   · 요일 · 4개 넘으면 '지난 N일 보기' · 로딩/오류/빈 목록 · 광고 조작 버튼 없음 · 모바일 세로 배치 CSS
import fs from "node:fs";
import vm from "node:vm";

let failures = 0;
const check = (ok, label, extra) => { if (!ok) failures += 1; console.log(`${ok ? "OK" : "FAIL"} ${label}`); if (!ok && extra !== undefined) console.log("   ", String(extra).slice(0, 400)); };
const ctx = { window: {}, console };
vm.createContext(ctx);
for (const f of ["./js/erp_ui.js", "./js/ad_product_profit.js"]) vm.runInContext(fs.readFileSync(new URL(f, import.meta.url), "utf8"), ctx);
const A = ctx.window.AdProductProfit;
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const items = [
  { report_date: "2026-09-29", status: "정상", reasons: [], generated_at: "2026-09-30T10:00:31+09:00", png: true },
  { report_date: "2026-09-28", status: "확인 필요", reasons: ["캠페인별: 광고센터 로그인 만료 - 맥에서 광고센터 재로그인이 필요해요"], generated_at: "2026-09-29T10:00:12+09:00", png: true },
  { report_date: "2026-09-27", status: "생성 실패", reasons: ["계정 합계(WING) 2026-09-27 미수집", "캠페인별: 캠페인 원본을 받지 못했어요"], generated_at: "2026-09-28T10:00:05+09:00", png: false },
  { report_date: "2026-09-26", status: "정상", reasons: [], generated_at: "2026-09-27T10:00:05+09:00", png: true },
  { report_date: "2026-09-25", status: "정상", reasons: [], generated_at: "2026-09-26T10:00:05+09:00", png: true },
];
let h = A.dailyHtml({ daily: { items }, dailyAll: false });
const t = text(h);
check(/2026-09-29\(화\)/.test(t) && /2026-09-27\(일\)/.test(t), "요일 표시", t);
check(t.includes("정상") && t.includes("확인 필요") && t.includes("생성 실패"), "상태 3종");
check(t.includes("광고센터 로그인 만료"), "확인 필요 사유 노출");
check((h.match(/PNG 받기/g) || []).length === 3 && (h.match(/받을 파일 없음/g) || []).length === 1, "실패 날짜만 버튼 비활성", h);
check(/disabled>받을 파일 없음/.test(h.replace(/\s+/g, " ")), "비활성 버튼 disabled");
check(h.includes("downloadDaily('2026-09-29')") && !h.includes("downloadDaily('2026-09-27')"), "다운로드 대상 날짜");
check(!t.includes("2026-09-25") && t.includes("지난 5일 보기"), "기본 4개 + 더보기");
h = A.dailyHtml({ daily: { items }, dailyAll: true });
check(text(h).includes("2026-09-25") && text(h).includes("접기"), "펼치기");
check(text(A.dailyHtml({ daily: null })).includes("불러오는 중"), "로딩");
check(text(A.dailyHtml({ daily: { error: "HTTP 401", items: [] } })).includes("불러오지 못했어요"), "오류");
check(text(A.dailyHtml({ daily: { items: [] } })).includes("매일 10:00"), "빈 목록 안내");
check(!/(예산|목표 ROAS|ON\/OFF|끄기|켜기).*(button|onclick)/.test(A.dailyHtml({ daily: { items } })), "광고 조작 버튼 없음");
check(A.dailyRowHtml({ report_date: "2026-09-29", status: "<b>x</b>", reasons: ["<img src=x>"], png: false }).includes("&lt;img"), "사유 이스케이프");
const page = A.pageHtml({ ...A._state, daily: { items } });
check(page.indexOf("일일 광고 보고서") < page.indexOf("adp-period"), "기존 화면 맨 위 배치");
const css = fs.readFileSync(new URL("./css/style.css", import.meta.url), "utf8");
check(/@media \(max-width: 640px\)[\s\S]*\.adr-row \{ flex-direction: column/.test(css), "모바일 세로 배치 CSS");
check(/\.adr-row \.btn \{ width: 100%/.test(css), "모바일 버튼 전체 폭");
const idx = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
check(idx.includes("js/ad_product_profit.js?v=3") && /css\/style\.css\?v=(7[3-9]|[89]\d)/.test(idx), "캐시 번호 올림");
console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);
