/* ============================================================
   주식회사 리버스 전자결재 시스템 (테스트 버전)
   - 순수 정적 웹앱: GitHub Pages에서 그대로 동작
   - 데이터는 브라우저 localStorage에 저장 (설정에서 JSON 공유 가능)
   ============================================================ */

"use strict";

const STORE_KEY = "reverse_epay_v1";
const SESSION_KEY = "reverse_epay_session";

/* ---------- 초기 데이터 ---------- */
const SEED = {
  users: [
    { id: "u1", name: "이사원", role: "사원", dept: "경영지원팀", approver: false },
    { id: "u2", name: "박팀장", role: "팀장", dept: "경영지원팀", approver: true },
    { id: "u3", name: "김대표", role: "대표이사", dept: "경영진", approver: true },
  ],
  accounts: ["복리후생비", "여비교통비", "접대비", "소모품비", "지급수수료", "광고선전비", "통신비", "차량유지비", "교육훈련비", "기타"],
  payMethods: ["법인카드", "개인카드(환급)", "계좌이체", "현금"],
  documents: [],
  products: [
    { id: "p1", code: "RV-001", name: "리버스 프로틴 젤리", category: "건강식품", spec: "30g x 10입", unit: "BOX", price: 25000, memo: "주력 제품", updatedAt: "2026-08-01", updatedBy: "박팀장" },
    { id: "p2", code: "RV-002", name: "리버스 콜라겐 스틱", category: "건강식품", spec: "2g x 30포", unit: "BOX", price: 32000, memo: "", updatedAt: "2026-08-10", updatedBy: "박팀장" },
    { id: "p3", code: "RV-003", name: "리버스 비타민C 츄어블", category: "건강식품", spec: "500mg x 60정", unit: "병", price: 18000, memo: "리뉴얼 예정", updatedAt: "2026-08-15", updatedBy: "이사원" },
  ],
  seq: { doc: 1, product: 4 },
};

/* ---------- 저장소 ---------- */
let DB = null;

function loadDB() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { DB = JSON.parse(raw); return; }
  } catch (e) { /* 손상 시 초기화 */ }
  DB = JSON.parse(JSON.stringify(SEED));
  saveDB();
}
function saveDB() { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }

/* ---------- 세션 ---------- */
let me = null;
function login(userId) {
  me = DB.users.find(u => u.id === userId);
  sessionStorage.setItem(SESSION_KEY, userId);
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  renderUserBox();
  location.hash = "#/dashboard";
  route();
}
function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  me = null;
  showLogin();
}
function showLogin() {
  document.getElementById("app").classList.add("hidden");
  const box = document.getElementById("login-users");
  box.innerHTML = DB.users.map(u => `
    <button class="login-user-btn" onclick="login('${u.id}')">
      <span class="avatar">${u.name[0]}</span>
      <span><b>${u.name}</b><small>${u.dept} · ${u.role}</small></span>
    </button>`).join("");
  document.getElementById("login-screen").classList.remove("hidden");
}
function renderUserBox() {
  document.getElementById("user-avatar").textContent = me.name[0];
  document.getElementById("user-name").textContent = me.name;
  document.getElementById("user-role").textContent = `${me.dept} · ${me.role}`;
  document.getElementById("topbar-user").textContent = `${me.name} (${me.role})`;
}

/* ---------- 유틸 ---------- */
const fmt = n => (Number(n) || 0).toLocaleString("ko-KR");
const today = () => new Date().toISOString().slice(0, 10);
const nowStr = () => {
  const d = new Date();
  return d.toISOString().slice(0, 10) + " " + d.toTimeString().slice(0, 5);
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const userName = id => (DB.users.find(u => u.id === id) || {}).name || "?";
const userRole = id => (DB.users.find(u => u.id === id) || {}).role || "";

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
  const cur = doc.approvalLine[doc.currentStep];
  return `<span class="chip progress">결재 중 (${userName(cur.userId)})</span>`;
}

/* 내 결재 차례인 문서 */
function myInbox() {
  return DB.documents.filter(d =>
    d.status === "progress" && d.approvalLine[d.currentStep]?.userId === me.id);
}

/* ---------- 라우터 ---------- */
const routes = {
  dashboard: { title: "대시보드", render: viewDashboard },
  new: { title: "지출결의서 작성", render: viewNewDoc },
  inbox: { title: "결재 대기함", render: viewInbox },
  drafts: { title: "내 기안함", render: viewDrafts },
  docs: { title: "전체 문서함", render: viewAllDocs },
  products: { title: "제품 마스터", render: viewProducts },
  settings: { title: "설정 · 데이터", render: viewSettings },
  doc: { title: "문서 상세", render: viewDocDetail },
};

function route() {
  if (!me) return;
  const hash = location.hash.replace(/^#\//, "") || "dashboard";
  const [name, param] = hash.split("/");
  const r = routes[name] || routes.dashboard;
  document.getElementById("page-title").textContent = r.title;
  document.querySelectorAll(".nav-item").forEach(el =>
    el.classList.toggle("active", el.dataset.route === name));
  document.getElementById("content").innerHTML = r.render(param);
  if (r.after) r.after(param);
  updateBadge();
  closeSidebar();
  window.scrollTo(0, 0);
}

function updateBadge() {
  const n = myInbox().length;
  const b = document.getElementById("badge-inbox");
  b.textContent = n;
  b.classList.toggle("hidden", n === 0);
}

/* ---------- 화면: 대시보드 ---------- */
function viewDashboard() {
  const inbox = myInbox().length;
  const mine = DB.documents.filter(d => d.drafterId === me.id);
  const progress = mine.filter(d => d.status === "progress").length;
  const approved = mine.filter(d => d.status === "approved").length;
  const thisMonth = today().slice(0, 7);
  const monthTotal = DB.documents
    .filter(d => d.status === "approved" && d.date.startsWith(thisMonth))
    .reduce((s, d) => s + d.total, 0);

  const recent = [...DB.documents].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 6);

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
    </div>

    <div class="card">
      <div class="card-head">
        <h2>최근 문서</h2>
        <button class="btn sm" onclick="location.hash='#/new'">＋ 지출결의서 작성</button>
      </div>
      ${docTable(recent)}
    </div>

    <div class="card">
      <div class="card-head">
        <h2>제품 마스터 최근 업데이트</h2>
        <button class="btn sm secondary" onclick="location.hash='#/products'">전체 보기</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>제품코드</th><th>제품명</th><th>규격</th><th class="num">단가</th><th>수정일</th></tr></thead>
        <tbody>
        ${[...DB.products].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 5)
          .map(p => `<tr><td>${esc(p.code)}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.spec)}</td><td class="num">₩${fmt(p.price)}</td><td>${esc(p.updatedAt)}</td></tr>`).join("")
          || `<tr><td colspan="5" class="empty">등록된 제품이 없습니다</td></tr>`}
        </tbody>
      </table></div>
    </div>`;
}

/* ---------- 문서 목록 테이블 공통 ---------- */
function docTable(list) {
  if (!list.length) return `<div class="table-wrap"><table><tbody><tr><td class="empty">문서가 없습니다</td></tr></tbody></table></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>문서번호</th><th>제목</th><th>기안자</th><th>기안일</th><th class="num">금액</th><th>상태</th></tr></thead>
    <tbody>${list.map(d => `
      <tr class="clickable" onclick="location.hash='#/doc/${d.id}'">
        <td>${d.docNo}</td>
        <td><b>${esc(d.title)}</b></td>
        <td>${userName(d.drafterId)}</td>
        <td>${d.date}</td>
        <td class="num">₩${fmt(d.total)}</td>
        <td>${docStatusChip(d)}</td>
      </tr>`).join("")}
    </tbody></table></div>`;
}

/* ---------- 화면: 지출결의서 작성 ---------- */
function viewNewDoc() {
  const approvers = DB.users.filter(u => u.id !== me.id && u.approver);
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
          <select id="f-pay">${DB.payMethods.map(m => `<option>${m}</option>`).join("")}</select>
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
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:10px">순서대로 결재가 진행됩니다. (기안자 → 1차 → 최종)</p>
      <div class="form-grid">
        <div class="field">
          <label>1차 결재자 *</label>
          <select id="f-appr1">
            ${approvers.map(u => `<option value="${u.id}" ${u.role === "팀장" ? "selected" : ""}>${u.name} (${u.role})</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>최종 결재자</label>
          <select id="f-appr2">
            <option value="">(없음 — 1차에서 종결)</option>
            ${approvers.map(u => `<option value="${u.id}" ${u.role === "대표이사" ? "selected" : ""}>${u.name} (${u.role})</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn secondary" onclick="location.hash='#/dashboard'">취소</button>
        <button class="btn" onclick="submitDoc()">상신 (결재 요청)</button>
      </div>
    </div>`;
}
routes.new.after = () => { addItemRow(); };

let itemRowSeq = 0;
function addItemRow() {
  const tbody = document.getElementById("item-rows");
  const tr = document.createElement("tr");
  tr.dataset.row = ++itemRowSeq;
  tr.innerHTML = `
    <td><select class="i-acct">${DB.accounts.map(a => `<option>${a}</option>`).join("")}</select></td>
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

function submitDoc() {
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

  const appr1 = document.getElementById("f-appr1").value;
  const appr2 = document.getElementById("f-appr2").value;
  const line = [appr1, appr2].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
    .map(uid => ({ userId: uid, status: "waiting", comment: "", date: "" }));
  if (!line.length) return toast("결재자를 선택해 주세요");

  const n = DB.seq.doc++;
  const doc = {
    id: "d" + String(n).padStart(5, "0"),
    docNo: `리버스-지출-${date.slice(0, 4)}-${String(n).padStart(3, "0")}`,
    type: "지출결의서",
    title, date,
    pay: document.getElementById("f-pay").value,
    note: document.getElementById("f-note").value.trim(),
    drafterId: me.id,
    createdAt: nowStr(),
    items,
    total: items.reduce((s, it) => s + it.amount, 0),
    approvalLine: line,
    currentStep: 0,
    status: "progress",
  };
  DB.documents.push(doc);
  saveDB();
  toast("상신되었습니다");
  location.hash = "#/doc/" + doc.id;
}

/* ---------- 화면: 결재 대기함 ---------- */
function viewInbox() {
  const list = myInbox().sort((a, b) => b.id.localeCompare(a.id));
  return `
    <div class="card">
      <div class="card-head"><h2>내가 결재할 문서 (${list.length}건)</h2></div>
      ${docTable(list)}
    </div>`;
}

/* ---------- 화면: 내 기안함 ---------- */
function viewDrafts() {
  const list = DB.documents.filter(d => d.drafterId === me.id).sort((a, b) => b.id.localeCompare(a.id));
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
function viewAllDocs() {
  let list = [...DB.documents].sort((a, b) => b.id.localeCompare(a.id));
  if (docsFilter.status) list = list.filter(d => d.status === docsFilter.status);
  if (docsFilter.q) {
    const q = docsFilter.q.toLowerCase();
    list = list.filter(d =>
      d.title.toLowerCase().includes(q) || d.docNo.toLowerCase().includes(q) ||
      userName(d.drafterId).includes(q));
  }
  return `
    <div class="card">
      <div class="card-head"><h2>전체 문서 (${list.length}건)</h2></div>
      <div class="searchbar" style="margin-bottom:14px">
        <input id="docs-q" placeholder="제목, 문서번호, 기안자 검색" value="${esc(docsFilter.q)}"
          oninput="docsFilter.q=this.value;refreshDocsTable()">
        <select onchange="docsFilter.status=this.value;refreshDocsTable()">
          <option value="">전체 상태</option>
          <option value="progress" ${docsFilter.status === "progress" ? "selected" : ""}>결재 중</option>
          <option value="approved" ${docsFilter.status === "approved" ? "selected" : ""}>승인 완료</option>
          <option value="rejected" ${docsFilter.status === "rejected" ? "selected" : ""}>반려</option>
        </select>
      </div>
      <div id="docs-table">${docTable(list)}</div>
    </div>`;
}
function refreshDocsTable() {
  let list = [...DB.documents].sort((a, b) => b.id.localeCompare(a.id));
  if (docsFilter.status) list = list.filter(d => d.status === docsFilter.status);
  if (docsFilter.q) {
    const q = docsFilter.q.toLowerCase();
    list = list.filter(d =>
      d.title.toLowerCase().includes(q) || d.docNo.toLowerCase().includes(q) ||
      userName(d.drafterId).includes(q));
  }
  document.getElementById("docs-table").innerHTML = docTable(list);
}

/* ---------- 화면: 문서 상세 ---------- */
function viewDocDetail(id) {
  const d = DB.documents.find(x => x.id === id);
  if (!d) return `<div class="card"><p class="empty">문서를 찾을 수 없습니다.</p></div>`;

  const isMyTurn = d.status === "progress" && d.approvalLine[d.currentStep].userId === me.id;

  const steps = `
    <div class="appr-line">
      <div class="appr-step approved">
        <div class="step-role">기안</div>
        <div class="step-name">${userName(d.drafterId)}</div>
        <div class="step-date">${d.createdAt}</div>
      </div>
      ${d.approvalLine.map((s, i) => {
        let cls = "", label = "대기";
        if (s.status === "approved") { cls = "approved"; label = "✔ 승인"; }
        else if (s.status === "rejected") { cls = "rejected"; label = "✖ 반려"; }
        else if (d.status === "progress" && i === d.currentStep) { cls = "current"; label = "결재 차례"; }
        return `<div class="appr-step ${cls}">
          <div class="step-role">${i + 1}차 결재 · ${userRole(s.userId)}</div>
          <div class="step-name">${userName(s.userId)}</div>
          <div class="step-status">${label}</div>
          ${s.date ? `<div class="step-date">${s.date}</div>` : ""}
        </div>`;
      }).join("")}
    </div>
    ${d.approvalLine.filter(s => s.comment).map(s =>
      `<div class="doc-comment"><b>${userName(s.userId)}</b> — ${esc(s.comment)}</div>`).join("")}`;

  return `
    <div class="card">
      <div class="card-head">
        <h2>${esc(d.title)}</h2>
        ${docStatusChip(d)}
      </div>
      <div class="doc-meta">
        <div><span>문서번호</span><b>${d.docNo}</b></div>
        <div><span>기안자</span>${userName(d.drafterId)} (${userRole(d.drafterId)})</div>
        <div><span>지출일</span>${d.date}</div>
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
        ${d.drafterId === me.id && d.status === "rejected" ? `<button class="btn" onclick="location.hash='#/new'">다시 작성</button>` : ""}
      </div>
    </div>`;
}

function decide(docId, approve) {
  const d = DB.documents.find(x => x.id === docId);
  if (!d || d.status !== "progress") return;
  const step = d.approvalLine[d.currentStep];
  if (step.userId !== me.id) return toast("결재 권한이 없습니다");

  step.comment = document.getElementById("appr-comment")?.value.trim() || "";
  step.date = nowStr();
  if (approve) {
    step.status = "approved";
    if (d.currentStep < d.approvalLine.length - 1) d.currentStep++;
    else d.status = "approved";
    toast("승인 처리되었습니다");
  } else {
    step.status = "rejected";
    d.status = "rejected";
    toast("반려 처리되었습니다");
  }
  saveDB();
  route();
}

/* ---------- 화면: 제품 마스터 ---------- */
let prodFilter = "";
function viewProducts() {
  return `
    <div class="card">
      <div class="card-head">
        <h2>제품 마스터 (${DB.products.length}종)</h2>
        <div style="display:flex;gap:8px">
          <button class="btn sm secondary" onclick="exportProductsCSV()">CSV 내보내기</button>
          <button class="btn sm" onclick="openProductModal()">＋ 제품 등록</button>
        </div>
      </div>
      <div class="searchbar" style="margin-bottom:14px">
        <input id="prod-q" placeholder="제품명, 코드, 분류 검색" value="${esc(prodFilter)}"
          oninput="prodFilter=this.value;refreshProductTable()">
      </div>
      <div id="product-table">${productTable()}</div>
    </div>`;
}
function productTable() {
  let list = [...DB.products].sort((a, b) => a.code.localeCompare(b.code));
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
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.memo)}</td>
        <td style="white-space:nowrap">${esc(p.updatedAt)}<br><small style="color:var(--text-sub)">${esc(p.updatedBy || "")}</small></td>
        <td style="white-space:nowrap">
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
  const p = id ? DB.products.find(x => x.id === id) : null;
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

function saveProduct(id) {
  const code = document.getElementById("p-code").value.trim();
  const name = document.getElementById("p-name").value.trim();
  if (!code || !name) return toast("제품코드와 제품명은 필수입니다");
  const dup = DB.products.find(p => p.code === code && p.id !== id);
  if (dup) return toast("이미 사용 중인 제품코드입니다");

  const data = {
    code, name,
    category: document.getElementById("p-cat").value.trim(),
    spec: document.getElementById("p-spec").value.trim(),
    unit: document.getElementById("p-unit").value.trim(),
    price: Number(document.getElementById("p-price").value) || 0,
    memo: document.getElementById("p-memo").value.trim(),
    updatedAt: today(),
    updatedBy: me.name,
  };
  if (id) {
    Object.assign(DB.products.find(p => p.id === id), data);
    toast("제품이 수정되었습니다");
  } else {
    DB.products.push({ id: "p" + DB.seq.product++, ...data });
    toast("제품이 등록되었습니다");
  }
  saveDB();
  closeModal();
  refreshProductTable();
  document.querySelector(".card-head h2").textContent = `제품 마스터 (${DB.products.length}종)`;
}

function deleteProduct(id) {
  const p = DB.products.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`'${p.name}' 제품을 삭제할까요?`)) return;
  DB.products = DB.products.filter(x => x.id !== id);
  saveDB();
  refreshProductTable();
  toast("삭제되었습니다");
}

function exportProductsCSV() {
  const head = ["제품코드", "제품명", "분류", "규격", "단위", "단가", "메모", "최종수정일", "수정자"];
  const rows = DB.products.map(p =>
    [p.code, p.name, p.category, p.spec, p.unit, p.price, p.memo, p.updatedAt, p.updatedBy || ""]);
  const csv = "﻿" + [head, ...rows]
    .map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  downloadFile(csv, `리버스_제품마스터_${today()}.csv`, "text/csv");
}

/* ---------- 화면: 설정 · 데이터 ---------- */
function viewSettings() {
  const size = (localStorage.getItem(STORE_KEY) || "").length;
  return `
    <div class="card">
      <h2>데이터 공유 (내보내기 / 가져오기)</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:14px">
        테스트 단계에서는 데이터가 <b>이 브라우저에만</b> 저장됩니다.<br>
        다른 PC·직원과 공유하려면 JSON 파일로 내보낸 뒤, 상대방 PC에서 가져오기 하세요.
      </p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" onclick="exportJSON()">📤 전체 데이터 내보내기 (JSON)</button>
        <label class="btn secondary" style="display:inline-flex;align-items:center">
          📥 데이터 가져오기
          <input type="file" accept=".json" style="display:none" onchange="importJSON(this)">
        </label>
      </div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">현재 데이터 크기: ${fmt(size)} bytes · 문서 ${DB.documents.length}건 · 제품 ${DB.products.length}종</p>
    </div>

    <div class="card">
      <h2>사용자 (데모)</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>이름</th><th>부서</th><th>직급</th><th>결재 권한</th></tr></thead>
        <tbody>${DB.users.map(u => `
          <tr><td><b>${u.name}</b>${u.id === me.id ? ' <span class="chip mine">나</span>' : ""}</td>
          <td>${u.dept}</td><td>${u.role}</td><td>${u.approver ? "✔" : "—"}</td></tr>`).join("")}
        </tbody>
      </table></div>
      <p style="color:var(--text-sub);font-size:12px;margin-top:10px">
        ※ 실제 도입 시에는 로그인/권한 관리를 서버(예: Supabase, Firebase)와 연동해야 합니다.
      </p>
    </div>

    <div class="card">
      <h2>초기화</h2>
      <p style="color:var(--text-sub);font-size:13px;margin-bottom:12px">모든 문서·제품 데이터를 지우고 초기 상태로 되돌립니다.</p>
      <button class="btn danger" onclick="resetAll()">전체 데이터 초기화</button>
    </div>`;
}

function exportJSON() {
  downloadFile(JSON.stringify(DB, null, 2), `리버스_전자결재_백업_${today()}.json`, "application/json");
  toast("JSON 파일로 내보냈습니다");
}
function importJSON(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.users || !data.documents || !data.products) throw new Error("형식 오류");
      DB = data;
      saveDB();
      toast("데이터를 가져왔습니다");
      route();
    } catch (e) {
      toast("올바른 백업 파일이 아닙니다");
    }
  };
  reader.readAsText(file);
  input.value = "";
}
function resetAll() {
  if (!confirm("정말 모든 데이터를 초기화할까요? 되돌릴 수 없습니다.")) return;
  DB = JSON.parse(JSON.stringify(SEED));
  saveDB();
  toast("초기화되었습니다");
  route();
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
  const sb = document.getElementById("sidebar");
  sb.classList.add("open");
  const bd = document.createElement("div");
  bd.className = "sidebar-backdrop";
  bd.onclick = closeSidebar;
  document.body.appendChild(bd);
});

/* ---------- 시작 ---------- */
document.getElementById("btn-logout").addEventListener("click", logout);
window.addEventListener("hashchange", route);

loadDB();
const savedUser = sessionStorage.getItem(SESSION_KEY);
if (savedUser && DB.users.some(u => u.id === savedUser)) {
  login(savedUser);
} else {
  showLogin();
}
