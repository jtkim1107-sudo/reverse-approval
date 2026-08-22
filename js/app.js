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
const today = () => new Date().toISOString().slice(0, 10);
const nowStr = () => {
  const d = new Date();
  return d.toISOString().slice(0, 10) + " " + d.toTimeString().slice(0, 5);
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
}

/* ---------- 라우터 ---------- */
const routes = {
  dashboard: { title: "대시보드", render: viewDashboard },
  new: { title: "지출결의서 작성", render: viewNewDoc, after: () => addItemRow() },
  inbox: { title: "결재 대기함", render: viewInbox },
  drafts: { title: "내 기안함", render: viewDrafts },
  docs: { title: "전체 문서함", render: viewAllDocs },
  products: { title: "제품 마스터", render: viewProducts },
  sales: { title: "매출 입력·조회", render: viewSales },
  purchases: { title: "매입 입력·조회", render: viewPurchases },
  inventory: { title: "재고 현황", render: viewInventory },
  settings: { title: "설정 · 알림", render: viewSettings },
  doc: { title: "문서 상세", render: viewDocDetail },
};

let routeSeq = 0;
async function route() {
  if (!me) return;
  const seq = ++routeSeq;
  const hash = location.hash.replace(/^#\//, "") || "dashboard";
  const [name, param] = hash.split("/");
  const r = routes[name] || routes.dashboard;
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
  const [docs, prodRes, saleRes, buyRes] = await Promise.all([
    fetchDocs(),
    sb.from("products").select("*").order("updated_at", { ascending: false }).limit(5),
    sb.from("sales").select("amount,date"),
    sb.from("purchases").select("amount,date"),
  ]);
  const products = prodRes.data || [];
  const nowMonth = today().slice(0, 7);
  const monthSales = (saleRes.data || []).filter(r => (r.date || "").startsWith(nowMonth))
    .reduce((s, r) => s + Number(r.amount), 0);
  const monthBuys = (buyRes.data || []).filter(r => (r.date || "").startsWith(nowMonth))
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
        <div class="step-date">${esc((d.created_at || "").slice(0, 16).replace("T", " "))}</div>
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
      </div>
      <div id="product-table">${productTable()}</div>
    </div>`;
}
function productTable() {
  let list = prodCache;
  if (prodFilter) {
    const q = prodFilter.toLowerCase();
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) ||
      (p.category || "").toLowerCase().includes(q));
  }
  if (!list.length) return `<div class="table-wrap"><table><tbody><tr><td class="empty">제품이 없습니다</td></tr></tbody></table></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>제품코드</th><th>제품명</th><th>분류</th><th>규격</th><th>단위</th><th class="num">단가</th><th>메모</th><th>최종수정</th><th></th></tr></thead>
    <tbody>${list.map(p => `
      <tr>
        <td>${esc(p.code)}</td>
        <td><b>${esc(p.name)}</b></td>
        <td>${esc(p.category)}</td>
        <td>${esc(p.spec)}</td>
        <td>${esc(p.unit)}</td>
        <td class="num">₩${fmt(p.price)}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(p.memo)}</td>
        <td>${esc(p.updated_at)}<br><small style="color:var(--text-sub)">${esc(p.updated_by || "")}</small></td>
        <td>
          <button class="btn sm secondary" onclick="openProductModal('${p.id}')">수정</button>
          <button class="btn sm danger" onclick="deleteProduct('${p.id}')">삭제</button>
        </td>
      </tr>`).join("")}
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
          <div class="field"><label>제품명 *</label><input id="p-name" value="${esc(p?.name || "")}" maxlength="60"></div>
          <div class="field"><label>분류</label><input id="p-cat" value="${esc(p?.category || "")}" placeholder="예) 건강식품" maxlength="30"></div>
          <div class="field"><label>규격</label><input id="p-spec" value="${esc(p?.spec || "")}" placeholder="예) 30g x 10입" maxlength="40"></div>
          <div class="field"><label>단위</label><input id="p-unit" value="${esc(p?.unit || "")}" placeholder="BOX / EA / 병" maxlength="10"></div>
          <div class="field"><label>단가(원)</label><input id="p-price" type="number" min="0" value="${p?.price ?? ""}"></div>
          <div class="field full"><label>메모</label><textarea id="p-memo">${esc(p?.memo || "")}</textarea></div>
        </div>
        <div class="modal-actions">
          <button class="btn secondary" onclick="closeModal()">취소</button>
          <button class="btn" onclick="saveProduct('${id || ""}')">저장</button>
        </div>
      </div>
    </div>`;
}
function closeModal() { document.getElementById("modal-root").innerHTML = ""; }

async function saveProduct(id) {
  const code = document.getElementById("p-code").value.trim();
  const name = document.getElementById("p-name").value.trim();
  if (!code || !name) return toast("제품코드와 제품명은 필수입니다");

  const data = {
    code, name,
    category: document.getElementById("p-cat").value.trim(),
    spec: document.getElementById("p-spec").value.trim(),
    unit: document.getElementById("p-unit").value.trim(),
    price: Number(document.getElementById("p-price").value) || 0,
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
  if (!confirm(`'${p.name}' 제품을 삭제할까요?`)) return;
  const { error } = await sb.from("products").delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  prodCache = prodCache.filter(x => x.id !== id);
  refreshProductTable();
  toast("삭제되었습니다");
}

function exportProductsCSV() {
  const head = ["제품코드", "제품명", "분류", "규격", "단위", "단가", "메모", "최종수정일", "수정자"];
  const rows = prodCache.map(p =>
    [p.code, p.name, p.category, p.spec, p.unit, p.price, p.memo, p.updated_at, p.updated_by || ""]);
  const csv = "﻿" + [head, ...rows]
    .map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadFile(csv, `리버스_제품마스터_${today()}.csv`, "text/csv");
}

/* ==================== ERP: 매출 / 매입 / 재고 ==================== */
const CHANNELS = ["스마트스토어", "쿠팡", "자사몰", "오픈마켓", "기타"];
let erpMonth = today().slice(0, 7);
let erpProducts = [];

const prodName = id => (erpProducts.find(p => p.id === id) || {}).name || "?";
const monthOf = r => (r.date || "").slice(0, 7);

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
    onchange="erpMonth=this.value;route()">`;
}

/* ---------- 매출 ---------- */
async function viewSales() {
  const [prodRes, res] = await Promise.all([
    sb.from("products").select("*").order("name"),
    sb.from("sales").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }).limit(500),
  ]);
  erpProducts = prodRes.data || [];
  const rows = (res.data || []).filter(r => monthOf(r) === erpMonth);
  const byChannel = {};
  rows.forEach(r => { byChannel[r.channel || "기타"] = (byChannel[r.channel || "기타"] || 0) + Number(r.amount); });

  return `
    <div class="card">
      <h2>매출 입력</h2>
      <div class="form-grid">
        <div class="field"><label>판매일 *</label><input id="s-date" type="date" value="${today()}"></div>
        <div class="field"><label>판매 채널</label>
          <select id="s-channel">${CHANNELS.map(c => `<option>${c}</option>`).join("")}</select></div>
        <div class="field"><label>제품 *</label>
          <select id="s-product" onchange="onSaleProductChange()">
            <option value="">제품 선택</option>
            ${erpProducts.map(p => `<option value="${p.id}" data-price="${p.price}">${esc(p.name)} (${esc(p.code)})</option>`).join("")}
          </select></div>
        <div class="field"><label>수량 *</label><input id="s-qty" type="number" min="1" value="1" oninput="calcSaleAmount()"></div>
        <div class="field"><label>판매 단가(원) *</label><input id="s-price" type="number" min="0" oninput="calcSaleAmount()"></div>
        <div class="field"><label>합계</label><input id="s-amount" readonly style="background:var(--gray-bg);font-weight:700"></div>
        <div class="field full"><label>메모</label><input id="s-memo" placeholder="주문번호, 특이사항 등" maxlength="100"></div>
      </div>
      <div class="modal-actions"><button class="btn" onclick="saveSale()">매출 저장</button></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>매출 내역</h2>${monthPicker()}</div>
      ${erpSummaryCards(rows, "매출")}
      ${Object.keys(byChannel).length ? `<p style="color:var(--text-sub);font-size:13px;margin-bottom:10px">채널별: ${
        Object.entries(byChannel).map(([c, v]) => `${c} ₩${fmt(v)}`).join(" · ")}</p>` : ""}
      <div class="table-wrap"><table>
        <thead><tr><th>판매일</th><th>제품</th><th>채널</th><th class="num">수량</th><th class="num">단가</th><th class="num">금액</th><th>메모</th><th>입력자</th><th></th></tr></thead>
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
            <td><button class="btn sm danger" onclick="deleteErpRow('sales','${r.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="9" class="empty">${erpMonth}월 매출이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function onSaleProductChange() {
  const sel = document.getElementById("s-product");
  const price = sel.selectedOptions[0]?.dataset.price;
  if (price) document.getElementById("s-price").value = price;
  calcSaleAmount();
}
function calcSaleAmount() {
  const qty = Number(document.getElementById("s-qty").value) || 0;
  const price = Number(document.getElementById("s-price").value) || 0;
  document.getElementById("s-amount").value = "₩" + fmt(qty * price);
}

async function saveSale() {
  const product_id = document.getElementById("s-product").value;
  const date = document.getElementById("s-date").value;
  const qty = Number(document.getElementById("s-qty").value) || 0;
  const unit_price = Number(document.getElementById("s-price").value) || 0;
  if (!product_id) return toast("제품을 선택해 주세요");
  if (!date) return toast("판매일을 선택해 주세요");
  if (qty <= 0) return toast("수량을 입력해 주세요");
  const { error } = await sb.from("sales").insert({
    date, product_id, qty, unit_price, amount: qty * unit_price,
    channel: document.getElementById("s-channel").value,
    memo: document.getElementById("s-memo").value.trim(),
    created_by: me.name,
  });
  if (error) return toast("저장에 실패했습니다");
  toast("매출이 저장되었습니다");
  erpMonth = date.slice(0, 7);
  route();
}

/* ---------- 매입 ---------- */
async function viewPurchases() {
  const [prodRes, res] = await Promise.all([
    sb.from("products").select("*").order("name"),
    sb.from("purchases").select("*").order("date", { ascending: false }).order("created_at", { ascending: false }).limit(500),
  ]);
  erpProducts = prodRes.data || [];
  const rows = (res.data || []).filter(r => monthOf(r) === erpMonth);

  return `
    <div class="card">
      <h2>매입 입력 (사입)</h2>
      <div class="form-grid">
        <div class="field"><label>매입일 *</label><input id="b-date" type="date" value="${today()}"></div>
        <div class="field"><label>거래처</label><input id="b-supplier" placeholder="예) OO상사" maxlength="40"></div>
        <div class="field"><label>제품 *</label>
          <select id="b-product">
            <option value="">제품 선택</option>
            ${erpProducts.map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.code)})</option>`).join("")}
          </select></div>
        <div class="field"><label>수량 *</label><input id="b-qty" type="number" min="1" value="1" oninput="calcBuyAmount()"></div>
        <div class="field"><label>매입 단가(원) *</label><input id="b-cost" type="number" min="0" oninput="calcBuyAmount()"></div>
        <div class="field"><label>합계</label><input id="b-amount" readonly style="background:var(--gray-bg);font-weight:700"></div>
        <div class="field full"><label>메모</label><input id="b-memo" placeholder="발주번호, 특이사항 등" maxlength="100"></div>
      </div>
      <div class="modal-actions"><button class="btn" onclick="savePurchase()">매입 저장</button></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>매입 내역</h2>${monthPicker()}</div>
      ${erpSummaryCards(rows, "매입")}
      <div class="table-wrap"><table>
        <thead><tr><th>매입일</th><th>제품</th><th>거래처</th><th class="num">수량</th><th class="num">단가</th><th class="num">금액</th><th>메모</th><th>입력자</th><th></th></tr></thead>
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
            <td><button class="btn sm danger" onclick="deleteErpRow('purchases','${r.id}')">삭제</button></td>
          </tr>`).join("") : `<tr><td colspan="9" class="empty">${erpMonth}월 매입이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

function calcBuyAmount() {
  const qty = Number(document.getElementById("b-qty").value) || 0;
  const cost = Number(document.getElementById("b-cost").value) || 0;
  document.getElementById("b-amount").value = "₩" + fmt(qty * cost);
}

async function savePurchase() {
  const product_id = document.getElementById("b-product").value;
  const date = document.getElementById("b-date").value;
  const qty = Number(document.getElementById("b-qty").value) || 0;
  const unit_cost = Number(document.getElementById("b-cost").value) || 0;
  if (!product_id) return toast("제품을 선택해 주세요");
  if (!date) return toast("매입일을 선택해 주세요");
  if (qty <= 0) return toast("수량을 입력해 주세요");
  const { error } = await sb.from("purchases").insert({
    date, product_id, qty, unit_cost, amount: qty * unit_cost,
    supplier: document.getElementById("b-supplier").value.trim(),
    memo: document.getElementById("b-memo").value.trim(),
    created_by: me.name,
  });
  if (error) return toast("저장에 실패했습니다");
  toast("매입이 저장되었습니다");
  erpMonth = date.slice(0, 7);
  route();
}

async function deleteErpRow(table, id) {
  if (!confirm("이 내역을 삭제할까요?")) return;
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) return toast("삭제에 실패했습니다");
  toast("삭제되었습니다");
  route();
}

/* ---------- 재고 현황 ---------- */
async function viewInventory() {
  const [prodRes, buyRes, saleRes] = await Promise.all([
    sb.from("products").select("*").order("name"),
    sb.from("purchases").select("product_id,qty,unit_cost,date"),
    sb.from("sales").select("product_id,qty"),
  ]);
  erpProducts = prodRes.data || [];
  const buys = buyRes.data || [];
  const sales = saleRes.data || [];

  const inv = erpProducts.map(p => {
    const myBuys = buys.filter(b => b.product_id === p.id);
    const bought = myBuys.reduce((s, b) => s + Number(b.qty), 0);
    const sold = sales.filter(x => x.product_id === p.id).reduce((s, x) => s + Number(x.qty), 0);
    const lastBuy = myBuys.sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    const lastCost = lastBuy ? Number(lastBuy.unit_cost) : 0;
    const stock = bought - sold;
    return { p, bought, sold, stock, lastCost, value: stock * lastCost };
  });
  const totalValue = inv.reduce((s, r) => s + r.value, 0);

  return `
    <div class="grid-stats">
      <div class="stat"><div class="stat-label">재고 평가액 (최근 매입가 기준)</div>
        <div class="stat-value blue">₩${fmt(totalValue)}</div></div>
      <div class="stat"><div class="stat-label">등록 제품</div>
        <div class="stat-value">${erpProducts.length}종</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>제품별 재고</h2>
        <button class="btn sm secondary" onclick="location.hash='#/purchases'">＋ 매입 입력</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>제품</th><th class="num">총 매입</th><th class="num">총 판매</th><th class="num">현재 재고</th><th class="num">최근 매입단가</th><th class="num">재고 금액</th></tr></thead>
        <tbody>${inv.length ? inv.map(r => `
          <tr>
            <td><b>${esc(r.p.name)}</b><br><small style="color:var(--text-sub)">${esc(r.p.code)} · ${esc(r.p.spec)}</small></td>
            <td class="num">${fmt(r.bought)}</td>
            <td class="num">${fmt(r.sold)}</td>
            <td class="num" style="font-weight:800;color:${r.stock < 0 ? "var(--red)" : r.stock <= 5 ? "var(--amber)" : "var(--text)"}">${fmt(r.stock)}</td>
            <td class="num">₩${fmt(r.lastCost)}</td>
            <td class="num">₩${fmt(r.value)}</td>
          </tr>`).join("") : `<tr><td colspan="6" class="empty">제품이 없습니다</td></tr>`}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 재고 = 매입 수량 − 판매 수량. 재고가 음수면 매입 입력이 누락된 것입니다.
      </p>
    </div>`;
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
      <div class="card-head"><h2>결재 알림</h2>${pushStatus}</div>
      <p style="color:var(--text-sub);font-size:13.5px;margin-bottom:12px">
        내 결재 차례가 오거나, 내가 올린 문서가 승인/반려되면 이 기기로 알림이 옵니다.<br>
        기기마다 한 번씩 켜주세요. (아이폰은 Safari에서 <b>홈 화면에 추가</b> 후 앱을 열어 켜야 합니다)
      </p>
      <button class="btn" onclick="ensurePushSubscribed(true).then(()=>route())">🔔 이 기기에서 알림 켜기</button>
    </div>

    <div class="card">
      <h2>데이터 저장 방식</h2>
      <p style="color:var(--text-sub);font-size:13.5px">
        모든 문서와 제품 정보는 <b>Supabase 클라우드 데이터베이스</b>에 저장되며,<br>
        전 직원이 같은 데이터를 실시간으로 공유합니다. PC·핸드폰 어디서 접속해도 동일합니다.
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
        ※ 직원 추가/삭제, 비밀번호 변경이 필요하면 관리자에게 요청하세요.
      </p>
    </div>

    <div class="card">
      <h2>문서 백업</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">전체 문서·제품 데이터를 JSON 파일로 내려받습니다.</p>
      <button class="btn" onclick="exportJSON()">📤 전체 데이터 내보내기 (JSON)</button>
    </div>`;
}

async function exportJSON() {
  const [docs, prods] = await Promise.all([
    sb.from("documents").select("*"),
    sb.from("products").select("*"),
  ]);
  const dump = { exportedAt: nowStr(), documents: docs.data || [], products: prods.data || [] };
  downloadFile(JSON.stringify(dump, null, 2), `리버스_전자결재_백업_${today()}.json`, "application/json");
  toast("JSON 파일로 내보냈습니다");
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
