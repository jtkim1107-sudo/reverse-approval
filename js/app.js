/* ============================================================
   주식회사 리버스 전자결재 시스템 — Supabase 연동 버전
   - 정적 웹앱 (GitHub Pages) + Supabase (DB/인증)
   - 모든 직원이 같은 데이터를 실시간 공유
   ============================================================ */

"use strict";

/* ---------- Supabase 연결 ---------- */
const SUPA_URL = "https://lqdgoqlkfckifqyjhnon.supabase.co";
const SUPA_KEY = "sb_publishable_MV6Ph9WOrv0nzVIvseXlLw_O5WhfQPv"; // publishable key (공개 가능)
const sb = window.supabase.createClient(SUPA_URL, SUPA_KEY);

const VAPID_PUBLIC_KEY = "BDGjrHCi-tBEuRwLkJ5HGtuB32VcQNwF69x1T0XJZy4QyUsO7D9RlWEfbVaXL-qQXI9S9JgRGJikX4DkdBFqbf4";

const ACCOUNTS = ["복리후생비", "여비교통비", "접대비", "소모품비", "지급수수료", "광고선전비", "통신비", "차량유지비", "교육훈련비", "기타"];
const PAY_METHODS = ["법인카드", "개인카드(환급)", "계좌이체", "현금"];

/* ---------- 전역 상태 ---------- */
let me = null;      // 내 프로필 {id, name, dept, role, approver}
let USERS = [];     // 전체 프로필
let loginTarget = null;

/* ---------- 유틸 ---------- */
const fmt = n => (Number(n) || 0).toLocaleString("ko-KR");
const pad2 = n => String(n).padStart(2, "0");
// 항상 한국(KST) 기준. 기기 시간대에 의존하면 해외에서 접속했을 때 하루 어긋난 채로 저장됨
const KST = { timeZone: "Asia/Seoul" };
const today = () =>
  new Intl.DateTimeFormat("en-CA", { ...KST, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
const nowStr = () => {
  const t = new Intl.DateTimeFormat("en-GB", { ...KST, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date());
  return `${today()} ${t}`;
};
const localDT = ts => {
  const d = new Date(ts);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- 부가세 ----------
   이익은 반드시 '공급가액(부가세 뺀 금액)' 기준으로 계산해야 합니다.
   판매가에는 부가세가 들어있고 원가에는 안 들어있으면, 그 차액만큼 이익이 부풀려 보입니다. */
let vatCfg = { enabled: true, salePriceIncludesVat: true, purchaseCostIncludesVat: false, expenseIncludesVat: true };
const VAT_RATE = 0.1;
// 부가세가 포함된 금액에서 공급가액만 떼어냄
const netAmt = (amount, included) => {
  const a = Number(amount) || 0;
  return (vatCfg.enabled && included) ? Math.round(a / (1 + VAT_RATE)) : a;
};
// 그 거래에 딸린 부가세.
// 부가세가 포함된 금액이면 빼내고, 별도로 적은 금액이면 그 10%를 따로 주고받은 것
const vatAmt = (amount, included) => {
  if (!vatCfg.enabled) return 0;
  const a = Number(amount) || 0;
  return included ? a - netAmt(a, true) : Math.round(a * VAT_RATE);
};
const isTaxable = p => (p?.tax_type || "과세") === "과세";
// 매출: 면세 상품은 부가세가 없으므로 판매가 전체가 공급가액
const saleNet = (amount, p) => (isTaxable(p) ? netAmt(amount, vatCfg.salePriceIncludesVat) : Number(amount) || 0);
const saleVat = (amount, p) => (isTaxable(p) ? vatAmt(amount, vatCfg.salePriceIncludesVat) : 0);
const buyNet = (amount, p) => (isTaxable(p) ? netAmt(amount, vatCfg.purchaseCostIncludesVat) : Number(amount) || 0);
const buyVat = (amount, p) => (isTaxable(p) ? vatAmt(amount, vatCfg.purchaseCostIncludesVat) : 0);
const expNet = amount => netAmt(amount, vatCfg.expenseIncludesVat);
const expVat = amount => vatAmt(amount, vatCfg.expenseIncludesVat);

async function loadVatCfg() {
  const { data } = await sb.from("settings").select("value").eq("key", "vat").maybeSingle();
  if (data?.value) vatCfg = { ...vatCfg, ...data.value };
  return vatCfg;
}
const userName = id => (USERS.find(u => u.id === id) || {}).name || "?";
const userRole = id => (USERS.find(u => u.id === id) || {}).role || "";

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 2400);
}

function docStatusChip(doc) {
  if (doc.status === "approved") return `<span class="chip approved">승인 완료</span>`;
  if (doc.status === "rejected") return `<span class="chip rejected">반려</span>`;
  const cur = doc.approval_line[doc.current_step];
  return `<span class="chip progress">결재 중 (${userName(cur?.userId)})</span>`;
}

/* ---------- 로그인 ---------- */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    const ok = await enterApp(session.user.id);
    if (ok) return;
  }
  await showLogin();
}

async function showLogin() {
  document.getElementById("app").classList.add("hidden");
  const { data: profiles, error } = await sb.from("profiles").select("*").order("name");
  const box = document.getElementById("login-users");
  if (error || !profiles?.length) {
    box.innerHTML = `<p style="color:var(--red);font-size:13px">서버 연결에 실패했습니다. 잠시 후 새로고침 해주세요.</p>`;
  } else {
    USERS = profiles;
    box.innerHTML = profiles.map(u => `
      <button class="login-user-btn" onclick="pickUser('${u.id}')">
        <span class="avatar">${esc(u.name[0])}</span>
        <span><b>${esc(u.name)}</b><small>${esc(u.dept)} · ${esc(u.role)}</small></span>
      </button>`).join("");
  }
  document.getElementById("login-screen").classList.remove("hidden");
}

function pickUser(id) {
  loginTarget = USERS.find(u => u.id === id);
  if (!loginTarget) return;
  document.getElementById("login-users").classList.add("hidden");
  document.getElementById("login-selected").innerHTML =
    `<span class="avatar">${esc(loginTarget.name[0])}</span> ${esc(loginTarget.name)} (${esc(loginTarget.role)})`;
  document.getElementById("login-form").classList.remove("hidden");
  document.getElementById("login-error").textContent = "";
  document.getElementById("login-pw").focus();
}

function resetLoginForm() {
  loginTarget = null;
  document.getElementById("login-form").classList.add("hidden");
  document.getElementById("login-users").classList.remove("hidden");
  document.getElementById("login-pw").value = "";
  document.getElementById("login-error").textContent = "";
}

async function doLogin(ev) {
  ev.preventDefault();
  if (!loginTarget) return false;
  const pw = document.getElementById("login-pw").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: loginTarget.email, password: pw });
  if (error) {
    errEl.textContent = "비밀번호가 올바르지 않습니다.";
    errEl.className = "login-note error";
    return false;
  }
  await enterApp(loginTarget.id);
  return false;
}

async function enterApp(userId) {
  const { data: profiles, error } = await sb.from("profiles").select("*").order("name");
  if (error || !profiles?.length) return false;
  USERS = profiles;
  me = USERS.find(u => u.id === userId);
  if (!me) { await sb.auth.signOut(); return false; }

  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("login-pw").value = "";
  renderUserBox();
  await loadVatCfg(); // 이익 계산 기준이므로 화면을 그리기 전에 불러와야 함
  if (!location.hash || location.hash === "#/") location.hash = "#/dashboard";
  await route();
  // 이미 알림 권한이 있으면 이 기기 구독을 현재 사용자로 갱신
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    ensurePushSubscribed(false);
  }
  return true;
}

/* ---------- 푸시 알림 ---------- */
function urlB64ToUint8Array(s) {
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function ensurePushSubscribed(interactive) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
    if (interactive) toast("이 브라우저는 알림을 지원하지 않습니다. (아이폰은 홈 화면에 추가 후 앱에서 켜주세요)");
    return false;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    let perm = Notification.permission;
    if (perm === "default" && interactive) perm = await Notification.requestPermission();
    if (perm !== "granted") {
      if (interactive) toast("알림 권한이 허용되지 않았습니다");
      return false;
    }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const json = sub.toJSON();
    const { error } = await sb.from("push_subscriptions").upsert(
      { user_id: me.id, endpoint: sub.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
      { onConflict: "endpoint" });
    if (error) throw error;
    if (interactive) toast("이 기기에서 알림이 켜졌습니다");
    return true;
  } catch (err) {
    console.error(err);
    if (interactive) toast("알림 설정에 실패했습니다");
    return false;
  }
}

async function logout() {
  await sb.auth.signOut();
  me = null;
  resetLoginForm();
  await showLogin();
}

async function changePassword() {
  const pw = document.getElementById("pw-new").value;
  const pw2 = document.getElementById("pw-new2").value;
  if (pw.length < 6) return toast("비밀번호는 6자 이상이어야 합니다");
  if (pw !== pw2) return toast("두 비밀번호가 일치하지 않습니다");
  const btn = document.getElementById("btn-pw");
  btn.disabled = true;
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    btn.disabled = false;
    return toast(error.message.includes("different") ? "기존과 다른 비밀번호를 입력하세요" : "변경에 실패했습니다");
  }
  toast("비밀번호가 변경되었습니다");
  document.getElementById("pw-new").value = "";
  document.getElementById("pw-new2").value = "";
  btn.disabled = false;
}

function renderUserBox() {
  document.getElementById("user-avatar").textContent = me.name[0];
  document.getElementById("user-name").textContent = me.name;
  document.getElementById("user-role").textContent = `${me.dept} · ${me.role}`;
  document.getElementById("topbar-user").textContent = `${me.name} (${me.role})`;
}

/* ---------- 데이터 조회 ---------- */
async function fetchDocs(filter) {
  let q = sb.from("documents").select("*").order("created_at", { ascending: false });
  if (filter?.drafter) q = q.eq("drafter_id", filter.drafter);
  if (filter?.status) q = q.eq("status", filter.status);
  const { data, error } = await q;
  if (error) { toast("문서를 불러오지 못했습니다"); return []; }
  return data || [];
}

function inboxOf(docs) {
  return docs.filter(d => d.status === "progress" && d.approval_line[d.current_step]?.userId === me.id);
}

async function updateBadge() {
  const docs = await fetchDocs({ status: "progress" });
  const n = inboxOf(docs).length;
  const b = document.getElementById("badge-inbox");
  b.textContent = n;
  b.classList.toggle("hidden", n === 0);
  // 내가 받은 미완료 업무 지시 수
  const { count } = await sb.from("tasks").select("id", { count: "exact", head: true })
    .eq("assignee_id", me.id).eq("status", "open");
  const tb = document.getElementById("badge-tasks");
  if (tb) {
    tb.textContent = count || 0;
    tb.classList.toggle("hidden", !count);
  }
}

/* ---------- 라우터 ---------- */
const routes = {
  dashboard: { title: "대시보드", render: viewDashboard },
  new: { title: "지출결의서 작성", render: viewNewDoc, after: () => addItemRow() },
  inbox: { title: "결재 대기함", render: viewInbox },
  drafts: { title: "내 기안함", render: viewDrafts },
  docs: { title: "전체 문서함", render: viewAllDocs },
  products: { title: "제품 마스터", render: viewProducts },
  channels: { title: "판매채널·SCM 계정", render: viewChannels },
  suppliers: { title: "매입 거래처", render: viewSuppliers },
  sales: { title: "매출 입력·조회", render: viewSales, after: () => addSaleRow() },
  purchases: { title: "매입 입력·조회", render: viewPurchases, after: () => addBuyRow() },
  inventory: { title: "재고 현황", render: viewInventory },
  profit: { title: "공헌이익", render: viewProfit },
  vat: { title: "부가세", render: viewVat },
  report: { title: "월별 리포트", render: viewReport },
  cash: { title: "자금일보", render: viewCash },
  tasks: { title: "업무 지시", render: viewTasks },
  aireport: { title: "AI 리포트", render: viewAiReport },
  settings: { title: "설정 · 알림", render: viewSettings },
  doc: { title: "문서 상세", render: viewDocDetail },
};

// 날짜가 바뀌면 화면 기본 날짜도 따라 옮김 (PWA는 며칠씩 안 닫고 쓰기 때문)
let lastKnownDay = today();
function syncTodayState() {
  const now = today();
  if (now === lastKnownDay) return;
  if (cashDate === lastKnownDay) cashDate = now;
  if (erpMonth === lastKnownDay.slice(0, 7)) erpMonth = now.slice(0, 7);
  lastKnownDay = now;
}

let routeSeq = 0;
async function route() {
  if (!me) return;
  const seq = ++routeSeq;
  const hash = location.hash.replace(/^#\//, "") || "dashboard";
  const [name, param] = hash.split("/");
  const r = routes[name] || routes.dashboard;
  syncTodayState(); // 앱을 켜둔 채 자정을 넘겨도 '오늘'이 어제로 굳지 않도록
  document.getElementById("page-title").textContent = r.title;
  document.querySelectorAll(".nav-item").forEach(el =>
    el.classList.toggle("active", el.dataset.route === name));
  const content = document.getElementById("content");
  content.innerHTML = `<div class="card" style="color:var(--text-sub)">불러오는 중…</div>`;
  const html = await r.render(param);
  if (seq !== routeSeq) return; // 다른 페이지로 이동한 경우 무시
  content.innerHTML = html;
  if (r.after) r.after(param);
  updateBadge();
  closeSidebar();
  window.scrollTo(0, 0);
}

/* ---------- 화면: 대시보드 ---------- */
async function viewDashboard() {
  const [docs, prodRes, saleRes, buyRes, taskRes, costRes] = await Promise.all([
    fetchDocs(),
    sb.from("products").select("*").order("updated_at", { ascending: false }).limit(5),
    sb.from("sales").select("amount,date"),
    sb.from("purchases").select("amount,date"),
    sb.from("tasks").select("assignee_id,status"),
    sb.from("purchase_costs").select("amount,date"),
  ]);
  const myTasks = (taskRes.data || []).filter(t => t.assignee_id === me.id && t.status === "open").length;
  const products = prodRes.data || [];
  const nowMonth = today().slice(0, 7);
  const monthSales = (saleRes.data || []).filter(r => (r.date || "").startsWith(nowMonth))
    .reduce((s, r) => s + Number(r.amount), 0);
  const monthBuys = (buyRes.data || []).filter(r => (r.date || "").startsWith(nowMonth))
    .reduce((s, r) => s + Number(r.amount), 0)
    + (costRes.data || []).filter(r => (r.date || "").startsWith(nowMonth))
    .reduce((s, r) => s + Number(r.amount), 0);
  const inbox = inboxOf(docs).length;
  const mine = docs.filter(d => d.drafter_id === me.id);
  const progress = mine.filter(d => d.status === "progress").length;
  const approved = mine.filter(d => d.status === "approved").length;
  const thisMonth = today().slice(0, 7);
  const monthTotal = docs
    .filter(d => d.status === "approved" && (d.date || "").startsWith(thisMonth))
    .reduce((s, d) => s + Number(d.total), 0);

  return `
    <div class="grid-stats">
      <div class="stat" onclick="location.hash='#/inbox'">
        <div class="stat-label">내 결재 대기</div>
        <div class="stat-value red">${inbox}건</div>
      </div>
      <div class="stat" onclick="location.hash='#/tasks'">
        <div class="stat-label">내가 받은 업무</div>
        <div class="stat-value ${myTasks ? "red" : "green"}">${myTasks}건</div>
      </div>
      <div class="stat" onclick="location.hash='#/drafts'">
        <div class="stat-label">내 기안 진행 중</div>
        <div class="stat-value amber">${progress}건</div>
      </div>
      <div class="stat" onclick="location.hash='#/drafts'">
        <div class="stat-label">내 기안 승인 완료</div>
        <div class="stat-value green">${approved}건</div>
      </div>
      <div class="stat" onclick="location.hash='#/docs'">
        <div class="stat-label">이번 달 승인 지출액</div>
        <div class="stat-value blue">₩${fmt(monthTotal)}</div>
      </div>
      <div class="stat" onclick="location.hash='#/sales'">
        <div class="stat-label">이번 달 매출</div>
        <div class="stat-value blue">₩${fmt(monthSales)}</div>
      </div>
      <div class="stat" onclick="location.hash='#/purchases'">
        <div class="stat-label">이번 달 매입</div>
        <div class="stat-value amber">₩${fmt(monthBuys)}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>최근 문서</h2>
        <button class="btn sm" onclick="location.hash='#/new'">＋ 지출결의서 작성</button>
      </div>
      ${docTable(docs.slice(0, 6))}
    </div>

    <div class="card">
      <div class="card-head">
        <h2>제품 마스터 최근 업데이트</h2>
        <button class="btn sm secondary" onclick="location.hash='#/products'">전체 보기</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>제품코드</th><th>제품명</th><th>규격</th><th class="num">단가</th><th>수정일</th></tr></thead>
        <tbody>
        ${products.map(p => `<tr><td>${esc(p.code)}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.spec)}</td><td class="num">₩${fmt(p.price)}</td><td>${esc(p.updated_at)}</td></tr>`).join("")
          || `<tr><td colspan="5" class="empty">등록된 제품이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

/* ---------- 문서 목록 테이블 ---------- */
function docTable(list) {
  if (!list.length) return `<div class="table-wrap"><table><tbody><tr><td class="empty">문서가 없습니다</td></tr></tbody></table></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>문서번호</th><th>제목</th><th>기안자</th><th>기안일</th><th class="num">금액</th><th>상태</th></tr></thead>
    <tbody>${list.map(d => `
      <tr class="clickable" onclick="location.hash='#/doc/${d.id}'">
        <td>${esc(d.doc_no)}</td>
        <td><b>${esc(d.title)}</b></td>
        <td>${userName(d.drafter_id)}</td>
        <td>${esc(d.date)}</td>
        <td class="num">₩${fmt(d.total)}</td>
        <td>${docStatusChip(d)}</td>
      </tr>`).join("")}
    </tbody></table></div>`;
}

/* ---------- 화면: 지출결의서 작성 ---------- */
async function viewNewDoc() {
  // 조직도상 나보다 윗사람만 결재 가능
  const approvers = USERS.filter(u => u.id !== me.id && u.approver && (u.rank || 0) > (me.rank || 0))
    .sort((a, b) => (a.rank || 0) - (b.rank || 0));
  if (!approvers.length) {
    // 최상위 결재권자(대표)가 직접 기안하는 경우 → 전결(자동 승인)
    return viewNewDocForm([], true);
  }
  return viewNewDocForm(approvers, false);
}

function viewNewDocForm(approvers, isTopRank) {
  return `
    <div class="card">
      <h2>지출결의서 작성</h2>
      <div class="form-grid">
        <div class="field full">
          <label>제목 *</label>
          <input id="f-title" placeholder="예) 8월 사무용품 구입 건" maxlength="80">
        </div>
        <div class="field">
          <label>지출(예정)일 *</label>
          <input id="f-date" type="date" value="${today()}">
        </div>
        <div class="field">
          <label>지불 방법</label>
          <select id="f-pay">${PAY_METHODS.map(m => `<option>${m}</option>`).join("")}</select>
        </div>
        <div class="field full">
          <label>비고 / 증빙 메모</label>
          <textarea id="f-note" placeholder="영수증 첨부 여부, 특이사항 등"></textarea>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>지출 항목</h2>
        <button class="btn sm secondary" onclick="addItemRow()">＋ 항목 추가</button>
      </div>
      <div class="table-wrap">
        <table class="items-table">
          <thead><tr><th style="width:150px">계정과목</th><th>내용</th><th style="width:140px" class="num">금액(원)</th><th style="width:40px"></th></tr></thead>
          <tbody id="item-rows"></tbody>
        </table>
      </div>
      <div class="total-line">합계 <b id="f-total">₩0</b></div>
    </div>

    <div class="card">
      <h2>결재선</h2>
      ${isTopRank ? `
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:10px">
        조직도상 상위 결재자가 없으므로 <b>상신 즉시 전결(자동 승인)</b> 처리됩니다.
      </p>` : `
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:10px">조직도상 윗사람에게 순서대로 결재가 진행됩니다.</p>
      <div class="form-grid">
        <div class="field">
          <label>1차 결재자 *</label>
          <select id="f-appr1">
            ${approvers.map((u, i) => `<option value="${u.id}" ${i === 0 ? "selected" : ""}>${esc(u.name)} (${esc(u.role)})</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>최종 결재자</label>
          <select id="f-appr2">
            <option value="">(없음 — 1차에서 종결)</option>
            ${approvers.map(u => `<option value="${u.id}" ${u.role === "대표이사" ? "selected" : ""}>${esc(u.name)} (${esc(u.role)})</option>`).join("")}
          </select>
        </div>
      </div>`}
      <div class="modal-actions">
        <button class="btn secondary" onclick="location.hash='#/dashboard'">취소</button>
        <button class="btn" id="btn-submit-doc" onclick="submitDoc()">${isTopRank ? "상신 (전결 처리)" : "상신 (결재 요청)"}</button>
      </div>
    </div>`;
}

function addItemRow() {
  const tbody = document.getElementById("item-rows");
  if (!tbody) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><select class="i-acct">${ACCOUNTS.map(a => `<option>${a}</option>`).join("")}</select></td>
    <td><input class="i-desc" placeholder="지출 내용" maxlength="100"></td>
    <td><input class="i-amt amount" type="number" min="0" step="1" placeholder="0" oninput="calcTotal()"></td>
    <td><button class="btn-row-del" title="삭제" onclick="this.closest('tr').remove();calcTotal()">✕</button></td>`;
  tbody.appendChild(tr);
}
function calcTotal() {
  const total = [...document.querySelectorAll(".i-amt")].reduce((s, el) => s + (Number(el.value) || 0), 0);
  document.getElementById("f-total").textContent = "₩" + fmt(total);
  return total;
}

async function submitDoc() {
  const title = document.getElementById("f-title").value.trim();
  const date = document.getElementById("f-date").value;
  if (!title) return toast("제목을 입력해 주세요");
  if (!date) return toast("지출일을 선택해 주세요");

  const items = [...document.querySelectorAll("#item-rows tr")].map(tr => ({
    account: tr.querySelector(".i-acct").value,
    desc: tr.querySelector(".i-desc").value.trim(),
    amount: Number(tr.querySelector(".i-amt").value) || 0,
  })).filter(it => it.desc || it.amount > 0);
  if (!items.length) return toast("지출 항목을 1개 이상 입력해 주세요");
  if (items.some(it => !it.desc)) return toast("항목 내용을 입력해 주세요");
  if (items.some(it => it.amount <= 0)) return toast("금액은 0보다 커야 합니다");

  // 결재선: 조직도상 윗사람. 최상위 직급이 기안하면 전결(자동 승인)
  const hasApprovalUI = !!document.getElementById("f-appr1");
  let line = [];
  if (hasApprovalUI) {
    const appr1 = document.getElementById("f-appr1").value;
    const appr2 = document.getElementById("f-appr2").value;
    line = [appr1, appr2].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
      .map(uid => ({ userId: uid, status: "waiting", comment: "", date: "" }));
    if (!line.length) return toast("결재자를 선택해 주세요");
  }
  const isJeongyeol = !hasApprovalUI;

  const btn = document.getElementById("btn-submit-doc");
  btn.disabled = true;
  try {
    const { data: docNo, error: e1 } = await sb.rpc("next_doc_no");
    if (e1) throw e1;
    const { data, error: e2 } = await sb.from("documents").insert({
      doc_no: docNo,
      title, date,
      pay: document.getElementById("f-pay").value,
      note: document.getElementById("f-note").value.trim(),
      drafter_id: me.id,
      items,
      total: items.reduce((s, it) => s + it.amount, 0),
      approval_line: line,
      current_step: 0,
      status: isJeongyeol ? "approved" : "progress",
    }).select().single();
    if (e2) throw e2;
    toast(isJeongyeol ? "전결 처리되었습니다" : "상신되었습니다");
    location.hash = "#/doc/" + data.id;
  } catch (err) {
    console.error(err);
    toast("상신에 실패했습니다. 다시 시도해 주세요.");
    btn.disabled = false;
  }
}

/* ---------- 화면: 결재 대기함 ---------- */
async function viewInbox() {
  const docs = await fetchDocs({ status: "progress" });
  const list = inboxOf(docs);
  return `
    <div class="card">
      <div class="card-head"><h2>내가 결재할 문서 (${list.length}건)</h2></div>
      ${docTable(list)}
    </div>`;
}

/* ---------- 화면: 내 기안함 ---------- */
async function viewDrafts() {
  const list = await fetchDocs({ drafter: me.id });
  return `
    <div class="card">
      <div class="card-head">
        <h2>내가 기안한 문서 (${list.length}건)</h2>
        <button class="btn sm" onclick="location.hash='#/new'">＋ 지출결의서 작성</button>
      </div>
      ${docTable(list)}
    </div>`;
}

/* ---------- 화면: 전체 문서함 ---------- */
let docsFilter = { q: "", status: "" };
let docsCache = [];
async function viewAllDocs() {
  docsCache = await fetchDocs();
  return `
    <div class="card">
      <div class="card-head"><h2 id="docs-count">전체 문서 (${filteredDocs().length}건)</h2></div>
      <div class="searchbar" style="margin-bottom:14px">
        <input placeholder="제목, 문서번호, 기안자 검색" value="${esc(docsFilter.q)}"
          oninput="docsFilter.q=this.value;refreshDocsTable()">
        <select onchange="docsFilter.status=this.value;refreshDocsTable()">
          <option value="">전체 상태</option>
          <option value="progress" ${docsFilter.status === "progress" ? "selected" : ""}>결재 중</option>
          <option value="approved" ${docsFilter.status === "approved" ? "selected" : ""}>승인 완료</option>
          <option value="rejected" ${docsFilter.status === "rejected" ? "selected" : ""}>반려</option>
        </select>
      </div>
      <div id="docs-table">${docTable(filteredDocs())}</div>
    </div>`;
}
function filteredDocs() {
  let list = docsCache;
  if (docsFilter.status) list = list.filter(d => d.status === docsFilter.status);
  if (docsFilter.q) {
    const q = docsFilter.q.toLowerCase();
    list = list.filter(d =>
      d.title.toLowerCase().includes(q) || d.doc_no.toLowerCase().includes(q) ||
      userName(d.drafter_id).includes(q));
  }
  return list;
}
function refreshDocsTable() {
  const list = filteredDocs();
  document.getElementById("docs-table").innerHTML = docTable(list);
  document.getElementById("docs-count").textContent = `전체 문서 (${list.length}건)`;
}

/* ---------- 화면: 문서 상세 ---------- */
async function viewDocDetail(id) {
  const { data: d, error } = await sb.from("documents").select("*").eq("id", id).single();
  if (error || !d) return `<div class="card"><p class="empty">문서를 찾을 수 없습니다.</p></div>`;

  const isMyTurn = d.status === "progress" && d.approval_line[d.current_step]?.userId === me.id;

  const steps = `
    <div class="appr-line">
      <div class="appr-step approved">
        <div class="step-role">기안</div>
        <div class="step-name">${userName(d.drafter_id)}</div>
        <div class="step-date">${esc(localDT(d.created_at))}</div>
      </div>
      ${d.approval_line.map((s, i) => {
        let cls = "", label = "대기";
        if (s.status === "approved") { cls = "approved"; label = "✔ 승인"; }
        else if (s.status === "rejected") { cls = "rejected"; label = "✖ 반려"; }
        else if (d.status === "progress" && i === d.current_step) { cls = "current"; label = "결재 차례"; }
        return `<div class="appr-step ${cls}">
          <div class="step-role">${i + 1}차 결재 · ${userRole(s.userId)}</div>
          <div class="step-name">${userName(s.userId)}</div>
          <div class="step-status">${label}</div>
          ${s.date ? `<div class="step-date">${esc(s.date)}</div>` : ""}
        </div>`;
      }).join("")}
    </div>
    ${d.approval_line.filter(s => s.comment).map(s =>
      `<div class="doc-comment"><b>${userName(s.userId)}</b> — ${esc(s.comment)}</div>`).join("")}`;

  return `
    <div class="card">
      <div class="card-head">
        <h2>${esc(d.title)}</h2>
        ${docStatusChip(d)}
      </div>
      <div class="doc-meta">
        <div><span>문서번호</span><b>${esc(d.doc_no)}</b></div>
        <div><span>기안자</span>${userName(d.drafter_id)} (${userRole(d.drafter_id)})</div>
        <div><span>지출일</span>${esc(d.date)}</div>
        <div><span>지불방법</span>${esc(d.pay)}</div>
      </div>
      ${d.note ? `<div class="doc-comment">📎 ${esc(d.note)}</div>` : ""}
    </div>

    <div class="card">
      <h2>지출 내역</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>계정과목</th><th>내용</th><th class="num">금액</th></tr></thead>
        <tbody>
          ${d.items.map(it => `<tr><td>${esc(it.account)}</td><td>${esc(it.desc)}</td><td class="num">₩${fmt(it.amount)}</td></tr>`).join("")}
        </tbody>
      </table></div>
      <div class="total-line">합계 <b>₩${fmt(d.total)}</b></div>
    </div>

    <div class="card">
      <h2>결재선</h2>
      ${steps}
      ${isMyTurn ? `
        <div class="approve-box">
          <textarea id="appr-comment" placeholder="결재 의견 (선택)"></textarea>
          <button class="btn green" onclick="decide('${d.id}', true)">승인</button>
          <button class="btn danger" onclick="decide('${d.id}', false)">반려</button>
        </div>` : ""}
      <div class="modal-actions">
        <button class="btn secondary" onclick="history.back()">← 뒤로</button>
        ${d.drafter_id === me.id && d.status === "rejected" ? `<button class="btn" onclick="location.hash='#/new'">다시 작성</button>` : ""}
      </div>
    </div>`;
}

async function decide(docId, approve) {
  // 최신 상태를 다시 읽어 동시 결재 충돌 방지
  const { data: d, error } = await sb.from("documents").select("*").eq("id", docId).single();
  if (error || !d || d.status !== "progress") { toast("이미 처리된 문서입니다"); route(); return; }
  const step = d.approval_line[d.current_step];
  if (step.userId !== me.id) { toast("결재 권한이 없습니다"); route(); return; }

  step.comment = document.getElementById("appr-comment")?.value.trim() || "";
  step.date = nowStr();
  let patch;
  if (approve) {
    step.status = "approved";
    patch = d.current_step < d.approval_line.length - 1
      ? { approval_line: d.approval_line, current_step: d.current_step + 1 }
      : { approval_line: d.approval_line, status: "approved" };
  } else {
    step.status = "rejected";
    patch = { approval_line: d.approval_line, status: "rejected" };
  }
  const { error: e2 } = await sb.from("documents").update(patch).eq("id", docId);
  if (e2) { toast("처리에 실패했습니다"); return; }
  toast(approve ? "승인 처리되었습니다" : "반려 처리되었습니다");
  route();
}

/* ---------- 화면: 제품 마스터 ---------- */
let prodFilter = "";
let prodTypeFilter = "";
let prodCache = [];
async function viewProducts() {
  const { data, error } = await sb.from("products").select("*").order("code");
  prodCache = error ? [] : (data || []);
  return `
    <div class="card">
      <div class="card-head">
        <h2 id="prod-count">제품 마스터 (${prodCache.length}종)</h2>
        <div style="display:flex;gap:8px">
          <button class="btn sm secondary" onclick="exportProductsCSV()">CSV 내보내기</button>
          <button class="btn sm" onclick="openProductModal()">＋ 제품 등록</button>
        </div>
      </div>
      <div class="searchbar" style="margin-bottom:14px">
        <input placeholder="제품명, 코드, 분류 검색" value="${esc(prodFilter)}"
          oninput="prodFilter=this.value;refreshProductTable()">
        <select onchange="prodTypeFilter=this.value;refreshProductTable()">
          <option value="">전체 (사입+위탁)</option>
          <option value="사입" ${prodTypeFilter === "사입" ? "selected" : ""}>사입만</option>
          <option value="위탁" ${prodTypeFilter === "위탁" ? "selected" : ""}>위탁만</option>
        </select>
      </div>
      <div id="product-table">${productTable()}</div>
    </div>`;
}
function productTable() {
  let list = prodCache;
  if (prodTypeFilter) list = list.filter(p => (p.trade_type || "사입") === prodTypeFilter);
  if (prodFilter) {
    const q = prodFilter.toLowerCase();
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) ||
      (p.category || "").toLowerCase().includes(q));
  }
  if (!list.length) return `<div class="table-wrap"><table><tbody><tr><td class="empty">제품이 없습니다</td></tr></tbody></table></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>제품코드</th><th>제품명</th><th>구분</th><th>부가세</th><th>분류</th>
      <th class="num">원가</th><th class="num">판매가</th><th class="num">마진<br><small>부가세 제외</small></th><th class="num">마진율</th>
      <th class="num">MSRP</th><th class="num">박스입수</th><th>메모</th><th>최종수정</th><th></th></tr></thead>
    <tbody>${list.map(p => {
      const cost = Number(p.cost_price) || 0, price = Number(p.price) || 0;
      const taxable = isTaxable(p);
      const nPrice = taxable ? netAmt(price, vatCfg.salePriceIncludesVat) : price;
      const nCost = taxable ? netAmt(cost, vatCfg.purchaseCostIncludesVat) : cost;
      const margin = cost && price ? nPrice - nCost : null;
      const rate = margin !== null && nPrice ? Math.round((margin / nPrice) * 100) : null;
      return `
      <tr>
        <td>${esc(p.code)}</td>
        <td><b>${esc(p.name)}</b></td>
        <td>${(p.trade_type || "사입") === "위탁"
          ? '<span class="chip waiting">위탁</span>'
          : '<span class="chip mine">사입</span>'}</td>
        <td>${taxable ? '<span style="color:var(--text-sub)">과세</span>' : '<span class="chip waiting">면세</span>'}</td>
        <td>${esc(p.category)}</td>
        <td class="num">${cost ? "₩" + fmt(cost) : '<span style="color:var(--text-sub)">—</span>'}</td>
        <td class="num">₩${fmt(price)}</td>
        <td class="num">${margin !== null ? "₩" + fmt(margin) : '<span style="color:var(--text-sub)">—</span>'}</td>
        <td class="num">${rate !== null
          ? `<b style="color:${rate < 20 ? "#d9480f" : "var(--brand)"}">${rate}%</b>`
          : '<span style="color:var(--text-sub)">—</span>'}</td>
        <td class="num">${p.msrp ? "₩" + fmt(p.msrp) : '<span style="color:var(--text-sub)">—</span>'}</td>
        <td class="num">${p.box_qty ? fmt(p.box_qty) : '<span style="color:var(--text-sub)">—</span>'}</td>
        <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(p.memo)}</td>
        <td>${esc(p.updated_at)}<br><small style="color:var(--text-sub)">${esc(p.updated_by || "")}</small></td>
        <td style="white-space:nowrap">
          <button class="btn sm secondary" onclick="openProductModal('${p.id}')">수정</button>
          <button class="btn sm danger" onclick="deleteProduct('${p.id}')">삭제</button>
        </td>
      </tr>`; }).join("")}
    </tbody></table></div>`;
}
function refreshProductTable() {
  document.getElementById("product-table").innerHTML = productTable();
}

function openProductModal(id) {
  const p = id ? prodCache.find(x => x.id === id) : null;
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${p ? "제품 수정" : "제품 등록"}</h3>
        <div class="form-grid">
          <div class="field"><label>제품코드 *</label><input id="p-code" value="${esc(p?.code || "")}" placeholder="RV-000" maxlength="20"></div>
          <div class="field"><label>구분 *</label>
            <select id="p-type">
              <option value="사입" ${(p?.trade_type || "사입") === "사입" ? "selected" : ""}>사입 (직접 재고 보유)</option>
              <option value="위탁" ${p?.trade_type === "위탁" ? "selected" : ""}>위탁 (공급처 직배송)</option>
            </select></div>
          <div class="field full"><label>제품명 *</label><input id="p-name" value="${esc(p?.name || "")}" maxlength="60"></div>
          <div class="field"><label>분류</label><input id="p-cat" value="${esc(p?.category || "")}" placeholder="예) 건강식품" maxlength="30"></div>
          <div class="field"><label>부가세</label>
            <select id="p-tax">
              <option value="과세" ${(p?.tax_type || "과세") === "과세" ? "selected" : ""}>과세 (대부분의 공산품)</option>
              <option value="면세" ${p?.tax_type === "면세" ? "selected" : ""}>면세 (미가공 식품·도서 등)</option>
            </select></div>
          <div class="field"><label>규격</label><input id="p-spec" value="${esc(p?.spec || "")}" placeholder="예) 30g x 10입" maxlength="40"></div>
          <div class="field"><label>단위</label><input id="p-unit" value="${esc(p?.unit || "")}" placeholder="BOX / EA / 병" maxlength="10"></div>
          <div class="field"><label>원가(원) — 매입 단가</label>
            <input id="p-cost" type="number" min="0" value="${p?.cost_price ?? ""}" oninput="calcMarginHint()"></div>
          <div class="field"><label>판매가(원) — 실제 판매</label>
            <input id="p-price" type="number" min="0" value="${p?.price ?? ""}" oninput="calcMarginHint()"></div>
          <div class="field"><label>MSRP(원) — 권장소비자가</label>
            <input id="p-msrp" type="number" min="0" value="${p?.msrp ?? ""}"></div>
          <div class="field"><label>박스입수(개)</label>
            <input id="p-box" type="number" min="0" value="${p?.box_qty ?? ""}" placeholder="예) 40"></div>
          <div class="field full" id="margin-hint" style="font-size:13px;color:var(--text-sub)"></div>
          <div class="field full"><label>메모 (그 외 참고사항)</label><textarea id="p-memo" placeholder="원가·판매가·박스입수는 위 칸에 입력하세요">${esc(p?.memo || "")}</textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveProduct('${id || ""}')">저장</button>
        </div>
      </div>
    </div>`;
  calcMarginHint();
}

function calcMarginHint() {
  const el = document.getElementById("margin-hint");
  if (!el) return;
  const cost = Number(document.getElementById("p-cost")?.value) || 0;
  const price = Number(document.getElementById("p-price")?.value) || 0;
  if (!cost || !price) { el.textContent = "원가와 판매가를 넣으면 마진이 자동 계산됩니다."; return; }
  const taxable = (document.getElementById("p-tax")?.value || "과세") === "과세";
  // 부가세를 뺀 금액끼리 비교해야 실제 마진
  const netPrice = taxable ? netAmt(price, vatCfg.salePriceIncludesVat) : price;
  const netCost = taxable ? netAmt(cost, vatCfg.purchaseCostIncludesVat) : cost;
  const m = netPrice - netCost, rate = netPrice ? Math.round((m / netPrice) * 100) : 0;
  el.innerHTML = `개당 마진 <b>₩${fmt(m)}</b> · 마진율 <b style="color:${rate < 20 ? "#d9480f" : "var(--brand)"}">${rate}%</b>`
    + (vatCfg.enabled && taxable ? ` <span style="color:var(--text-sub)">(부가세 제외: 판매 ₩${fmt(netPrice)} − 원가 ₩${fmt(netCost)})</span>` : "")
    + (rate < 20 ? " ⚠️ 마진율이 낮습니다" : "");
}

function closeModal() { document.getElementById("modal-root").innerHTML = ""; }

async function saveProduct(id) {
  const code = document.getElementById("p-code").value.trim();
  const name = document.getElementById("p-name").value.trim();
  if (!code || !name) return toast("제품코드와 제품명은 필수입니다");

  const data = {
    code, name,
    trade_type: document.getElementById("p-type").value,
    tax_type: document.getElementById("p-tax").value,
    category: document.getElementById("p-cat").value.trim(),
    spec: document.getElementById("p-spec").value.trim(),
    unit: document.getElementById("p-unit").value.trim(),
    price: Number(document.getElementById("p-price").value) || 0,
    cost_price: Number(document.getElementById("p-cost").value) || null,
    msrp: Number(document.getElementById("p-msrp").value) || null,
    box_qty: Number(document.getElementById("p-box").value) || null,
    memo: document.getElementById("p-memo").value.trim(),
    updated_at: today(),
    updated_by: me.name,
  };
  const res = id
    ? await sb.from("products").update(data).eq("id", id)
    : await sb.from("products").insert(data);
  if (res.error) {
    toast(res.error.code === "23505" ? "이미 사용 중인 제품코드입니다" : "저장에 실패했습니다");
    return;
  }
  toast(id ? "제품이 수정되었습니다" : "제품이 등록되었습니다");
  closeModal();
  const { data: fresh } = await sb.from("products").select("*").order("code");
  prodCache = fresh || [];
  refreshProductTable();
  const cnt = document.getElementById("prod-count");
  if (cnt) cnt.textContent = `제품 마스터 (${prodCache.length}종)`;
}

async function deleteProduct(id) {
  const p = prodCache.find(x => x.id === id);
  if (!p) return;
  // 거래 기록이 있으면 DB가 삭제를 막는다 — 이유를 알려줘야 사용자가 헤매지 않음
  const [s, b] = await Promise.all([
    sb.from("sales").select("id", { count: "exact", head: true }).eq("product_id", id),
    sb.from("purchases").select("id", { count: "exact", head: true }).eq("product_id", id),
  ]);
  const used = (s.count || 0) + (b.count || 0);
  if (used) {
    return alert(
      `'${p.name}'은(는) 삭제할 수 없습니다.\n\n`
      + `매출 ${s.count || 0}건, 매입 ${b.count || 0}건에 이미 사용되고 있습니다.\n`
      + `지우면 과거 매출·매입 기록의 품목명이 사라지기 때문에 시스템이 막고 있습니다.\n\n`
      + `더 이상 취급하지 않는 상품이라면, 제품명 뒤에 '(단종)'을 붙여 두세요.`);
  }
  if (!confirm(`'${p.name}' 제품을 삭제할까요?`)) return;
  const { error } = await sb.from("products").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  prodCache = prodCache.filter(x => x.id !== id);
  refreshProductTable();
  toast("삭제되었습니다");
}

function exportProductsCSV() {
  const head = ["제품코드", "제품명", "구분", "부가세", "분류", "규격", "단위", "원가", "판매가",
    "마진(부가세제외)", "마진율(%)", "MSRP", "박스입수", "메모", "최종수정일", "수정자"];
  const rows = prodCache.map(p => {
    const cost = Number(p.cost_price) || 0, price = Number(p.price) || 0;
    const taxable = isTaxable(p);
    const nPrice = taxable ? netAmt(price, vatCfg.salePriceIncludesVat) : price;
    const nCost = taxable ? netAmt(cost, vatCfg.purchaseCostIncludesVat) : cost;
    const margin = cost && price ? nPrice - nCost : "";
    const rate = margin !== "" && nPrice ? Math.round((margin / nPrice) * 100) : "";
    return [p.code, p.name, p.trade_type || "사입", p.tax_type || "과세", p.category, p.spec, p.unit,
      p.cost_price ?? "", price, margin, rate, p.msrp ?? "", p.box_qty ?? "",
      p.memo, p.updated_at, p.updated_by || ""];
  });
  const csv = "﻿" + [head, ...rows]
    .map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadFile(csv, `리버스_제품마스터_${today()}.csv`, "text/csv");
}

/* ==================== ERP: 매출 / 매입 / 재고 / 리포트 ==================== */
const CHANNELS = ["스마트스토어", "쿠팡", "자사몰", "오픈마켓", "기타"];
let erpChannelList = [];  // sales_channels 테이블
let erpTransfers = [];    // stock_transfers (쿠팡 사외재고 이동)
let erpMonth = today().slice(0, 7);
let erpProducts = [];
let erpStock = {};      // product_id → {stock, lastCost}
let erpRowsCache = [];  // 현재 목록 캐시 (수정 모달용)
let erpCostsCache = []; // 부대비용(택배·운송) 캐시
let erpSuppliers = [];      // 과거 매입에 쓰인 거래처명
let erpSupplierList = [];   // suppliers 테이블 (등록된 거래처)
let erpChannels = [];

const prodName = id => (erpProducts.find(p => p.id === id) || {}).name || "?";

// 등록된 거래처 + 과거 매입에 쓰인 이름을 합쳐 선택지로. 하나도 없으면 등록을 안내
function supplierOptionsHtml(sel) {
  const active = erpSupplierList.filter(s => s.active !== false).map(s => s.name);
  const names = [...new Set([...active, ...erpSuppliers])].filter(Boolean);
  if (!names.length) {
    return `<div style="border:1.5px dashed var(--line);border-radius:9px;padding:10px;font-size:13px;color:var(--text-sub)">
      등록된 거래처가 없습니다 —
      <a onclick="location.hash='#/suppliers'" style="color:var(--brand);cursor:pointer;font-weight:600">거래처를 먼저 등록해 주세요 →</a>
      <input type="hidden" id="b-supplier" value="">
    </div>`;
  }
  return `<select id="b-supplier">
    <option value="">거래처를 선택하세요</option>
    ${names.map(n => `<option value="${esc(n)}" ${n === sel ? "selected" : ""}>${esc(n)}</option>`).join("")}
  </select>`;
}
const monthOf = r => (r.date || "").slice(0, 7);

/* 제품·재고·거래처·채널 공통 로드 */
async function loadErpBase() {
  const [prodRes, buyRes, saleRes, costRes, chRes, trRes, spRes] = await Promise.all([
    sb.from("products").select("*").order("name"),
    sb.from("purchases").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("sales").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("purchase_costs").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("sales_channels").select("*").order("created_at"),
    sb.from("stock_transfers").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("suppliers").select("*").order("name"),
  ]);
  erpSupplierList = spRes.data || [];
  erpProducts = prodRes.data || [];
  const buys = buyRes.data || [];
  const sales = saleRes.data || [];
  const costs = costRes.data || [];
  erpChannelList = chRes.data || [];
  erpTransfers = trRes.data || [];
  erpStock = {};
  // 재고는 '오늘까지 실제로 일어난' 입출고만 반영 (내일 입고 예정을 미리 입력해도 지금 재고는 그대로)
  const td = today();
  const upTo = arr => arr.filter(x => (x.date || "") <= td);
  erpProducts.forEach(p => {
    const myBuys = upTo(buys.filter(b => b.product_id === p.id));
    const bought = myBuys.reduce((s, b) => s + Number(b.qty), 0);
    const mySales = upTo(sales.filter(x => x.product_id === p.id));
    const sold = mySales.reduce((s, x) => s + Number(x.qty), 0);
    // 쿠팡 사외재고: 쿠팡으로 보낸(입고) − 회수 − 쿠팡 채널 판매
    const moved = upTo(erpTransfers.filter(t => t.product_id === p.id))
      .reduce((s, t) => s + (t.kind === "쿠팡입고" ? 1 : -1) * Number(t.qty), 0);
    const coupangSold = mySales.filter(x => (x.channel || "").includes("쿠팡"))
      .reduce((s, x) => s + Number(x.qty), 0);
    // 이동 기록 없이 쿠팡 매출부터 넣으면 atCoupang이 음수가 되고, 그만큼 자사창고가 부풀려짐 → 0에서 끊음
    const atCoupang = Math.max(0, moved - coupangSold);
    const stock = bought - sold;
    erpStock[p.id] = {
      stock, atCoupang, inHouse: stock - atCoupang,
      coupangUntracked: moved - coupangSold < 0 ? coupangSold - moved : 0, // 이동 누락 의심 수량
      // 최근 매입단가 우선, 없으면 제품 마스터의 등록 원가
      lastCost: myBuys.length ? Number(myBuys[0].unit_cost) : (Number(p.cost_price) || 0),
    };
  });
  erpSuppliers = [...new Set([...buys.map(b => b.supplier), ...costs.map(c => c.supplier)].filter(Boolean))];
  // 채널 목록: 등록된 채널 + 과거 매출에 쓰인 채널
  erpChannels = [...new Set([...erpChannelList.map(c => c.name), ...sales.map(s => s.channel).filter(Boolean)])];
  return { buys, sales, costs };
}

const tradeTypeOf = p => (p?.trade_type || "사입");
const tradeTypeOfId = id => tradeTypeOf(erpProducts.find(p => p.id === id));

function productOptions(sel, mode) {
  // 매입은 사입 상품만 대상 (위탁은 우리가 사입하지 않음)
  const list = mode === "buy" ? erpProducts.filter(p => tradeTypeOf(p) === "사입") : erpProducts;
  return `<option value="">품목 선택</option>` + list.map(p => {
    const tag = mode === "buy"
      ? (p.cost_price ? `원가 ₩${fmt(p.cost_price)}` : "원가 미등록")
      : (tradeTypeOf(p) === "위탁" ? "위탁" : `재고 ${fmt(erpStock[p.id]?.stock || 0)}`);
    return `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)} (${tag})</option>`;
  }).join("");
}

function erpSummaryCards(rows, label) {
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">${erpMonth} ${label} 합계</div>
        <div class="stat-value blue">₩${fmt(total)}</div></div>
      <div class="stat"><div class="stat-label">${erpMonth} ${label} 건수</div>
        <div class="stat-value">${rows.length}건</div></div>
    </div>`;
}

function monthPicker() {
  return `<input type="month" value="${erpMonth}" style="border:1.5px solid var(--line);border-radius:9px;padding:8px 12px"
    onchange="if(this.value){erpMonth=this.value;route()}else{this.value=erpMonth}">`;
}

/* ---------- 매출 (전표식 다품목 입력) ---------- */
async function viewSales() {
  const { sales } = await loadErpBase();
  const rows = sales.filter(r => monthOf(r) === erpMonth);
  erpRowsCache = rows;
  const byChannel = {};
  rows.forEach(r => { byChannel[r.channel || "기타"] = (byChannel[r.channel || "기타"] || 0) + Number(r.amount); });

  return `
    <div class="card">
      <div class="card-head"><h2>매출 입력</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm secondary" onclick="downloadXlsTemplate('sales')" title="엑셀 업로드용 표준 양식 내려받기">양식↓</button>
          <button class="btn sm secondary" onclick="openExcelImport('sales')">📎 엑셀 업로드</button>
          <button class="btn sm secondary" onclick="addSaleRow()">＋ 품목 추가</button>
        </div></div>
      <div class="form-grid" style="margin-bottom:10px">
        <div class="field"><label>판매일 *</label><input id="s-date" type="date" value="${today()}"></div>
        <div class="field"><label>판매 채널
          <a onclick="location.hash='#/channels'" style="color:var(--brand);font-size:12px;cursor:pointer;font-weight:400">＋채널 관리</a></label>
          <select id="s-channel">
            <option value="">채널을 선택하세요</option>
            ${erpChannels.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
            <option value="기타">기타</option>
          </select></div>
      </div>
      <div class="table-wrap"><table class="items-table">
        <thead><tr><th style="min-width:190px">품목 (현재 재고)</th><th style="width:85px" class="num">수량</th><th style="width:115px" class="num">단가(원)</th><th style="width:110px" class="num">금액</th><th>적요</th><th style="width:40px"></th></tr></thead>
        <tbody id="sale-rows"></tbody>
      </table></div>
      <div class="total-line">합계 <b id="s-total">₩0</b></div>
      <div class="modal-actions"><button class="btn" id="btn-save-sales" onclick="saveSales()">매출 저장</button></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>매출 내역</h2>
        <div style="display:flex;gap:8px;align-items:center">
          ${monthPicker()}
          <button class="btn sm secondary" onclick="exportErpCSV('sales')">CSV</button>
        </div></div>
      ${erpSummaryCards(rows, "매출")}
      ${Object.keys(byChannel).length ? `<p style="color:var(--text-sub);font-size:13px;margin-bottom:10px">채널별: ${
        Object.entries(byChannel).map(([c, v]) => `${esc(c)} ₩${fmt(v)}`).join(" · ")}</p>` : ""}
      <div class="table-wrap"><table>
        <thead><tr><th>판매일</th><th>품목</th><th>채널</th><th class="num">수량</th><th class="num">단가</th><th class="num">금액</th><th>적요</th><th>입력자</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `
          <tr>
            <td>${esc(r.date)}</td>
            <td><b>${esc(prodName(r.product_id))}</b></td>
            <td>${esc(r.channel)}</td>
            <td class="num">${fmt(r.qty)}</td>
            <td class="num">₩${fmt(r.unit_price)}</td>
            <td class="num"><b>₩${fmt(r.amount)}</b></td>
            <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(r.memo)}</td>
            <td>${esc(r.created_by)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="openErpEditModal('sales','${r.id}')">수정</button>
              <button class="btn sm danger" onclick="deleteErpRow('sales','${r.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="9" class="empty">${erpMonth}월 매출이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function addSaleRow() {
  const tbody = document.getElementById("sale-rows");
  if (!tbody) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><select class="sr-prod" onchange="onSaleRowProduct(this)">${productOptions()}</select></td>
    <td><input class="sr-qty" type="number" min="1" value="1" oninput="calcSalesTotal()"></td>
    <td><input class="sr-price" type="number" min="0" placeholder="0" oninput="calcSalesTotal()"></td>
    <td class="num sr-amt" style="font-weight:700">₩0</td>
    <td><input class="sr-memo" placeholder="주문번호 등" maxlength="100"></td>
    <td><button class="btn-row-del" title="삭제" onclick="this.closest('tr').remove();calcSalesTotal()">✕</button></td>`;
  tbody.appendChild(tr);
}
function onSaleRowProduct(sel) {
  const p = erpProducts.find(x => x.id === sel.value);
  if (p) sel.closest("tr").querySelector(".sr-price").value = p.price || "";
  calcSalesTotal();
}
function calcSalesTotal() {
  let total = 0;
  document.querySelectorAll("#sale-rows tr").forEach(tr => {
    const amt = (Number(tr.querySelector(".sr-qty").value) || 0) * (Number(tr.querySelector(".sr-price").value) || 0);
    tr.querySelector(".sr-amt").textContent = "₩" + fmt(amt);
    total += amt;
  });
  const el = document.getElementById("s-total");
  if (el) el.textContent = "₩" + fmt(total);
}

async function saveSales() {
  const date = document.getElementById("s-date").value;
  const channel = document.getElementById("s-channel").value.trim();
  if (!date) return toast("판매일을 선택해 주세요");
  // 채널이 틀리면 수수료·쿠팡 재고까지 어긋나므로 기본 선택으로 두지 않음
  if (!channel) return toast("판매 채널을 선택해 주세요");
  const recs = [];
  const qtyByPid = {};
  const priceWarns = [];
  for (const tr of document.querySelectorAll("#sale-rows tr")) {
    const pid = tr.querySelector(".sr-prod").value;
    const qty = Number(tr.querySelector(".sr-qty").value) || 0;
    const price = Number(tr.querySelector(".sr-price").value) || 0;
    if (!pid && !price) continue; // 빈 줄은 건너뜀
    if (!pid) return toast("품목을 선택해 주세요");
    if (qty <= 0) return toast("수량은 1 이상이어야 합니다");
    if (!Number.isInteger(qty)) return toast("수량은 정수로 입력해 주세요");
    if (price <= 0) return toast(`'${prodName(pid)}'의 단가를 입력해 주세요`);
    // 등록 판매가와 크게 다르면 0을 더 붙였을 가능성이 큼
    const listed = Number(erpProducts.find(p => p.id === pid)?.price) || 0;
    if (listed && (price >= listed * 5 || price * 5 <= listed)) {
      priceWarns.push(`'${prodName(pid)}' 단가 ₩${fmt(price)} (등록 판매가 ₩${fmt(listed)})`);
    }
    qtyByPid[pid] = (qtyByPid[pid] || 0) + qty;
    recs.push({ date, channel, product_id: pid, qty, unit_price: price, amount: qty * price,
      // 판매 시점 원가를 남겨야 나중에 원가가 바뀌어도 과거 이익이 흔들리지 않음
      unit_cost: Number(erpProducts.find(p => p.id === pid)?.cost_price) || null,
      memo: tr.querySelector(".sr-memo").value.trim(), created_by: me.name });
  }
  if (!recs.length) return toast("품목을 1개 이상 입력해 주세요");
  if (priceWarns.length && !confirm(
    `단가가 평소와 많이 다릅니다. 자릿수를 확인해 주세요.\n\n${priceWarns.join("\n")}\n\n이대로 저장할까요?`)) return;
  // 같은 품목이 여러 줄이면 합산해서 비교해야 함 (줄마다 따로 보면 초과를 놓침)
  const stockWarns = Object.entries(qtyByPid)
    .filter(([pid, q]) => tradeTypeOfId(pid) === "사입" && q > (erpStock[pid]?.stock ?? 0))
    .map(([pid, q]) => `'${prodName(pid)}' 재고 ${fmt(erpStock[pid]?.stock ?? 0)} < 판매 ${fmt(q)}`);
  if (stockWarns.length && !confirm(
    `재고보다 많은 수량입니다.\n\n${stockWarns.join("\n")}\n\n그래도 저장할까요?`)) return;
  const btn = document.getElementById("btn-save-sales");
  btn.disabled = true;
  const { error } = await sb.from("sales").insert(recs);
  if (error) { btn.disabled = false; return toast("저장에 실패했습니다"); }
  toast(`매출 ${recs.length}건 저장되었습니다`);
  erpMonth = date.slice(0, 7);
  route();
}

/* ---------- 매입 (전표식 다품목 입력) ---------- */
async function viewPurchases() {
  const { buys, costs } = await loadErpBase();
  const rows = buys.filter(r => monthOf(r) === erpMonth);
  const costRows = costs.filter(r => monthOf(r) === erpMonth);
  erpRowsCache = rows;
  erpCostsCache = costRows;
  const goodsTotal = rows.reduce((s, r) => s + Number(r.amount), 0);
  const shipTotal = costRows.filter(c => c.kind === "택배비").reduce((s, c) => s + Number(c.amount), 0);
  const freightTotal = costRows.filter(c => c.kind === "운송비").reduce((s, c) => s + Number(c.amount), 0);

  return `
    <div class="card">
      <div class="card-head"><h2>매입 입력 (사입)</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm secondary" onclick="downloadXlsTemplate('purchases')" title="엑셀 업로드용 표준 양식 내려받기">양식↓</button>
          <button class="btn sm secondary" onclick="openExcelImport('purchases')">📎 엑셀 업로드</button>
          <button class="btn sm secondary" onclick="addBuyRow()">＋ 품목 추가</button>
        </div></div>
      <div class="form-grid" style="margin-bottom:10px">
        <div class="field"><label>매입일 *</label><input id="b-date" type="date" value="${today()}"></div>
        <div class="field"><label>거래처 *
          <a onclick="location.hash='#/suppliers'" style="color:var(--brand);font-size:12px;cursor:pointer;font-weight:400">＋거래처 관리</a></label>
          ${supplierOptionsHtml()}</div>
        <div class="field"><label>택배비(원) — 상품값과 별도</label><input id="b-ship" type="number" min="0" placeholder="0"></div>
        <div class="field"><label>운송비(원) — 상품값과 별도</label><input id="b-freight" type="number" min="0" placeholder="0"></div>
      </div>
      <div class="table-wrap"><table class="items-table">
        <thead><tr><th style="min-width:190px">품목 (현재 재고)</th><th style="width:85px" class="num">수량</th><th style="width:115px" class="num">단가(원)</th><th style="width:110px" class="num">금액</th><th>적요</th><th style="width:40px"></th></tr></thead>
        <tbody id="buy-rows"></tbody>
      </table></div>
      <div class="total-line">상품 합계 <b id="b-total">₩0</b></div>
      <div class="modal-actions"><button class="btn" id="btn-save-buys" onclick="savePurchases()">매입 저장</button></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>매입 내역</h2>
        <div style="display:flex;gap:8px;align-items:center">
          ${monthPicker()}
          <button class="btn sm secondary" onclick="exportErpCSV('purchases')">CSV</button>
        </div></div>
      <div class="grid-stats">
        <div class="stat"><div class="stat-label">${erpMonth} 상품 매입</div>
          <div class="stat-value blue">₩${fmt(goodsTotal)}</div></div>
        <div class="stat"><div class="stat-label">택배비</div>
          <div class="stat-value amber">₩${fmt(shipTotal)}</div></div>
        <div class="stat"><div class="stat-label">운송비</div>
          <div class="stat-value amber">₩${fmt(freightTotal)}</div></div>
        <div class="stat"><div class="stat-label">총 매입 (상품+부대비용)</div>
          <div class="stat-value">₩${fmt(goodsTotal + shipTotal + freightTotal)}</div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>매입일</th><th>품목</th><th>거래처</th><th class="num">수량</th><th class="num">단가</th><th class="num">금액</th><th>적요</th><th>입력자</th><th></th></tr></thead>
        <tbody>${rows.length ? rows.map(r => `
          <tr>
            <td>${esc(r.date)}</td>
            <td><b>${esc(prodName(r.product_id))}</b></td>
            <td>${esc(r.supplier)}</td>
            <td class="num">${fmt(r.qty)}</td>
            <td class="num">₩${fmt(r.unit_cost)}</td>
            <td class="num"><b>₩${fmt(r.amount)}</b></td>
            <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(r.memo)}</td>
            <td>${esc(r.created_by)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="openErpEditModal('purchases','${r.id}')">수정</button>
              <button class="btn sm danger" onclick="deleteErpRow('purchases','${r.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="9" class="empty">${erpMonth}월 매입이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>부대비용 내역 (택배비 · 운송비)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>일자</th><th>구분</th><th>거래처</th><th class="num">금액</th><th>입력자</th><th></th></tr></thead>
        <tbody>${costRows.length ? costRows.map(c => `
          <tr>
            <td>${esc(c.date)}</td>
            <td>${c.kind === "택배비" ? '<span class="chip mine">택배비</span>' : '<span class="chip waiting">운송비</span>'}</td>
            <td>${esc(c.supplier)}</td>
            <td class="num"><b>₩${fmt(c.amount)}</b></td>
            <td>${esc(c.created_by)}</td>
            <td><button class="btn sm danger" onclick="deleteErpRow('purchase_costs','${c.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="6" class="empty">${erpMonth}월 부대비용이 없습니다</td></tr>`}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 택배비·운송비는 상품 매입액과 분리 집계되며, 재고 단가에는 포함되지 않습니다.
      </p>
    </div>`;
}

function addBuyRow() {
  const tbody = document.getElementById("buy-rows");
  if (!tbody) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><select class="br-prod" onchange="onBuyRowProduct(this)">${productOptions("", "buy")}</select></td>
    <td><input class="br-qty" type="number" min="1" value="1" oninput="calcBuysTotal()"></td>
    <td><input class="br-cost" type="number" min="0" placeholder="0" oninput="calcBuysTotal()"></td>
    <td class="num br-amt" style="font-weight:700">₩0</td>
    <td><input class="br-memo" placeholder="발주번호 등" maxlength="100"></td>
    <td><button class="btn-row-del" title="삭제" onclick="this.closest('tr').remove();calcBuysTotal()">✕</button></td>`;
  tbody.appendChild(tr);
}
function onBuyRowProduct(sel) {
  // 해당 품목의 최근 매입단가 자동 입력
  const st = erpStock[sel.value];
  if (st?.lastCost) sel.closest("tr").querySelector(".br-cost").value = st.lastCost;
  calcBuysTotal();
}
function calcBuysTotal() {
  let total = 0;
  document.querySelectorAll("#buy-rows tr").forEach(tr => {
    const amt = (Number(tr.querySelector(".br-qty").value) || 0) * (Number(tr.querySelector(".br-cost").value) || 0);
    tr.querySelector(".br-amt").textContent = "₩" + fmt(amt);
    total += amt;
  });
  const el = document.getElementById("b-total");
  if (el) el.textContent = "₩" + fmt(total);
}

async function savePurchases() {
  const date = document.getElementById("b-date").value;
  const supplier = document.getElementById("b-supplier").value.trim();
  if (!date) return toast("매입일을 선택해 주세요");
  if (!supplier) return toast("거래처를 선택해 주세요 (매입 거래처 화면에서 등록할 수 있습니다)");
  const ship = Number(document.getElementById("b-ship").value) || 0;
  const freight = Number(document.getElementById("b-freight").value) || 0;
  const recs = [];
  for (const tr of document.querySelectorAll("#buy-rows tr")) {
    const pid = tr.querySelector(".br-prod").value;
    const qty = Number(tr.querySelector(".br-qty").value) || 0;
    const cost = Number(tr.querySelector(".br-cost").value) || 0;
    if (!pid && !cost) continue;
    if (!pid) return toast("품목을 선택해 주세요");
    if (qty <= 0) return toast("수량은 1 이상이어야 합니다");
    if (!Number.isInteger(qty)) return toast("수량은 정수로 입력해 주세요");
    // 0원 매입이 들어가면 그 상품의 '최근 매입단가'가 0이 되어 재고 평가액과 이익이 전부 망가짐
    if (cost <= 0) return toast(`'${prodName(pid)}'의 매입 단가를 입력해 주세요`);
    recs.push({ date, supplier, product_id: pid, qty, unit_cost: cost, amount: qty * cost,
      memo: tr.querySelector(".br-memo").value.trim(), created_by: me.name });
  }
  if (!recs.length && !ship && !freight) return toast("품목 또는 부대비용을 입력해 주세요");
  const btn = document.getElementById("btn-save-buys");
  btn.disabled = true;
  // 부대비용을 먼저 넣는다 — 상품 매입이 커밋된 뒤 실패하면 재시도 시 매입이 중복되기 때문
  const costRecs = [];
  if (ship > 0) costRecs.push({ date, kind: "택배비", amount: ship, supplier, created_by: me.name });
  if (freight > 0) costRecs.push({ date, kind: "운송비", amount: freight, supplier, created_by: me.name });
  if (costRecs.length) {
    const { error: e2 } = await sb.from("purchase_costs").insert(costRecs);
    if (e2) { btn.disabled = false; return toast("부대비용 저장에 실패했습니다 (매입은 아직 저장되지 않았습니다)"); }
  }
  if (recs.length) {
    const { error } = await sb.from("purchases").insert(recs);
    if (error) {
      btn.disabled = false;
      // 부대비용만 남으면 이중 계상이 되므로 되돌린다
      if (costRecs.length) await sb.from("purchase_costs").delete().eq("date", date).eq("supplier", supplier)
        .in("kind", costRecs.map(c => c.kind));
      return toast("저장에 실패했습니다");
    }
  }
  toast(`저장되었습니다 (상품 ${recs.length}건${costRecs.length ? ", 부대비용 " + costRecs.length + "건" : ""})`);
  erpMonth = date.slice(0, 7);
  route();
}

/* ---------- 엑셀 업로드 → 초안 확인 → 승인 등록 ---------- */
let xlsDraft = null;

// 열 제목 인식 키워드 — code를 product보다 먼저 검사해야 "상품코드"가 상품명으로 오인되지 않음
const XLS_KEYS = [
  ["code", ["상품코드", "품목코드", "제품코드", "코드", "sku", "code"]],
  ["date", ["판매일", "매입일", "거래일", "주문일", "날짜", "일자", "date"]],
  ["product", ["상품명", "제품명", "품목명", "품명", "상품", "제품", "품목", "product"]],
  ["qty", ["수량", "판매수량", "매입수량", "개수", "qty", "ea"]],
  ["price", ["단가", "판매단가", "매입단가", "판매가", "가격", "price"]],
  ["amount", ["금액", "합계", "총액", "공급가액", "판매금액", "매입금액", "amount"]],
  ["channel", ["판매채널", "판매처", "채널", "쇼핑몰", "몰"]],
  ["supplier", ["거래처", "공급처", "매입처", "공급자"]],
  ["memo", ["적요", "메모", "비고", "주문번호", "발주번호", "note"]],
];
const XLS_LABEL = { code: "상품코드", date: "날짜", product: "상품명", qty: "수량",
  price: "단가", amount: "금액", channel: "채널", supplier: "거래처", memo: "적요" };
const xlsNorm = s => String(s ?? "").toLowerCase().replace(/[\s()\[\]·,\-_]/g, "");
const xlsNum = v => Number(String(v ?? "").replace(/[^\d.\-]/g, "")) || 0;

function xlsDateOf(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  if (typeof v === "number" && v > 20000 && v < 60000) {
    // 엑셀 날짜 일련번호 (1900-01-01 기준)
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v ?? "").trim();
  let m = s.match(/(\d{4})[.\-\/년\s]+(\d{1,2})[.\-\/월\s]+(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})[.\-\/월\s]+(\d{1,2})일?$/);
  if (m) {
    // 연도가 없으면 올해로 보되, 그러면 미래가 되는 경우(연초에 작년 12월 파일)엔 작년으로
    const y = Number(today().slice(0, 4));
    const guess = `${y}-${pad2(m[1])}-${pad2(m[2])}`;
    return guess > today() ? `${y - 1}-${pad2(m[1])}-${pad2(m[2])}` : guess;
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);          // 20260823
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

function xlsMatchProduct(nameRaw, codeRaw, isSale) {
  const list = isSale ? erpProducts : erpProducts.filter(p => tradeTypeOf(p) === "사입");
  const code = xlsNorm(codeRaw), name = xlsNorm(nameRaw);
  let p = null;
  if (code) p = list.find(x => xlsNorm(x.code) === code);
  if (!p && name) p = list.find(x => xlsNorm(x.name) === name) || list.find(x => xlsNorm(x.code) === name);
  if (!p && name && name.length >= 3) p = list.find(x => xlsNorm(x.name).includes(name) || name.includes(xlsNorm(x.name)));
  return p || null;
}

function openExcelImport(mode) {
  if (typeof XLSX === "undefined") return toast("엑셀 모듈을 아직 불러오지 못했습니다. 잠시 후 다시 시도해 주세요");
  let inp = document.getElementById("xls-file");
  if (!inp) {
    inp = document.createElement("input");
    inp.type = "file"; inp.id = "xls-file"; inp.accept = ".xlsx,.xls,.csv"; inp.style.display = "none";
    document.body.appendChild(inp);
  }
  inp.value = "";
  inp.onchange = () => { if (inp.files[0]) parseExcelFile(inp.files[0], mode); };
  inp.click();
}

function parseExcelFile(file, mode) {
  const reader = new FileReader();
  reader.onload = e => {
    let wsRows;
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      wsRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    } catch (err) { return toast("파일을 읽지 못했습니다. 엑셀(.xlsx) 파일인지 확인해 주세요"); }
    buildExcelDraft(wsRows, mode);
  };
  reader.readAsArrayBuffer(file);
}

function buildExcelDraft(wsRows, mode) {
  const isSale = mode === "sales";
  // 첫 20줄에서 열 제목 줄을 자동 탐색
  let headIdx = -1, colMap = null, bestScore = 0;
  for (let i = 0; i < Math.min(wsRows.length, 20); i++) {
    const map = {};
    (wsRows[i] || []).forEach((cell, ci) => {
      const t = xlsNorm(cell);
      if (!t || Object.values(map).includes(ci)) return;
      for (const [key, kws] of XLS_KEYS) {
        if (map[key] !== undefined) continue;
        if (kws.some(k => t === xlsNorm(k) || t.includes(xlsNorm(k)))) { map[key] = ci; return; }
      }
    });
    const score = Object.keys(map).length;
    if (score > bestScore) { bestScore = score; headIdx = i; colMap = map; }
  }
  if (bestScore < 2 || (colMap.product === undefined && colMap.code === undefined)) {
    return toast("열 제목(상품명·수량 등)을 찾지 못했습니다. '양식↓' 버튼의 표준 양식을 참고해 주세요");
  }
  const rows = [];
  for (let i = headIdx + 1; i < wsRows.length; i++) {
    const r = wsRows[i] || [];
    const get = k => (colMap[k] !== undefined ? r[colMap[k]] : "");
    const prodText = String(get("product") ?? "").trim() || String(get("code") ?? "").trim();
    const qtyRaw = xlsNum(get("qty"));
    const amount = xlsNum(get("amount"));
    if (!prodText && !qtyRaw && !amount) continue;       // 빈 줄
    if (/합계|총계|소계/.test(prodText)) continue;        // 합계 줄 제외
    const p = xlsMatchProduct(get("product"), get("code"), isSale);
    // 값이 없어서 시스템이 대신 채운 항목은 표시해 줘야 사용자가 검토할 수 있음
    const guessed = [];
    const qty = qtyRaw || (guessed.push("수량"), 1);
    let price = xlsNum(get("price"));
    if (!price && amount) price = Math.round(amount / qty);
    // 단가/금액이 아예 없으면 제품 마스터 기준가로 채움 (매출=판매가, 매입=원가)
    if (!price && p) { price = Number(isSale ? p.price : p.cost_price) || 0; if (price) guessed.push("단가"); }
    const parsedDate = xlsDateOf(get("date"));
    if (!parsedDate) guessed.push("날짜");
    rows.push({
      date: parsedDate || today(),
      pid: p ? p.id : "",
      prodText,
      qty, price,
      // 파일에 적힌 금액이 있으면 그대로 보존 (단가 역산 후 재곱하면 원 단위가 어긋남)
      srcAmount: amount || 0,
      guessed,
      party: String(get(isSale ? "channel" : "supplier") ?? "").trim(),
      memo: String(get("memo") ?? "").trim().slice(0, 100),
    });
  }
  if (!rows.length) return toast("읽을 수 있는 데이터 줄이 없습니다");
  if (rows.length > 300) return toast("한 번에 300줄까지만 올릴 수 있습니다. 파일을 나눠 주세요");
  const colNames = Object.entries(colMap)
    .map(([k, ci]) => `${XLS_LABEL[k] || k} ← "${String(wsRows[headIdx][ci]).trim()}"`);
  xlsDraft = { mode, rows, noDateCol: colMap.date === undefined, colNames,
               dateFailed: rows.filter(r => r.guessed.includes("날짜")).length };
  renderExcelPreview();
}

function xlsRowHtml(r, i, isSale) {
  return `
    <tr data-idx="${i}">
      <td><input type="checkbox" class="xr-chk" checked onchange="updateXlsSummary()"></td>
      <td style="white-space:nowrap"><span class="xr-st"></span>${r.guessed?.length
        ? `<div title="파일에 값이 없어 자동으로 채운 항목" style="font-size:11px;color:#d9480f">자동채움<br>${esc(r.guessed.join("·"))}</div>` : ""}</td>
      <td><input type="date" class="xr-date" value="${esc(r.date)}" style="width:130px" onchange="updateXlsSummary()"></td>
      <td>
        <select class="xr-prod" onchange="updateXlsSummary()">${productOptions(r.pid, isSale ? "" : "buy")}</select>
        <div style="font-size:11px;color:${r.pid ? "var(--text-sub)" : "#d9480f"};margin-top:2px">
          원본: ${esc(r.prodText) || "(품목 없음)"}</div>
      </td>
      <td><input type="number" class="xr-qty" min="1" value="${r.qty}" style="width:70px" oninput="updateXlsSummary()"></td>
      <td><input type="number" class="xr-price" min="0" value="${r.price}" style="width:100px" oninput="updateXlsSummary()"></td>
      <td class="num xr-amt" style="font-weight:700"></td>
      <td><input class="xr-party" value="${esc(r.party)}" placeholder="${isSale ? "채널" : "거래처"}" style="width:90px"
        list="${isSale ? "xls-channel-list" : "xls-supplier-list"}"></td>
      <td><input class="xr-memo" value="${esc(r.memo)}" maxlength="100" style="width:110px"></td>
    </tr>`;
}

function renderExcelPreview() {
  const d = xlsDraft;
  const isSale = d.mode === "sales";
  const unmatched = d.rows.filter(r => !r.pid).length;
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:980px;width:96vw">
        <h3>📎 엑셀 초안 확인 — ${isSale ? "매출" : "매입"} ${d.rows.length}줄</h3>
        <p style="font-size:13px;color:var(--text-sub);margin:4px 0 10px">
          엑셀에서 읽어온 초안입니다. 내용을 확인·수정한 뒤 <b>등록</b>을 누르면 저장됩니다.
          ${unmatched ? `<br>⚠️ 품목을 못 찾은 줄이 <b>${unmatched}건</b> 있습니다 — 직접 선택하거나 체크를 해제해 주세요.` : ""}
          ${d.noDateCol ? `<br>ℹ️ 날짜 열이 없어 전부 오늘 날짜로 넣었습니다. 필요하면 줄마다 고쳐 주세요.` : ""}
          ${d.dateFailed && !d.noDateCol ? `<br>⚠️ 날짜를 읽지 못한 줄이 <b>${d.dateFailed}건</b> 있어 오늘 날짜로 채웠습니다 — 꼭 확인해 주세요.` : ""}</p>
        ${d.colNames?.length ? `<details style="font-size:12px;color:var(--text-sub);margin-bottom:10px">
          <summary style="cursor:pointer">엑셀의 어느 열을 무엇으로 읽었는지 보기 (${d.colNames.length}개)</summary>
          <div style="padding:8px 0 0 6px">${d.colNames.map(esc).join(" · ")}</div>
          <div style="padding-top:4px">※ 잘못 읽었다면 취소하고, [양식↓] 버튼의 표준 양식으로 다시 만들어 주세요.</div>
        </details>` : ""}
        <div class="table-wrap" style="max-height:52vh;overflow:auto"><table>
          <thead><tr><th></th><th>상태</th><th>날짜</th><th style="min-width:200px">품목</th>
            <th class="num">수량</th><th class="num">단가</th><th class="num">금액</th>
            <th>${isSale ? "채널" : "거래처"}</th><th>적요</th></tr></thead>
          <tbody id="xls-rows">${d.rows.map((r, i) => xlsRowHtml(r, i, isSale)).join("")}</tbody>
          <datalist id="xls-channel-list">${erpChannels.map(c => `<option value="${esc(c)}">`).join("")}</datalist>
          <datalist id="xls-supplier-list">${
            [...new Set([...erpSupplierList.filter(s => s.active !== false).map(s => s.name), ...erpSuppliers])]
              .filter(Boolean).map(n => `<option value="${esc(n)}">`).join("")}</datalist>
        </table></div>
        <div class="total-line" id="xls-summary"></div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-xls-go" onclick="confirmExcelImport()">등록</button>
        </div>
      </div>
    </div>`;
  updateXlsSummary();
}

function updateXlsSummary() {
  let valid = 0, warn = 0, total = 0;
  document.querySelectorAll("#xls-rows tr").forEach(tr => {
    const on = tr.querySelector(".xr-chk").checked;
    const pid = tr.querySelector(".xr-prod").value;
    const date = tr.querySelector(".xr-date").value;
    const qty = Number(tr.querySelector(".xr-qty").value) || 0;
    const price = Number(tr.querySelector(".xr-price").value) || 0;
    const amt = qty * price;
    tr.querySelector(".xr-amt").textContent = "₩" + fmt(amt);
    const st = tr.querySelector(".xr-st");
    if (!on) { st.textContent = "제외"; st.style.color = "var(--text-sub)"; tr.style.opacity = ".45"; return; }
    tr.style.opacity = "1";
    // 단가 0원은 매출·원가를 망가뜨리므로 반드시 확인시킴
    if (!pid || !date || qty <= 0 || price <= 0) { st.textContent = "⚠️ 확인"; st.style.color = "#d9480f"; warn++; }
    else { st.textContent = "✅"; st.style.color = ""; valid++; total += amt; }
  });
  const sum = document.getElementById("xls-summary");
  const btn = document.getElementById("btn-xls-go");
  if (!sum || !btn) return;
  sum.innerHTML = warn
    ? `⚠️ 확인 필요 <b style="color:#d9480f">${warn}건</b> — 품목·날짜·수량을 채우거나 체크를 해제해 주세요`
    : `등록 대상 <b>${valid}건</b> · 합계 <b>₩${fmt(total)}</b>`;
  btn.disabled = valid === 0 || warn > 0;
  btn.textContent = valid ? `${valid}건 등록` : "등록";
}

async function confirmExcelImport() {
  const isSale = xlsDraft.mode === "sales";
  const recs = [];
  document.querySelectorAll("#xls-rows tr").forEach(tr => {
    if (!tr.querySelector(".xr-chk").checked) return;
    const idx = Number(tr.dataset.idx);
    const src = xlsDraft.rows[idx];
    const pid = tr.querySelector(".xr-prod").value;
    const qty = Number(tr.querySelector(".xr-qty").value) || 0;
    const price = Number(tr.querySelector(".xr-price").value) || 0;
    const party = tr.querySelector(".xr-party").value.trim();
    // 파일에 적힌 금액을 그대로 쓴다 (단가를 역산해 다시 곱하면 원 단위가 어긋나고 할인가가 사라짐)
    const keepSrc = src && src.srcAmount > 0 && qty === src.qty && price === src.price;
    const base = {
      date: tr.querySelector(".xr-date").value, product_id: pid, qty,
      amount: keepSrc ? src.srcAmount : qty * price,
      memo: tr.querySelector(".xr-memo").value.trim(), created_by: me.name,
    };
    recs.push(isSale
      ? { ...base, unit_price: price, channel: party || "기타",
          unit_cost: Number(erpProducts.find(p => p.id === pid)?.cost_price) || null }
      : { ...base, unit_cost: price, supplier: party });
  });
  if (!recs.length) return;

  // 같은 파일을 두 번 올리는 사고 방지 — 날짜+품목+수량+금액이 같은 기존 데이터와 대조
  const dates = [...new Set(recs.map(r => r.date))];
  const { data: exist } = await sb.from(isSale ? "sales" : "purchases")
    .select("date,product_id,qty,amount").in("date", dates);
  if (exist?.length) {
    const key = r => `${r.date}|${r.product_id}|${r.qty}|${r.amount}`;
    const existKeys = new Set(exist.map(key));
    const dup = recs.filter(r => existKeys.has(key(r)));
    if (dup.length && !confirm(
      `이미 등록된 것과 완전히 같은 내용이 ${dup.length}건 있습니다.\n`
      + `(같은 날짜·품목·수량·금액)\n\n`
      + `예시: ${dup.slice(0, 3).map(r => `${r.date} ${prodName(r.product_id)} ${r.qty}개`).join(", ")}\n\n`
      + `같은 파일을 두 번 올린 것이라면 [취소]를 누르세요.\n`
      + `실제로 같은 주문이 여러 건이면 [확인]을 눌러 계속하세요.`)) return;
  }

  if (isSale) {
    // 사입 상품 재고 초과 경고 (품목별 합산)
    const byPid = {};
    recs.forEach(r => { byPid[r.product_id] = (byPid[r.product_id] || 0) + r.qty; });
    const warns = Object.entries(byPid)
      .filter(([pid, q]) => tradeTypeOfId(pid) === "사입" && q > (erpStock[pid]?.stock ?? 0))
      .map(([pid, q]) => `'${prodName(pid)}' 재고(${fmt(erpStock[pid]?.stock ?? 0)}) < 판매수량(${fmt(q)})`);
    if (warns.length && !confirm(warns.join("\n") + "\n\n재고보다 많이 팔린 것으로 기록됩니다. 그래도 등록할까요?")) return;
  }
  const btn = document.getElementById("btn-xls-go");
  btn.disabled = true;
  const { error } = await sb.from(isSale ? "sales" : "purchases").insert(recs);
  if (error) { btn.disabled = false; return toast("등록에 실패했습니다. 다시 시도해 주세요"); }
  toast(`엑셀 ${recs.length}건이 등록되었습니다`);
  closeModal();
  xlsDraft = null;
  erpMonth = recs[0].date.slice(0, 7);
  route();
}

function downloadXlsTemplate(mode) {
  const isSale = mode === "sales";
  const rows = isSale
    ? [["판매일", "채널", "상품명", "수량", "단가", "적요"],
       [today(), "쿠팡", "(상품명 또는 상품코드)", "3", "15000", "주문번호 등"]]
    : [["매입일", "거래처", "상품명", "수량", "단가", "적요"],
       [today(), "아가드", "(상품명 또는 상품코드)", "10", "8000", "발주번호 등"]];
  const csv = "﻿" + rows.map(r => r.join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = isSale ? "매출_업로드양식.csv" : "매입_업로드양식.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 개선 요청 (불편사항 → 대표에게 알림) ---------- */
function openFeedback() {
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>💬 개선 요청 · 불편사항</h3>
        <p style="font-size:13px;color:var(--text-sub);margin:4px 0 10px">
          시스템을 쓰다가 불편한 점, 있었으면 하는 기능을 편하게 적어 주세요.<br>
          대표님께 바로 알림이 가고, 개발 담당이 반영합니다.</p>
        <textarea id="fb-text" rows="5" maxlength="500" placeholder="예) 매출 입력할 때 어제 날짜가 기본이면 좋겠어요"
          style="width:100%;border:1.5px solid var(--line);border-radius:9px;padding:10px;font:inherit;resize:vertical"></textarea>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-fb-send" onclick="sendFeedback()">보내기</button>
        </div>
      </div>
    </div>`;
  document.getElementById("fb-text").focus();
}

async function sendFeedback() {
  const text = document.getElementById("fb-text").value.trim();
  if (!text) return toast("내용을 입력해 주세요");
  // 최상위 직급(대표)에게 업무 지시 형태로 전달 → 기존 푸시 알림 그대로 활용
  const top = USERS.reduce((a, b) => (b.rank > (a?.rank ?? -1) ? b : a), null) || me;
  const btn = document.getElementById("btn-fb-send");
  btn.disabled = true;
  const { error } = await sb.from("tasks").insert({
    title: "[개선요청] " + text.slice(0, 40) + (text.length > 40 ? "…" : ""),
    detail: text + `\n\n— ${me.name}이(가) 앱 사용 중 보낸 개선 요청입니다.`,
    assignee_id: top.id,
    creator_id: me.id,
    due_date: null,
  });
  if (error) { btn.disabled = false; return toast("전송에 실패했습니다"); }
  toast("개선 요청을 보냈습니다 (알림 발송)");
  closeModal();
}

/* ---------- 내역 수정 / 삭제 / CSV ---------- */
function openErpEditModal(table, id) {
  const r = erpRowsCache.find(x => x.id === id);
  if (!r) return;
  const isSale = table === "sales";
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${isSale ? "매출" : "매입"} 내역 수정</h3>
        <div class="form-grid">
          <div class="field"><label>${isSale ? "판매일" : "매입일"}</label><input id="e-date" type="date" value="${esc(r.date)}"></div>
          <div class="field"><label>${isSale ? "채널" : "거래처"}</label>
            ${isSale
              ? `<select id="e-party">${[...new Set([...erpChannels, r.channel, "기타"])].filter(Boolean).map(c => `<option ${c === r.channel ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>`
              : `<select id="e-party">${
                  [...new Set([...erpSupplierList.filter(s => s.active !== false).map(s => s.name), ...erpSuppliers, r.supplier])]
                    .filter(Boolean)
                    .map(n => `<option ${n === r.supplier ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>`}</div>
          <div class="field full"><label>품목</label><select id="e-prod">${productOptions(r.product_id, isSale ? "" : "buy")}</select></div>
          <div class="field"><label>수량</label><input id="e-qty" type="number" min="1" value="${r.qty}"></div>
          <div class="field"><label>단가(원)</label><input id="e-price" type="number" min="0" value="${isSale ? r.unit_price : r.unit_cost}"></div>
          <div class="field full"><label>적요</label><input id="e-memo" value="${esc(r.memo)}" maxlength="100"></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveErpEdit('${table}','${id}')">저장</button>
        </div>
      </div>
    </div>`;
}

async function saveErpEdit(table, id) {
  const isSale = table === "sales";
  const pid = document.getElementById("e-prod").value;
  const qty = Number(document.getElementById("e-qty").value) || 0;
  const price = Number(document.getElementById("e-price").value) || 0;
  if (!pid) return toast("품목을 선택해 주세요");
  if (qty <= 0) return toast("수량은 1 이상이어야 합니다");
  const eDate = document.getElementById("e-date").value;
  // 날짜가 비면 그 내역이 모든 집계에서 사라지므로 반드시 막아야 함
  if (!eDate) return toast("날짜를 입력해 주세요");
  const patch = {
    date: eDate,
    product_id: pid, qty, amount: qty * price,
    memo: document.getElementById("e-memo").value.trim(),
  };
  const party = document.getElementById("e-party").value.trim();
  if (isSale) {
    patch.unit_price = price;
    patch.channel = party || "기타";
    // 품목을 바꾸면 원가 스냅샷도 새 품목 기준으로 갱신 (안 하면 이익 계산이 틀어짐)
    patch.unit_cost = Number(erpProducts.find(p => p.id === pid)?.cost_price) || null;
  } else { patch.unit_cost = price; patch.supplier = party; }
  const { data, error } = await sb.from(table).update(patch).eq("id", id).select("id");
  if (error) return toast("수정에 실패했습니다");
  if (!data?.length) return toast("수정할 내역을 찾지 못했습니다 (다른 사람이 이미 삭제했을 수 있습니다)");
  toast("수정되었습니다");
  closeModal();
  route();
}

// 삭제 대상 설명 (무엇을 지우는지 보여줘야 오클릭을 막을 수 있음)
function erpRowLabel(table, id) {
  const row = [...erpRowsCache, ...erpCostsCache].find(x => x.id === id);
  if (table === "cash_plans") {
    const p = cashPlans.find(x => x.id === id);
    if (!p) return "";
    return `\n\n${p.date} · ${p.kind} · ${p.title} · ₩${fmt(p.amount)}`
      + (p.repeat === "매월" ? "\n\n⚠️ '매월 반복' 계획입니다 — 이번 달뿐 아니라 반복 전체가 삭제됩니다." : "");
  }
  if (!row) return "";
  const who = row.channel || row.supplier || row.kind || "";
  const amt = row.amount != null ? ` · ₩${fmt(row.amount)}` : "";
  const nm = row.product_id ? ` · ${prodName(row.product_id)}` : "";
  return `\n\n${row.date} · ${who}${nm}${amt}`;
}

async function deleteErpRow(table, id) {
  const effect = table === "sales" ? "\n(매출을 지우면 재고와 공헌이익이 함께 바뀝니다)"
    : table === "purchases" ? "\n(매입을 지우면 재고가 줄어듭니다)" : "";
  if (!confirm(`이 내역을 삭제할까요?${erpRowLabel(table, id)}${effect}`)) return;
  const { data, error } = await sb.from(table).delete().eq("id", id).select("id");
  if (error) return toast("삭제에 실패했습니다");
  if (!data?.length) return toast("삭제할 내역을 찾지 못했습니다 (이미 삭제되었을 수 있습니다)");
  toast("삭제되었습니다");
  route();
}

function exportErpCSV(table) {
  const isSale = table === "sales";
  const head = isSale
    ? ["판매일", "품목", "채널", "수량", "단가", "금액", "적요", "입력자"]
    : ["매입일", "품목", "거래처", "수량", "단가", "금액", "적요", "입력자"];
  const rows = erpRowsCache.map(r => [
    r.date, prodName(r.product_id), isSale ? r.channel : r.supplier,
    r.qty, isSale ? r.unit_price : r.unit_cost, r.amount, r.memo, r.created_by]);
  const csv = "﻿" + [head, ...rows]
    .map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadFile(csv, `리버스_${isSale ? "매출" : "매입"}_${erpMonth}.csv`, "text/csv");
}

/* ---------- 재고 현황 ---------- */
async function viewInventory() {
  const { buys, sales } = await loadErpBase();

  // 재고 관리는 사입 상품만 (위탁은 공급처 재고)
  const stockProducts = erpProducts.filter(p => tradeTypeOf(p) === "사입");
  const consignCount = erpProducts.length - stockProducts.length;
  const inv = stockProducts.map(p => {
    const bought = buys.filter(b => b.product_id === p.id).reduce((s, b) => s + Number(b.qty), 0);
    const sold = sales.filter(x => x.product_id === p.id).reduce((s, x) => s + Number(x.qty), 0);
    const st = erpStock[p.id] || { stock: 0, inHouse: 0, atCoupang: 0, lastCost: 0 };
    return { p, bought, sold, ...st, value: st.stock * st.lastCost };
  });
  const totalValue = inv.reduce((s, r) => s + r.value, 0);
  const totalCoupang = inv.reduce((s, r) => s + r.atCoupang, 0);
  const totalInHouse = inv.reduce((s, r) => s + r.inHouse, 0);
  const recentTransfers = erpTransfers.slice(0, 20);

  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">재고 평가액 (최근 매입가 기준)</div>
        <div class="stat-value blue">₩${fmt(totalValue)}</div></div>
      <div class="stat"><div class="stat-label">자사창고 재고</div>
        <div class="stat-value">${fmt(totalInHouse)}개</div></div>
      <div class="stat"><div class="stat-label">쿠팡 사외재고</div>
        <div class="stat-value amber">${fmt(totalCoupang)}개</div></div>
      <div class="stat" onclick="location.hash='#/products'"><div class="stat-label">위탁 제품 (재고 제외)</div>
        <div class="stat-value">${consignCount}종</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>제품별 재고 (자사창고 / 쿠팡)</h2>
        <div style="display:flex;gap:8px">
          <button class="btn sm" onclick="openTransferModal()">🚚 쿠팡 재고 이동</button>
          <button class="btn sm secondary" onclick="location.hash='#/purchases'">＋ 매입 입력</button>
        </div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>제품</th><th class="num">총 매입</th><th class="num">총 판매</th><th class="num">자사창고</th><th class="num">쿠팡</th><th class="num">총 재고</th><th class="num">최근 매입단가</th><th class="num">재고 금액</th></tr></thead>
        <tbody>${inv.length ? inv.map(r => `
          <tr>
            <td><b>${esc(r.p.name)}</b><br><small style="color:var(--text-sub)">${esc(r.p.code)} · ${esc(r.p.spec)}</small></td>
            <td class="num">${fmt(r.bought)}</td>
            <td class="num">${fmt(r.sold)}</td>
            <td class="num" style="color:${r.inHouse < 0 ? "var(--red)" : "var(--text)"}">${fmt(r.inHouse)}</td>
            <td class="num" style="color:${r.atCoupang < 0 ? "var(--red)" : "var(--amber)"}">${fmt(r.atCoupang)}</td>
            <td class="num" style="font-weight:800;color:${r.stock < 0 ? "var(--red)" : r.stock <= 5 ? "var(--amber)" : "var(--text)"}">${fmt(r.stock)}</td>
            <td class="num">₩${fmt(r.lastCost)}</td>
            <td class="num">₩${fmt(r.value)}</td>
          </tr>`).join("") : `<tr><td colspan="8" class="empty">제품이 없습니다</td></tr>`}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 창고에서 쿠팡 물류센터로 보낸 수량은 <b>🚚 쿠팡 재고 이동</b>으로 기록하세요.<br>
        ※ <b>쿠팡</b> 채널 매출은 쿠팡 재고에서, 그 외 채널 매출은 자사창고에서 차감됩니다.<br>
        ※ 숫자가 음수면 이동/매입 기록이 누락된 것입니다. 위탁 상품은 이 화면에 표시되지 않습니다.
      </p>
    </div>

    <div class="card">
      <h2>쿠팡 재고 이동 내역 (최근 20건)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>일자</th><th>품목</th><th>구분</th><th class="num">수량</th><th>메모</th><th>입력자</th><th></th></tr></thead>
        <tbody>${recentTransfers.length ? recentTransfers.map(t => `
          <tr>
            <td>${esc(t.date)}</td>
            <td><b>${esc(prodName(t.product_id))}</b></td>
            <td>${t.kind === "쿠팡입고" ? '<span class="chip mine">창고→쿠팡</span>' : '<span class="chip waiting">쿠팡→창고</span>'}</td>
            <td class="num">${fmt(t.qty)}</td>
            <td>${esc(t.memo)}</td>
            <td>${esc(t.created_by)}</td>
            <td><button class="btn sm danger" onclick="deleteErpRow('stock_transfers','${t.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="7" class="empty">이동 내역이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function openTransferModal() {
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>🚚 쿠팡 재고 이동</h3>
        <div class="form-grid">
          <div class="field"><label>일자</label><input id="tr-date" type="date" value="${today()}"></div>
          <div class="field"><label>구분</label>
            <select id="tr-kind">
              <option value="쿠팡입고">창고 → 쿠팡 (입고)</option>
              <option value="쿠팡회수">쿠팡 → 창고 (회수)</option>
            </select></div>
          <div class="field full"><label>품목 *</label><select id="tr-prod">${productOptions("", "buy")}</select></div>
          <div class="field"><label>수량 *</label><input id="tr-qty" type="number" min="1" value="1"></div>
          <div class="field"><label>메모</label><input id="tr-memo" placeholder="송장번호 등" maxlength="100"></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveTransfer()">저장</button>
        </div>
      </div>
    </div>`;
}

async function saveTransfer() {
  const pid = document.getElementById("tr-prod").value;
  const qty = Number(document.getElementById("tr-qty").value) || 0;
  const date = document.getElementById("tr-date").value;
  if (!pid) return toast("품목을 선택해 주세요");
  if (qty <= 0) return toast("수량을 입력해 주세요");
  if (!date) return toast("일자를 선택해 주세요");
  const kind = document.getElementById("tr-kind").value;
  if (kind === "쿠팡입고" && qty > (erpStock[pid]?.inHouse ?? 0)) {
    if (!confirm(`자사창고 재고(${fmt(erpStock[pid]?.inHouse ?? 0)})보다 많은 수량입니다.\n그래도 저장할까요?`)) return;
  }
  const { error } = await sb.from("stock_transfers").insert({
    date, product_id: pid, qty, kind,
    memo: document.getElementById("tr-memo").value.trim(),
    created_by: me.name,
  });
  if (error) return toast("저장에 실패했습니다");
  toast("이동이 기록되었습니다");
  closeModal();
  route();
}

/* ---------- 월별 리포트 ---------- */
/* ---------- 공헌이익 (매출 − 변동비) ---------- */
// 변동비 = 상품원가 + 판매수수료 + 출고배송비 + 광고비
// 공헌이익이 고정비를 넘어서는 순간부터 회사가 흑자입니다.

function channelSetting(name) {
  const c = erpChannelList.find(x => x.name === name);
  return { fee: Number(c?.fee_rate) || 0, ship: Number(c?.ship_fee) || 0 };
}

// 매출 1줄의 공헌이익 계산 (광고비 제외 — 광고비는 기간 단위로 배분)
// 배송비는 '주문 1건당 1회'. 같은 날·같은 채널·같은 적요(주문번호)면 한 주문으로 묶는다.
// 적요가 비어 있으면 묶을 근거가 없으므로 그 줄만 1회 부과.
function shipKeyOf(r) {
  const memo = (r.memo || "").trim();
  return memo ? `${r.date}|${r.channel}|${memo}` : `row:${r.id || Math.random()}`;
}
function shipChargedRows(rows) {
  const seen = new Set(), charged = new Set();
  for (const r of rows) {
    const k = shipKeyOf(r);
    if (!seen.has(k)) { seen.add(k); charged.add(r); }
  }
  return charged; // 주문의 첫 줄에만 배송비를 매김
}

function cmOfSale(r, shipCharged) {
  const gross = Number(r.amount) || 0;              // 고객이 낸 돈 (부가세 포함)
  const qty = Number(r.qty) || 0;
  const p = erpProducts.find(x => x.id === r.product_id);
  // 이익은 전부 공급가액(부가세 뺀 금액) 기준 — 부가세는 우리 돈이 아니라 나중에 내야 할 돈
  const revenue = saleNet(gross, p);
  const outVat = saleVat(gross, p);
  // 판매 시점 원가 스냅샷 우선, 없으면 현재 제품 마스터 원가
  const unitCost = Number(r.unit_cost ?? p?.cost_price) || 0;
  const cost = buyNet(unitCost * qty, p);
  const st = channelSetting(r.channel);
  const feeGross = Math.round(gross * st.fee / 100);
  const shipGross = (!shipCharged || shipCharged.has(r)) ? st.ship : 0;
  const fee = expNet(feeGross), ship = expNet(shipGross);
  return {
    // 고객이 실제로 낸 돈 = 공급가액 + 부가세 (판매가를 부가세 별도로 적는 경우도 맞음)
    gross: revenue + outVat, revenue, outVat, qty, cost, fee, ship,
    inVat: buyVat(unitCost * qty, p) + expVat(feeGross) + expVat(shipGross),
    cm: revenue - cost - fee - ship,
    noCost: !unitCost,
    noChannel: !!r.channel && !erpChannelList.some(c => c.name === r.channel),
  };
}

function sumCM(rows) {
  const shipCharged = shipChargedRows(rows);
  return rows.reduce((s, r) => {
    const c = cmOfSale(r, shipCharged);
    s.gross += c.gross; s.revenue += c.revenue; s.outVat += c.outVat; s.inVat += c.inVat;
    s.qty += c.qty; s.cost += c.cost;
    s.fee += c.fee; s.ship += c.ship; s.cm += c.cm;
    if (c.noCost) { s.noCostRows++; s.noCostRevenue += c.revenue; }
    if (c.noChannel) s.unknownChannels.add(r.channel);
    return s;
  }, { gross: 0, revenue: 0, outVat: 0, inVat: 0, qty: 0, cost: 0, fee: 0, ship: 0, cm: 0,
       noCostRows: 0, noCostRevenue: 0, unknownChannels: new Set() });
}

async function viewProfit() {
  const { sales } = await loadErpBase();
  const [adRes, fixRes] = await Promise.all([
    sb.from("ad_costs").select("*").order("date", { ascending: false }),
    sb.from("fixed_costs").select("*").order("created_at"),
  ]);
  const ads = adRes.data || [];
  const fixed = (fixRes.data || []).filter(f => f.active !== false);
  profitAdsCache = ads;
  profitFixedCache = fixed;

  // 아직 오지 않은 날짜는 실적이 아니므로 제외 (미래 매출을 미리 입력해도 이익이 부풀지 않도록)
  const td = today();
  const rows = sales.filter(r => monthOf(r) === erpMonth && (r.date || "") <= td);
  const monthAds = ads.filter(a => String(a.date).slice(0, 7) === erpMonth && String(a.date) <= td);
  const adGross = monthAds.reduce((s, a) => s + Number(a.amount), 0);
  const adTotal = expNet(adGross);                    // 광고비도 공급가액 기준으로
  const adVat = adGross - adTotal;
  const fixTotal = fixed.reduce((s, f) => s + Number(f.amount), 0);

  const t = sumCM(rows);
  const shipCharged = shipChargedRows(rows);
  const cmNet = t.cm - adTotal;                       // 광고비까지 뺀 최종 공헌이익
  const cmRate = t.revenue ? (cmNet / t.revenue) * 100 : 0;
  const op = cmNet - fixTotal;                        // 영업이익 (고정비 차감)
  const bepRate = fixTotal ? Math.max(0, Math.min(100, Math.round((cmNet / fixTotal) * 100))) : null;

  // 일별 누적 (쌓여가는 구조)
  const dayMap = {};
  rows.forEach(r => {
    const d = r.date;
    if (!dayMap[d]) dayMap[d] = { revenue: 0, cm: 0 };
    const c = cmOfSale(r, shipCharged);
    dayMap[d].revenue += c.revenue;
    dayMap[d].cm += c.cm;
  });
  monthAds.forEach(a => {
    const d = String(a.date);
    if (!dayMap[d]) dayMap[d] = { revenue: 0, cm: 0 };
    dayMap[d].cm -= expNet(a.amount);
  });
  const days = Object.keys(dayMap).sort();
  let acc = 0;
  const dayRows = days.map(d => { acc += dayMap[d].cm; return { d, ...dayMap[d], acc }; });
  const maxAcc = Math.max(fixTotal, ...dayRows.map(x => Math.abs(x.acc)), 1);

  // BEP 달성 예상일
  let bepMsg = "";
  if (fixTotal > 0) {
    const hit = dayRows.find(x => x.acc >= fixTotal);
    if (hit) {
      bepMsg = `🎉 <b>${hit.d.slice(5)}에 손익분기 돌파</b> — 이후 공헌이익은 그대로 이익입니다`;
    } else if (acc > 0) {
      // '거래가 있었던 날 수'가 아니라 '실제 경과 일수'로 나눠야 속도가 부풀지 않음
      const isThisMonth = erpMonth === td.slice(0, 7);
      const lastDay = new Date(Number(erpMonth.slice(0, 4)), Number(erpMonth.slice(5, 7)), 0).getDate();
      const elapsed = isThisMonth ? Number(td.slice(8, 10)) : lastDay;
      const remain = isThisMonth ? lastDay - elapsed : 0;
      const perDay = acc / Math.max(1, elapsed);
      const need = Math.ceil((fixTotal - acc) / perDay);
      bepMsg = `현재 속도(하루 평균 ₩${fmt(Math.round(perDay))})면 <b>약 ${need}일 더</b> 필요합니다`
        + (isThisMonth
            ? (need > remain
                ? ` — 이번 달 남은 ${remain}일로는 <b style="color:var(--red)">도달이 어렵습니다</b>`
                : ` (이번 달 ${remain}일 남음)`)
            : "");
    } else {
      bepMsg = `손익분기까지 <b>₩${fmt(fixTotal - cmNet)}</b> 남았습니다`;
    }
  }

  // 채널별
  const byCh = {};
  rows.forEach(r => {
    const k = r.channel || "기타";
    if (!byCh[k]) byCh[k] = { revenue: 0, cost: 0, fee: 0, ship: 0, cm: 0, ad: 0 };
    const c = cmOfSale(r, shipCharged);
    byCh[k].revenue += c.revenue; byCh[k].cost += c.cost;
    byCh[k].fee += c.fee; byCh[k].ship += c.ship; byCh[k].cm += c.cm;
  });
  monthAds.forEach(a => {
    const k = a.channel || "기타";
    if (!byCh[k]) byCh[k] = { revenue: 0, cost: 0, fee: 0, ship: 0, cm: 0, ad: 0 };
    byCh[k].ad += Number(a.amount);
    byCh[k].cm -= Number(a.amount);
  });

  // 품목별
  const byProd = {};
  rows.forEach(r => {
    if (!byProd[r.product_id]) byProd[r.product_id] = { qty: 0, revenue: 0, cm: 0 };
    const c = cmOfSale(r, shipCharged);
    byProd[r.product_id].qty += c.qty;
    byProd[r.product_id].revenue += c.revenue;
    byProd[r.product_id].cm += c.cm;
  });
  const prodList = Object.entries(byProd).sort((a, b) => b[1].cm - a[1].cm);

  const noSetting = erpChannelList.filter(c => !Number(c.fee_rate)).map(c => c.name);

  return `
    <div class="card">
      <div class="card-head">
        <h2>${erpMonth} 공헌이익</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${monthPicker()}
          <button class="btn sm secondary" onclick="openAdModal()">＋ 광고비</button>
          <button class="btn sm secondary" onclick="openFixedModal()">고정비 설정</button>
        </div>
      </div>
      <div class="grid-stats">
        <div class="stat"><div class="stat-label">매출 (부가세 제외)</div>
          <div class="stat-value">₩${fmt(t.revenue)}</div>
          ${vatCfg.enabled && t.outVat ? `<div style="font-size:12px;color:var(--text-sub);margin-top:2px">
            고객이 낸 돈 ₩${fmt(t.gross)} − 부가세 ₩${fmt(t.outVat)}</div>` : ""}</div>
        <div class="stat"><div class="stat-label">변동비 합계</div>
          <div class="stat-value amber">₩${fmt(t.cost + t.fee + t.ship + adTotal)}</div></div>
        <div class="stat"><div class="stat-label">공헌이익</div>
          <div class="stat-value" style="color:${cmNet >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(cmNet)}</div></div>
        <div class="stat"><div class="stat-label">공헌이익률</div>
          <div class="stat-value ${cmRate >= 30 ? "blue" : "amber"}">${cmRate.toFixed(1)}%</div></div>
      </div>
      ${vatCfg.enabled ? `<p style="font-size:12.5px;color:var(--text-sub);margin-top:10px">
        🧾 모든 금액은 <b>부가세를 뺀 공급가액</b> 기준입니다. 고객이 낸 부가세는 우리 이익이 아니라
        <a onclick="location.hash='#/vat'" style="color:var(--brand);cursor:pointer">나중에 내야 할 돈</a>이라 이익에서 제외합니다.
        (${vatCfg.salePriceIncludesVat ? "판매가=부가세 포함" : "판매가=부가세 별도"} ·
         ${vatCfg.purchaseCostIncludesVat ? "매입원가=부가세 포함" : "매입원가=부가세 별도"} —
        <a onclick="location.hash='#/settings'" style="color:var(--brand);cursor:pointer">설정 변경</a>)</p>` : ""}
      ${t.noCostRows ? `<div style="background:#fff4e6;border:1px solid #ffa94d;border-radius:9px;padding:12px;margin-top:12px;font-size:13px">
        <b style="color:#d9480f">⚠️ 위 공헌이익은 실제보다 부풀려져 있습니다</b><br>
        원가가 등록되지 않은 매출이 <b>${t.noCostRows}줄 (₩${fmt(t.noCostRevenue)})</b> 있습니다.
        이 매출은 원가를 0원으로 계산하므로, 실제 이익은 표시된 금액보다 <b>최소 ₩${fmt(Math.round(t.noCostRevenue * 0.5))} 이상 적습니다</b>.<br>
        <a onclick="location.hash='#/products'" style="color:var(--brand);cursor:pointer;font-weight:600">제품 마스터에서 원가 입력하기 →</a>
      </div>` : ""}
      ${t.unknownChannels.size ? `<div style="background:#fff4e6;border:1px solid #ffa94d;border-radius:9px;padding:12px;margin-top:10px;font-size:13px">
        <b style="color:#d9480f">⚠️ 채널 목록에 없는 이름으로 기록된 매출이 있습니다</b>: ${[...t.unknownChannels].map(esc).join(", ")}<br>
        이 매출들은 수수료·배송비가 0원으로 계산됩니다. 판매채널 화면에서 같은 이름으로 등록하거나, 매출의 채널명을 맞춰 주세요.
      </div>` : ""}
      ${noSetting.length ? `<p style="color:var(--text-sub);font-size:13px;margin-top:8px">
        ℹ️ 수수료율 0%인 채널: ${noSetting.map(esc).join(", ")} — 자사몰처럼 수수료가 없으면 정상입니다.
        오픈마켓이라면 판매채널 화면에서 수수료율·배송비를 넣어 주세요.</p>` : ""}
    </div>

    <div class="card">
      <h2>변동비 구성</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>항목</th><th class="num">금액</th><th class="num">매출 대비</th></tr></thead>
        <tbody>
          <tr><td>매출액</td><td class="num"><b>₩${fmt(t.revenue)}</b></td><td class="num">100%</td></tr>
          ${[["상품원가", t.cost], ["판매수수료", t.fee], ["출고배송비", t.ship], ["광고비", adTotal]].map(([label, v]) => `
            <tr><td style="padding-left:18px;color:var(--text-sub)">− ${label}</td>
              <td class="num">₩${fmt(v)}</td>
              <td class="num">${t.revenue ? (v / t.revenue * 100).toFixed(1) : 0}%</td></tr>`).join("")}
          <tr style="border-top:2px solid var(--line)">
            <td><b>= 공헌이익</b></td>
            <td class="num"><b style="color:${cmNet >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(cmNet)}</b></td>
            <td class="num"><b>${cmRate.toFixed(1)}%</b></td></tr>
          <tr><td style="padding-left:18px;color:var(--text-sub)">− 고정비 (월)</td>
            <td class="num">₩${fmt(fixTotal)}</td><td class="num">—</td></tr>
          <tr style="border-top:2px solid var(--line)">
            <td><b>= 영업이익</b></td>
            <td class="num"><b style="color:${op >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(op)}</b></td>
            <td class="num">${t.revenue ? (op / t.revenue * 100).toFixed(1) + "%" : "—"}</td></tr>
        </tbody>
      </table></div>
      ${fixTotal ? `
        <div style="margin-top:16px">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
            <span>손익분기 달성률</span><b>${bepRate}%</b></div>
          <div style="height:14px;background:var(--line);border-radius:7px;overflow:hidden">
            <div style="height:100%;width:${Math.max(0, bepRate)}%;background:${bepRate >= 100 ? "var(--green)" : "var(--brand)"};transition:width .4s"></div>
          </div>
          <p style="font-size:13px;color:var(--text-sub);margin-top:8px">${bepMsg}</p>
        </div>` : `
        <p style="color:var(--text-sub);font-size:13px;margin-top:12px">
          ※ [고정비 설정]에 월 고정비(임대료·급여·통신비 등)를 넣으면 손익분기 도달 여부가 표시됩니다.</p>`}
    </div>

    <div class="card">
      <h2>일별 공헌이익 누적</h2>
      ${dayRows.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>일자</th><th class="num">매출</th><th class="num">공헌이익</th><th class="num">누적</th><th style="min-width:120px">누적 추이</th></tr></thead>
        <tbody>${dayRows.map(x => {
          const w = Math.min(100, Math.round(Math.abs(x.acc) / maxAcc * 100));
          const over = fixTotal && x.acc >= fixTotal;
          return `<tr>
            <td>${esc(x.d.slice(5))}</td>
            <td class="num">₩${fmt(x.revenue)}</td>
            <td class="num" style="color:${x.cm >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(x.cm)}</td>
            <td class="num"><b>₩${fmt(x.acc)}</b></td>
            <td><div style="height:10px;background:var(--line);border-radius:5px;overflow:hidden">
              <div style="height:100%;width:${w}%;background:${x.acc < 0 ? "var(--red)" : over ? "var(--green)" : "var(--brand)"}"></div></div></td>
          </tr>`; }).join("")}
        </tbody>
      </table></div>
      ${fixTotal ? `<p style="font-size:12px;color:var(--text-sub);margin-top:8px">
        막대는 월 고정비 ₩${fmt(fixTotal)} 기준입니다. 초록색이면 그 날짜에 손익분기를 넘긴 상태입니다.</p>` : ""}
      ` : `<div class="table-wrap"><table><tbody><tr><td class="empty">${erpMonth} 매출이 없습니다</td></tr></tbody></table></div>`}
    </div>

    <div class="card">
      <h2>채널별 공헌이익</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>채널</th><th class="num">매출</th><th class="num">원가</th><th class="num">수수료</th><th class="num">배송비</th><th class="num">광고비</th><th class="num">공헌이익</th><th class="num">이익률</th></tr></thead>
        <tbody>${Object.keys(byCh).length ? Object.entries(byCh)
          .sort((a, b) => b[1].cm - a[1].cm).map(([k, v]) => `
          <tr>
            <td><b>${esc(k)}</b></td>
            <td class="num">₩${fmt(v.revenue)}</td>
            <td class="num">₩${fmt(v.cost)}</td>
            <td class="num">₩${fmt(v.fee)}</td>
            <td class="num">₩${fmt(v.ship)}</td>
            <td class="num">₩${fmt(v.ad)}</td>
            <td class="num"><b style="color:${v.cm >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(v.cm)}</b></td>
            <td class="num">${v.revenue ? (v.cm / v.revenue * 100).toFixed(1) + "%" : "—"}</td>
          </tr>`).join("") : `<tr><td colspan="8" class="empty">데이터가 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>품목별 공헌이익</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>품목</th><th class="num">수량</th><th class="num">매출</th><th class="num">공헌이익</th><th class="num">이익률</th><th class="num">개당 이익</th></tr></thead>
        <tbody>${prodList.length ? prodList.map(([pid, v]) => {
          const rate = v.revenue ? (v.cm / v.revenue * 100) : 0;
          return `<tr>
            <td><b>${esc(prodName(pid))}</b></td>
            <td class="num">${fmt(v.qty)}</td>
            <td class="num">₩${fmt(v.revenue)}</td>
            <td class="num"><b style="color:${v.cm >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(v.cm)}</b></td>
            <td class="num" style="color:${rate < 15 ? "#d9480f" : "inherit"}">${rate.toFixed(1)}%</td>
            <td class="num">₩${fmt(v.qty ? Math.round(v.cm / v.qty) : 0)}</td>
          </tr>`; }).join("") : `<tr><td colspan="6" class="empty">데이터가 없습니다</td></tr>`}
        </tbody>
      </table></div>
      <p style="font-size:12px;color:var(--text-sub);margin-top:10px">
        ※ 이익률 15% 미만은 주황색입니다. 많이 팔릴수록 손해인 상품을 여기서 잡아냅니다.</p>
    </div>

    <div class="card">
      <div class="card-head"><h2>${erpMonth} 광고비 내역</h2>
        <button class="btn sm secondary" onclick="openAdModal()">＋ 광고비 입력</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>일자</th><th>채널</th><th class="num">금액</th><th>메모</th><th>입력자</th><th></th></tr></thead>
        <tbody>${monthAds.length ? monthAds.map(a => `
          <tr>
            <td>${esc(String(a.date))}</td>
            <td>${esc(a.channel || "전체")}</td>
            <td class="num"><b>₩${fmt(a.amount)}</b></td>
            <td>${esc(a.memo)}</td>
            <td>${esc(a.created_by)}</td>
            <td><button class="btn sm danger" onclick="deleteErpRow('ad_costs','${a.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="6" class="empty">${erpMonth} 광고비가 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

let profitAdsCache = [], profitFixedCache = [];

/* ---------- 부가세 ---------- */
// 부가세 신고는 분기 단위. 1기 예정(1~3월)·확정(4~6월), 2기 예정(7~9월)·확정(10~12월)
const VAT_PERIODS = [
  { key: "1", label: "1~3월", months: ["01", "02", "03"], due: "4월 25일" },
  { key: "2", label: "4~6월", months: ["04", "05", "06"], due: "7월 25일" },
  { key: "3", label: "7~9월", months: ["07", "08", "09"], due: "10월 25일" },
  { key: "4", label: "10~12월", months: ["10", "11", "12"], due: "1월 25일" },
];
function vatPeriodOf(dateStr) {
  const m = String(dateStr).slice(5, 7);
  return VAT_PERIODS.find(p => p.months.includes(m));
}

async function viewVat() {
  const { sales, buys, costs } = await loadErpBase();
  const [adRes] = await Promise.all([sb.from("ad_costs").select("*")]);
  const ads = adRes.data || [];
  const td = today();
  const year = erpMonth.slice(0, 4);

  const calc = period => {
    const inRange = d => String(d).slice(0, 4) === year && period.months.includes(String(d).slice(5, 7)) && String(d) <= td;
    const s = sales.filter(r => inRange(r.date));
    const b = buys.filter(r => inRange(r.date));
    const c = costs.filter(r => inRange(r.date));
    const a = ads.filter(r => inRange(r.date));
    // 매출세액 = 고객에게 받은 부가세
    const outVat = s.reduce((sum, r) => sum + saleVat(r.amount, erpProducts.find(p => p.id === r.product_id)), 0);
    const saleNetSum = s.reduce((sum, r) => sum + saleNet(r.amount, erpProducts.find(p => p.id === r.product_id)), 0);
    // 매입세액 = 우리가 낸 부가세 (돌려받음)
    const buyVatSum = b.reduce((sum, r) => sum + buyVat(r.amount, erpProducts.find(p => p.id === r.product_id)), 0);
    const buyNetSum = b.reduce((sum, r) => sum + buyNet(r.amount, erpProducts.find(p => p.id === r.product_id)), 0);
    const costVat = c.reduce((sum, r) => sum + expVat(r.amount), 0);
    const adVat = a.reduce((sum, r) => sum + expVat(r.amount), 0);
    const inVat = buyVatSum + costVat + adVat;
    return { period, outVat, inVat, pay: outVat - inVat, saleNetSum, buyNetSum,
             costVat, adVat, buyVatSum, saleCnt: s.length, buyCnt: b.length };
  };
  const periods = VAT_PERIODS.map(calc);
  const nowP = vatPeriodOf(td);
  const cur = periods.find(p => p.period.key === nowP.key);
  const yearPay = periods.reduce((s, p) => s + p.pay, 0);

  return `
    <div class="card">
      <div class="card-head"><h2>${year}년 부가세</h2>${monthPicker()}</div>
      ${!vatCfg.enabled ? `<p style="color:var(--text-sub)">부가세 계산이 꺼져 있습니다. 설정에서 켜 주세요.</p>` : `
      <div class="grid-stats">
        <div class="stat"><div class="stat-label">이번 분기 (${cur.period.label}) 낼 세금</div>
          <div class="stat-value ${cur.pay >= 0 ? "red" : "green"}">₩${fmt(Math.abs(cur.pay))}</div>
          <div style="font-size:12px;color:var(--text-sub);margin-top:2px">
            ${cur.pay >= 0 ? `${cur.period.due}까지 납부` : "환급 예상"}</div></div>
        <div class="stat"><div class="stat-label">받은 부가세 (매출세액)</div>
          <div class="stat-value">₩${fmt(cur.outVat)}</div></div>
        <div class="stat"><div class="stat-label">낸 부가세 (매입세액)</div>
          <div class="stat-value">₩${fmt(cur.inVat)}</div></div>
        <div class="stat"><div class="stat-label">${year}년 전체 예상</div>
          <div class="stat-value">₩${fmt(yearPay)}</div></div>
      </div>
      <div style="background:var(--brand-light);border-radius:9px;padding:14px;margin-top:14px;font-size:13.5px;line-height:1.7">
        <b>부가세는 우리 돈이 아닙니다.</b><br>
        물건을 팔 때 고객에게서 <b>부가세를 대신 받아 두었다가</b>, 분기마다 나라에 냅니다.
        대신 우리가 물건을 사면서 낸 부가세는 빼 줍니다.<br><br>
        <b>낼 세금 = 받은 부가세 − 낸 부가세</b><br>
        이번 분기 = ₩${fmt(cur.outVat)} − ₩${fmt(cur.inVat)} = <b style="color:${cur.pay >= 0 ? "var(--red)" : "var(--green)"}">₩${fmt(cur.pay)}</b>
        ${cur.pay < 0 ? " (마이너스면 돌려받습니다)" : ""}
      </div>`}
    </div>

    <div class="card">
      <h2>분기별 내역</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>분기</th><th class="num">매출 (부가세 제외)</th><th class="num">받은 부가세</th>
          <th class="num">매입 (부가세 제외)</th><th class="num">낸 부가세</th><th class="num">낼 세금</th><th>납부기한</th></tr></thead>
        <tbody>${periods.map(p => `
          <tr ${p.period.key === nowP.key ? 'style="background:var(--brand-light)"' : ""}>
            <td><b>${p.period.label}</b>${p.period.key === nowP.key ? ' <span class="chip mine">진행 중</span>' : ""}</td>
            <td class="num">₩${fmt(p.saleNetSum)}</td>
            <td class="num">₩${fmt(p.outVat)}</td>
            <td class="num">₩${fmt(p.buyNetSum)}</td>
            <td class="num">₩${fmt(p.inVat)}</td>
            <td class="num"><b style="color:${p.pay >= 0 ? "var(--red)" : "var(--green)"}">₩${fmt(p.pay)}</b></td>
            <td>${p.period.due}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
      <p style="font-size:12px;color:var(--text-sub);margin-top:10px">
        ※ 낸 부가세에는 상품 매입뿐 아니라 택배비·운송비·광고비의 부가세도 포함됩니다.<br>
        ※ 실제 신고는 세무대리인을 통해 하시고, 이 화면은 <b>미리 준비하고 자금을 확보하기 위한 참고용</b>입니다.
      </p>
    </div>

    <div class="card">
      <h2>💰 세금 낼 돈 미리 챙겨두기</h2>
      <p style="font-size:13.5px;color:var(--text-sub);margin-bottom:12px">
        부가세는 통장에 있는 돈처럼 보이지만 <b>나중에 나갈 돈</b>입니다.
        미리 '나갈 돈'으로 등록해 두면 자금 예측에 반영되어, 납부일에 당황하지 않습니다.</p>
      ${cur.pay > 0 ? `
        <button class="btn" onclick="registerVatPlan(${cur.pay}, '${cur.period.label}', '${cur.period.due}')">
          ${cur.period.label} 부가세 ₩${fmt(cur.pay)}을(를) 나갈 돈으로 등록</button>
        <p style="font-size:12px;color:var(--text-sub);margin-top:8px">
          ※ 분기가 끝나기 전이라 금액은 계속 늘어납니다. 분기 마감 후 다시 등록하면 정확합니다.</p>
      ` : `<p style="color:var(--text-sub);font-size:13px">이번 분기는 낼 세금이 없습니다 (환급 또는 0원).</p>`}
    </div>`;
}

async function registerVatPlan(amount, label, due) {
  const y = Number(today().slice(0, 4));
  const mm = { "4월 25일": "04", "7월 25일": "07", "10월 25일": "10", "1월 25일": "01" }[due];
  const yy = mm === "01" ? y + 1 : y;
  const date = `${yy}-${mm}-25`;
  if (!confirm(`${label} 부가세 ₩${fmt(amount)}을(를)\n${date} 나갈 돈으로 등록할까요?`)) return;
  const { error } = await sb.from("cash_plans").insert({
    date, kind: "출금", title: `부가세 납부 (${label})`, amount, repeat: "없음", created_by: me.name,
  });
  if (error) return toast("등록에 실패했습니다");
  toast("자금일보의 '나갈 돈'에 등록되었습니다");
  location.hash = "#/cash";
}

function openAdModal() {
  const chOpts = erpChannels.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>광고비 입력</h3>
        <div class="form-grid">
          <div class="field"><label>일자 *</label><input id="ad-date" type="date" value="${today()}"></div>
          <div class="field"><label>채널</label>
            <select id="ad-ch"><option value="">전체 (공통)</option>${chOpts}</select></div>
          <div class="field full"><label>금액(원) *</label><input id="ad-amt" type="number" min="0" placeholder="0"></div>
          <div class="field full"><label>메모</label><input id="ad-memo" maxlength="100" placeholder="예) 쿠팡 광고 8월 1주차"></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-ad-save" onclick="saveAd()">저장</button>
        </div>
      </div>
    </div>`;
}

async function saveAd() {
  const date = document.getElementById("ad-date").value;
  const amount = Number(document.getElementById("ad-amt").value) || 0;
  if (!date) return toast("일자를 선택해 주세요");
  if (amount <= 0) return toast("금액을 입력해 주세요");
  const btn = document.getElementById("btn-ad-save");
  btn.disabled = true;
  const { error } = await sb.from("ad_costs").insert({
    date, amount,
    channel: document.getElementById("ad-ch").value || null,
    memo: document.getElementById("ad-memo").value.trim(),
    created_by: me.name,
  });
  if (error) { btn.disabled = false; return toast("저장에 실패했습니다"); }
  toast("광고비가 저장되었습니다");
  closeModal();
  erpMonth = date.slice(0, 7);
  route();
}

function openFixedModal() {
  const list = profitFixedCache;
  const total = list.reduce((s, f) => s + Number(f.amount), 0);
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:560px">
        <h3>월 고정비 설정</h3>
        <p style="font-size:13px;color:var(--text-sub);margin:4px 0 12px">
          매달 고정으로 나가는 비용입니다 (임대료·급여·통신비·구독료 등).<br>
          공헌이익이 이 금액을 넘으면 그 달은 흑자입니다.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>항목</th><th class="num">월 금액</th><th></th></tr></thead>
          <tbody>${list.length ? list.map(f => `
            <tr><td>${esc(f.title)}</td><td class="num">₩${fmt(f.amount)}</td>
              <td><button class="btn sm danger" onclick="deleteFixed('${f.id}')">삭제</button></td></tr>`).join("")
            : `<tr><td colspan="3" class="empty">등록된 고정비가 없습니다</td></tr>`}
          </tbody>
          ${list.length ? `<tfoot><tr><td><b>합계</b></td><td class="num"><b>₩${fmt(total)}</b></td><td></td></tr></tfoot>` : ""}
        </table></div>
        <div class="form-grid" style="margin-top:14px">
          <div class="field"><label>항목명</label><input id="fx-title" maxlength="40" placeholder="예) 사무실 임대료"></div>
          <div class="field"><label>월 금액(원)</label><input id="fx-amt" type="number" min="0" placeholder="0"></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">닫기</button>
          <button class="btn" id="btn-fx-save" onclick="saveFixed()">추가</button>
        </div>
      </div>
    </div>`;
}

async function saveFixed() {
  const title = document.getElementById("fx-title").value.trim();
  const amount = Number(document.getElementById("fx-amt").value) || 0;
  if (!title) return toast("항목명을 입력해 주세요");
  if (amount <= 0) return toast("금액을 입력해 주세요");
  const btn = document.getElementById("btn-fx-save");
  btn.disabled = true;
  const { error } = await sb.from("fixed_costs").insert({ title, amount });
  if (error) { btn.disabled = false; return toast("저장에 실패했습니다"); }
  toast("고정비가 추가되었습니다");
  closeModal();
  route();
}

async function deleteFixed(id) {
  if (!confirm("이 고정비 항목을 삭제할까요?")) return;
  const { error } = await sb.from("fixed_costs").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  closeModal();
  route();
}

async function viewReport() {
  const { buys, sales, costs } = await loadErpBase();

  // 최근 6개월 매출/매입/차액 (매입 = 상품 + 택배·운송비)
  const months = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  }
  const monthRows = months.map(m => {
    const sale = sales.filter(r => monthOf(r) === m).reduce((s, r) => s + Number(r.amount), 0);
    const goods = buys.filter(r => monthOf(r) === m).reduce((s, r) => s + Number(r.amount), 0);
    const extra = costs.filter(r => monthOf(r) === m).reduce((s, r) => s + Number(r.amount), 0);
    const buy = goods + extra;
    return { m, sale, buy, goods, extra, diff: sale - buy };
  });

  // 이번 달 채널별 / 품목별
  const nowMonth = months[0];
  const monthSales = sales.filter(r => monthOf(r) === nowMonth);
  const byChannel = {};
  monthSales.forEach(r => {
    const c = r.channel || "기타";
    byChannel[c] = (byChannel[c] || 0) + Number(r.amount);
  });
  const byProduct = {};
  monthSales.forEach(r => {
    if (!byProduct[r.product_id]) byProduct[r.product_id] = { qty: 0, amount: 0 };
    byProduct[r.product_id].qty += Number(r.qty);
    byProduct[r.product_id].amount += Number(r.amount);
  });
  const topProducts = Object.entries(byProduct)
    .sort((a, b) => b[1].amount - a[1].amount).slice(0, 5);

  // 이번 달 사입/위탁 매출 분리
  const saipSales = monthSales.filter(r => tradeTypeOfId(r.product_id) === "사입")
    .reduce((s, r) => s + Number(r.amount), 0);
  const witakSales = monthSales.filter(r => tradeTypeOfId(r.product_id) === "위탁")
    .reduce((s, r) => s + Number(r.amount), 0);

  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">${nowMonth} 사입 매출</div>
        <div class="stat-value blue">₩${fmt(saipSales)}</div></div>
      <div class="stat"><div class="stat-label">${nowMonth} 위탁 매출</div>
        <div class="stat-value amber">₩${fmt(witakSales)}</div></div>
    </div>
    <div class="card">
      <h2>최근 6개월 매출 · 매입</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>월</th><th class="num">매출</th><th class="num">매입</th><th class="num">차액 (매출−매입)</th></tr></thead>
        <tbody>${monthRows.map(r => `
          <tr>
            <td><b>${r.m}</b></td>
            <td class="num">₩${fmt(r.sale)}</td>
            <td class="num">₩${fmt(r.buy)}${r.extra ? `<br><small style="color:var(--text-sub)">상품 ₩${fmt(r.goods)} + 택배·운송 ₩${fmt(r.extra)}</small>` : ""}</td>
            <td class="num" style="font-weight:700;color:${r.diff >= 0 ? "var(--green)" : "var(--red)"}">₩${fmt(r.diff)}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 매입 = 상품 매입 + 택배비·운송비. 차액은 단순 매출−매입입니다. (기간 내 재고 변동·경비 미반영)
      </p>
    </div>

    <div class="card">
      <h2>${nowMonth} 채널별 매출</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>채널</th><th class="num">매출액</th><th class="num">비중</th></tr></thead>
        <tbody>${Object.keys(byChannel).length ? Object.entries(byChannel)
          .sort((a, b) => b[1] - a[1]).map(([c, v]) => {
            const total = Object.values(byChannel).reduce((s, x) => s + x, 0);
            return `<tr><td><b>${esc(c)}</b></td><td class="num">₩${fmt(v)}</td>
              <td class="num">${total ? Math.round(v / total * 100) : 0}%</td></tr>`;
          }).join("") : `<tr><td colspan="3" class="empty">이번 달 매출이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>${nowMonth} 품목별 매출 TOP 5</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>품목</th><th class="num">판매 수량</th><th class="num">매출액</th></tr></thead>
        <tbody>${topProducts.length ? topProducts.map(([pid, v]) => `
          <tr><td><b>${esc(prodName(pid))}</b></td>
            <td class="num">${fmt(v.qty)}</td><td class="num">₩${fmt(v.amount)}</td></tr>`).join("")
          : `<tr><td colspan="3" class="empty">이번 달 매출이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

/* ---------- 매입 거래처 ---------- */
let supplierCache = [];

async function viewSuppliers() {
  const { data, error } = await sb.from("suppliers").select("*").order("name");
  supplierCache = error ? [] : (data || []);
  const list = supplierCache;
  return `
    <div class="card">
      <div class="card-head"><h2>매입 거래처 (${list.length}곳)</h2>
        <button class="btn sm" onclick="openSupplierModal()">＋ 거래처 등록</button></div>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        물건을 사오는 곳(제조사·도매처·수입사)을 등록합니다. 여기 등록한 거래처가
        <b>매입 입력 화면의 선택 목록</b>에 나옵니다. 결제조건을 적어두면 자금 계획을 세울 때 도움이 됩니다.</p>
      ${!list.length ? `<div style="background:var(--brand-light);border-radius:9px;padding:14px;font-size:13.5px">
        아직 등록된 거래처가 없습니다. <b>[＋ 거래처 등록]</b>을 눌러 자주 매입하는 곳부터 넣어 보세요.<br>
        상호만 넣어도 되고, 사업자등록번호·결제조건은 나중에 채워도 됩니다.
      </div>` : `
      <div class="table-wrap"><table>
        <thead><tr><th>거래처명</th><th>사업자번호</th><th>대표자</th><th>연락처</th>
          <th>담당자</th><th>결제조건</th><th>메모</th><th></th></tr></thead>
        <tbody>${list.map(s => `
          <tr ${s.active === false ? 'style="opacity:.5"' : ""}>
            <td><b>${esc(s.name)}</b>${s.active === false ? ' <span class="chip waiting">거래중단</span>' : ""}
              ${s.tax_type === "면세" ? ' <span class="chip waiting">면세</span>' : ""}</td>
            <td>${esc(s.biz_no) || "—"}</td>
            <td>${esc(s.ceo) || "—"}</td>
            <td>${s.phone ? `<a href="tel:${esc(s.phone)}" style="color:var(--brand)">${esc(s.phone)}</a>` : "—"}</td>
            <td>${esc(s.manager) || "—"}</td>
            <td>${esc(s.pay_terms) || "—"}</td>
            <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(s.memo)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="openSupplierModal('${s.id}')">수정</button>
              <button class="btn sm danger" onclick="deleteSupplier('${s.id}')">삭제</button></td>
          </tr>`).join("")}
        </tbody>
      </table></div>`}
    </div>`;
}

function openSupplierModal(id) {
  const s = id ? supplierCache.find(x => x.id === id) : null;
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal" style="max-width:620px">
        <h3>${s ? "거래처 수정" : "거래처 등록"}</h3>
        <div class="form-grid">
          <div class="field full"><label>거래처명 *</label>
            <input id="sp-name" value="${esc(s?.name || "")}" placeholder="예) 한빛유통" maxlength="40"></div>
          <div class="field"><label>사업자등록번호</label>
            <input id="sp-biz" value="${esc(s?.biz_no || "")}" placeholder="000-00-00000" maxlength="20"></div>
          <div class="field"><label>대표자</label>
            <input id="sp-ceo" value="${esc(s?.ceo || "")}" maxlength="20"></div>
          <div class="field"><label>연락처</label>
            <input id="sp-phone" value="${esc(s?.phone || "")}" placeholder="02-000-0000" maxlength="20"></div>
          <div class="field"><label>이메일</label>
            <input id="sp-email" value="${esc(s?.email || "")}" maxlength="60"></div>
          <div class="field"><label>담당자</label>
            <input id="sp-manager" value="${esc(s?.manager || "")}" placeholder="예) 김과장" maxlength="20"></div>
          <div class="field"><label>결제조건</label>
            <input id="sp-terms" list="payterms-list" value="${esc(s?.pay_terms || "")}" placeholder="예) 월말 결제" maxlength="30">
            <datalist id="payterms-list">
              <option value="선입금"><option value="월말 결제"><option value="익월 10일 결제">
              <option value="익월 말일 결제"><option value="현금 결제"><option value="30일 후 결제">
            </datalist></div>
          <div class="field"><label>부가세</label>
            <select id="sp-tax">
              <option value="과세" ${(s?.tax_type || "과세") === "과세" ? "selected" : ""}>과세 (세금계산서)</option>
              <option value="면세" ${s?.tax_type === "면세" ? "selected" : ""}>면세 (계산서)</option>
            </select></div>
          <div class="field"><label>거래 상태</label>
            <select id="sp-active">
              <option value="1" ${s?.active !== false ? "selected" : ""}>거래 중</option>
              <option value="0" ${s?.active === false ? "selected" : ""}>거래 중단 (목록에서 숨김)</option>
            </select></div>
          <div class="field full"><label>주소</label>
            <input id="sp-addr" value="${esc(s?.address || "")}" maxlength="100"></div>
          <div class="field full"><label>메모</label>
            <textarea id="sp-memo" maxlength="200" placeholder="예) 최소 주문 50만원, 배송 3일 소요">${esc(s?.memo || "")}</textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-sp-save" onclick="saveSupplier('${id || ""}')">저장</button>
        </div>
      </div>
    </div>`;
  document.getElementById("sp-name").focus();
}

async function saveSupplier(id) {
  const name = document.getElementById("sp-name").value.trim();
  if (!name) return toast("거래처명을 입력해 주세요");
  const btn = document.getElementById("btn-sp-save");
  if (btn) btn.disabled = true;
  const data = {
    name,
    biz_no: document.getElementById("sp-biz").value.trim(),
    ceo: document.getElementById("sp-ceo").value.trim(),
    phone: document.getElementById("sp-phone").value.trim(),
    email: document.getElementById("sp-email").value.trim(),
    manager: document.getElementById("sp-manager").value.trim(),
    pay_terms: document.getElementById("sp-terms").value.trim(),
    tax_type: document.getElementById("sp-tax").value,
    active: document.getElementById("sp-active").value === "1",
    address: document.getElementById("sp-addr").value.trim(),
    memo: document.getElementById("sp-memo").value.trim(),
    updated_by: me.name,
  };
  const res = id
    ? await sb.from("suppliers").update(data).eq("id", id).select("id")
    : await sb.from("suppliers").insert(data).select("id");
  if (res.error) {
    if (btn) btn.disabled = false;
    return toast(res.error.code === "23505" ? "이미 등록된 거래처명입니다" : "저장에 실패했습니다");
  }
  if (!res.data?.length) { if (btn) btn.disabled = false; return toast("처리할 거래처를 찾지 못했습니다"); }
  toast(id ? "수정되었습니다" : "거래처가 등록되었습니다");
  closeModal();
  route();
}

async function deleteSupplier(id) {
  const s = supplierCache.find(x => x.id === id);
  if (!s) return;
  // 거래처명은 매입 기록에 문자열로 남으므로, 기록이 있으면 '거래 중단'을 권함
  const { count } = await sb.from("purchases").select("id", { count: "exact", head: true }).eq("supplier", s.name);
  if (count) {
    return alert(
      `'${s.name}'은(는) 삭제하지 않는 편이 좋습니다.\n\n`
      + `이 거래처로 기록된 매입이 ${count}건 있습니다.\n`
      + `삭제해도 매입 기록은 남지만, 거래처 정보(사업자번호·결제조건)를 잃게 됩니다.\n\n`
      + `더 이상 거래하지 않는다면 [수정] → 거래 상태를 '거래 중단'으로 바꿔 주세요.`);
  }
  if (!confirm(`'${s.name}' 거래처를 삭제할까요?`)) return;
  const { data, error } = await sb.from("suppliers").delete().eq("id", id).select("id");
  if (error || !data?.length) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  route();
}

/* ---------- 판매채널 · SCM 계정 ---------- */
async function viewChannels() {
  const { data } = await sb.from("sales_channels").select("*").order("created_at");
  const list = data || [];
  return `
    <div class="card">
      <div class="card-head"><h2>판매채널 · SCM 계정 (${list.length}개)</h2>
        <button class="btn sm" onclick="openChannelModal()">＋ 채널 추가</button></div>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        판매 채널과 각 채널 관리시스템(SCM)의 접속 정보를 관리합니다. 여기 등록한 채널이 매출 입력 시 선택지로 나옵니다.<br>
        ⚠️ 비밀번호는 로그인한 직원이 볼 수 있으니, 이 앱의 로그인 비밀번호를 잘 관리하세요.
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>채널명</th><th class="num">수수료</th><th class="num">배송비</th><th>사이트</th><th>아이디</th><th>비밀번호</th><th>메모</th><th></th></tr></thead>
        <tbody>${list.length ? list.map(c => `
          <tr>
            <td><b>${esc(c.name)}</b></td>
            <td class="num">${Number(c.fee_rate) ? Number(c.fee_rate).toFixed(1) + "%" : '<span style="color:#d9480f">미설정</span>'}</td>
            <td class="num">${Number(c.ship_fee) ? "₩" + fmt(c.ship_fee) : '<span style="color:var(--text-sub)">—</span>'}</td>
            <td>${c.url ? `<a href="${esc(normUrl(c.url))}" target="_blank" rel="noopener" style="color:var(--brand)">바로가기 ↗</a>` : "—"}</td>
            <td>${c.login_id ? `${esc(c.login_id)} <button class="btn-ghost" style="font-size:12px" title="복사" onclick="copyText('${esc(c.login_id)}')">📋</button>` : "—"}</td>
            <td>${c.login_pw
              ? `<span id="pw-${c.id}" data-pw="${esc(c.login_pw)}">••••••</span>
                 <button class="btn-ghost" style="font-size:12px" title="보기" onclick="togglePw('${c.id}')">👁</button>
                 <button class="btn-ghost" style="font-size:12px" title="복사" onclick="copyText('${esc(c.login_pw)}')">📋</button>`
              : "—"}</td>
            <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis">${esc(c.memo)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm secondary" onclick="openChannelModal('${c.id}')">수정</button>
              <button class="btn sm danger" onclick="deleteChannel('${c.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="8" class="empty">등록된 채널이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

let channelCache = [];
// URL에 http(s):// 가 없으면 붙여줌 (없으면 상대경로로 깨짐)
function normUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : "https://" + u;
}
function togglePw(id) {
  const el = document.getElementById("pw-" + id);
  if (!el) return;
  const shown = el.textContent !== "••••••";
  el.textContent = shown ? "••••••" : el.dataset.pw;
}
function copyText(t) {
  const done = () => toast("복사되었습니다");
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
  } else {
    fallbackCopy(t, done);
  }
}
function fallbackCopy(t, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch (e) {
    toast("복사 실패 — 길게 눌러 복사하세요");
  }
}

async function openChannelModal(id) {
  if (!channelCache.length || id) {
    const { data } = await sb.from("sales_channels").select("*");
    channelCache = data || [];
  }
  const c = id ? channelCache.find(x => x.id === id) : null;
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${c ? "채널 수정" : "채널 추가"}</h3>
        <div class="form-grid">
          <div class="field full"><label>채널명 *</label><input id="ch-name" value="${esc(c?.name || "")}" placeholder="예) 11번가" maxlength="30"></div>
          <div class="field full"><label>관리시스템(SCM) 주소</label><input id="ch-url" value="${esc(c?.url || "")}" placeholder="https://..." maxlength="200"></div>
          <div class="field"><label>아이디</label><input id="ch-id" value="${esc(c?.login_id || "")}" maxlength="60" autocomplete="off"></div>
          <div class="field"><label>비밀번호</label><input id="ch-pw" value="${esc(c?.login_pw || "")}" maxlength="60" autocomplete="off"></div>
          <div class="field"><label>판매수수료 (%)</label>
            <input id="ch-fee" type="number" min="0" max="100" step="0.1" value="${c?.fee_rate ?? ""}" placeholder="예) 10.8"></div>
          <div class="field"><label>출고배송비 (건당, 원)</label>
            <input id="ch-ship" type="number" min="0" value="${c?.ship_fee ?? ""}" placeholder="예) 3000"></div>
          <div class="field full" style="font-size:12px;color:var(--text-sub)">
            ※ 수수료율·배송비를 넣으면 공헌이익 화면에서 채널별 실제 이익이 자동 계산됩니다.</div>
          <div class="field full"><label>메모</label><textarea id="ch-memo" maxlength="200">${esc(c?.memo || "")}</textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveChannel('${id || ""}')">저장</button>
        </div>
      </div>
    </div>`;
}

async function saveChannel(id) {
  const name = document.getElementById("ch-name").value.trim();
  if (!name) return toast("채널명을 입력해 주세요");
  const fee = Number(document.getElementById("ch-fee").value) || 0;
  if (fee < 0 || fee > 100) return toast("수수료율은 0~100 사이로 입력해 주세요");
  // 10.8%를 0.108로 넣는 실수가 잦아 수수료가 100배 작게 계산됨
  if (fee > 0 && fee < 1 && !confirm(
    `수수료율을 ${fee}%로 저장할까요?\n\n`
    + `10.8%처럼 퍼센트 숫자를 그대로 넣어야 합니다 (0.108이 아니라 10.8).\n`
    + `${fee}%가 맞다면 [확인]을 누르세요.`)) return;
  const data = {
    name,
    url: normUrl(document.getElementById("ch-url").value),
    login_id: document.getElementById("ch-id").value.trim(),
    login_pw: document.getElementById("ch-pw").value,
    fee_rate: fee,
    ship_fee: Number(document.getElementById("ch-ship").value) || 0,
    memo: document.getElementById("ch-memo").value.trim(),
  };
  const res = id
    ? await sb.from("sales_channels").update(data).eq("id", id)
    : await sb.from("sales_channels").insert(data);
  if (res.error) return toast(res.error.code === "23505" ? "이미 있는 채널명입니다" : "저장에 실패했습니다");
  toast(id ? "수정되었습니다" : "채널이 추가되었습니다");
  closeModal();
  route();
}

async function deleteChannel(id) {
  const c = channelCache.find(x => x.id === id) || {};
  if (!confirm(
    `'${c.name || "이 채널"}' 채널을 삭제할까요?\n\n`
    + `매출 기록은 남지만, 이 채널의 수수료율·배송비 설정이 사라져\n`
    + `과거 달의 공헌이익이 실제보다 크게 표시됩니다.\n`
    + `채널을 더 안 쓰더라도 설정은 남겨두는 편이 정확합니다.`)) return;
  const { error } = await sb.from("sales_channels").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  route();
}

/* ---------- AI 리포트 ---------- */
async function viewAiReport() {
  const { data } = await sb.from("ai_reports").select("*").order("date", { ascending: false }).limit(14);
  const reports = data || [];
  if (!reports.length) {
    return `<div class="card">
      <h2>🤖 AI 리포트</h2>
      <p style="color:var(--text-sub);font-size:13.5px">
        아직 생성된 리포트가 없습니다. <b>매일 아침 8시</b>에 어제 매출·재고·결재·업무·자금을 자동 분석해서
        이상징후와 함께 리포트를 만들어 알림으로 보내드립니다.
      </p>
    </div>`;
  }
  return reports.map((r, i) => `
    <div class="card" ${i === 0 ? 'style="border:2px solid var(--brand)"' : ""}>
      <div class="card-head">
        <h2>${i === 0 ? "🤖 최신 리포트 · " : ""}${esc(r.date)}</h2>
        ${r.anomalies
          ? `<span class="chip rejected">이상징후 ${r.anomalies}건</span>`
          : '<span class="chip approved">이상 없음</span>'}
      </div>
      <div style="white-space:pre-wrap;font-size:14px;line-height:1.8">${esc(r.content)}</div>
    </div>`).join("") + `
    <p style="color:var(--text-sub);font-size:12px">※ 매일 아침 8시에 자동 생성됩니다. 최근 14일치가 보관됩니다.</p>`;
}

/* ---------- 업무 지시 ---------- */
async function viewTasks() {
  const { data } = await sb.from("tasks").select("*").order("created_at", { ascending: false }).limit(300);
  const list = data || [];
  const myOpen = list.filter(t => t.assignee_id === me.id && t.status === "open");
  const iAssigned = list.filter(t => t.creator_id === me.id);
  const others = USERS.filter(u => u.id !== me.id);

  const dday = d => {
    if (!d) return "";
    const diff = Math.round((new Date(d) - new Date(today())) / 86400000);
    const label = diff === 0 ? "오늘까지" : diff > 0 ? `D-${diff}` : `${-diff}일 지남`;
    const color = diff < 0 ? "var(--red)" : diff <= 1 ? "var(--amber)" : "var(--text-sub)";
    return `<span style="color:${color};font-weight:700">${label}</span> <small style="color:var(--text-sub)">(${esc(d)})</small>`;
  };

  return `
    <div class="card">
      <h2>업무 지시하기</h2>
      <div class="form-grid">
        <div class="field full"><label>지시 내용 *</label>
          <input id="t-title" placeholder="예) 쿠팡 발주서 오늘까지 넣어주세요" maxlength="100"></div>
        <div class="field"><label>담당자 *</label>
          <select id="t-assignee">${others.map(u => `<option value="${u.id}">${esc(u.name)} (${esc(u.role)})</option>`).join("")}</select></div>
        <div class="field"><label>기한 (선택)</label><input id="t-due" type="date"></div>
        <div class="field full"><label>상세 설명 (선택)</label>
          <textarea id="t-detail" placeholder="참고 링크, 세부 내용 등"></textarea></div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="btn-create-task" onclick="createTask()">지시 보내기 (알림 발송)</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>📥 내가 받은 지시 (${myOpen.length}건)</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>내용</th><th>지시자</th><th>기한</th><th>받은 날</th><th></th></tr></thead>
        <tbody>${myOpen.length ? myOpen.map(t => `
          <tr>
            <td><b>${esc(t.title)}</b>${t.detail ? `<br><small style="color:var(--text-sub)">${esc(t.detail)}</small>` : ""}</td>
            <td>${userName(t.creator_id)}</td>
            <td>${t.status === "done" ? "—" : (dday(t.due_date) || "—")}</td>
            <td>${esc(localDT(t.created_at).slice(0, 10))}</td>
            <td><button class="btn sm green" onclick="completeTask('${t.id}')">✔ 완료</button></td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty">받은 지시가 없습니다 👍</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>📤 내가 시킨 일 (${iAssigned.filter(t => t.status === "open").length}건 진행 중)</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>내용</th><th>담당자</th><th>기한</th><th>상태</th><th></th></tr></thead>
        <tbody>${iAssigned.length ? iAssigned.map(t => `
          <tr>
            <td><b>${esc(t.title)}</b>${t.detail ? `<br><small style="color:var(--text-sub)">${esc(t.detail)}</small>` : ""}</td>
            <td>${userName(t.assignee_id)}</td>
            <td>${t.status === "done" ? "—" : (dday(t.due_date) || "—")}</td>
            <td>${t.status === "done"
              ? `<span class="chip approved">완료</span><br><small style="color:var(--text-sub)">${esc(localDT(t.done_at).slice(0, 10))}</small>`
              : '<span class="chip progress">진행 중</span>'}</td>
            <td><button class="btn sm danger" onclick="deleteTask('${t.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty">시킨 일이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

async function createTask() {
  const title = document.getElementById("t-title").value.trim();
  if (!title) return toast("지시 내용을 입력해 주세요");
  const assignee = document.getElementById("t-assignee").value;
  if (!assignee) return toast("담당자를 선택해 주세요");
  const btn = document.getElementById("btn-create-task");
  btn.disabled = true; // 연타로 중복 등록 방지
  const { error } = await sb.from("tasks").insert({
    title,
    detail: document.getElementById("t-detail").value.trim(),
    assignee_id: assignee,
    creator_id: me.id,
    due_date: document.getElementById("t-due").value || null,
  });
  if (error) { btn.disabled = false; return toast("지시 등록에 실패했습니다"); }
  toast("지시를 보냈습니다 (알림 발송)");
  route();
}

async function completeTask(id) {
  const { error } = await sb.from("tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", id);
  if (error) return toast("처리에 실패했습니다");
  toast("완료 처리되었습니다 (지시자에게 알림)");
  route();
}

async function deleteTask(id) {
  if (!confirm("이 지시를 삭제할까요?")) return;
  const { error } = await sb.from("tasks").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  route();
}

/* ---------- 자금일보 ---------- */
const CASH_CATS_IN = ["판매대금", "정산금", "대표 입금", "기타 입금"];
const CASH_CATS_OUT = ["매입대금", "경비", "광고비", "급여", "세금·공과", "기타 출금"];
let cashDate = today();
let cashAccounts = [];
let cashTxns = [];
let cashPlans = [];

function addDaysStr(base, n) {
  const d = new Date(base + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 예정 입출금을 향후 days일 발생분으로 전개 (매월 반복 포함)
function planOccurrences(plans, startStr, days) {
  const endStr = addDaysStr(startStr, days);
  const occ = [];
  for (const p of plans) {
    if (p.repeat === "매월") {
      const dom = Number(p.date.slice(8, 10));
      const base = new Date(startStr + "T00:00:00");
      for (let m = 0; m <= 2; m++) {
        const y = base.getFullYear(), mo = base.getMonth() + m;
        const lastDay = new Date(y, mo + 1, 0).getDate();
        const dd = new Date(y, mo, Math.min(dom, lastDay));
        const ds = `${dd.getFullYear()}-${pad2(dd.getMonth() + 1)}-${pad2(dd.getDate())}`;
        if (ds >= startStr && ds <= endStr && ds >= p.date) occ.push({ ...p, occDate: ds });
      }
    } else if (p.date <= endStr) {
      // 예정일이 지났는데 아직 처리 안 된 건도 포함해야 함 (빠지면 자금이 여유 있어 보임)
      occ.push({ ...p, occDate: p.date, overdue: p.date < startStr });
    }
  }
  return occ.sort((a, b) => a.occDate.localeCompare(b.occDate) || (a.kind === "입금" ? -1 : 1));
}

async function viewCash() {
  const [accRes, txnRes, planRes] = await Promise.all([
    sb.from("cash_accounts").select("*").order("created_at"),
    sb.from("cash_txns").select("*").order("date").order("created_at"),
    sb.from("cash_plans").select("*").order("date"),
  ]);
  cashAccounts = accRes.data || [];
  cashTxns = txnRes.data || [];
  cashPlans = planRes.data || [];

  if (!cashAccounts.length) {
    return `
      <div class="card">
        <h2>자금일보 시작하기</h2>
        <p style="color:var(--text-sub);font-size:13.5px;margin-bottom:14px">
          먼저 관리할 계좌를 등록하세요. <b>기초잔액</b>은 자금일보를 시작하는 시점의 계좌 잔액입니다.<br>
          이후 매일 입금·출금만 입력하면 잔액이 자동 계산됩니다.
        </p>
        <button class="btn" onclick="openCashAccountModal()">＋ 계좌 등록</button>
      </div>`;
  }

  // 계좌별: 전일잔액 = 기초잔액 + (선택일 이전 입금-출금), 당일 입출금, 당일잔액
  const rows = cashAccounts.map(a => {
    const mine = cashTxns.filter(t => t.account_id === a.id);
    const before = mine.filter(t => t.date < cashDate)
      .reduce((s, t) => s + (t.kind === "입금" ? 1 : -1) * Number(t.amount), 0);
    const dayIn = mine.filter(t => t.date === cashDate && t.kind === "입금")
      .reduce((s, t) => s + Number(t.amount), 0);
    const dayOut = mine.filter(t => t.date === cashDate && t.kind === "출금")
      .reduce((s, t) => s + Number(t.amount), 0);
    const prev = Number(a.initial_balance) + before;
    return { a, prev, dayIn, dayOut, bal: prev + dayIn - dayOut };
  });
  const tot = rows.reduce((s, r) => ({ prev: s.prev + r.prev, dayIn: s.dayIn + r.dayIn, dayOut: s.dayOut + r.dayOut, bal: s.bal + r.bal }),
    { prev: 0, dayIn: 0, dayOut: 0, bal: 0 });
  const dayList = cashTxns.filter(t => t.date === cashDate)
    .sort((x, y) => (y.created_at || "").localeCompare(x.created_at || ""));
  const accName = id => { const a = cashAccounts.find(x => x.id === id); return a ? a.name : "?"; };

  // ===== 향후 30일 자금 예측 =====
  // 실제 잔액에는 '오늘까지 실제로 오간 돈'만 포함 (미래 날짜 거래는 아직 통장에 없음)
  const futureTxns = cashTxns.filter(t => t.date > today());
  const curBal = cashAccounts.reduce((s, a) =>
    s + Number(a.initial_balance) + cashTxns.filter(t => t.account_id === a.id && t.date <= today())
      .reduce((ss, t) => ss + (t.kind === "입금" ? 1 : -1) * Number(t.amount), 0), 0);
  const occ = planOccurrences(cashPlans, today(), 30);
  let runBal = curBal;
  const projRows = occ.map(o => {
    runBal += (o.kind === "입금" ? 1 : -1) * Number(o.amount);
    return { ...o, bal: runBal };
  });
  const planIn = occ.filter(o => o.kind === "입금").reduce((s, o) => s + Number(o.amount), 0);
  const planOut = occ.filter(o => o.kind === "출금").reduce((s, o) => s + Number(o.amount), 0);
  const minRow = projRows.reduce((m, r) => (m === null || r.bal < m.bal) ? r : m, null);

  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">${cashDate} 총 잔액 (실제)</div>
        <div class="stat-value blue">₩${fmt(tot.bal)}</div></div>
      <div class="stat"><div class="stat-label">당일 입금</div>
        <div class="stat-value green">₩${fmt(tot.dayIn)}</div></div>
      <div class="stat"><div class="stat-label">당일 출금</div>
        <div class="stat-value red">₩${fmt(tot.dayOut)}</div></div>
      <div class="stat"><div class="stat-label">들어올 돈 (30일)</div>
        <div class="stat-value green">+₩${fmt(planIn)}</div></div>
    </div>

    ${futureTxns.length ? `
    <div class="card" style="border:2px solid #d9480f">
      <h2 style="color:#d9480f">⚠️ 아직 들어오지 않은 돈이 '실제 거래'로 기록돼 있습니다</h2>
      <p style="font-size:13.5px;color:var(--text-sub);margin:6px 0 12px">
        아래 ${futureTxns.length}건은 <b>오늘(${today()}) 이후 날짜</b>인데 실제 입출금 내역에 들어가 있습니다.
        예정된 돈이라면 <b>[예정으로 옮기기]</b>를 눌러 주세요 — 실제 잔액에서 빠지고 '들어올 돈'으로 관리됩니다.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>날짜</th><th>구분</th><th class="num">금액</th><th>적요</th><th></th></tr></thead>
        <tbody>${futureTxns.map(t => `
          <tr>
            <td><b>${esc(t.date)}</b></td>
            <td>${t.kind === "입금" ? '<span class="chip approved">입금</span>' : '<span class="chip rejected">출금</span>'}</td>
            <td class="num"><b>${t.kind === "입금" ? "+" : "−"}₩${fmt(t.amount)}</b></td>
            <td>${esc(t.memo || t.category)}</td>
            <td style="white-space:nowrap">
              <button class="btn sm" onclick="convertTxnToPlan('${t.id}')">예정으로 옮기기</button>
              <button class="btn sm danger" onclick="deleteCashTxn('${t.id}')">삭제</button></td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>` : ""}

    <div class="card">
      <div class="card-head"><h2>계좌별 자금 현황</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="date" value="${cashDate}" style="border:1.5px solid var(--line);border-radius:9px;padding:8px 12px"
            onchange="if(this.value){cashDate=this.value;route()}else{this.value=cashDate}">
          <button class="btn sm secondary" onclick="openCashAccountModal()">＋ 계좌</button>
        </div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>계좌</th><th class="num">전일잔액</th><th class="num">당일입금</th><th class="num">당일출금</th><th class="num">당일잔액</th></tr></thead>
        <tbody>
          ${rows.map(r => `
          <tr>
            <td><b>${esc(r.a.name)}</b>
              <button class="btn-ghost" title="계좌 수정" style="font-size:12px" onclick="openCashAccountModal('${r.a.id}')">✎</button>
              ${r.a.bank ? `<br><small style="color:var(--text-sub)">${esc(r.a.bank)}</small>` : ""}</td>
            <td class="num">₩${fmt(r.prev)}</td>
            <td class="num" style="color:var(--green)">${r.dayIn ? "+₩" + fmt(r.dayIn) : "—"}</td>
            <td class="num" style="color:var(--red)">${r.dayOut ? "−₩" + fmt(r.dayOut) : "—"}</td>
            <td class="num" style="font-weight:800">₩${fmt(r.bal)}</td>
          </tr>`).join("")}
          <tr style="background:var(--brand-light)">
            <td><b>합계</b></td>
            <td class="num"><b>₩${fmt(tot.prev)}</b></td>
            <td class="num" style="color:var(--green)"><b>+₩${fmt(tot.dayIn)}</b></td>
            <td class="num" style="color:var(--red)"><b>−₩${fmt(tot.dayOut)}</b></td>
            <td class="num" style="font-weight:800"><b>₩${fmt(tot.bal)}</b></td>
          </tr>
        </tbody>
      </table></div>
    </div>

    <div class="card" ${minRow && minRow.bal < 0 ? 'style="border:2px solid var(--red)"' : ""}>
      <div class="card-head"><h2>📅 들어올 돈 · 나갈 돈 (향후 30일)</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn sm" onclick="openPlanModal('입금')">＋ 들어올 돈</button>
          <button class="btn sm secondary" onclick="openPlanModal('출금')">＋ 나갈 돈</button>
          ${minRow && minRow.bal < 0
            ? `<span class="chip rejected">⚠️ ${esc(minRow.occDate.slice(5))} 자금 부족 예상</span>`
            : '<span class="chip approved">30일 내 이상 없음</span>'}
        </div></div>
      <p style="font-size:13px;color:var(--text-sub);margin:-4px 0 12px">
        아직 통장에 들어오지 않았지만 <b>들어올 예정인 돈</b>(자본금·정산금 등)과
        <b>나갈 예정인 돈</b>(매입대금·급여 등)을 여기에 등록하세요.
        실제 잔액과 섞이지 않고, 언제 자금이 부족해지는지 미리 알려줍니다.</p>
      <div class="grid-stats">
        <div class="stat"><div class="stat-label">현재 잔액</div>
          <div class="stat-value blue">₩${fmt(curBal)}</div></div>
        <div class="stat"><div class="stat-label">30일 내 예정 입금</div>
          <div class="stat-value green">+₩${fmt(planIn)}</div></div>
        <div class="stat"><div class="stat-label">30일 내 예정 출금</div>
          <div class="stat-value red">−₩${fmt(planOut)}</div></div>
        <div class="stat"><div class="stat-label">30일 후 예상 잔액</div>
          <div class="stat-value ${curBal + planIn - planOut < 0 ? "red" : ""}">₩${fmt(curBal + planIn - planOut)}</div></div>
      </div>

      <h2 style="font-size:14.5px;margin:16px 0 10px">잔액 흐름 (예정 반영)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>예정일</th><th>내용</th><th class="num">금액</th><th class="num">예상 잔액</th><th></th></tr></thead>
        <tbody>${projRows.length ? projRows.map(r => `
          <tr>
            <td>${esc(r.occDate)}</td>
            <td><b>${esc(r.title)}</b>${r.repeat === "매월" ? ' <span class="chip mine">매월</span>' : ""}
              ${r.overdue ? ' <span class="chip rejected">예정일 지남</span>' : ""}</td>
            <td class="num" style="color:${r.kind === "입금" ? "var(--green)" : "var(--red)"}">${r.kind === "입금" ? "+" : "−"}₩${fmt(r.amount)}</td>
            <td class="num" style="font-weight:800;color:${r.bal < 0 ? "var(--red)" : "var(--text)"}">₩${fmt(r.bal)}</td>
            <td><button class="btn sm danger" onclick="deleteErpRow('cash_plans','${r.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="5" class="empty">향후 30일 예정된 입출금이 없습니다 — 결제 예정·정산 예정을 등록해 두세요</td></tr>`}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 예상 잔액 = 현재 잔액 + 예정 입금 − 예정 출금 (날짜순 누적). 실제 입출금이 일어나면 위의 '입출금 입력'에 기록하고, 여기 계획은 삭제하세요.<br>
        ※ '매월 반복' 계획은 삭제하면 반복 전체가 삭제됩니다.
      </p>
    </div>

    <div class="card">
      <h2>입출금 입력</h2>
      <div class="form-grid">
        <div class="field"><label>일자</label><input id="c-date" type="date" value="${cashDate}"></div>
        <div class="field"><label>계좌 *</label>
          <select id="c-account">
            ${cashAccounts.length > 1 ? '<option value="">계좌를 선택하세요</option>' : ""}
            ${cashAccounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></div>
        <div class="field"><label>구분 *</label>
          <select id="c-kind" onchange="refreshCashCats()">
            <option value="입금">입금 (+)</option>
            <option value="출금">출금 (−)</option>
          </select></div>
        <div class="field"><label>분류</label>
          <select id="c-cat">${CASH_CATS_IN.map(c => `<option>${c}</option>`).join("")}</select></div>
        <div class="field"><label>금액(원) *</label><input id="c-amount" type="number" min="1" placeholder="0"></div>
        <div class="field"><label>적요</label><input id="c-memo" placeholder="예) 쿠팡 정산, OO상사 대금" maxlength="100"></div>
      </div>
      <div class="modal-actions"><button class="btn" id="btn-save-txn" onclick="saveCashTxn()">저장</button></div>
    </div>

    <div class="card">
      <h2>${cashDate} 입출금 내역 (${dayList.length}건)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>계좌</th><th>구분</th><th>분류</th><th class="num">금액</th><th>적요</th><th>입력자</th><th></th></tr></thead>
        <tbody>${dayList.length ? dayList.map(t => `
          <tr>
            <td>${esc(accName(t.account_id))}</td>
            <td>${t.kind === "입금" ? '<span class="chip approved">입금</span>' : '<span class="chip rejected">출금</span>'}</td>
            <td>${esc(t.category)}</td>
            <td class="num" style="font-weight:700;color:${t.kind === "입금" ? "var(--green)" : "var(--red)"}">
              ${t.kind === "입금" ? "+" : "−"}₩${fmt(t.amount)}</td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(t.memo)}</td>
            <td>${esc(t.created_by)}</td>
            <td><button class="btn sm danger" onclick="deleteCashTxn('${t.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="7" class="empty">해당 일자 입출금이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function refreshCashCats() {
  const kind = document.getElementById("c-kind").value;
  const cats = kind === "입금" ? CASH_CATS_IN : CASH_CATS_OUT;
  document.getElementById("c-cat").innerHTML = cats.map(c => `<option>${c}</option>`).join("");
}

function openCashAccountModal(id) {
  const a = id ? cashAccounts.find(x => x.id === id) : null;
  const root = document.getElementById("modal-root");
  root.innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${a ? "계좌 수정" : "계좌 등록"}</h3>
        <div class="form-grid">
          <div class="field"><label>계좌명 *</label><input id="a-name" value="${esc(a?.name || "")}" placeholder="예) 기업은행 주거래" maxlength="30"></div>
          <div class="field"><label>은행/비고</label><input id="a-bank" value="${esc(a?.bank || "")}" placeholder="예) 기업은행 123-456" maxlength="40"></div>
          <div class="field full"><label>기초잔액(원) *</label><input id="a-balance" type="number" value="${a ? Number(a.initial_balance) : ""}" placeholder="자금일보 시작 시점의 잔액">
            <p style="color:var(--text-sub);font-size:12px;margin-top:4px">자금일보 시작 시점의 통장 잔액입니다. 수정하면 모든 날짜의 잔액이 다시 계산됩니다.</p></div>
        </div>
        <div class="modal-actions" style="justify-content:space-between">
          <span>${a ? `<button class="btn danger" onclick="deleteCashAccount('${a.id}')">계좌 삭제</button>` : ""}</span>
          <span style="display:flex;gap:10px">
            <button class="btn secondary" onclick="closeModal()">취소</button>
            <button class="btn" id="btn-save-acc" onclick="saveCashAccount('${id || ""}')">${a ? "저장" : "등록"}</button>
          </span>
        </div>
      </div>
    </div>`;
}

async function saveCashAccount(id) {
  const name = document.getElementById("a-name").value.trim();
  if (!name) return toast("계좌명을 입력해 주세요");
  const balRaw = document.getElementById("a-balance").value.trim();
  // 비워두면 0으로 저장되어 이후 모든 잔액이 틀어짐
  if (balRaw === "") return toast("기초잔액을 입력해 주세요 (없으면 0을 입력)");
  const data = {
    name,
    bank: document.getElementById("a-bank").value.trim(),
    initial_balance: Number(balRaw) || 0,
  };
  const btn = document.getElementById("btn-save-acc");
  if (btn) btn.disabled = true; // 계좌가 두 번 등록되면 기초잔액이 이중 계상됨
  const res = id
    ? await sb.from("cash_accounts").update(data).eq("id", id).select("id")
    : await sb.from("cash_accounts").insert(data).select("id");
  if (res.error) { if (btn) btn.disabled = false; return toast("저장에 실패했습니다"); }
  if (!res.data?.length) { if (btn) btn.disabled = false; return toast("처리할 계좌를 찾지 못했습니다"); }
  toast(id ? "계좌가 수정되었습니다" : "계좌가 등록되었습니다");
  closeModal();
  route();
}

async function deleteCashAccount(id) {
  const cnt = cashTxns.filter(t => t.account_id === id).length;
  if (!confirm(`이 계좌를 삭제할까요?${cnt ? `\n입출금 내역 ${cnt}건도 함께 삭제됩니다.` : ""}`)) return;
  const { error } = await sb.from("cash_accounts").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("계좌가 삭제되었습니다");
  closeModal();
  route();
}

async function saveCashTxn() {
  const amount = Number(document.getElementById("c-amount").value) || 0;
  if (amount <= 0) return toast("금액을 입력해 주세요");
  const date = document.getElementById("c-date").value;
  if (!date) return toast("일자를 선택해 주세요");
  const kind = document.getElementById("c-kind").value;
  // 아직 오지 않은 날짜 = 실제 거래가 아니라 '예정' — 잔액에 섞이지 않게 계획으로 유도
  if (date > today()) {
    // '취소'가 저장으로 이어지면 안 됨 — 취소는 항상 아무 일도 일어나지 않아야 함
    alert(
      `${date}는 아직 오지 않은 날짜입니다.\n\n`
      + `실제 입출금은 통장에 돈이 오간 뒤에 기록하는 곳입니다.\n`
      + `아직 ${kind === "입금" ? "들어오지" : "나가지"} 않은 돈은 '들어올 돈·나갈 돈(예정)'으로 등록해 주세요.\n\n`
      + `[확인]을 누르면 예정 등록 창이 열립니다.`);
    openPlanModal(kind, {
      date, amount,
      title: document.getElementById("c-memo").value.trim()
        || document.getElementById("c-cat").value
        || (kind === "입금" ? "입금 예정" : "출금 예정"),
    });
    return;
  }
  const accountId = document.getElementById("c-account").value;
  if (!accountId) return toast("계좌를 선택해 주세요");
  const btn = document.getElementById("btn-save-txn");
  if (btn) btn.disabled = true; // 연타로 같은 입출금이 두 번 기록되는 것 방지
  const { error } = await sb.from("cash_txns").insert({
    date,
    account_id: accountId,
    kind,
    category: document.getElementById("c-cat").value,
    amount,
    memo: document.getElementById("c-memo").value.trim(),
    created_by: me.name,
  });
  if (error) { if (btn) btn.disabled = false; return toast("저장에 실패했습니다"); }
  toast("저장되었습니다");
  cashDate = date;
  route();
}

function openPlanModal(kind, preset) {
  const isIn = kind === "입금";
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" onclick="if(event.target===this)closeModal()">
      <div class="modal">
        <h3>${isIn ? "💵 들어올 돈 등록" : "💸 나갈 돈 등록"}</h3>
        <p style="font-size:13px;color:var(--text-sub);margin:4px 0 12px">
          ${isIn
            ? "아직 통장에 들어오지 않았지만 들어올 예정인 돈입니다. (자본금 입금·정산금 등)"
            : "앞으로 나갈 예정인 돈입니다. (매입대금·급여·세금 등)"}<br>
          실제 잔액에는 더해지지 않고, 예정 잔액 흐름에만 반영됩니다.</p>
        <div class="form-grid">
          <div class="field"><label>${isIn ? "입금" : "출금"} 예정일 *</label>
            <input id="cp-date" type="date" value="${esc(preset?.date || addDaysStr(today(), 7))}"></div>
          <div class="field"><label>금액(원) *</label>
            <input id="cp-amount" type="number" min="1" value="${preset?.amount ?? ""}" placeholder="0"></div>
          <div class="field full"><label>내용 *</label>
            <input id="cp-title" value="${esc(preset?.title || "")}" maxlength="60"
              placeholder="${isIn ? "예) 자본금 추가 입금" : "예) 한빛유통 매입대금"}"></div>
          <div class="field full"><label>반복</label>
            <select id="cp-repeat">
              <option value="없음">한 번만</option>
              <option value="매월">매월 반복 (급여·임대료 등)</option>
            </select></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" id="btn-cp-save" onclick="saveCashPlan('${kind}'${preset?.fromTxnId ? `,'${preset.fromTxnId}'` : ""})">등록</button>
        </div>
      </div>
    </div>`;
  document.getElementById("cp-title").focus();
}

async function saveCashPlan(kind, fromTxnId) {
  const title = document.getElementById("cp-title").value.trim();
  const amount = Number(document.getElementById("cp-amount").value) || 0;
  const date = document.getElementById("cp-date").value;
  if (!title) return toast("내용을 입력해 주세요");
  if (amount <= 0) return toast("금액을 입력해 주세요");
  if (!date) return toast("예정일을 선택해 주세요");
  const btn = document.getElementById("btn-cp-save");
  if (btn) btn.disabled = true;
  const { error } = await sb.from("cash_plans").insert({
    date, title, amount,
    kind: kind || document.getElementById("cp-kind")?.value || "출금",
    repeat: document.getElementById("cp-repeat").value,
    created_by: me.name,
  });
  if (error) { if (btn) btn.disabled = false; return toast("저장에 실패했습니다"); }
  // 실제 거래에서 옮겨온 경우, 원래 거래는 삭제 (잔액 이중 계산 방지)
  if (fromTxnId) {
    const del = await sb.from("cash_txns").delete().eq("id", fromTxnId).select("id");
    if (del.error || !del.data?.length) {
      closeModal(); route();
      return toast("예정은 등록됐지만 원래 거래가 지워지지 않았습니다 — 실제 거래에서 직접 삭제해 주세요");
    }
  }
  toast(fromTxnId ? "예정으로 옮겼습니다" : "등록되었습니다");
  closeModal();
  route();
}

// 미래 날짜로 잘못 기록된 실제 거래 → 예정으로 이동
function convertTxnToPlan(id) {
  const t = cashTxns.find(x => x.id === id);
  if (!t) return;
  openPlanModal(t.kind, {
    date: t.date, amount: Number(t.amount),
    title: t.memo || t.category || (t.kind === "입금" ? "입금 예정" : "출금 예정"),
    fromTxnId: id,
  });
}

async function deleteCashTxn(id) {
  if (!confirm("이 내역을 삭제할까요?")) return;
  const { error } = await sb.from("cash_txns").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  route();
}

/* ---------- 화면: 설정 ---------- */
async function viewSettings() {
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
  const perm = pushSupported ? Notification.permission : "unsupported";
  const pushStatus =
    perm === "granted" ? '<span class="chip approved">켜짐</span>' :
    perm === "denied" ? '<span class="chip rejected">차단됨 (브라우저 설정에서 허용 필요)</span>' :
    perm === "unsupported" ? '<span class="chip waiting">미지원</span>' :
    '<span class="chip waiting">꺼짐</span>';
  return `
    <div class="card">
      <h2>비밀번호 변경</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        <b>${esc(me.name)}</b>님의 로그인 비밀번호를 변경합니다. 변경 후 다음 로그인부터 새 비밀번호를 사용하세요.
      </p>
      <div class="form-grid">
        <div class="field"><label>새 비밀번호 (6자 이상) *</label>
          <input id="pw-new" type="password" autocomplete="new-password" placeholder="새 비밀번호"></div>
        <div class="field"><label>새 비밀번호 확인 *</label>
          <input id="pw-new2" type="password" autocomplete="new-password" placeholder="한 번 더 입력"></div>
      </div>
      <div class="modal-actions"><button class="btn" id="btn-pw" onclick="changePassword()">비밀번호 변경</button></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>결재 알림</h2>${pushStatus}</div>
      <p style="color:var(--text-sub);font-size:13.5px;margin-bottom:12px">
        내 결재 차례가 오거나, 내가 올린 문서가 승인/반려되면 이 기기로 알림이 옵니다.<br>
        기기마다 한 번씩 켜주세요. (아이폰은 Safari에서 <b>홈 화면에 추가</b> 후 앱을 열어 켜야 합니다)
      </p>
      <button class="btn" onclick="ensurePushSubscribed(true).then(()=>route())">🔔 이 기기에서 알림 켜기</button>
    </div>

    <div class="card">
      <h2>🧾 부가세 기준</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        입력하는 금액에 부가세가 <b>들어 있는지</b>를 정해 둡니다. 이 설정에 따라 이익 계산이 달라지므로,
        실제 입력 방식과 맞는지 꼭 확인해 주세요.</p>
      <div class="form-grid">
        <div class="field"><label>부가세 계산</label>
          <select id="vat-enabled">
            <option value="1" ${vatCfg.enabled ? "selected" : ""}>사용 (일반과세자)</option>
            <option value="0" ${!vatCfg.enabled ? "selected" : ""}>사용 안 함 (간이과세자·면세사업자)</option>
          </select></div>
        <div class="field"><label>제품 마스터의 <b>판매가</b></label>
          <select id="vat-sale">
            <option value="1" ${vatCfg.salePriceIncludesVat ? "selected" : ""}>부가세 포함 (쿠팡·스마트스토어 판매가)</option>
            <option value="0" ${!vatCfg.salePriceIncludesVat ? "selected" : ""}>부가세 별도</option>
          </select></div>
        <div class="field"><label>제품 마스터의 <b>원가</b> · 매입 단가</label>
          <select id="vat-buy">
            <option value="0" ${!vatCfg.purchaseCostIncludesVat ? "selected" : ""}>부가세 별도 (세금계산서 공급가액)</option>
            <option value="1" ${vatCfg.purchaseCostIncludesVat ? "selected" : ""}>부가세 포함</option>
          </select></div>
        <div class="field"><label>수수료 · 배송비 · 광고비</label>
          <select id="vat-exp">
            <option value="1" ${vatCfg.expenseIncludesVat ? "selected" : ""}>부가세 포함 (청구된 금액 그대로)</option>
            <option value="0" ${!vatCfg.expenseIncludesVat ? "selected" : ""}>부가세 별도</option>
          </select></div>
      </div>
      <div style="background:var(--brand-light);border-radius:9px;padding:12px;margin-top:12px;font-size:13px;line-height:1.7">
        <b>예시</b> — 판매가 11,900원(부가세 포함), 원가 5,500원(부가세 별도)일 때<br>
        · 실제 매출(공급가액) = 11,900 ÷ 1.1 = <b>10,818원</b> · 부가세 1,082원은 나중에 납부<br>
        · 이익 = 10,818 − 5,500 = <b>5,318원</b> (부가세를 안 빼면 6,400원으로 <b style="color:#d9480f">1,082원 부풀려짐</b>)
      </div>
      <div class="modal-actions"><button class="btn" id="btn-vat-save" onclick="saveVatCfg()">저장</button></div>
    </div>

    <div class="card">
      <h2>데이터 저장 방식</h2>
      <p style="color:var(--text-sub);font-size:13.5px">
        모든 데이터는 <b>Supabase 클라우드 데이터베이스</b>에 저장되며, 전 직원이 같은 데이터를 공유합니다.
        PC·핸드폰 어디서 접속해도 동일합니다.<br>
        ※ 화면은 <b>열거나 새로고침할 때</b> 최신 내용을 불러옵니다. 두 사람이 동시에 작업 중이라면,
        상대가 방금 입력한 내용을 보려면 화면을 다시 열어 주세요.
      </p>
    </div>

    <div class="card">
      <h2>사용자</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>이름</th><th>부서</th><th>직급</th><th>결재 권한</th></tr></thead>
        <tbody>${USERS.map(u => `
          <tr><td><b>${esc(u.name)}</b>${u.id === me.id ? ' <span class="chip mine">나</span>' : ""}</td>
          <td>${esc(u.dept)}</td><td>${esc(u.role)}</td><td>${u.approver ? "✔" : "—"}</td></tr>`).join("")}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 본인 비밀번호는 이 화면 위쪽에서 직접 변경할 수 있습니다. 직원 추가·삭제는 관리자에게 요청하세요.
      </p>
    </div>

    <div class="card">
      <h2>데이터 백업</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">
        결재문서·제품·매출·매입·재고·자금·광고비·업무 등 <b>모든 데이터</b>를 JSON 파일 하나로 내려받습니다.
        가끔 받아서 PC에 보관해 두세요.</p>
      <button class="btn" id="btn-export" onclick="exportJSON()">📤 전체 데이터 내보내기 (JSON)</button>
    </div>`;
}

async function saveVatCfg() {
  const btn = document.getElementById("btn-vat-save");
  if (btn) btn.disabled = true;
  const value = {
    enabled: document.getElementById("vat-enabled").value === "1",
    salePriceIncludesVat: document.getElementById("vat-sale").value === "1",
    purchaseCostIncludesVat: document.getElementById("vat-buy").value === "1",
    expenseIncludesVat: document.getElementById("vat-exp").value === "1",
  };
  const { data, error } = await sb.from("settings")
    .upsert({ key: "vat", value, updated_at: new Date().toISOString(), updated_by: me.name },
            { onConflict: "key" }).select("key");
  if (error || !data?.length) { if (btn) btn.disabled = false; return toast("저장에 실패했습니다"); }
  vatCfg = { ...vatCfg, ...value };
  toast("부가세 기준이 저장되었습니다 — 이익 계산에 바로 반영됩니다");
  route();
}

const BACKUP_TABLES = ["documents", "products", "sales", "purchases", "purchase_costs", "settings",
  "sales_channels", "suppliers", "stock_transfers", "cash_accounts", "cash_txns", "cash_plans",
  "ad_costs", "fixed_costs", "tasks", "ai_reports", "profiles"];

async function exportJSON() {
  const btn = document.getElementById("btn-export");
  if (btn) { btn.disabled = true; btn.textContent = "내보내는 중…"; }
  const results = await Promise.all(BACKUP_TABLES.map(t => sb.from(t).select("*")));
  const failed = [];
  const dump = { exportedAt: nowStr() };
  BACKUP_TABLES.forEach((t, i) => {
    if (results[i].error) failed.push(t);
    dump[t] = results[i].data || [];
  });
  if (btn) { btn.disabled = false; btn.textContent = "📤 전체 데이터 내보내기 (JSON)"; }
  // 일부라도 못 읽었으면 '백업했다'고 안심시키면 안 됨
  if (failed.length) {
    return alert(`백업을 만들지 못했습니다.\n\n다음 항목을 읽지 못했습니다: ${failed.join(", ")}\n`
      + `잠시 후 다시 시도해 주세요.`);
  }
  const counts = BACKUP_TABLES.map(t => `${t} ${dump[t].length}`).join(", ");
  downloadFile(JSON.stringify(dump, null, 2), `리버스_전체백업_${today()}.json`, "application/json");
  toast(`백업 완료 (${BACKUP_TABLES.length}개 항목)`);
  console.log("백업 내용:", counts);
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 모바일 사이드바 ---------- */
function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.querySelector(".sidebar-backdrop")?.remove();
}
document.getElementById("menu-toggle").addEventListener("click", () => {
  const sb2 = document.getElementById("sidebar");
  sb2.classList.add("open");
  const bd = document.createElement("div");
  bd.className = "sidebar-backdrop";
  bd.onclick = closeSidebar;
  document.body.appendChild(bd);
});

/* ---------- 시작 ---------- */
document.getElementById("btn-logout").addEventListener("click", logout);
window.addEventListener("hashchange", route);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* 미지원 환경 무시 */ });
}
boot();
