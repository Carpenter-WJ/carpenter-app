// ── Firebase 참조 ──
const auth = firebase.auth();
const fsdb = firebase.firestore();
fsdb.enablePersistence({synchronizeTabs:true}).catch(function(){});

// 고정 공휴일 (MM-DD)
const FIXED_HOL = {
  '01-01':'신정','03-01':'삼일절','05-05':'어린이날','06-06':'현충일',
  '07-17':'제헌절','08-15':'광복절','10-03':'개천절','10-09':'한글날','12-25':'성탄절'
};
// 음력 기반 공휴일 (YYYY-MM-DD) — 설날·추석·부처님오신날·대체공휴일
const VAR_HOL = {
  '2024-02-09':'설연휴','2024-02-10':'설날','2024-02-11':'설연휴',
  '2024-02-12':'대체공휴일','2024-05-15':'부처님오신날',
  '2024-09-16':'추석연휴','2024-09-17':'추석','2024-09-18':'추석연휴',
  '2025-01-28':'설연휴','2025-01-29':'설날','2025-01-30':'설연휴',
  '2025-03-03':'대체공휴일','2025-05-06':'대체공휴일',
  '2025-10-05':'추석연휴','2025-10-06':'추석','2025-10-07':'추석연휴',
  '2025-10-08':'대체공휴일',
  '2026-02-17':'설연휴','2026-02-18':'설날','2026-02-19':'설연휴',
  '2026-05-24':'부처님오신날',
  '2026-09-24':'추석연휴','2026-09-25':'추석','2026-09-26':'추석연휴',
  '2027-02-06':'설연휴','2027-02-07':'설날','2027-02-08':'설연휴',
  '2027-05-13':'부처님오신날',
  '2027-09-14':'추석연휴','2027-09-15':'추석','2027-09-16':'추석연휴',
  '2028-01-26':'설연휴','2028-01-27':'설날','2028-01-28':'설연휴',
  '2028-05-02':'부처님오신날',
  '2028-10-02':'추석연휴','2028-10-03':'추석','2028-10-04':'추석연휴',
  '2028-10-05':'대체공휴일',
};
function getHoli(ds) { return VAR_HOL[ds] || FIXED_HOL[ds.slice(5)] || null; }

const WORK_COLORS = [
  { id:'orange', bg:'rgba(230,126,34,.18)', border:'#E67E22' },
  { id:'red',    bg:'rgba(255,59,48,.15)',  border:'#FF3B30' },
  { id:'blue',   bg:'rgba(0,122,255,.15)',  border:'#007AFF' },
  { id:'green',  bg:'rgba(52,199,89,.15)',  border:'#34C759' },
  { id:'purple', bg:'rgba(155,89,182,.15)', border:'#9B59B6' },
  { id:'pink',   bg:'rgba(255,45,146,.15)', border:'#FF2D92' },
  { id:'teal',   bg:'rgba(26,188,156,.15)', border:'#1ABC9C' },
  { id:'gray',   bg:'rgba(142,142,147,.15)',border:'#8E8E93' },
];
function getColor(id) { return WORK_COLORS.find(c=>c.id===id) || WORK_COLORS[0]; }

let currentUser = null;
let DB = { works: [], payments: [], jobs: [], notifications: [], dailyNotes: {} };
// ── 팀 모드 상태 ──
let dataMode = 'personal'; // 'personal' | 'team' | 'pending'
let activeTeamId = null;
let teamInfo = null;       // teams/{teamId} 문서
let teamRole = null;       // 'leader' | 'member'
let teamMembers = [];
let teamMemberExits = []; // {uid, exitedAt, works, payments, docId}
let pendingTeamId = null;  // 가입 신청 대기 중인 팀 ID
let pendingTeamName = '';  // 대기 중인 팀 이름
let joinRequests = [];     // 팀장용 — 대기 중인 가입 신청 목록
let _pendingListener = null;
let _notifListener = null;
const TODAY = new Date();
let calY = TODAY.getFullYear(), calM = TODAY.getMonth();
let statY = TODAY.getFullYear(), statM = TODAY.getMonth();
let workY = TODAY.getFullYear(), workM = TODAY.getMonth();
let payY = TODAY.getFullYear(), payM = TODAY.getMonth(), payFilter = 'all';
let workSearch = '';
let showWeekSum = localStorage.getItem('showWeekSum') !== 'false';
let curTab = 'cal';
let selDate = null;
let selWorkId = null;
let editDates = [];
let editColor = 'orange';
function movePay(d) { payM+=d; if(payM>11){payM=0;payY++;} if(payM<0){payM=11;payY--;} renderPay(); }
function setPayFilter(f) { payFilter=f; renderPay(); }

function toggleInfoSection(force) {
  const body=document.getElementById('infoBody');
  const arrow=document.getElementById('infoArrow');
  const open=force!==undefined?force:!body.classList.contains('open');
  body.classList.toggle('open',open);
  arrow.classList.toggle('open',open);
}

// ── 일일 메모 ──
async function saveDailyNote() {
  if (!selDate || !currentUser) return;
  const text = document.getElementById('inDayMemo').value.trim();
  if (text) { DB.dailyNotes[selDate] = text; } else { delete DB.dailyNotes[selDate]; }
  localStorage.setItem('moksujilji2', JSON.stringify(DB));
  renderCal();
  try {
    const ref = fsdb.collection('users').doc(currentUser.uid).collection('dailyNotes').doc(selDate);
    if (text) { await ref.set({ text, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }); }
    else { await ref.delete(); }
    const el = document.getElementById('dayMemoSaved');
    if (el) { el.style.display = 'block'; setTimeout(() => el.style.display = 'none', 1500); }
  } catch(e) { console.error('일일 메모 저장 오류:', e); }
}

// ── 현장 자동완성 ──
function getSiteHistory() {
  if (dataMode === 'team') {
    return DB.jobs.map(j => ({ site:j.site, address:j.address||'', contact:j.contact||'', phone:j.phone||'', memo:j.memo||'', color:j.color||'orange', workDesc:'' }));
  }
  const seen = new Set();
  return DB.works
    .slice().sort((a,b)=>(b.dates?.[b.dates.length-1]||'').localeCompare(a.dates?.[a.dates.length-1]||''))
    .filter(w=>{ if(seen.has(w.site)) return false; seen.add(w.site); return true; })
    .map(w=>({ site:w.site, workDesc:w.workDesc||'', address:w.address||'', contact:w.contact||'', phone:w.phone||'', memo:w.memo||'', color:w.color||'orange' }));
}

let _siteHistory = [];
function onSiteInput() {
  const val = document.getElementById('inSite').value.trim();
  const dd = document.getElementById('siteDropdown');
  if (!val) { dd.style.display = 'none'; return; }
  _siteHistory = getSiteHistory().filter(s => s.site !== val && s.site.toLowerCase().includes(val.toLowerCase()));
  if (_siteHistory.length === 0) { dd.style.display = 'none'; return; }
  dd.innerHTML = _siteHistory.map((s, i) => `
    <div class="sdi" onclick="selectSiteHistory(${i})">
      <div class="sdi-name">${s.site}</div>
      ${s.address ? `<div class="sdi-meta">📍 ${s.address}</div>` : ''}
    </div>`).join('');
  dd.style.display = '';
}

function selectSiteHistory(idx) {
  const s = _siteHistory[idx]; if (!s) return;
  document.getElementById('inSite').value = s.site;
  document.getElementById('inWorkDesc').value = s.workDesc;
  document.getElementById('inAddress').value = s.address;
  document.getElementById('inContact').value = s.contact;
  document.getElementById('inPhone').value = s.phone;
  document.getElementById('inMemo').value = s.memo;
  if (s.color) { editColor = s.color; renderColorChips(); }
  document.getElementById('siteDropdown').style.display = 'none';
  if (s.address || s.contact || s.phone || s.memo) toggleInfoSection(true);
}

document.addEventListener('click', e => {
  const dd = document.getElementById('siteDropdown');
  if (dd && !dd.contains(e.target) && e.target.id !== 'inSite') dd.style.display = 'none';
});

// ── 테마 ──
function applyTheme() {
  const saved = localStorage.getItem('theme') || 'system';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved === 'dark' || (saved === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', isDark);
  ['system','light','dark'].forEach(t => {
    const el = document.getElementById('thm-'+t);
    if(el) el.classList.toggle('on', t === saved);
  });
}
function setTheme(t) { localStorage.setItem('theme', t); applyTheme(); }
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();

// ── 기본 일당 ──
let defaultWage = localStorage.getItem('defaultWage') || '';
let userDisplayName = ''; // 사용자 설정 닉네임 (구글 이름과 별개)
let workEntryMode = 'team'; // 팀 모드에서 기록 추가 시 'team' | 'personal'
function saveDefWage(v) { defaultWage = v; localStorage.setItem('defaultWage', v); }
function setWeekSum(v) { showWeekSum = v; localStorage.setItem('showWeekSum', v); renderCal(); }

// ── 설정 탭 렌더 ──
function renderSet() {
  applyTheme();
  if (teamRole === 'leader') loadJoinRequests().then(renderTeamSettings);
  else renderTeamSettings();
  const inp = document.getElementById('defWageInp');
  if(inp) inp.value = defaultWage;
  const wst = document.getElementById('weekSumToggle');
  if(wst) wst.checked = showWeekSum;
  const card = document.getElementById('accountCard');
  if(!card) return;
  if(currentUser) {
    const avatar = currentUser.photoURL
      ? `<img class="set-avatar" src="${currentUser.photoURL}" onerror="this.style.display='none'">`
      : `<div class="set-avatar" style="background:var(--pri);display:flex;align-items:center;justify-content:center;font-size:22px;color:#fff">👤</div>`;
    card.innerHTML = `
      <div class="set-profile">
        ${avatar}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="set-profile-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${userDisplayName||'이름 없음'}</div>
            <button onclick="editDisplayName()" style="flex-shrink:0;background:none;border:1px solid var(--border);border-radius:8px;padding:4px 10px;font-size:12px;color:var(--muted);cursor:pointer">수정</button>
          </div>
          <div class="set-profile-email">${currentUser.email||''}</div>
        </div>
      </div>`;
  } else {
    card.innerHTML = `<div class="empty" style="padding:20px">로그인이 필요합니다.</div>`;
  }
}

function renderColorChips() {
  document.getElementById('colorChips').innerHTML = WORK_COLORS.map(c =>
    `<div class="cchip${editColor===c.id?' on':''}" style="background:${c.border}" onclick="selectColor('${c.id}')"></div>`
  ).join('');
}
function selectColor(id) { editColor=id; renderColorChips(); }

async function editDisplayName() {
  const newName = prompt('이름(닉네임)을 입력해주세요', userDisplayName);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed) { alert('이름을 입력해주세요.'); return; }
  if (trimmed.length > 20) { alert('20자 이내로 입력해주세요.'); return; }
  try {
    const userRef = fsdb.collection('users').doc(currentUser.uid);
    await userRef.set({ customName: trimmed }, { merge: true });
    userDisplayName = trimmed;
    // 팀 멤버 문서도 업데이트 (팀에 속해 있으면)
    if (dataMode === 'team' && activeTeamId) {
      teamRef().collection('members').doc(currentUser.uid).update({ displayName: trimmed }).catch(()=>{});
    }
    renderSet();
    showToast('이름이 변경되었습니다.');
  } catch(e) { console.error(e); alert('이름 변경에 실패했습니다.'); }
}

// ── 팀 모드 헬퍼 ──
function teamRef() { return fsdb.collection('teams').doc(activeTeamId); }
function updateHeader() {
  const ind = document.getElementById('teamIndicator');
  if (!ind) return;
  if (dataMode === 'team' && teamInfo) {
    const roleLbl = teamRole === 'leader' ? '팀장' : '팀원';
    ind.textContent = `👥 ${teamInfo.name} · ${roleLbl}`;
    ind.style.display = '';
  } else {
    ind.style.display = 'none';
  }
}
function showTeamWelcome() {
  if (!teamInfo) return;
  document.getElementById('teamWelcomeTitle').textContent = `${teamInfo.name}에 합류됐어요!`;
  document.getElementById('teamWelcomeDesc').innerHTML = teamRole === 'leader'
    ? '✅ 팀원 일당을 대신 등록할 수 있어요<br>✅ 현장 공개 범위를 설정할 수 있어요<br>✅ 가입 신청을 승인/거절할 수 있어요<br>✅ 팀 전체 정산 현황을 확인할 수 있어요'
    : '✅ 팀장이 등록한 현장과 내 일당을 볼 수 있어요<br>✅ 팀 일정 외 개인 날일도 따로 기록할 수 있어요<br>✅ 내 정산 내역을 직접 확인할 수 있어요';
  openOv('teamWelcomeOv');
}
// 일당/정산금액을 볼 수 있는지: 개인 모드는 항상 true, 팀 모드는 팀장 또는 본인 작성건만
function canSeeWage(w) {
  if (dataMode !== 'team') return true;
  if (w.isPersonal) return true; // 개인 날일 기록은 항상 본인 것
  const owner = w.ownerUid || w.createdBy;
  return teamRole === 'leader' || owner === currentUser.uid;
}
function canDeleteJob(w) {
  if (dataMode !== 'team') return true;
  if (w.isPersonal) return true; // 개인 날일 기록은 항상 본인이 삭제 가능
  const owner = w.ownerUid || w.createdBy;
  return teamRole === 'leader' || owner === currentUser.uid;
}

async function save() {
  localStorage.setItem('moksujilji2', JSON.stringify(DB));
  if (!currentUser) return;
  try {
    if (dataMode === 'team') {
      const t = teamRef();
      const personalWorksIds = new Set(DB.works.filter(w => w.isPersonal).map(w => w.id));
      const batch = fsdb.batch();
      DB.works.forEach(w => {
        if (w.isPersonal) return; // 개인 날일 기록은 팀 wages에서 제외
        if (!canSeeWage(w)) return;
        batch.set(t.collection('wages').doc(w.id), {
          jobId: w.jobId, dates: w.dates, unit: w.unit, wage: w.wage, isPaid: w.isPaid,
          ownerUid: w.ownerUid || w.createdBy,
          createdBy: w.createdBy, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      DB.payments.forEach(p => {
        if (personalWorksIds.has(p.workId)) return; // 개인 날일 정산은 팀 payments에서 제외
        const { workId, ...rest } = p;
        batch.set(t.collection('payments').doc(p.id), { ...rest, wageId: workId, createdBy: p.createdBy });
      });
      await batch.commit();
      // 개인 날일 기록은 users/{uid}/works + payments에 저장
      const personalWorks = DB.works.filter(w => w.isPersonal);
      const personalPays = DB.payments.filter(p => personalWorksIds.has(p.workId));
      if (personalWorks.length > 0 || personalPays.length > 0) {
        const ref = fsdb.collection('users').doc(currentUser.uid);
        const pBatch = fsdb.batch();
        personalWorks.forEach(w => pBatch.set(ref.collection('works').doc(w.id), w));
        personalPays.forEach(p => pBatch.set(ref.collection('payments').doc(p.id), p));
        await pBatch.commit();
      }
    } else {
      const ref = fsdb.collection('users').doc(currentUser.uid);
      const batch = fsdb.batch();
      DB.works.forEach(w => batch.set(ref.collection('works').doc(w.id), w));
      DB.payments.forEach(p => batch.set(ref.collection('payments').doc(p.id), p));
      await batch.commit();
    }
  } catch(e) { console.error('저장 오류:', e); }
}

// 단일 work를 Firestore에 핀포인트 저장 (팀 wages 또는 개인 works)
async function saveOneWork(w) {
  if (!currentUser) return;
  if (dataMode === 'team' && !w.isPersonal) {
    if (!canSeeWage(w)) return; // wage 수정 권한 없을 때 skip (job 정보는 saveJobInfo가 처리)
    await teamRef().collection('wages').doc(w.id).set({
      jobId: w.jobId, dates: w.dates, unit: w.unit, wage: w.wage, isPaid: w.isPaid,
      workDesc: w.workDesc || '',
      ownerUid: w.ownerUid || w.createdBy,
      createdBy: w.createdBy, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } else {
    await fsdb.collection('users').doc(currentUser.uid).collection('works').doc(w.id).set(w);
  }
}

// work의 isPaid 필드만 Firestore에 업데이트
async function updateOneWage(w) {
  if (!currentUser) return;
  if (dataMode === 'team' && !w.isPersonal) {
    await teamRef().collection('wages').doc(w.id).update({
      isPaid: w.isPaid, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } else {
    await fsdb.collection('users').doc(currentUser.uid).collection('works').doc(w.id).update({ isPaid: w.isPaid });
  }
}

// 단일 payment를 Firestore에 핀포인트 저장
async function saveOnePay(p) {
  if (!currentUser) return;
  const w = DB.works.find(x => x.id === p.workId);
  if (dataMode === 'team' && !w?.isPersonal) {
    const { workId, ...rest } = p;
    await teamRef().collection('payments').doc(p.id).set({ ...rest, wageId: workId, createdBy: p.createdBy });
  } else {
    await fsdb.collection('users').doc(currentUser.uid).collection('payments').doc(p.id).set(p);
  }
}

async function loadTeamData() {
  const t = teamRef();
  const isLeader = teamRole === 'leader';
  const myUid = currentUser.uid;
  // 팀원은 ownerUid가 본인인 wages만 조회 (리더는 전체)
  const wagesQuery = isLeader ? t.collection('wages') : t.collection('wages').where('ownerUid', '==', myUid);
  const paysQuery = isLeader ? t.collection('payments') : t.collection('payments').where('createdBy', '==', myUid);
  // 팀장은 전체 jobs 조회, 팀원은 visibility='all'만 먼저 조회
  // visibility='selected' 쿼리는 복합 인덱스 필요 → 별도 try-catch (인덱스 빌드 중 실패해도 나머지 유지)
  const mainJobsQuery = isLeader
    ? t.collection('jobs').get()
    : t.collection('jobs').where('visibility', '==', 'all').get();
  const [jobsSnap, wagesSnap, paysSnap, membersSnap] = await Promise.all([
    mainJobsQuery, wagesQuery.get(), paysQuery.get(), t.collection('members').get()
  ]);
  let jobsSelected = { docs: [] };
  if (!isLeader) {
    try {
      jobsSelected = await t.collection('jobs').where('visibility', '==', 'selected').where('sharedWith', 'array-contains', myUid).get();
    } catch(e) { console.warn('선택공개 현장 로드 실패 (인덱스 빌드 중일 수 있음):', e.message); }
  }
  const allJobDocs = isLeader ? jobsSnap.docs : [...jobsSnap.docs, ...jobsSelected.docs];
  // notifications는 복합 인덱스가 필요해 별도 try-catch로 분리 (인덱스 빌드 중일 때 실패해도 나머지 데이터 유지)
  let notifSnap = { docs: [] };
  try {
    notifSnap = await t.collection('notifications').where('toUid', '==', myUid).get();
  } catch(e) { console.warn('알림 로드 실패:', e.message); }
  const jobById = {};
  DB.jobs = allJobDocs.map(d => {
    const j = { id: d.id, ...d.data() };
    jobById[j.id] = j;
    return j;
  });
  DB.works = wagesSnap.docs.map(d => {
    const wg = d.data();
    const job = jobById[wg.jobId] || {};
    return {
      id: d.id, jobId: wg.jobId,
      site: job.site || '(삭제된 현장)', address: job.address, contact: job.contact, phone: job.phone, memo: job.memo, color: job.color,
      jobCreatedBy: job.createdBy,
      dates: wg.dates, unit: wg.unit, wage: wg.wage, isPaid: wg.isPaid,
      ownerUid: wg.ownerUid || wg.createdBy, createdBy: wg.createdBy
    };
  });
  DB.payments = paysSnap.docs.map(d => {
    const p = d.data();
    return { id: d.id, date: p.date, amount: p.amount, note: p.note, createdBy: p.createdBy, workId: p.wageId };
  });
  DB.notifications = notifSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  teamMembers = membersSnap.docs.map(d => d.data()).sort((a, b) => (a.role === 'leader' ? -1 : b.role === 'leader' ? 1 : 0));
  teamMemberExits = [];
  if (isLeader) {
    try {
      const exitsSnap = await t.collection('memberExits').get();
      teamMemberExits = exitsSnap.docs.map(d => {
        const data = d.data();
        // 구 형식: doc id = uid, uid 필드 없음 / 신규 형식: uid 필드 있음
        return { ...data, uid: data.uid || d.id, docId: d.id };
      });
    } catch(e) { console.warn('memberExits 로드 실패:', e.message); }
  }
  // 팀 기록과 함께 개인 날일 기록 + 정산도 로드 (isPersonal: true 태그로 구분)
  try {
    const [personalWorksSnap, personalPaysSnap] = await Promise.all([
      fsdb.collection('users').doc(myUid).collection('works').get(),
      fsdb.collection('users').doc(myUid).collection('payments').get()
    ]);
    if (!personalWorksSnap.empty) {
      const personalWorks = personalWorksSnap.docs.map(d => ({ ...d.data(), isPersonal: true }));
      DB.works = [...DB.works, ...personalWorks];
    }
    if (!personalPaysSnap.empty) {
      const personalPays = personalPaysSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      DB.payments = [...DB.payments, ...personalPays];
    }
  } catch(e) { console.warn('개인 날일 기록 로드 오류:', e.message); }
  updateNotifBadge();
  startNotifListener(activeTeamId);
}

function memberName(uid) {
  if (currentUser && uid === currentUser.uid) return '나';
  const m = teamMembers.find(x => x.uid === uid);
  return m ? (m.displayName || '이름 없음') : '팀원';
}

// 팀장이 팀원에게 지급해야 하는 기록 여부 (지급 관점 vs 수령 관점 분기 핵심)
function isPayOut(w) {
  return dataMode === 'team' && teamRole === 'leader' && !w.isPersonal;
}

// 현장 상태: 예정(전체 날짜가 미래) > 진행 중
function getWorkStatus(w) {
  const today = todayStr();
  if ((w.dates||[]).length > 0 && (w.dates||[]).every(d => d > today)) return 'planned';
  return 'active';
}

// 기록/정산/통계 탭 공통 뱃지 — 팀 모드에서만 표시
function workTypeBadge(w) {
  if (dataMode !== 'team') return '';
  const base = 'font-size:10px;font-weight:700;border-radius:4px;padding:1px 7px;margin-left:6px;vertical-align:middle;display:inline-block';
  if (w.isPersonal) {
    return `<span style="${base};background:rgba(52,199,89,.15);color:#34C759">개인</span>`;
  }
  const name = memberName(w.ownerUid || w.createdBy);
  return `<span style="${base};background:#e8f0fe;color:#3b5bdb">팀</span><span style="font-size:10px;font-weight:600;color:var(--muted);margin-left:4px;vertical-align:middle">${name}</span>`;
}

async function loadData() {
  try {
    const userRef = fsdb.collection('users').doc(currentUser.uid);
    const userDoc = await userRef.get();
    // 닉네임 로드 — customName 우선, 없으면 구글 이름으로 초기화
    const savedName = userDoc.exists ? userDoc.data().customName : null;
    if (savedName) {
      userDisplayName = savedName;
    } else {
      userDisplayName = currentUser.displayName || '';
      if (userDisplayName) userRef.set({ customName: userDisplayName }, { merge: true });
    }
    const teamId = userDoc.exists ? userDoc.data().teamId : null;

    if (teamId) {
      dataMode = 'team';
      activeTeamId = teamId;
      const memberDoc = await teamRef().collection('members').doc(currentUser.uid).get();
      if (memberDoc.exists) {
        teamRole = memberDoc.data().role;
        const teamDoc = await teamRef().get();
        teamInfo = teamDoc.exists ? teamDoc.data() : null;

        // 팀이 해체된 경우 → 본인 기록 개인으로 이관 후 개인 모드 복귀
        if (teamInfo && teamInfo.disbanded) {
          await migrateFromDisbandedTeam(userRef, teamDoc);
          dataMode = 'personal'; activeTeamId = null; teamRole = null; teamInfo = null; DB.jobs = []; DB.notifications = [];
          await loadPersonalData(userRef);
          showToast('팀이 해체되어 기록이 개인으로 이관되었습니다.');
        } else {
          await loadTeamData();
          localStorage.setItem('moksujilji2', JSON.stringify(DB));
        }
      } else {
        // 팀장에 의해 강제 퇴출됨 → memberExits 패키지 확인 후 개인 이관
        try {
          // 신규 형식(uid 필드 쿼리) + 구 형식(doc id = uid) 둘 다 처리
          const [newExits, oldExit] = await Promise.all([
            teamRef().collection('memberExits').where('uid', '==', currentUser.uid).get(),
            teamRef().collection('memberExits').doc(currentUser.uid).get()
          ]);
          const exitDocs = [...newExits.docs, ...(oldExit.exists && !oldExit.data().uid ? [oldExit] : [])];
          if (exitDocs.length > 0) {
            const allWorks = exitDocs.flatMap(d => d.data().works || []);
            const allPays = exitDocs.flatMap(d => d.data().payments || []);
            if (allWorks.length > 0 || allPays.length > 0) {
              const batch = fsdb.batch();
              allWorks.forEach(w => batch.set(userRef.collection('works').doc(w.id), w));
              allPays.forEach(p => batch.set(userRef.collection('payments').doc(p.id), p));
              await batch.commit();
            }
            const delBatch = fsdb.batch();
            exitDocs.forEach(d => delBatch.delete(d.ref));
            await delBatch.commit();
          }
        } catch(e) { console.warn('퇴출 이관 처리 오류:', e.message); }
        await userRef.update({ teamId: firebase.firestore.FieldValue.delete() });
        dataMode = 'personal'; activeTeamId = null; teamRole = null; teamInfo = null; DB.jobs = []; DB.notifications = [];
        await loadPersonalData(userRef);
        showToast('팀에서 내보내졌습니다. 작업 기록은 개인 기록으로 이관되었어요.');
      }
    } else {
      // teamId 없음 — 가입 신청 대기 중인지 확인
      const pTeamId = userDoc.exists ? userDoc.data().pendingTeamId : null;
      if (pTeamId) {
        try {
          const reqDoc = await fsdb.collection('teams').doc(pTeamId).collection('joinRequests').doc(currentUser.uid).get();
          if (reqDoc.exists && reqDoc.data().status === 'approved') {
            // 팀장이 승인함 → teamId 설정하고 팀 모드로 진입
            await userRef.update({ teamId: pTeamId, pendingTeamId: firebase.firestore.FieldValue.delete() });
            activeTeamId = pTeamId; dataMode = 'team';
            const teamDoc = await teamRef().get();
            teamInfo = teamDoc.exists ? teamDoc.data() : null;
            const memberDoc2 = await teamRef().collection('members').doc(currentUser.uid).get();
            teamRole = memberDoc2.exists ? memberDoc2.data().role : 'member';
            await loadTeamData();
            localStorage.setItem('moksujilji2', JSON.stringify(DB));
            showTeamWelcome();
          } else if (reqDoc.exists && reqDoc.data().status === 'rejected') {
            // 거절됨
            await userRef.update({ pendingTeamId: firebase.firestore.FieldValue.delete() });
            pendingTeamId = null; pendingTeamName = '';
            dataMode = 'personal'; activeTeamId = null; DB.jobs = []; DB.notifications = [];
            await loadPersonalData(userRef);
            showToast('팀 가입 신청이 거절되었습니다.');
          } else {
            // 아직 대기 중
            const tDoc = await fsdb.collection('teams').doc(pTeamId).get();
            pendingTeamId = pTeamId;
            pendingTeamName = tDoc.exists ? (tDoc.data().name || '') : '';
            dataMode = 'pending';
            activeTeamId = null; DB.jobs = []; DB.notifications = [];
            await loadPersonalData(userRef);
            startPendingListener(pTeamId);
          }
        } catch(e) {
          console.warn('가입 신청 상태 확인 오류:', e.message);
          dataMode = 'personal'; activeTeamId = null; DB.jobs = []; DB.notifications = [];
          await loadPersonalData(userRef);
        }
      } else {
        dataMode = 'personal'; activeTeamId = null; teamRole = null; teamInfo = null; DB.jobs = []; DB.notifications = [];
        await loadPersonalData(userRef);
      }
    }
  } catch(e) {
    console.error('데이터 로드 오류:', e);
    const local = localStorage.getItem('moksujilji2');
    if (local) {
      const parsed = JSON.parse(local);
      DB = { works: parsed.works||[], payments: parsed.payments||[], jobs: parsed.jobs||[], notifications: parsed.notifications||[], dailyNotes: parsed.dailyNotes||{} };
    }
  }
  updateHeader();
  renderCal();
  setTimeout(showOnboard, 600);
}

async function migrateFromDisbandedTeam(userRef, teamDoc) {
  const myUid = currentUser.uid;
  const tName = teamDoc.data().name || '(해체된 팀)';
  const t = teamRef();
  // jobs는 visibility 필터 쿼리로 분리 (private job 있으면 전체 쿼리 실패)
  const [jobsAll, jobsSel, wagesSnap, paysSnap] = await Promise.all([
    t.collection('jobs').where('visibility', '==', 'all').get(),
    t.collection('jobs').where('visibility', '==', 'selected').where('sharedWith', 'array-contains', myUid).get(),
    t.collection('wages').where('ownerUid', '==', myUid).get(),
    t.collection('payments').where('createdBy', '==', myUid).get()
  ]);
  const jobById = {};
  [...jobsAll.docs, ...jobsSel.docs].forEach(d => { jobById[d.id] = d.data(); });
  if (wagesSnap.docs.length === 0 && paysSnap.docs.length === 0) {
    await userRef.update({ teamId: firebase.firestore.FieldValue.delete() });
    return;
  }
  const batch = fsdb.batch();
  wagesSnap.docs.forEach(d => {
    const wg = d.data(); const job = jobById[wg.jobId] || {};
    batch.set(userRef.collection('works').doc(d.id), {
      id: d.id, jobId: wg.jobId,
      site: job.site || '(팀 현장)', address: job.address || '',
      contact: job.contact || '', phone: job.phone || '',
      memo: job.memo || '', color: job.color || '#007AFF',
      dates: wg.dates || [], unit: wg.unit || 1,
      wage: wg.wage, isPaid: wg.isPaid || false,
      createdBy: wg.createdBy, teamName: tName
    });
  });
  paysSnap.docs.forEach(d => {
    const p = d.data();
    batch.set(userRef.collection('payments').doc(d.id), {
      id: d.id, date: p.date, amount: p.amount,
      note: p.note || '', workId: p.wageId || '',
      createdBy: p.createdBy
    });
  });
  batch.update(userRef, { teamId: firebase.firestore.FieldValue.delete() });
  await batch.commit();
}

async function loadPersonalData(userRef) {
  const ref = userRef || fsdb.collection('users').doc(currentUser.uid);
  const [worksSnap, paysSnap, notesSnap] = await Promise.all([
    ref.collection('works').get(),
    ref.collection('payments').get(),
    ref.collection('dailyNotes').get()
  ]);
  DB.dailyNotes = {};
  notesSnap.docs.forEach(d => { if(d.data().text) DB.dailyNotes[d.id] = d.data().text; });

  if (!worksSnap.empty || !paysSnap.empty) {
    // 서브컬렉션 방식으로 로드
    DB.works = worksSnap.docs.map(d => d.data());
    DB.payments = paysSnap.docs.map(d => d.data());
    localStorage.setItem('moksujilji2', JSON.stringify(DB));
  } else {
    // 기존 단일문서 방식 → 서브컬렉션으로 마이그레이션
    const oldDoc = await ref.get();
    if (oldDoc.exists && (oldDoc.data().works || oldDoc.data().payments)) {
      const old = oldDoc.data();
      DB.works = old.works || [];
      DB.payments = old.payments || [];
      await save(); // 서브컬렉션에 저장
      await ref.update({ // 구 데이터 정리
        works: firebase.firestore.FieldValue.delete(),
        payments: firebase.firestore.FieldValue.delete()
      });
    } else {
      // 로컬 데이터 마이그레이션 (최초 로그인)
      const local = localStorage.getItem('moksujilji2');
      if (local) { DB = JSON.parse(local); await save(); }
    }
  }
}

// ── 팀 관리 ──
async function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 혼동되는 0/O, 1/I 제외
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const doc = await fsdb.collection('inviteCodes').doc(code).get();
    if (!doc.exists) return code;
  }
  throw new Error('CODE_GEN_FAILED');
}

async function migrateToTeam(teamDoc) {
  if (DB.works.length === 0) return;
  // jobs 먼저 커밋 (wages 규칙이 exists(jobs/{id})를 체크하므로 같은 batch 금지)
  for (let i = 0; i < DB.works.length; i += 450) {
    const batch = fsdb.batch();
    DB.works.slice(i, i + 450).forEach(w => {
      const { wage, isPaid, unit, dates, teamName, ...jobFields } = w;
      batch.set(teamDoc.collection('jobs').doc(w.id), { ...jobFields, createdBy: currentUser.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit();
  }
  // jobs 커밋 완료 후 wages 커밋
  for (let i = 0; i < DB.works.length; i += 450) {
    const batch = fsdb.batch();
    DB.works.slice(i, i + 450).forEach(w => {
      const { wage, isPaid, unit, dates } = w;
      batch.set(teamDoc.collection('wages').doc(w.id), { jobId: w.id, dates, unit, wage, isPaid, ownerUid: currentUser.uid, createdBy: currentUser.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit();
  }
  for (let i = 0; i < DB.payments.length; i += 450) {
    const batch = fsdb.batch();
    DB.payments.slice(i, i + 450).forEach(p => {
      const { workId, ...rest } = p;
      batch.set(teamDoc.collection('payments').doc(p.id), { ...rest, wageId: workId, createdBy: currentUser.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit();
  }
}

async function createTeam() {
  const name = document.getElementById('inTeamName').value.trim();
  if (!name) { alert('팀 이름을 입력해주세요.'); return; }
  const btn = document.getElementById('teamCreateBtn');
  btn.disabled = true;
  try {
    const userRef = fsdb.collection('users').doc(currentUser.uid);
    const teamId = fsdb.collection('teams').doc().id;

    await fsdb.runTransaction(async tx => {
      const userDoc = await tx.get(userRef);
      if (userDoc.exists && userDoc.data().teamId) throw new Error('ALREADY_IN_TEAM');
      tx.set(userRef, { teamId }, { merge: true });
    });

    try {
      const code = await generateInviteCode();
      const teamDoc = fsdb.collection('teams').doc(teamId);
      await teamDoc.set({
        name, leaderUid: currentUser.uid, tradeType: '',
        memberCount: 1, maxMembers: 3, plan: 'free',
        inviteCode: code, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: currentUser.uid
      });
      await teamDoc.collection('members').doc(currentUser.uid).set({
        uid: currentUser.uid, role: 'leader',
        displayName: userDisplayName || currentUser.displayName || '', photoURL: currentUser.photoURL || '',
        joinedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await fsdb.collection('inviteCodes').doc(code).set({
        teamId, createdAt: firebase.firestore.FieldValue.serverTimestamp(), active: true
      });
      closeOv('teamCreateOv');
      document.getElementById('inTeamName').value = '';
      alert(`팀이 생성됐어요!\n초대 코드: ${code}\n\n페이지를 새로고침합니다.`);
      location.reload();
    } catch (innerErr) {
      console.error('팀 생성 중 오류:', innerErr);
      await userRef.update({ teamId: firebase.firestore.FieldValue.delete() }).catch(() => {});
      alert(`팀 생성 중 오류가 발생했습니다.\n${innerErr.code || ''} ${innerErr.message || innerErr}`);
    }
  } catch (e) {
    if (e.message === 'ALREADY_IN_TEAM') alert('이미 팀에 속해 있습니다.');
    else { console.error(e); alert(`팀 생성 중 오류가 발생했습니다.\n${e.code || ''} ${e.message || e}`); }
  } finally {
    btn.disabled = false;
  }
}

async function joinTeamByCode() {
  const code = document.getElementById('inJoinCode').value.trim().toUpperCase();
  if (!code) { alert('초대 코드를 입력해주세요.'); return; }
  const msg = document.getElementById('inJoinMessage').value.trim();
  const btn = document.getElementById('teamJoinBtn');
  btn.disabled = true;
  try {
    const userRef = fsdb.collection('users').doc(currentUser.uid);
    const userDoc = await userRef.get();
    if (userDoc.exists && userDoc.data().teamId) throw new Error('ALREADY_IN_TEAM');
    if (userDoc.exists && userDoc.data().pendingTeamId) throw new Error('ALREADY_PENDING');

    const codeDoc = await fsdb.collection('inviteCodes').doc(code).get();
    if (!codeDoc.exists || codeDoc.data().active === false) throw new Error('INVALID_CODE');
    const tId = codeDoc.data().teamId;

    const tDoc = await fsdb.collection('teams').doc(tId).get();
    if (!tDoc.exists) throw new Error('INVALID_CODE');
    const tData = tDoc.data();
    if (tData.memberCount >= tData.maxMembers) throw new Error('TEAM_FULL');
    if (tData.disbanded) throw new Error('INVALID_CODE');

    const memberDoc = await fsdb.collection('teams').doc(tId).collection('members').doc(currentUser.uid).get();
    if (memberDoc.exists) throw new Error('ALREADY_MEMBER');

    // 직접 합류 대신 가입 신청서 생성
    await fsdb.collection('teams').doc(tId).collection('joinRequests').doc(currentUser.uid).set({
      uid: currentUser.uid,
      displayName: userDisplayName || currentUser.displayName || '',
      photoURL: currentUser.photoURL || '',
      message: msg,
      status: 'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await userRef.set({ pendingTeamId: tId }, { merge: true });

    closeOv('teamJoinOv');
    document.getElementById('inJoinCode').value = '';
    document.getElementById('inJoinMessage').value = '';
    alert(`가입 신청이 완료되었어요!\n팀장이 승인하면 팀에 합류됩니다.`);
    location.reload();
  } catch (e) {
    const msgs = {
      ALREADY_IN_TEAM: '이미 팀에 속해 있습니다.',
      ALREADY_PENDING: '이미 가입 신청 중인 팀이 있습니다.',
      INVALID_CODE: '유효하지 않은 초대 코드입니다.',
      TEAM_FULL: '팀 정원이 가득 찼습니다.',
      ALREADY_MEMBER: '이미 이 팀의 멤버입니다.'
    };
    alert(msgs[e.message] || `신청 중 오류가 발생했습니다.\n${e.code || ''} ${e.message || e}`);
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

async function loadJoinRequests() {
  if (!activeTeamId || teamRole !== 'leader') return;
  try {
    const snap = await teamRef().collection('joinRequests').where('status', '==', 'pending').get();
    joinRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e) { console.warn('가입 신청 로드 실패:', e.message); joinRequests = []; }
}

function openTeamRequestsOv() {
  openOv('teamRequestsOv');
  renderJoinRequestList();
}

function renderJoinRequestList() {
  const wrap = document.getElementById('joinRequestList');
  if (!wrap) return;
  if (joinRequests.length === 0) {
    wrap.innerHTML = '<div style="text-align:center;color:var(--muted);padding:24px 0;font-size:14px">대기 중인 가입 신청이 없어요</div>';
    return;
  }
  wrap.innerHTML = joinRequests.map(r => `
    <div class="set-item" style="align-items:flex-start;gap:10px">
      ${r.photoURL
        ? `<img class="set-avatar" style="width:40px;height:40px;flex-shrink:0" src="${r.photoURL}" onerror="this.style.display='none'">`
        : `<div class="set-avatar" style="width:40px;height:40px;flex-shrink:0;background:var(--pri);display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff">👤</div>`}
      <div class="set-text" style="flex:1">
        <div class="set-item-lbl">${r.displayName || '이름 없음'}</div>
        ${r.message ? `<div class="set-item-sub" style="white-space:pre-wrap">"${r.message}"</div>` : '<div class="set-item-sub" style="color:var(--muted)">메시지 없음</div>'}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
        <button class="btn-pri" style="width:auto;padding:6px 14px;font-size:13px" onclick="approveJoinRequest('${r.id}')">승인</button>
        <button class="btn-out" style="width:auto;padding:6px 14px;font-size:13px;color:var(--red);border-color:var(--red)" onclick="rejectJoinRequest('${r.id}')">거절</button>
      </div>
    </div>`).join('');
}

async function approveJoinRequest(uid) {
  if (teamRole !== 'leader') return;
  const req = joinRequests.find(r => r.id === uid);
  if (!req) return;
  if (teamInfo.memberCount >= teamInfo.maxMembers) { alert('팀 정원이 가득 찼습니다.'); return; }
  try {
    const t = teamRef();
    const batch = fsdb.batch();
    // 멤버 문서 생성
    batch.set(t.collection('members').doc(uid), {
      uid, role: 'member',
      displayName: req.displayName || '', photoURL: req.photoURL || '',
      joinedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    // 카운트 증가
    batch.update(t, { memberCount: firebase.firestore.FieldValue.increment(1) });
    // 신청 상태 갱신
    batch.update(t.collection('joinRequests').doc(uid), { status: 'approved', respondedAt: firebase.firestore.FieldValue.serverTimestamp() });
    await batch.commit();
    teamInfo.memberCount = (teamInfo.memberCount || 0) + 1;
    joinRequests = joinRequests.filter(r => r.id !== uid);
    renderJoinRequestList();
    renderTeamSettings();
    showToast(`${req.displayName || '팀원'} 승인 완료`);
  } catch(e) { console.error(e); alert('승인에 실패했습니다.\n' + e.message); }
}

async function rejectJoinRequest(uid) {
  if (teamRole !== 'leader') return;
  const req = joinRequests.find(r => r.id === uid);
  if (!req) return;
  if (!confirm(`${req.displayName || '신청자'}의 가입 신청을 거절할까요?`)) return;
  try {
    await teamRef().collection('joinRequests').doc(uid).update({
      status: 'rejected', respondedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    joinRequests = joinRequests.filter(r => r.id !== uid);
    renderJoinRequestList();
    renderTeamSettings();
    showToast('가입 신청을 거절했습니다.');
  } catch(e) { console.error(e); alert('거절에 실패했습니다.\n' + e.message); }
}

function startPendingListener(teamId) {
  if (_pendingListener) { _pendingListener(); _pendingListener = null; }
  if (!currentUser || !teamId) return;
  _pendingListener = fsdb.collection('teams').doc(teamId)
    .collection('joinRequests').doc(currentUser.uid)
    .onSnapshot(async (doc) => {
      if (!doc.exists) return;
      const status = doc.data().status;
      if (status === 'approved') {
        stopPendingListener();
        const userRef = fsdb.collection('users').doc(currentUser.uid);
        await userRef.update({ teamId, pendingTeamId: firebase.firestore.FieldValue.delete() });
        activeTeamId = teamId; dataMode = 'team';
        const teamDoc = await fsdb.collection('teams').doc(teamId).get();
        teamInfo = teamDoc.exists ? teamDoc.data() : null;
        const memberDoc = await fsdb.collection('teams').doc(teamId).collection('members').doc(currentUser.uid).get();
        teamRole = memberDoc.exists ? memberDoc.data().role : 'member';
        await loadTeamData();
        localStorage.setItem('moksujilji2', JSON.stringify(DB));
        updateHeader();
        renderTeamSettings();
        showTeamWelcome();
      } else if (status === 'rejected') {
        stopPendingListener();
        const userRef = fsdb.collection('users').doc(currentUser.uid);
        await userRef.update({ pendingTeamId: firebase.firestore.FieldValue.delete() });
        pendingTeamId = null; pendingTeamName = '';
        dataMode = 'personal'; activeTeamId = null; DB.jobs = []; DB.notifications = [];
        await loadPersonalData(fsdb.collection('users').doc(currentUser.uid));
        renderTeamSettings();
        showToast('팀 가입 신청이 거절되었습니다.');
      }
    }, (e) => console.error('가입 신청 감지 오류:', e));
}

function stopPendingListener() {
  if (_pendingListener) { _pendingListener(); _pendingListener = null; }
}

function startNotifListener(teamId) {
  if (_notifListener) { _notifListener(); _notifListener = null; }
  if (!currentUser || !teamId) return;
  try {
    _notifListener = fsdb.collection('teams').doc(teamId)
      .collection('notifications')
      .where('toUid', '==', currentUser.uid)
      .onSnapshot(snap => {
        if (dataMode !== 'team') return;
        DB.notifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        updateNotifBadge();
        renderNotifPanel();
      }, e => console.warn('알림 실시간 수신 오류:', e.message));
  } catch(e) { console.warn('알림 리스너 시작 오류:', e.message); }
}

function stopNotifListener() {
  if (_notifListener) { _notifListener(); _notifListener = null; }
}

async function cancelJoinRequest() {
  if (!confirm('팀 가입 신청을 취소할까요?')) return;
  try {
    const userRef = fsdb.collection('users').doc(currentUser.uid);
    const userDoc = await userRef.get();
    const pTeamId = userDoc.exists ? userDoc.data().pendingTeamId : null;
    if (pTeamId) {
      try {
        await fsdb.collection('teams').doc(pTeamId).collection('joinRequests').doc(currentUser.uid).delete();
      } catch(e) { console.warn('신청서 삭제 실패:', e.message); }
    }
    stopPendingListener();
    await userRef.update({ pendingTeamId: firebase.firestore.FieldValue.delete() });
    pendingTeamId = null; pendingTeamName = '';
    dataMode = 'personal';
    renderTeamSettings();
    showToast('가입 신청을 취소했습니다.');
  } catch(e) { console.error(e); alert('신청 취소에 실패했습니다.'); }
}

async function rotateInviteCode() {
  if (teamRole !== 'leader') return;
  if (!confirm('초대 코드를 재발급하면 기존 코드는 더 이상 사용할 수 없어요. 계속할까요?')) return;
  try {
    const oldCode = teamInfo.inviteCode;
    const newCode = await generateInviteCode();
    const batch = fsdb.batch();
    batch.set(fsdb.collection('inviteCodes').doc(newCode), {
      teamId: activeTeamId, createdAt: firebase.firestore.FieldValue.serverTimestamp(), active: true
    });
    if (oldCode) batch.update(fsdb.collection('inviteCodes').doc(oldCode), { active: false });
    batch.update(teamRef(), { inviteCode: newCode });
    await batch.commit();
    teamInfo.inviteCode = newCode;
    renderTeamSettings();
  } catch (e) { console.error(e); alert('코드 재발급에 실패했습니다.'); }
}

async function renameTeam() {
  if (teamRole !== 'leader') return;
  const newName = prompt('새 팀 이름을 입력하세요', teamInfo.name || '');
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed) { alert('팀 이름을 입력해주세요.'); return; }
  if (trimmed === teamInfo.name) return;
  try {
    await teamRef().update({ name: trimmed });
    teamInfo.name = trimmed;
    updateHeader();
    renderTeamSettings();
    const titleEl = document.getElementById('teamMembersTitle');
    if (titleEl) titleEl.textContent = trimmed;
    showToast('팀 이름이 변경되었습니다.');
  } catch(e) { console.error(e); alert('팀 이름 변경에 실패했습니다.'); }
}

async function deleteTeam() {
  if (teamRole !== 'leader') return;
  if (!confirm('팀을 해체하면 팀이 닫히고,\n기록은 각자 개인으로 이관됩니다.\n계속할까요?')) return;
  try {
    const t = teamRef();
    const myUid = currentUser.uid;
    const tName = teamInfo.name;
    const userRef = fsdb.collection('users').doc(myUid);

    // jobs 맵 구성 (이관 시 site 정보 결합용)
    const [jobsSnap, wagesSnap, paysSnap] = await Promise.all([
      t.collection('jobs').get(),
      t.collection('wages').where('ownerUid', '==', myUid).get(),
      t.collection('payments').where('createdBy', '==', myUid).get()
    ]);
    const jobById = {};
    jobsSnap.docs.forEach(d => { jobById[d.id] = d.data(); });

    // 팀장 본인 wages+payments → users/{uid}/works+payments 이관
    if (wagesSnap.docs.length > 0 || paysSnap.docs.length > 0) {
      const batch = fsdb.batch();
      wagesSnap.docs.forEach(d => {
        const wg = d.data(); const job = jobById[wg.jobId] || {};
        batch.set(userRef.collection('works').doc(d.id), {
          id: d.id, jobId: wg.jobId,
          site: job.site || '(팀 현장)', address: job.address || '',
          contact: job.contact || '', phone: job.phone || '',
          memo: job.memo || '', color: job.color || '#007AFF',
          dates: wg.dates || [], unit: wg.unit || 1,
          wage: wg.wage, isPaid: wg.isPaid || false,
          createdBy: wg.createdBy, teamName: tName
        });
      });
      paysSnap.docs.forEach(d => {
        const p = d.data();
        batch.set(userRef.collection('payments').doc(d.id), {
          id: d.id, date: p.date, amount: p.amount,
          note: p.note || '', workId: p.wageId || '',
          createdBy: p.createdBy
        });
      });
      await batch.commit();
    }

    // disbanded 표시 + 초대코드 비활성화 + 팀장 teamId 제거
    const batch2 = fsdb.batch();
    batch2.update(t, { disbanded: true, disbandedAt: firebase.firestore.FieldValue.serverTimestamp() });
    if (teamInfo.inviteCode) {
      batch2.update(fsdb.collection('inviteCodes').doc(teamInfo.inviteCode), { active: false });
    }
    batch2.update(userRef, { teamId: firebase.firestore.FieldValue.delete() });
    await batch2.commit();

    activeTeamId = null; teamInfo = null; teamRole = null; teamMembers = [];
    dataMode = 'personal';
    DB = { works: [], payments: [], jobs: [], notifications: [], dailyNotes: {} };
    await loadData();
    renderTeamSettings();
    showToast('팀이 해체되었습니다. 기록이 개인으로 이관되었어요.');
  } catch (e) { console.error(e); alert('팀 해체에 실패했습니다: ' + e.message); }
}

async function loadTeamMembers() {
  if (!activeTeamId) return;
  const snap = await teamRef().collection('members').get();
  teamMembers = snap.docs.map(d => d.data()).sort((a, b) => (a.role === 'leader' ? -1 : b.role === 'leader' ? 1 : 0));
}

function openTeamMembersOv() {
  openOv('teamMembersOv');
  loadTeamMembers().then(renderMemberList);
}

function renderMemberList() {
  const titleEl = document.getElementById('teamMembersTitle');
  const subtitleEl = document.getElementById('teamMembersSubtitle');
  const renameBtn = document.getElementById('teamRenameBtn');
  if (titleEl && teamInfo) titleEl.textContent = teamInfo.name || '팀원 목록';
  if (subtitleEl) subtitleEl.textContent = `팀원 ${teamMembers.length}명`;
  if (renameBtn) renameBtn.style.display = teamRole === 'leader' ? '' : 'none';
  const wrap = document.getElementById('teamMemberList');
  wrap.innerHTML = teamMembers.map(m => `
    <div class="set-item">
      ${m.photoURL
        ? `<img class="set-avatar" style="width:36px;height:36px" src="${m.photoURL}" onerror="this.style.display='none'">`
        : `<div class="set-avatar" style="width:36px;height:36px;background:var(--pri);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff">👤</div>`}
      <div class="set-text">
        <div class="set-item-lbl">${m.displayName || '이름 없음'}${m.role === 'leader' ? ' (팀장)' : ''}</div>
      </div>
      ${(teamRole === 'leader' && m.role !== 'leader')
        ? `<button class="btn-out" style="width:auto;padding:6px 12px;font-size:13px;color:#FF3B30;border-color:#FF3B30" onclick="removeMember('${m.uid}')">내보내기</button>`
        : ''}
    </div>`).join('');
}

async function removeMember(uid) {
  if (teamRole !== 'leader') return;
  if (!confirm('이 팀원을 팀에서 내보낼까요?\n팀원의 작업 기록은 개인 기록으로 이관돼요.')) return;
  try {
    const t = teamRef();
    const tName = teamInfo.name || '';
    // 팀원 wages/payments 수집
    const [wagesSnap, paysSnap, jobsSnap] = await Promise.all([
      t.collection('wages').where('ownerUid', '==', uid).get(),
      t.collection('payments').where('createdBy', '==', uid).get(),
      t.collection('jobs').get()
    ]);
    const jobById = {};
    jobsSnap.docs.forEach(d => { jobById[d.id] = d.data(); });
    // 이관 패키지 생성 (퇴출 팀원이 다음 로그인 시 읽어감)
    const exitWorks = wagesSnap.docs.map(d => {
      const wg = d.data(); const job = jobById[wg.jobId] || {};
      return {
        id: d.id, jobId: wg.jobId,
        site: job.site || '(팀 현장)', address: job.address || '',
        contact: job.contact || '', phone: job.phone || '',
        memo: job.memo || '', color: job.color || '#007AFF',
        dates: wg.dates || [], unit: wg.unit || 1,
        wage: wg.wage, isPaid: wg.isPaid || false,
        createdBy: wg.createdBy, teamName: tName
      };
    });
    const exitPays = paysSnap.docs.map(d => {
      const p = d.data();
      return { id: d.id, date: p.date, amount: p.amount, note: p.note || '', workId: p.wageId || '', createdBy: p.createdBy };
    });
    if (exitWorks.length > 0 || exitPays.length > 0) {
      const exitDocId = `${uid}_${Date.now()}`;
      const exitMember = teamMembers.find(m => m.uid === uid);
      const exitDisplayName = exitMember?.customName || exitMember?.displayName || '';
      await t.collection('memberExits').doc(exitDocId).set({
        uid, displayName: exitDisplayName, works: exitWorks, payments: exitPays,
        exitedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    // 멤버 문서 삭제 + 카운트 감소
    const batch = fsdb.batch();
    batch.delete(t.collection('members').doc(uid));
    batch.update(t, { memberCount: firebase.firestore.FieldValue.increment(-1) });
    await batch.commit();
    teamInfo.memberCount = (teamInfo.memberCount || 1) - 1;
    await loadTeamMembers();
    renderMemberList();
    renderTeamSettings();
  } catch (e) { console.error(e); alert('내보내기에 실패했습니다.\n' + e.message); }
}

function renderTeamSettings() {
  const card = document.getElementById('teamCard');
  if (!card) return;

  // 가입 신청 대기 중
  if (dataMode === 'pending') {
    card.innerHTML = `
      <div class="set-item">
        <div class="set-icon" style="background:rgba(255,149,0,.12)">⏳</div>
        <div class="set-text">
          <div class="set-item-lbl">팀 가입 승인 대기 중</div>
          <div class="set-item-sub">${pendingTeamName ? pendingTeamName + ' · ' : ''}팀장 승인 후 합류됩니다</div>
        </div>
        <button class="btn-out" style="width:auto;padding:6px 12px;font-size:13px;color:var(--red);border-color:var(--red)" onclick="cancelJoinRequest()">취소</button>
      </div>`;
    return;
  }

  // 팀 없음
  if (dataMode !== 'team' || !teamInfo) {
    card.innerHTML = `
      <div class="set-item" style="cursor:pointer" onclick="openOv('teamCreateOv')">
        <div class="set-icon" style="background:rgba(0,122,255,.12)">👥</div>
        <div class="set-text"><div class="set-item-lbl">팀 만들기</div><div class="set-item-sub">팀원들과 현장을 함께 관리해요</div></div>
      </div>
      <div class="set-item" style="cursor:pointer" onclick="openOv('teamJoinOv')">
        <div class="set-icon" style="background:rgba(52,199,89,.12)">🔑</div>
        <div class="set-text"><div class="set-item-lbl">코드로 참여하기</div><div class="set-item-sub">초대 코드를 입력해 팀 가입을 신청해요</div></div>
      </div>`;
    return;
  }

  // 팀 소속
  const reqBadge = joinRequests.length > 0
    ? `<span style="display:inline-flex;align-items:center;justify-content:center;background:var(--red);color:#fff;border-radius:50%;width:18px;height:18px;font-size:11px;font-weight:700;margin-left:4px">${joinRequests.length}</span>`
    : '';
  card.innerHTML = `
    <div class="set-item" style="cursor:pointer" onclick="openTeamMembersOv()">
      <div class="set-icon" style="background:rgba(0,122,255,.12)">👥</div>
      <div class="set-text">
        <div class="set-item-lbl">${teamInfo.name}</div>
        <div class="set-item-sub">${teamRole === 'leader' ? '팀장' : '팀원'} · 멤버 ${teamInfo.memberCount}/${teamInfo.maxMembers}명</div>
      </div>
      <span style="color:var(--muted);font-size:18px">›</span>
    </div>
    ${teamRole === 'leader' ? `
    <div class="set-item" style="cursor:pointer" onclick="openTeamRequestsOv()">
      <div class="set-icon" style="background:rgba(52,199,89,.12)">📋</div>
      <div class="set-text">
        <div class="set-item-lbl">가입 신청 관리${reqBadge}</div>
        <div class="set-item-sub">${joinRequests.length > 0 ? `대기 중인 신청 ${joinRequests.length}건` : '신청 없음'}</div>
      </div>
      <span style="color:var(--muted);font-size:18px">›</span>
    </div>
    <div class="set-item">
      <div class="set-icon" style="background:rgba(255,149,0,.12)">🔢</div>
      <div class="set-text">
        <div class="set-item-lbl">초대 코드</div>
        <div class="set-item-sub" style="font-family:monospace;font-size:15px;letter-spacing:1px">${teamInfo.inviteCode}</div>
      </div>
      <button class="btn-out" style="width:auto;padding:6px 12px;font-size:13px" onclick="rotateInviteCode()">재발급</button>
    </div>
    <div class="set-item" style="cursor:pointer" onclick="deleteTeam()">
      <div class="set-icon" style="background:rgba(255,59,48,.12)">🗑️</div>
      <div class="set-text"><div class="set-item-lbl" style="color:var(--red)">팀 해체</div><div class="set-item-sub">기록은 각자 개인으로 이관돼요</div></div>
    </div>` : ''}`;
}

function doSignOut() {
  if (confirm('로그아웃 하시겠습니까?')) auth.signOut();
}
function todayStr() { const t=new Date(); return ymd(t.getFullYear(), t.getMonth(), t.getDate()); }
function ymd(y,m,d) { return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function parsD(s) { const [y,m,d]=s.split('-').map(Number); return {y,m:m-1,d}; }
function dowN(y,m,d) { return new Date(y,m,d).getDay(); }
function fmtW(n) { return Number(n).toLocaleString('ko-KR')+'원'; }
function fmtDate(s) {
  const {y,m,d}=parsD(s);
  const dow=['일','월','화','수','목','금','토'][dowN(y,m,d)];
  return `${String(m+1).padStart(2,'0')}.${String(d).padStart(2,'0')}(${dow})`;
}
function expAmt(w) { return w.wage==null ? null : (w.dates||[]).length * Number(w.wage) * Number(w.unit || 1); }
function rcvAmt(wId) { return DB.payments.filter(p=>p.workId===wId).reduce((s,p)=>s+Number(p.amount),0); }

function formatDatesShort(dates) {
  if(!dates||dates.length===0) return '';
  const s=[...dates].sort();
  if(s.length===1) return `${fmtDate(s[0])} · 1일`;
  // 연속 구간 분리
  const ranges=[];
  let rs=s[0], re=s[0];
  for(let i=1;i<=s.length;i++){
    if(i<s.length){
      const a=new Date(re+'T00:00:00'), b=new Date(s[i]+'T00:00:00');
      if((b-a)/86400000===1){re=s[i];continue;}
    }
    ranges.push(rs===re?fmtDate(rs):`${fmtDate(rs)}~${fmtDate(re)}`);
    if(i<s.length){rs=s[i];re=s[i];}
  }
  return `${ranges.join(', ')} · ${s.length}일`;
}

// ── 온보딩 ──
const OB_STEPS = [
  {
    icon: '🔨',
    title: '목수 일지에 오신 걸 환영해요',
    desc: '현장 기록부터 정산·통계·팀 관리까지<br>목수 일지 하나로 깔끔하게 정리해드려요'
  },
  {
    icon: '🗓️',
    title: '달력에서 현장을 기록해요',
    desc: '날짜를 탭하면 현장명·날짜·일당을<br>바로 추가할 수 있어요<br><br><span style="display:inline-block;background:rgba(0,122,255,.1);color:var(--pri);border-radius:20px;padding:5px 14px;font-size:13px;font-weight:600">달력 탭에서 + 버튼을 눌러보세요</span>'
  },
  {
    icon: '🧾',
    title: '정산으로 미수금을 관리해요',
    desc: '현장마다 받아야 할 금액과<br>입금 내역을 한눈에 확인하고<br>미수금을 빠짐없이 챙길 수 있어요'
  },
  {
    icon: '📊',
    title: '통계로 수입을 한눈에',
    desc: '월별 작업 일수·품수·수령액을<br>자동으로 집계해드려요<br>연간 흐름도 그래프로 확인할 수 있어요'
  },
  {
    icon: '👥',
    title: '팀으로 함께 관리해요',
    desc: '팀을 만들고 초대 코드를 공유하면<br>팀원이 가입 신청을 해요<br><br>승인 후 팀원 일당 대신 입력,<br>현장 공유, 정산까지 함께 관리할 수 있어요'
  },
];
let obStep = 0;
function showOnboard() {
  if(localStorage.getItem('onboarded_v2')) return;
  obStep = 0; renderOb();
  document.getElementById('obOv').style.display = 'flex';
}
function renderOb() {
  const s = OB_STEPS[obStep];
  document.getElementById('obIcon').textContent = s.icon;
  document.getElementById('obTitle').textContent = s.title;
  document.getElementById('obDesc').innerHTML = s.desc.replace(/\n/g,'<br>');
  document.getElementById('obDots').innerHTML = OB_STEPS.map((_,i)=>`<div class="ob-dot${i===obStep?' on':''}"></div>`).join('');
  document.getElementById('obBtn').textContent = obStep===OB_STEPS.length-1 ? '시작하기 →' : '다음';
}
function onboardNext() {
  if(obStep < OB_STEPS.length-1) { obStep++; renderOb(); }
  else { localStorage.setItem('onboarded_v2','1'); document.getElementById('obOv').style.display='none'; }
}

// ── 탭 ──
function goTab(tab, btn) {
  curTab=tab;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.tbtn').forEach(b=>b.classList.remove('on'));
  document.getElementById('page-'+tab).classList.add('on');
  btn.classList.add('on');
  const titles={cal:'목수 일지',work:'현장',pay:'정산',stat:'통계',set:'설정'};
  document.getElementById('hTit').textContent=titles[tab]||'목수 일지';
  const fab=document.getElementById('fab');
  if(tab==='cal')  { renderCal(); fab.style.display='flex'; fab.onclick=()=>openWorkOv(null,todayStr()); }
  if(tab==='work') { renderWork(); fab.style.display='flex'; fab.onclick=()=>openWorkOv(null,todayStr()); }
  if(tab==='pay')  { renderPay(); fab.style.display='none'; }
  if(tab==='stat') { renderStat(); fab.style.display='none'; }
  if(tab==='set')  { renderSet(); fab.style.display='none'; }
}

// ── 달력 ──
function moveM(d) {
  calM+=d; if(calM>11){calM=0;calY++;} if(calM<0){calM=11;calY--;} renderCal();
}

function renderCal() {
  document.getElementById('calLbl').textContent=`${calY}년 ${calM+1}월`;

  // 예정 현장 제외한 통계 계산
  const allDates=[];
  DB.works.filter(w=>getWorkStatus(w)==='active').forEach(w=>(w.dates||[]).forEach(d=>{const p=parsD(d);if(p.y===calY&&p.m===calM)allDates.push(d);}));
  const workDays=new Set(allDates).size;
  let mWage=0, mUnit=0;
  DB.works.filter(w=>getWorkStatus(w)==='active').forEach(w=>{
    const cnt=(w.dates||[]).filter(d=>{const p=parsD(d);return p.y===calY&&p.m===calM;}).length;
    const u=Number(w.unit||1);
    if(w.wage!=null) mWage+=cnt*Number(w.wage)*u;
    mUnit+=cnt*u;
  });
  const monthWorks=DB.works.filter(w=>getWorkStatus(w)==='active'&&(w.dates||[]).some(d=>{const p=parsD(d);return p.y===calY&&p.m===calM;}));
  const mUnpaid=monthWorks.filter(w=>w.wage!=null&&!w.isPaid).reduce((s,w)=>s+Math.max(0,expAmt(w)-rcvAmt(w.id)),0);
  const mUnitStr=mUnit%1===0?mUnit:mUnit.toFixed(1);

  document.getElementById('calSum').innerHTML=`
    <div class="cs-item"><div class="cv">${workDays}일</div><div class="cl">작업일수</div></div>
    <div class="cs-item"><div class="cv">${mUnitStr}품</div><div class="cl">품</div></div>
    <div class="cs-item"><div class="cv">${(mWage/10000).toFixed(0)}만원</div><div class="cl">총 일당</div></div>
    <div class="cs-item"><div class="cv">${(mUnpaid/10000).toFixed(0)}만원</div><div class="cl">미수금</div></div>
  `;

  // 연속 날짜 구간별 바 계산 (예정/완료 포함, status 구분)
  const bars=[];
  DB.works.forEach(w=>{
    const md=(w.dates||[]).filter(d=>{const p=parsD(d);return p.y===calY&&p.m===calM;}).sort();
    if(!md.length) return;
    const wStatus=getWorkStatus(w);
    let rs=md[0], re=md[0];
    for(let i=1;i<=md.length;i++){
      if(i<md.length){
        const a=new Date(re+'T00:00:00'), b=new Date(md[i]+'T00:00:00');
        if((b-a)/86400000===1){re=md[i];continue;}
      }
      bars.push({site:w.site,color:w.color||'orange',startDs:rs,endDs:re,status:wStatus,ownerUid:w.ownerUid||w.createdBy,isPersonal:w.isPersonal});
      if(i<md.length){rs=md[i];re=md[i];}
    }
  });

  const firstDow=new Date(calY,calM,1).getDay();
  const dim=new Date(calY,calM+1,0).getDate();
  const diPrev=new Date(calY,calM,0).getDate();
  const todStr=todayStr();

  // 전체 셀 목록 구성
  const cells=[];
  for(let i=firstDow-1;i>=0;i--) cells.push({d:diPrev-i,ds:null,other:true});
  for(let d=1;d<=dim;d++) cells.push({d,ds:ymd(calY,calM,d),other:false});
  const rem=cells.length%7===0?0:7-cells.length%7;
  for(let d=1;d<=rem;d++) cells.push({d,ds:null,other:true});

  let html='';
  for(let w=0;w<cells.length/7;w++){
    const wk=cells.slice(w*7,w*7+7);

    // 날짜 숫자 행
    html+='<div class="cal-week"><div class="cal-dates">';
    wk.forEach(cell=>{
      if(cell.other){
        html+=`<div class="ccell other"><span class="dnum">${cell.d}</span></div>`;
      } else {
        const wd=dowN(calY,calM,cell.d);
        const holi=getHoli(cell.ds);
        let cls='ccell';
        if(cell.ds===todStr)cls+=' today';
        if(wd===0)cls+=' sunday';
        if(wd===6)cls+=' saturday';
        if(holi)cls+=' holiday';
        html+=`<div class="${cls}" onclick="openDayOv('${cell.ds}')"><span class="dnum">${cell.d}</span>${holi?`<div class="holi">${holi}</div>`:''}${DB.dailyNotes[cell.ds]?'<div class="note-dot"></div>':''}</div>`;
      }
    });
    html+='</div>';

    // 이 주에 해당하는 이벤트 바 계산
    const wkBars=[];
    bars.forEach(bar=>{
      let cs=-1,ce=-1;
      wk.forEach((cell,idx)=>{
        if(!cell.ds) return;
        if(cell.ds>=bar.startDs&&cell.ds<=bar.endDs){
          if(cs===-1)cs=idx;
          ce=idx;
        }
      });
      if(cs===-1) return;
      wkBars.push({site:bar.site,color:bar.color,colStart:cs,colSpan:ce-cs+1,clickDs:wk[cs].ds,status:bar.status,ownerUid:bar.ownerUid,isPersonal:bar.isPersonal});
    });

    if(wkBars.length){
      html+='<div class="cal-events">';
      wkBars.forEach(bar=>{
        const c=getColor(bar.color);
        const isPlanned=bar.status==='planned';
        const planStyle=isPlanned?`;opacity:0.6;border-left-style:dashed;background:transparent;border:1.5px dashed ${c.border};color:${c.border}`:'';
        const isOthers=dataMode==='team'&&teamRole==='leader'&&!bar.isPersonal&&bar.ownerUid&&bar.ownerUid!==currentUser.uid;
        const ownerLabel=isOthers?` · ${memberName(bar.ownerUid)}`:'';
        const othersStyle=isOthers?';opacity:0.75;border-left-style:dashed':'';
        html+=`<div class="cbar" style="grid-column:${bar.colStart+1}/span ${bar.colSpan};background:${c.bg};border-left-color:${c.border};color:${c.border}${planStyle}${othersStyle}" onclick="openDayOv('${bar.clickDs}')">${bar.site}${ownerLabel}${isPlanned?' 예정':''}</div>`;
      });
      html+='</div>';
    }

    // 주간 수입 합계 (예정·팀원 인건비 제외, 설정 켜진 경우만)
    if(showWeekSum){
      const wkWage=DB.works.filter(w=>getWorkStatus(w)==='active'&&w.wage!=null&&!isPayOut(w)).reduce((s,w)=>{
        const cnt=(w.dates||[]).filter(d=>wk.some(cell=>cell.ds&&cell.ds===d)).length;
        return s+cnt*Number(w.wage)*Number(w.unit||1);
      },0);
      if(wkWage>0) html+=`<div class="cal-wsum"><span class="cal-wsum-lbl">주간</span><span class="cal-wsum-val">${(wkWage/10000).toFixed(0)}만원</span></div>`;
    }

    html+='</div>';
  }

  document.getElementById('calGrid').innerHTML=html;
  const calHint=document.getElementById('calHint');
  if(calHint) calHint.style.display=DB.works.length===0?'':'none';
}

// ── 날짜 모달 ──
function openDayOv(ds) {
  selDate=ds;
  const h=getHoli(ds);
  document.getElementById('dayOvTitle').textContent=fmtDate(ds)+(h?` · ${h}`:'');
  const works=DB.works.filter(w=>(w.dates||[]).includes(ds));
  if(works.length===0){
    document.getElementById('dayOvWorks').innerHTML='<div class="empty" style="padding:16px 0 8px">이 날 작업 기록이 없습니다</div>';
  } else {
    document.getElementById('dayOvWorks').innerHTML=works.map(w=>`
      <div class="dm-work">
        <div class="dm-site">${w.site}${dataMode==='team'&&!w.isPersonal?` <span style="font-size:11px;color:var(--muted);font-weight:500">· ${memberName(w.ownerUid||w.createdBy)}</span>`:''}</div>
        <div class="dm-wage">${w.wage!=null?fmtW(w.wage):'비공개'}</div>
        <button class="dm-edit" onclick="openWorkOv('${w.id}',null)">✏️</button>
      </div>
    `).join('');
  }
  document.getElementById('inDayMemo').value = DB.dailyNotes[ds] || '';
  document.getElementById('dayMemoSaved').style.display = 'none';
  openOv('dayOv');
}

// ── 작업 추가/수정 ──
function openWorkOv(workId, prefillDate) {
  closeAll();
  editDates=[];
  document.getElementById('editWorkId').value=workId||'';
  document.getElementById('workOvTitle').textContent=workId?'작업 수정':'작업 추가';
  let wageEditable=true;
  if(workId){
    const w=DB.works.find(x=>x.id===workId);
    if(w){
      wageEditable=canSeeWage(w);
      document.getElementById('inSite').value=w.site;
      document.getElementById('inWage').value=wageEditable?w.wage:'';
      document.getElementById('inUnit').value=String(w.unit||1);
      editDates=[...w.dates]; editColor=w.color||'orange';
      document.getElementById('inWorkDesc').value=w.workDesc||'';
      document.getElementById('inAddress').value=w.address||'';
      document.getElementById('inContact').value=w.contact||'';
      document.getElementById('inPhone').value=w.phone||'';
      document.getElementById('inMemo').value=w.memo||'';
      toggleInfoSection(!!(w.address||w.contact||w.phone||w.memo));
    }
  } else {
    document.getElementById('inSite').value='';
    document.getElementById('inWorkDesc').value='';
    document.getElementById('inWage').value=defaultWage||'';
    document.getElementById('inUnit').value='1';
    document.getElementById('inAddress').value='';
    document.getElementById('inContact').value='';
    document.getElementById('inPhone').value='';
    document.getElementById('inMemo').value='';
    editColor='orange';
    if(prefillDate) editDates=[prefillDate];
    toggleInfoSection(false);
  }
  document.getElementById('wageFg').style.display=wageEditable?'':'none';
  document.getElementById('wageHiddenNote').style.display=wageEditable?'none':'';
  document.getElementById('siteDropdown').style.display='none';
  // 팀장 전용 UI
  const ownerFg=document.getElementById('ownerFg');
  const memberWagesFg=document.getElementById('memberWagesFg');
  const visFg=document.getElementById('visibilityFg');
  const editingPersonal=workId&&DB.works.find(x=>x.id===workId)?.isPersonal;
  if(dataMode==='team' && teamRole==='leader' && !editingPersonal){
    visFg.style.display='';
    let initVis='all', initShared=[];
    if(workId){
      // 수정 모드: 소유자 이름만 표시, 단일 일당/품수 입력
      ownerFg.style.display=''; memberWagesFg.style.display='none';
      const w=DB.works.find(x=>x.id===workId);
      if(w){
        const om=teamMembers.find(m=>m.uid===(w.ownerUid||w.createdBy));
        document.getElementById('ownerName').textContent=om?(om.uid===currentUser.uid?'나 (팀장)':(om.displayName||'팀원')):'(알 수 없음)';
        const job=DB.jobs.find(j=>j.id===w.jobId);
        if(job){ initVis=job.visibility||'all'; initShared=job.sharedWith||[]; }
      }
    } else {
      // 신규 모드: 팀원 다중 입력, 단일 일당/품수 숨김
      ownerFg.style.display='none'; memberWagesFg.style.display='';
      document.getElementById('wageFg').style.display='none';
      document.getElementById('unitFg').style.display='none';
      renderMemberWageList();
    }
    setVisibility(initVis, initShared);
  } else {
    ownerFg.style.display='none'; memberWagesFg.style.display='none';
    visFg.style.display='none'; document.getElementById('sharedWithFg').style.display='none';
    document.getElementById('wageFg').style.display=wageEditable?'':'none';
    document.getElementById('unitFg').style.display='';
  }
  // 기록 유형 토글 (팀 모드 신규 추가 시에만)
  const recordTypeFg=document.getElementById('recordTypeFg');
  if(dataMode==='team' && !workId){
    recordTypeFg.style.display='';
    workEntryMode='team';
    document.getElementById('btnTeamRec').style.background='var(--card)';
    document.getElementById('btnTeamRec').style.color='var(--text)';
    document.getElementById('btnPersonalRec').style.background='transparent';
    document.getElementById('btnPersonalRec').style.color='var(--muted)';
  } else {
    recordTypeFg.style.display='none';
  }
  renderColorChips();
  renderDateChips();
  openOv('workOv');
}

function renderMemberWageList() {
  const unitOpts=[0.5,1,1.5,2,2.5,3,3.5,4,4.5,5].map(v=>`<option value="${v}"${v===1?' selected':''}>${v}품</option>`).join('');
  document.getElementById('memberWageList').innerHTML=teamMembers.map(m=>`
    <div class="mw-row">
      <label class="mw-check-label">
        <input type="checkbox" class="mw-check" value="${m.uid}" checked>
        <span class="mw-name">${m.uid===currentUser.uid?'나 (팀장)':(m.displayName||'팀원')}</span>
      </label>
      <input type="number" class="mw-wage" placeholder="일당" value="${defaultWage||''}" inputmode="numeric">
      <span style="font-size:11px;color:var(--muted)">원</span>
      <select class="mw-unit">${unitOpts}</select>
    </div>`).join('');
}

function setRecordType(type) {
  workEntryMode = type;
  const isTeam = type === 'team';
  const btnT = document.getElementById('btnTeamRec');
  const btnP = document.getElementById('btnPersonalRec');
  btnT.style.background = isTeam ? 'var(--card)' : 'transparent';
  btnT.style.color = isTeam ? 'var(--text)' : 'var(--muted)';
  btnP.style.background = isTeam ? 'transparent' : 'var(--card)';
  btnP.style.color = isTeam ? 'var(--muted)' : 'var(--text)';
  if (!isTeam) {
    // 개인 기록: 팀장 전용 UI 숨기고 단일 일당 입력으로 전환
    document.getElementById('memberWagesFg').style.display = 'none';
    document.getElementById('ownerFg').style.display = 'none';
    document.getElementById('wageFg').style.display = '';
    document.getElementById('unitFg').style.display = '';
    document.getElementById('visibilityFg').style.display = 'none';
    document.getElementById('sharedWithFg').style.display = 'none';
  } else {
    // 팀 기록: 역할별 UI 복원
    if (teamRole === 'leader') {
      document.getElementById('memberWagesFg').style.display = '';
      document.getElementById('wageFg').style.display = 'none';
      document.getElementById('unitFg').style.display = 'none';
      document.getElementById('visibilityFg').style.display = '';
      document.getElementById('sharedWithFg').style.display = 'none';
      setVisibility('all');
      renderMemberWageList();
    } else {
      document.getElementById('wageFg').style.display = '';
      document.getElementById('unitFg').style.display = '';
    }
  }
}

function renderDateChips() {
  const sorted=[...editDates].sort();
  document.getElementById('dateChips').innerHTML=sorted.map(d=>`
    <div class="dchip">${fmtDate(d)}<button onclick="removeDate('${d}')">✕</button></div>
  `).join('');
  const lbl=document.getElementById('dateLabel');
  if(lbl) lbl.textContent=editDates.length>0?`일한 날짜 (총 ${editDates.length}일)`:'일한 날짜';
}
function removeDate(d) { editDates=editDates.filter(x=>x!==d); renderDateChips(); }

// ── 공개 범위 / 알림 ──
function setVisibility(vis, sharedWith) {
  ['all','selected','private'].forEach(v=>{
    const btn=document.getElementById('vis-'+v);
    if(btn) btn.classList.toggle('on', v===vis);
  });
  const fg=document.getElementById('sharedWithFg');
  if(vis==='selected'){
    fg.style.display='';
    const others=teamMembers.filter(m=>m.uid!==currentUser.uid);
    document.getElementById('sharedWithList').innerHTML=others.map(m=>`
      <label class="member-check">
        <input type="checkbox" value="${m.uid}" ${(sharedWith||[]).includes(m.uid)?'checked':''}>
        <span>${m.displayName||'팀원'}</span>
      </label>`).join('');
  } else { fg.style.display='none'; }
}

function getSelectedVisibility() {
  const active=document.querySelector('.vis-btn.on');
  const vis=active?active.id.replace('vis-',''):'all';
  let sharedWith=[];
  if(vis==='selected'){
    sharedWith=Array.from(document.querySelectorAll('#sharedWithList input:checked')).map(c=>c.value);
  }
  return {vis, sharedWith};
}

function updateNotifBadge() {
  const badge = document.getElementById('notifBadge');
  const btn = document.getElementById('notifBtn');
  if (!badge || !btn) return;
  const isTeam = dataMode === 'team';
  btn.style.display = isTeam ? '' : 'none';
  if (!isTeam) return;
  const cnt = DB.notifications.filter(n => !n.isRead).length;
  badge.style.display = cnt > 0 ? '' : 'none';
  badge.textContent = cnt > 0 ? cnt : '';
  const readAllBtn = document.getElementById('notifReadAllBtn');
  if (readAllBtn) readAllBtn.disabled = cnt === 0;
}

function relTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s/60)}분 전`;
  if (s < 86400) return `${Math.floor(s/3600)}시간 전`;
  if (s < 86400*30) return `${Math.floor(s/86400)}일 전`;
  return d.toLocaleDateString('ko-KR', {month:'numeric', day:'numeric'});
}

const NOTIF_ICON = { pay_request:'💰', wage_modified:'✏️', wage_added:'➕', work_deleted:'🗑️' };

function renderNotifPanel() {
  const el = document.getElementById('notifList');
  if (!el) return;
  const sorted = [...DB.notifications].sort((a, b) => {
    const ta = a.createdAt?.toDate?.() || new Date(0);
    const tb = b.createdAt?.toDate?.() || new Date(0);
    return tb - ta;
  });
  if (sorted.length === 0) {
    el.innerHTML = '<div class="notif-empty">새 알림이 없어요</div>';
    return;
  }
  el.innerHTML = sorted.map(n => {
    const icon = NOTIF_ICON[n.type] || '🔔';
    const unread = !n.isRead;
    let actionHtml = '';
    if (unread && teamRole === 'leader' && n.type === 'pay_request') {
      actionHtml = `<div class="notif-item-action"><button onclick="openPayDetail('${n.wageId}');markNotifRead('${n.id}');closeNotifPanel()">정산 처리</button></div>`;
    }
    return `
      <div class="notif-item${unread?' unread':''}">
        <div class="notif-item-icon">${icon}</div>
        <div class="notif-item-body">
          <div class="notif-item-msg">${n.message||''}</div>
          <div class="notif-item-time">${relTime(n.createdAt)}</div>
          ${actionHtml}
        </div>
        ${unread?`<button onclick="markNotifRead('${n.id}')" style="background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer;padding:0 0 0 8px;flex-shrink:0;align-self:center">✕</button>`:''}
      </div>`;
  }).join('');
}

function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  const overlay = document.getElementById('notifOverlay');
  const hdr = document.querySelector('.hdr');
  if (hdr) panel.style.paddingTop = hdr.offsetHeight + 'px';
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  overlay.style.display = isOpen ? 'none' : 'block';
}

function closeNotifPanel() {
  document.getElementById('notifPanel')?.classList.remove('open');
  const overlay = document.getElementById('notifOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function markAllRead() {
  const unread = DB.notifications.filter(n => !n.isRead);
  if (!unread.length) return;
  unread.forEach(n => { n.isRead = true; });
  updateNotifBadge();
  renderNotifPanel();
  await Promise.all(unread.map(n =>
    teamRef().collection('notifications').doc(n.id).update({isRead:true}).catch(()=>{})
  ));
}


function markNotifRead(notifId) {
  teamRef().collection('notifications').doc(notifId).update({isRead:true}).catch(()=>{});
  const n = DB.notifications.find(x => x.id === notifId);
  if (n) n.isRead = true;
  updateNotifBadge();
  renderNotifPanel();
}

async function createNotification(toUid, type, wageId, site) {
  const msgs = {
    wage_modified: `팀장이 "${site}" 일당을 수정했어요`,
    wage_added: `팀장이 "${site}" 작업을 등록해줬어요`,
    work_deleted: `팀장이 "${site}" 작업 기록을 삭제했어요`,
    pay_request: `"${site}" 정산을 요청했어요`,
  };
  const msg = msgs[type] || `팀장이 "${site}" 작업을 등록해줬어요`;
  await teamRef().collection('notifications').add({
    toUid, fromUid:currentUser.uid, type, wageId, site, message:msg,
    isRead:false, createdAt:firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function requestPay(workId) {
  const w = DB.works.find(x => x.id === workId);
  if(!w || !teamInfo?.leaderUid) { showToast('팀 정보를 불러올 수 없어요. 새로고침 후 다시 시도해주세요.'); return; }
  const sentKey = 'sentPayReq_' + activeTeamId;
  const sent = JSON.parse(localStorage.getItem(sentKey) || '[]');
  if(sent.includes(workId)) { showToast('이미 정산 요청을 보낸 현장이에요'); return; }
  try {
    await createNotification(teamInfo.leaderUid, 'pay_request', workId, w.site);
    localStorage.setItem(sentKey, JSON.stringify([...sent, workId]));
    showToast('팀장에게 정산 요청을 보냈어요');
  } catch(e) {
    console.error('정산 요청 오류:', e);
    showToast('정산 요청 전송에 실패했어요. 잠시 후 다시 시도해주세요.');
  }
}

function updateBulkBar() {
  const bar = document.getElementById('bulkBar');
  if (!bar) return;
  const cnt = document.querySelectorAll('.bulk-check:checked').length;
  bar.classList.toggle('on', cnt > 0);
  const countEl = document.getElementById('bulkBarCount');
  if (countEl) countEl.textContent = `${cnt}건 선택됨`;
}

async function bulkSetPaid() {
  const checked = [...document.querySelectorAll('.bulk-check:checked')].map(el => el.dataset.wid);
  if (!checked.length) return;
  if (!confirm(`선택한 ${checked.length}개 현장을 지급 완료 처리할까요?`)) return;
  const targets = DB.works.filter(w => checked.includes(w.id));
  const newPays = [];
  targets.forEach(w => {
    w.isPaid = true;
    const outstanding = Math.max(0, (expAmt(w)||0) - rcvAmt(w.id));
    if (outstanding > 0) {
      const newPay = {id:'p_'+Date.now()+'_'+w.id, workId:w.id, date:todayStr(), amount:outstanding, note:'정산 완료 처리', createdBy:currentUser.uid};
      DB.payments.push(newPay);
      newPays.push(newPay);
    }
  });
  localStorage.setItem('moksujilji2', JSON.stringify(DB));
  await Promise.all([
    ...targets.map(w => updateOneWage(w)),
    ...newPays.map(p => saveOnePay(p))
  ]);
  showToast(`${checked.length}개 현장 지급 완료 처리됐어요`);
  renderPay();
}

// ── 커스텀 날짜 선택 ──
let pickY, pickM, pickMode='single', pickSel=[], rangeStart=null;
let payDateMode=false;

function closeDatePickOv() {
  if(payDateMode) {
    payDateMode=false;
    document.querySelector('.mode-seg').style.display='';
    document.getElementById('datePickTitle').textContent='날짜 선택';
    document.getElementById('datePickOv').style.zIndex='';
  }
  closeOv('datePickOv');
}

function openPayDatePick() {
  payDateMode=true;
  const cur=document.getElementById('inPayDate').value;
  if(cur){ const p=parsD(cur); pickY=p.y; pickM=p.m; }
  else { const n=new Date(); pickY=n.getFullYear(); pickM=n.getMonth(); }
  pickSel=cur?[cur]:[];
  rangeStart=null;
  document.querySelector('.mode-seg').style.display='none';
  document.getElementById('rangeHint').style.display='none';
  document.getElementById('datePickTitle').textContent='정산일 선택';
  document.getElementById('datePickOv').style.zIndex='400';
  renderPickCal();
  openOv('datePickOv');
}

function openDatePickOv() {
  const now=new Date();
  pickY=now.getFullYear(); pickM=now.getMonth();
  pickSel=[]; rangeStart=null;
  setPickMode('single');
  renderPickCal();
  openOv('datePickOv');
}

function setPickMode(mode) {
  pickMode=mode; rangeStart=null;
  document.getElementById('modeBtn-single').classList.toggle('on',mode==='single');
  document.getElementById('modeBtn-range').classList.toggle('on',mode==='range');
  document.getElementById('rangeHint').style.display=mode==='range'?'block':'none';
  if(mode==='range') document.getElementById('rangeHint').textContent='시작일을 탭하세요';
  renderPickCal();
}

function movePickM(d) {
  pickM+=d; if(pickM>11){pickM=0;pickY++;} if(pickM<0){pickM=11;pickY--;} renderPickCal();
}

function renderPickCal() {
  document.getElementById('pickLbl').textContent=`${pickY}년 ${pickM+1}월`;
  const firstDow=new Date(pickY,pickM,1).getDay();
  const dim=new Date(pickY,pickM+1,0).getDate();
  const diPrev=new Date(pickY,pickM,0).getDate();
  const todStr=todayStr();
  let html='';

  for(let i=firstDow-1;i>=0;i--) html+=`<button class="pd other" disabled>${diPrev-i}</button>`;

  for(let d=1;d<=dim;d++){
    const ds=ymd(pickY,pickM,d);
    const wd=dowN(pickY,pickM,d);
    let cls='pd';
    if(ds===todStr) cls+=' tod';
    if(wd===0) cls+=' sun';
    if(wd===6) cls+=' sat';
    if(getHoli(ds)) cls+=' holi';
    if(payDateMode) {
      if(ds>todStr){ html+=`<button class="${cls} other" disabled>${d}</button>`; continue; }
      if(pickSel.includes(ds)) cls+=' sel';
    } else {
      if(editDates.includes(ds)) cls+=' already';
      else if(ds===rangeStart) cls+=' rng-start';
      else if(pickSel.includes(ds)) cls+=' sel';
    }
    html+=`<button class="${cls}" onclick="onPickDay('${ds}')">${d}</button>`;
  }

  const rem=(firstDow+dim)%7===0?0:7-(firstDow+dim)%7;
  for(let d=1;d<=rem;d++) html+=`<button class="pd other" disabled>${d}</button>`;
  document.getElementById('pickGrid').innerHTML=html;

  const total=pickSel.length;
  document.getElementById('pickSelCount').textContent=(!payDateMode&&total>0)?`${total}일 선택됨`:'';
}

function onPickDay(ds) {
  if(payDateMode) {
    pickSel=[ds];
    renderPickCal();
    return;
  }
  if(editDates.includes(ds)) return;

  if(pickMode==='single') {
    if(pickSel.includes(ds)) pickSel=pickSel.filter(x=>x!==ds);
    else pickSel.push(ds);
  } else {
    if(!rangeStart) {
      rangeStart=ds;
      document.getElementById('rangeHint').textContent='종료일을 탭하세요';
    } else {
      const start=rangeStart<ds?rangeStart:ds;
      const end=rangeStart<ds?ds:rangeStart;
      let cur=new Date(start+'T00:00:00');
      const endD=new Date(end+'T00:00:00');
      while(cur<=endD){
        const s=ymd(cur.getFullYear(),cur.getMonth(),cur.getDate());
        if(!editDates.includes(s)&&!pickSel.includes(s)) pickSel.push(s);
        cur.setDate(cur.getDate()+1);
      }
      rangeStart=null;
      document.getElementById('rangeHint').textContent='시작일을 탭하세요';
    }
  }
  renderPickCal();
}

function confirmDatePick() {
  if(payDateMode) {
    if(pickSel.length>0) {
      const d=pickSel[0];
      document.getElementById('inPayDate').value=d;
      document.getElementById('inPayDateText').textContent=fmtDate(d);
    }
    payDateMode=false;
    document.querySelector('.mode-seg').style.display='';
    document.getElementById('datePickTitle').textContent='날짜 선택';
    document.getElementById('datePickOv').style.zIndex='';
    closeOv('datePickOv');
    return;
  }
  pickSel.forEach(d=>{ if(!editDates.includes(d)) editDates.push(d); });
  editDates.sort(); renderDateChips();
  closeOv('datePickOv');
}

async function saveWorkMulti(site,workDesc,address,contact,phone,memo) {
  // 선택된 팀원 + 각자 일당/품수 수집
  const rows=[...document.querySelectorAll('#memberWageList .mw-row')];
  const members=[];
  for(const row of rows){
    const check=row.querySelector('.mw-check');
    if(!check.checked) continue;
    const wage=Number(row.querySelector('.mw-wage').value);
    const unit=Number(row.querySelector('.mw-unit').value)||1;
    const name=row.querySelector('.mw-name').textContent;
    if(!wage){alert(`${name}의 일당을 입력해주세요.`);return;}
    members.push({uid:check.value,wage,unit,name:name.trim()});
  }
  if(members.length===0){alert('한 명 이상 선택해주세요.');return;}

  const dayCount=editDates.length;
  const summaryLines=members.map(m=>`• ${m.name} · ${dayCount}일 · ${fmtW(m.wage*dayCount*m.unit)}`).join('\n');
  if(!confirm(`[${site}]\n\n${summaryLines}\n\n총 ${members.length}명을 등록할까요?`))return;

  const {vis:jobVis,sharedWith:jobSharedWith}=getSelectedVisibility();

  // job 생성 또는 기존 job 사용
  let jobId;
  const matched=DB.jobs.find(j=>j.site===site);
  if(matched){
    jobId=matched.id;
    saveJobInfo(jobId,{site,address,contact,phone,memo,color:editColor,visibility:jobVis,sharedWith:jobSharedWith});
  } else {
    jobId=Date.now().toString(36)+'j';
    const jobData={site,address,contact,phone,memo,color:editColor,visibility:jobVis,sharedWith:jobSharedWith,createdBy:currentUser.uid,createdAt:firebase.firestore.FieldValue.serverTimestamp()};
    try{
      await teamRef().collection('jobs').doc(jobId).set(jobData);
      DB.jobs.push({id:jobId,...jobData});
    }catch(e){alert(`현장 생성 중 오류\n${e.message}`);return;}
  }

  // 각 팀원 wage 일괄 생성
  const t=teamRef();
  const batch=fsdb.batch();
  const newWorks=[];
  const now=Date.now();
  members.forEach((m,i)=>{
    const wId=(now+i).toString(36);
    const sortedDates=editDates.sort();
    batch.set(t.collection('wages').doc(wId),{
      jobId,dates:sortedDates,unit:m.unit,wage:m.wage,isPaid:false,workDesc,
      ownerUid:m.uid,createdBy:currentUser.uid,
      createdAt:firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:firebase.firestore.FieldValue.serverTimestamp()
    });
    newWorks.push({id:wId,site,workDesc,wage:m.wage,unit:m.unit,dates:sortedDates,isPaid:false,
      color:editColor,address,contact,phone,memo,
      createdBy:currentUser.uid,ownerUid:m.uid,jobId});
    if(m.uid!==currentUser.uid) createNotification(m.uid,'wage_created',wId,site);
  });
  try{await batch.commit();}catch(e){alert(`저장 오류\n${e.message}`);return;}

  DB.works.push(...newWorks);
  DB.works.sort((a,b)=>(b.dates?.[b.dates.length-1]||'').localeCompare(a.dates?.[a.dates.length-1]||''));
  localStorage.setItem('moksujilji2',JSON.stringify(DB));
  closeAll();
  if(curTab==='cal')renderCal();
  else if(curTab==='work')renderWork();
  else if(curTab==='pay')renderPay();
}

async function saveWork() {
  const site=document.getElementById('inSite').value.trim();
  const unit=Number(document.getElementById('inUnit').value);
  const workId=document.getElementById('editWorkId').value;
  const workDesc=document.getElementById('inWorkDesc').value.trim();
  const address=document.getElementById('inAddress').value.trim();
  const contact=document.getElementById('inContact').value.trim();
  const phone=document.getElementById('inPhone').value.trim();
  const memo=document.getElementById('inMemo').value.trim();
  if(!site){alert('현장명을 입력해 주세요.');return;}
  if(editDates.length===0){alert('날짜를 1개 이상 추가해 주세요.');return;}

  const isLeaderMode=dataMode==='team'&&teamRole==='leader';
  const existing=workId?DB.works.find(x=>x.id===workId):null;
  const isPersonalSave=dataMode==='team'&&(existing?!!existing.isPersonal:workEntryMode==='personal');

  // 팀 모드에서 개인 날일 기록 저장 (users/{uid}/works)
  if(isPersonalSave){
    const wage=Number(document.getElementById('inWage').value);
    if(!wage){alert('일당을 입력해 주세요.');return;}
    let savedW;
    if(existing){
      existing.site=site;existing.unit=unit;existing.dates=[...editDates].sort();
      existing.color=editColor;existing.workDesc=workDesc;existing.address=address;existing.contact=contact;
      existing.phone=phone;existing.memo=memo;existing.wage=wage;
      savedW=existing;
    } else {
      const wId=Date.now().toString(36);
      savedW={id:wId,site,workDesc,address,contact,phone,memo,wage,unit,dates:[...editDates].sort(),isPaid:false,color:editColor,isPersonal:true};
      DB.works.push(savedW);
    }
    DB.works.sort((a,b)=>(b.dates[b.dates.length-1]||'').localeCompare(a.dates[a.dates.length-1]||''));
    localStorage.setItem('moksujilji2',JSON.stringify(DB));
    try{
      await fsdb.collection('users').doc(currentUser.uid).collection('works').doc(savedW.id).set(savedW);
    }catch(e){console.error('개인 기록 저장 오류:',e);alert('저장 오류: '+e.message);return;}
    closeAll();
    if(curTab==='cal')renderCal();
    else if(curTab==='work')renderWork();
    else if(curTab==='pay')renderPay();
    return;
  }

  // 팀장 신규 다중 등록 모드
  if(isLeaderMode&&!existing){
    await saveWorkMulti(site,workDesc,address,contact,phone,memo);
    return;
  }

  // 단일 등록 (개인모드 / 팀원 / 팀장 수정)
  const ownerUid=currentUser.uid;
  let jobVis='all', jobSharedWith=[];
  if(isLeaderMode){ const v=getSelectedVisibility(); jobVis=v.vis; jobSharedWith=v.sharedWith; }
  else if(existing && dataMode==='team'){
    // 팀원이 수정 시 기존 job의 visibility 유지 (덮어쓰기 방지)
    const existingJob=DB.jobs.find(j=>j.id===existing.jobId);
    if(existingJob){ jobVis=existingJob.visibility||'all'; jobSharedWith=existingJob.sharedWith||[]; }
  }
  const wageEditable=!existing||canSeeWage(existing);
  let wage;
  if(wageEditable){
    wage=Number(document.getElementById('inWage').value);
    if(!wage){alert('일당을 입력해 주세요.');return;}
  }

  let _savedWork = existing; // 핀포인트 저장 대상 추적
  if(existing){
    existing.site=site;existing.unit=unit;existing.dates=editDates.sort();existing.color=editColor;
    existing.workDesc=workDesc;existing.address=address;existing.contact=contact;existing.phone=phone;existing.memo=memo;
    if(wageEditable) existing.wage=wage;
    if(dataMode==='team'){
      saveJobInfo(existing.jobId,{site,address,contact,phone,memo,color:editColor,visibility:jobVis,sharedWith:jobSharedWith});
      // 팀장이 타인 일당 수정 시 알림
      if(isLeaderMode && (existing.ownerUid||existing.createdBy)!==currentUser.uid){
        createNotification(existing.ownerUid||existing.createdBy,'wage_modified',existing.id,site);
      }
    }
  } else {
    let jobId;
    if(dataMode==='team'){
      const matched=DB.jobs.find(j=>j.site===site);
      if(matched){
        jobId=matched.id;
        if(address||contact||phone||memo||isLeaderMode){
          saveJobInfo(jobId,{site,address,contact,phone,memo,color:editColor,visibility:jobVis,sharedWith:jobSharedWith});
        }
      } else {
        jobId=Date.now().toString(36)+'j';
        const jobData={site,address,contact,phone,memo,color:editColor,visibility:jobVis,sharedWith:jobSharedWith,createdBy:currentUser.uid,createdAt:firebase.firestore.FieldValue.serverTimestamp()};
        try {
          await teamRef().collection('jobs').doc(jobId).set(jobData);
          DB.jobs.push({id:jobId,...jobData});
        } catch(e) {
          console.error('현장 생성 오류:', e);
          alert(`현장 생성 중 오류가 발생했습니다.\n${e.code||''} ${e.message||e}`);
          return;
        }
      }
    }
    const wId=Date.now().toString(36);
    const w={id:wId,site,workDesc,wage,unit,dates:editDates.sort(),isPaid:false,color:editColor,address,contact,phone,memo};
    if(dataMode==='team'){ w.createdBy=currentUser.uid; w.ownerUid=ownerUid; w.jobId=jobId; }
    DB.works.push(w);
    _savedWork = w;
    // 팀장이 타인 대신 신규 등록 시 알림
    if(isLeaderMode && ownerUid!==currentUser.uid){
      createNotification(ownerUid,'wage_created',wId,site);
    }
  }
  DB.works.sort((a,b)=>(b.dates?.[b.dates.length-1]||'').localeCompare(a.dates?.[a.dates.length-1]||''));
  localStorage.setItem('moksujilji2', JSON.stringify(DB));
  if (_savedWork) { try { await saveOneWork(_savedWork); } catch(e) { console.error('저장 오류:', e); } }
  closeAll();
  if(curTab==='cal')renderCal();
  else if(curTab==='work')renderWork();
  else if(curTab==='pay')renderPay();
}

// 현장(jobs) 공유 정보를 즉시 저장 — wages와 별도 문서라 save()의 일괄 batch 대상이 아님.
// 이미 존재하는 현장(matched 또는 수정)의 정보 갱신용 — 새 현장 생성은 saveWork()에서 await로 직접 처리.
function saveJobInfo(jobId, fields) {
  teamRef().collection('jobs').doc(jobId).set(fields, { merge: true }).then(() => {
    const idx=DB.jobs.findIndex(j=>j.id===jobId);
    if(idx>=0) DB.jobs[idx]={...DB.jobs[idx], ...fields};
  }).catch(e=>console.error('현장 정보 저장 오류:', e));
}

async function delWork(id) {
  if(!confirm('이 작업 기록을 삭제하시겠습니까?\n관련 정산 내역도 함께 삭제됩니다.'))return;
  if (currentUser) {
    try {
      if (dataMode === 'team') {
        const work = DB.works.find(x => x.id === id);
        if (work && work.isPersonal) {
          // 개인 날일 기록: users/{uid}/works에서 삭제
          const ref = fsdb.collection('users').doc(currentUser.uid);
          const batch = fsdb.batch();
          batch.delete(ref.collection('works').doc(id));
          DB.payments.filter(p=>p.workId===id).forEach(p=>batch.delete(ref.collection('payments').doc(p.id)));
          await batch.commit();
        } else {
          const t = teamRef();
          const batch = fsdb.batch();
          // wages만 삭제 (jobs는 다른 팀원이 같은 현장을 참조 중일 수 있어 그대로 둠)
          batch.delete(t.collection('wages').doc(id));
          DB.payments.filter(p=>p.workId===id).forEach(p=>batch.delete(t.collection('payments').doc(p.id)));
          await batch.commit();
          if (work && work.ownerUid && work.ownerUid !== currentUser.uid) {
            createNotification(work.ownerUid, 'work_deleted', id, work.site);
          }
        }
      } else {
        const ref = fsdb.collection('users').doc(currentUser.uid);
        const batch = fsdb.batch();
        batch.delete(ref.collection('works').doc(id));
        DB.payments.filter(p=>p.workId===id).forEach(p=>batch.delete(ref.collection('payments').doc(p.id)));
        await batch.commit();
      }
    } catch(e) { console.error('삭제 오류:', e); alert('삭제 권한이 없거나 오류가 발생했습니다.'); return; }
  }
  DB.works=DB.works.filter(w=>w.id!==id);
  DB.payments=DB.payments.filter(p=>p.workId!==id);
  localStorage.setItem('moksujilji2', JSON.stringify(DB));
  if(curTab==='cal')renderCal();
  else if(curTab==='work')renderWork();
  else if(curTab==='pay')renderPay();
}

// ── 기록 탭 ──
function moveWork(d) {
  workM+=d; if(workM>11){workM=0;workY++;} if(workM<0){workM=11;workY--;} renderWork();
}

function toggleWorkSearch() {
  const bar = document.getElementById('workSearchBar');
  const isOpen = bar.style.display !== 'none';
  bar.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) { document.getElementById('workSearchInput').focus(); }
  else { workSearch = ''; document.getElementById('workSearchInput').value = ''; renderWork(); }
}
function onWorkSearch() {
  workSearch = document.getElementById('workSearchInput').value.trim().toLowerCase();
  renderWork();
}
function renderWork() {
  document.getElementById('workLbl').textContent=`${workY}년 ${workM+1}월`;

  // 검색 모드: 전체 기간에서 현장명 검색
  let base;
  if (workSearch) {
    base = DB.works.filter(w => (w.site||'').toLowerCase().includes(workSearch));
  } else {
    base = DB.works.filter(w => (w.dates||[]).some(d=>{const p=parsD(d);return p.y===workY&&p.m===workM;}));
  }

  const filtered = base;

  // 통계에는 예정 현장 제외 (실제 작업일/일당만 집계)
  const activeFiltered=filtered.filter(w=>getWorkStatus(w)==='active');
  const totalDays=new Set(activeFiltered.flatMap(w=>(w.dates||[]).filter(d=>{const p=parsD(d);return p.y===workY&&p.m===workM;}))).size;
  const totalWage=activeFiltered.reduce((s,w)=>{
    if(w.wage==null) return s;
    const cnt=(w.dates||[]).filter(d=>{const p=parsD(d);return p.y===workY&&p.m===workM;}).length;
    return s+cnt*Number(w.wage)*Number(w.unit||1);
  },0);
  const plannedCount=filtered.filter(w=>getWorkStatus(w)==='planned').length;
  const isCurMonth=workY===TODAY.getFullYear()&&workM===TODAY.getMonth();
  const monthLbl=isCurMonth?'이번 달':`${workY}년 ${workM+1}월`;
  const plannedSuffix=(!workSearch&&plannedCount>0)?` · 예정 ${plannedCount}건`:'';
  const secTitle = workSearch
    ? `"${workSearch}" 검색 결과 ${filtered.length}건`
    : filtered.length>0?`${activeFiltered.length}개 현장 · ${totalDays}일 · ${fmtW(totalWage)}${plannedSuffix}`:monthLbl+' 작업 기록';
  document.getElementById('workSecTitle').textContent = secTitle;
  const el=document.getElementById('wList');
  if(filtered.length===0){
    const isAll = DB.works.length===0;
    const ctaBtn = isAll ? `<button onclick="openWorkOv(null,todayStr())" style="margin-top:20px;padding:12px 28px;background:var(--pri);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer">첫 현장 추가하기</button>` : '';
    const emptyMsg = workSearch ? `"${workSearch}" 현장을 찾을 수 없어요` : isAll ? '아직 작업 기록이 없어요' : monthLbl+' 작업 기록이 없어요';
    el.innerHTML=`<div class="es"><div class="es-icon">${isAll&&!workSearch?'🏗️':'📋'}</div><div class="es-title">${emptyMsg}</div><div class="es-desc">${isAll&&!workSearch?'현장명, 날짜, 일당을<br>기록해보세요':''}</div>${!workSearch?ctaBtn:''}</div>`;
    return;
  }
  // 같은 현장(jobId)에 묶인 여러 명의 근무기록을 한 카드로 그룹핑 (팀 모드에서 의미 있음)
  const groups=[]; const byKey={};
  filtered.forEach(w=>{
    const key=w.jobId||w.id;
    if(!byKey[key]){ byKey[key]={items:[]}; byKey[key].key=key; groups.push(byKey[key]); }
    byKey[key].items.push(w);
  });
  groups.sort((a,b)=>{
    const la=a.items[0].dates?.[a.items[0].dates.length-1]||'', lb=b.items[0].dates?.[b.items[0].dates.length-1]||'';
    return lb.localeCompare(la);
  });

  el.innerHTML=groups.map(g=>{
    const head=g.items[0];
    const c=getColor(head.color||'orange');
    if(g.items.length===1) return renderWorkRow(head,workY,workM,true);
    return `
      <div class="wgroup" style="border-left:4px solid ${c.border}">
        <div class="wgroup-head">
          <div class="wi-site">${head.site}</div>
          <div class="wgroup-count">${g.items.length}명 작업</div>
        </div>
        <div class="wgroup-body">${g.items.map(w=>renderWorkRow(w,workY,workM,false)).join('')}</div>
      </div>`;
  }).join('');
}

function renderWorkRow(w,y,m,standalone) {
  const wageVisible=w.wage!=null;
  const rcv=wageVisible?rcvAmt(w.id):0;
  const wStatus=getWorkStatus(w);
  const statusBadge=wStatus==='planned'?'<span class="wi-badge" style="background:rgba(0,122,255,.1);color:#007AFF">예정</span>':'';
  const badge=!wageVisible
    ?'<span class="wi-badge">비공개</span>'
    :w.isPaid
    ?`<span class="wi-badge badge-paid">${isPayOut(w)?'지급완료':'정산완료'}</span>`
    :(rcv>0
      ?`<span class="wi-badge badge-partial">${isPayOut(w)?'부분지급':'부분정산'}</span>`
      :`<span class="wi-badge badge-unpaid">${isPayOut(w)?'미지급':'미정산'}</span>`);
  const mDates=(w.dates||[]).filter(d=>{const p=parsD(d);return p.y===y&&p.m===m;});
  const u=Number(w.unit||1);
  const total=wageVisible?mDates.length*Number(w.wage)*u:null;
  const calc=wageVisible?(()=>{const parts=[fmtW(w.wage)];if(mDates.length>1)parts.push(`${mDates.length}일`);if(u!==1)parts.push(`${u}품`);return parts.length>1?parts.join(' × '):'';})():'';
  const c=getColor(w.color||'orange');
  const delBtn=canDeleteJob(w)?`<button class="wi-del" onclick="event.stopPropagation();delWork('${w.id}')">🗑</button>`:'';
  const titleHtml=standalone
    ?`<div class="wi-site">${w.site}${workTypeBadge(w)}</div>`
    :(dataMode==='team'?`<div class="wi-who">${workTypeBadge(w)}</div>`:'');
  return `
    <div class="witem" onclick="openWorkOv('${w.id}',null)"${standalone?` style="border-left:4px solid ${c.border}"`:''}>
      <div class="wi-main">
        ${titleHtml}
        <div class="wi-dates">${formatDatesShort(mDates)}</div>
        ${w.workDesc?`<div style="font-size:11px;color:var(--muted);margin-top:1px">${w.workDesc}</div>`:''}
        <div class="wi-wage">${wageVisible?`일당 ${fmtW(w.wage)}${u!==1?` · ${u}품`:''}`:'일당 비공개'}</div>
        ${statusBadge}${badge}
      </div>
      <div class="wi-right">
        <div class="wi-total">${wageVisible?fmtW(total):'—'}</div>
        ${calc?`<div class="wi-calc">${calc}</div>`:''}
      </div>
      ${delBtn}
    </div>`;
}

// ── 입금 탭 ──
function renderPay() {
  document.getElementById('payLbl').textContent=`${payY}년 ${payM+1}월`;

  const monthWorks=DB.works.filter(w=>w.wage!=null&&getWorkStatus(w)!=='planned'&&(w.dates||[]).some(d=>{const p=parsD(d);return p.y===payY&&p.m===payM;}));
  const mWage=monthWorks.reduce((s,w)=>{
    const cnt=(w.dates||[]).filter(d=>{const p=parsD(d);return p.y===payY&&p.m===payM;}).length;
    return s+cnt*Number(w.wage)*Number(w.unit||1);
  },0);
  const mUnpaid=monthWorks.filter(w=>!w.isPaid).reduce((s,w)=>s+Math.max(0,expAmt(w)-rcvAmt(w.id)),0);

  const isLeaderPay = dataMode==='team' && teamRole==='leader' && monthWorks.some(w=>!w.isPersonal);
  document.getElementById('balArea').innerHTML=`
    <div class="bal-card">
      <div class="bc-row">
        <div class="bc-item"><div class="bi-l">${isLeaderPay?'이달 총 인건비':'이달 총 일당'}</div><div class="bi-v">${fmtW(mWage)}</div></div>
        <div class="bc-item"><div class="bi-l">${isLeaderPay?'이달 미지급금':'이달 미수금'}</div><div class="bi-v" style="color:${mUnpaid>0?'var(--red)':'var(--muted)'}">${fmtW(mUnpaid)}</div></div>
      </div>
    </div>`;

  document.getElementById('payFilterWrap').innerHTML=`<div style="display:flex;gap:6px">${[['all','전체'],['unpaid',isLeaderPay?'미지급':'미수금'],['done','완료']].map(([v,l])=>`<button onclick="setPayFilter('${v}')" style="background:${payFilter===v?'var(--pri)':'none'};color:${payFilter===v?'#fff':'var(--muted)'};border:1.5px solid ${payFilter===v?'var(--pri)':'var(--border)'};border-radius:20px;font-size:11px;font-weight:600;padding:4px 12px;cursor:pointer">${l}</button>`).join('')}</div>`;

  const el=document.getElementById('pList');
  if(monthWorks.length===0){
    el.innerHTML='<div class="es"><div class="es-icon">🧾</div><div class="es-title">이달 현장이 없어요</div><div class="es-desc">기록 탭에서 현장을 추가하면<br>여기서 정산을 관리할 수 있어요</div></div>';
    return;
  }

  const filtered=monthWorks
    .filter(w=>payFilter==='all'?true:payFilter==='done'?w.isPaid:!w.isPaid)
    .sort((a,b)=>a.isPaid===b.isPaid?0:a.isPaid?1:-1);

  if(filtered.length===0){
    el.innerHTML=`<div class="es" style="padding:32px 24px"><div class="es-title" style="font-size:15px">${payFilter==='done'?'완료된 현장이 없어요':(isLeaderPay?'미지급금이 없어요 🎉':'미수금이 없어요 🎉')}</div></div>`;
    return;
  }

  updateBulkBar();
  el.innerHTML=filtered.map(w=>{
    const exp=expAmt(w), rcv=rcvAmt(w.id), diff=rcv-exp;
    const c=getColor(w.color||'orange');
    const badge=w.isPaid
      ?`<span class="wi-badge badge-paid" style="font-size:11px">${isPayOut(w)?'지급완료':'정산완료'}</span>`
      :(rcv>0
        ?`<span class="wi-badge badge-partial" style="font-size:11px">${isPayOut(w)?'부분지급':'부분정산'}</span>`
        :`<span class="wi-badge badge-unpaid" style="font-size:11px">${isPayOut(w)?'미지급':'미정산'}</span>`);
    const diffHtml=diff===0?'':`<div class="pi-diff ${diff<0?'minus':'plus'}">${diff<0?'▼':'▲'} ${fmtW(Math.abs(diff))} ${diff<0?(isPayOut(w)?'덜 줌':'덜 받음'):(isPayOut(w)?'더 줌':'더 받음')}</div>`;
    // 미수금 aging 뱃지 — 마지막 작업일 기준 경과 일수
    const lastWkDate=(w.dates||[]).slice().sort().slice(-1)[0]||'';
    const agingDays=lastWkDate?Math.floor((Date.now()-new Date(lastWkDate+'T00:00:00').getTime())/86400000):0;
    const agingBadge=!w.isPaid&&agingDays>=60
      ?`<span class="wi-badge" style="background:rgba(255,59,48,.1);color:var(--red);font-size:10px">⚠️ ${agingDays}일 경과</span>`
      :!w.isPaid&&agingDays>=30
      ?`<span class="wi-badge" style="background:rgba(255,149,0,.1);color:#FF9500;font-size:10px">⚠️ 30일 초과</span>`
      :'';
    const requestPayBtn=!w.isPaid&&w.wage!=null&&dataMode==='team'&&teamRole!=='leader'&&!w.isPersonal
      ?`<button onclick="event.stopPropagation();requestPay('${w.id}')" style="font-size:11px;font-weight:700;background:none;border:1.5px solid var(--border);border-radius:20px;padding:3px 10px;cursor:pointer;color:var(--muted)">정산 요청</button>`:'';
    const canBulk=isLeaderPay&&!w.isPaid;
    const contentHtml=`
      <div class="pi-top">
        <div style="min-width:0;flex:1">
          <div class="pi-site">${w.site}${workTypeBadge(w)}</div>
          <div class="pi-meta">${formatDatesShort(w.dates)}</div>
        </div>
        <div class="pi-right">
          <div class="pi-exp">${isPayOut(w)?'지급 예정':'예상'} ${fmtW(exp)}</div>
          <div class="pi-rcv">${fmtW(rcv)}</div>
          ${diffHtml}
        </div>
      </div>
      <div class="pi-bottom">${badge}${agingBadge}${requestPayBtn}<div class="pi-arrow">상세 보기 ›</div></div>`;
    if(canBulk){
      return `
        <div class="pitem" style="border-left:4px solid ${c.border};display:flex;align-items:stretch;padding:0">
          <div onclick="event.stopPropagation()" style="display:flex;align-items:center;padding:0 10px 0 14px;flex-shrink:0">
            <input type="checkbox" class="bulk-check" data-wid="${w.id}" onchange="updateBulkBar()" style="width:18px;height:18px;accent-color:var(--pri);cursor:pointer">
          </div>
          <div style="flex:1;padding:14px 16px 14px 0;min-width:0" onclick="openPayDetail('${w.id}')">${contentHtml}</div>
        </div>`;
    }
    return `<div class="pitem" onclick="openPayDetail('${w.id}')" style="border-left:4px solid ${c.border}">${contentHtml}</div>`;
  }).join('');
}

function sharePayInfo(wId) {
  const w=DB.works.find(x=>x.id===wId); if(!w)return;
  const exp=expAmt(w), rcv=rcvAmt(wId), outstanding=Math.max(0,exp-rcv);
  const text=`[${w.site}] 미수금 안내\n미수금: ${fmtW(outstanding)}\n(총 예상: ${fmtW(exp)}, 수령: ${fmtW(rcv)})`;
  if(navigator.share){navigator.share({text});}
  else{navigator.clipboard.writeText(text).then(()=>alert('클립보드에 복사됐습니다'));}
}

// ── 입금 상세 ──
function openPayDetail(wId) {
  selWorkId=wId;
  const w=DB.works.find(x=>x.id===wId);
  if(!w||w.wage==null)return;
  const exp=expAmt(w), rcv=rcvAmt(wId), diff=rcv-exp;
  const outstanding=Math.max(0,exp-rcv);
  document.getElementById('pdShareBtn').style.display=outstanding>0&&!w.isPaid?'block':'none';
  document.getElementById('pdSite').textContent=w.site;
  const infoLines=[
    w.workDesc&&`<div style="font-size:12px;color:var(--text2);margin-top:4px;font-weight:600">🔨 ${w.workDesc}</div>`,
    w.address&&`<div style="font-size:12px;color:var(--muted);margin-top:4px">📍 ${w.address}</div>`,
    (w.contact||w.phone)&&`<div style="font-size:12px;color:var(--muted);margin-top:2px">👤 ${[w.contact,w.phone].filter(Boolean).join(' · ')}</div>`,
    w.memo&&`<div style="font-size:12px;color:var(--muted);margin-top:2px">📝 ${w.memo}</div>`,
  ].filter(Boolean).join('');
  const payOut = isPayOut(w);
  document.getElementById('pdInfo').innerHTML=`
    ${formatDatesShort(w.dates)} · 일당 ${fmtW(w.wage)}<br>
    ${payOut?'지급 예정':'예상'} <b>${fmtW(exp)}</b> &nbsp;|&nbsp; ${payOut?'지급':'수령'} <b>${fmtW(rcv)}</b>
    ${diff!==0?` &nbsp;|&nbsp; 차액 <b style="color:${diff<0?'var(--red)':'var(--green)'}">${diff<0?'▼':'▲'} ${fmtW(Math.abs(diff))}</b>`:''}
    ${infoLines}
  `;
  const addPayBtn = document.querySelector('#payDetailOv .btn-out');
  if (addPayBtn) addPayBtn.textContent = payOut ? '+ 지급 금액 기록' : '+ 받은 금액 기록';
  const ptLabel = document.querySelector('#payDetailOv .pt-label');
  if (ptLabel) ptLabel.textContent = payOut ? '지급 완료' : '정산 완료';
  const ptDesc = document.querySelector('#payDetailOv .paid-toggle div div:last-child');
  if (ptDesc) ptDesc.textContent = payOut ? '수동으로 지급 완료 처리' : '수동으로 정산 완료 처리';
  const pays=DB.payments.filter(p=>p.workId===wId).sort((a,b)=>a.date.localeCompare(b.date));
  document.getElementById('pdPayRows').innerHTML=pays.length===0
    ?'<div class="empty" style="padding:20px 0">정산 내역이 없습니다</div>'
    :pays.map(p=>`
      <div class="pay-row">
        <div class="pr-main">
          <div class="pr-date">${fmtDate(p.date)}</div>
          <div class="pr-amt">+${fmtW(p.amount)}</div>
          ${p.note?`<div class="pr-note">${p.note}</div>`:''}
        </div>
        <button class="pr-del" onclick="delPay('${p.id}')">🗑</button>
      </div>`).join('');
  document.getElementById('paidToggle').classList.toggle('on',w.isPaid);
  openOv('payDetailOv');
}

async function togglePaid() {
  const w=DB.works.find(x=>x.id===selWorkId);
  if(!w)return;
  w.isPaid=!w.isPaid;
  if(w.isPaid) {
    const outstanding=Math.max(0,(expAmt(w)||0)-rcvAmt(selWorkId));
    if(outstanding>0) {
      const newPay={id:'p_'+Date.now(),workId:selWorkId,date:todayStr(),amount:outstanding,note:'정산 완료 처리',createdBy:currentUser.uid};
      DB.payments.push(newPay);
      try { await saveOnePay(newPay); } catch(e) { console.error('정산 기록 저장 오류:', e); }
    }
  }
  localStorage.setItem('moksujilji2', JSON.stringify(DB));
  try { await updateOneWage(w); } catch(e) { console.error('저장 오류:', e); }
  document.getElementById('paidToggle').classList.toggle('on',w.isPaid);
  document.getElementById('pdShareBtn').style.display = Math.max(0,(expAmt(w)||0)-rcvAmt(selWorkId))>0&&!w.isPaid?'block':'none';
  renderPay();
}

function openAddPayOv() {
  const today=todayStr();
  document.getElementById('inPayDate').value=today;
  document.getElementById('inPayDateText').textContent=fmtDate(today);
  document.getElementById('inPayAmt').value='';
  document.getElementById('inPayNote').value='';
  openOv('addPayOv');
}

let _toastTimer=null;
function showToast(msg) {
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  if(_toastTimer) clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>t.classList.remove('show'), 2500);
}

async function savePayment() {
  const date=document.getElementById('inPayDate').value;
  const amount=Number(document.getElementById('inPayAmt').value);
  const note=document.getElementById('inPayNote').value.trim();
  if(!date||!amount){alert('날짜와 금액을 입력해 주세요.');return;}
  const w=DB.works.find(x=>x.id===selWorkId);
  const pay={id:Date.now().toString(36),workId:selWorkId,date,amount,note};
  if(dataMode==='team') pay.createdBy=w?(w.ownerUid||w.createdBy):currentUser.uid;
  DB.payments.push(pay);
  const paidNow = w && !w.isPaid && rcvAmt(selWorkId) >= expAmt(w);
  if (paidNow) w.isPaid = true;
  localStorage.setItem('moksujilji2', JSON.stringify(DB));
  try {
    await saveOnePay(pay);
    if (paidNow) await updateOneWage(w);
  } catch(e) { console.error('저장 오류:', e); }
  closeOv('addPayOv'); openPayDetail(selWorkId); renderPay();
  if (paidNow) showToast('정산이 완료됐어요 ✓');
}

async function delPay(id) {
  if(!confirm('이 입금 내역을 삭제하시겠습니까?'))return;
  if (currentUser) {
    try {
      if (dataMode === 'team') {
        const pay = DB.payments.find(p => p.id === id);
        const isPersonalPay = pay && !!DB.works.find(w => w.id === pay.workId)?.isPersonal;
        if (isPersonalPay) {
          await fsdb.collection('users').doc(currentUser.uid).collection('payments').doc(id).delete();
        } else {
          await teamRef().collection('payments').doc(id).delete();
        }
      } else {
        await fsdb.collection('users').doc(currentUser.uid).collection('payments').doc(id).delete();
      }
    } catch(e) { console.error('삭제 오류:', e); alert('삭제 권한이 없거나 오류가 발생했습니다.'); return; }
  }
  DB.payments=DB.payments.filter(p=>p.id!==id);
  localStorage.setItem('moksujilji2', JSON.stringify(DB));
  openPayDetail(selWorkId); renderPay();
}

// ── 통계 ──
function moveStat(d) {
  statM+=d; if(statM>11){statM=0;statY++;} if(statM<0){statM=11;statY--;} renderStat();
}

function renderMemberStats() {
  const section = document.getElementById('memberStatsSection');
  if (!section) return;
  if (dataMode !== 'team' || teamRole !== 'leader') { section.style.display = 'none'; return; }
  section.style.display = '';

  // 현재 팀원 + 이전 팀원 uid 수집 (팀장 본인 제외)
  const allUids = [...new Set([
    ...teamMembers.filter(m => m.uid !== currentUser.uid).map(m => m.uid),
    ...teamMemberExits.map(e => e.uid).filter(u => u !== currentUser.uid)
  ])];

  const el = document.getElementById('memberStatsList');

  // 팀 전체 요약 (isPersonal 제외)
  const teamWorks = DB.works.filter(w => !w.isPersonal && w.wage != null);
  const totalWage = teamWorks.reduce((s, w) => s + expAmt(w), 0);
  const totalUnpaid = teamWorks.reduce((s, w) => s + Math.max(0, expAmt(w)-rcvAmt(w.id)), 0);
  const summaryHtml = `<div class="card" style="margin-bottom:12px;padding:14px 16px">
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px;font-weight:600">팀 전체 누적</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div><div style="font-size:11px;color:var(--muted)">총 인건비</div><div style="font-size:17px;font-weight:700">${fmtW(totalWage)}</div></div>
      <div><div style="font-size:11px;color:var(--muted)">전체 미지급금</div><div style="font-size:17px;font-weight:700;color:${totalUnpaid>0?'var(--red)':'var(--green)'}">${fmtW(totalUnpaid)}</div></div>
    </div>
  </div>`;

  if (allUids.length === 0) {
    el.innerHTML = summaryHtml + '<div class="es" style="padding:24px 0"><div class="es-title" style="font-size:15px">팀원 기록이 없어요</div></div>';
    return;
  }

  el.innerHTML = summaryHtml + allUids.map(uid => {
    const member = teamMembers.find(m => m.uid === uid);
    const isActive = !!member;
    const exitEntry = teamMemberExits.find(e => e.uid === uid);
    const name = member?.customName || member?.displayName || exitEntry?.displayName || memberName(uid);

    // 이 uid의 퇴장 기록 → 타임스탬프 오름차순
    const exitTimes = teamMemberExits
      .filter(e => e.uid === uid)
      .map(e => { const t = e.exitedAt; return t?.toMillis ? t.toMillis() : t?.seconds ? t.seconds*1000 : 0; })
      .filter(t => t > 0)
      .sort((a, b) => a - b);

    const totalPeriods = exitTimes.length + (isActive ? 1 : 0);
    const showLabel = totalPeriods > 1;

    // 이 uid의 팀 작업 기록
    const wages = DB.works.filter(w => !w.isPersonal && w.wage != null && (w.ownerUid === uid || (!w.ownerUid && w.createdBy === uid)));
    if (wages.length === 0 && !isActive) return '';

    // 기간별 그룹핑
    const groups = Array.from({ length: Math.max(totalPeriods, 1) }, () => []);
    wages.forEach(w => {
      const maxMs = Math.max(...(w.dates||[]).map(d => new Date(d+'T00:00:00').getTime()));
      let idx = exitTimes.findIndex(t => maxMs < t);
      if (idx === -1) idx = exitTimes.length;
      if (idx < groups.length) groups[idx].push(w);
    });

    const statusBadge = isActive
      ? `<span class="wi-badge badge-paid" style="font-size:10px">현재 팀원</span>`
      : `<span class="wi-badge" style="font-size:10px;background:var(--bg-sub);color:var(--muted)">이전 팀원</span>`;

    const periodsHtml = groups.map((gWages, i) => {
      if (gWages.length === 0) return '';
      const total = gWages.reduce((s, w) => s + expAmt(w), 0);
      const rcv = gWages.reduce((s, w) => s + rcvAmt(w.id), 0);
      const unpaid = Math.max(0, total - rcv);
      const header = showLabel ? `<div style="font-size:11px;font-weight:700;color:var(--muted);margin:10px 0 6px;padding-top:${i>0?'10px':0};border-top:${i>0?'1px solid var(--border)':''}">${i+1}기</div>` : '';
      const rows = gWages.sort((a,b)=>{
        const la=(a.dates||[])[0]||'', lb=(b.dates||[])[0]||''; return la.localeCompare(lb);
      }).map(w => {
        const cnt = (w.dates||[]).length;
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span style="color:var(--text2)">${w.site} · ${cnt}일</span>
          <span style="font-weight:600">${fmtW(expAmt(w))}</span>
        </div>`;
      }).join('');
      const unpaidColor = unpaid > 0 ? 'var(--red)' : 'var(--green)';
      const unpaidLbl = unpaid > 0 ? `미지급금 ${fmtW(unpaid)}` : '완납';
      return `${header}${rows}
        <div style="display:flex;justify-content:space-between;padding:7px 0 2px;font-size:13px">
          <span style="color:var(--muted)">합계 ${fmtW(total)}</span>
          <span style="font-weight:700;color:${unpaidColor}">${unpaidLbl}</span>
        </div>`;
    }).join('');

    return `<div class="card" style="margin-bottom:10px;padding:14px 16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-size:16px;font-weight:700">👤 ${name}</div>
        ${statusBadge}
      </div>
      ${periodsHtml || '<div style="font-size:13px;color:var(--muted);padding:4px 0">작업 기록이 없어요</div>'}
    </div>`;
  }).filter(Boolean).join('');

  if (!el.innerHTML) el.innerHTML = '<div class="es" style="padding:24px 0"><div class="es-title" style="font-size:15px">팀원 기록이 없어요</div></div>';
}

function renderIncomeChart() {
  const months=[];
  for(let i=5;i>=0;i--){
    let y=statY, m=statM-i;
    if(m<0){m+=12;y--;}
    const wage=DB.works.filter(w=>w.wage!=null&&getWorkStatus(w)!=='planned'&&(w.dates||[]).some(d=>{const p=parsD(d);return p.y===y&&p.m===m;}))
      .reduce((s,w)=>{const cnt=(w.dates||[]).filter(d=>{const p=parsD(d);return p.y===y&&p.m===m;}).length;return s+cnt*Number(w.wage)*Number(w.unit||1);},0);
    months.push({y,m,wage,lbl:`${m+1}월`});
  }
  const max=Math.max(...months.map(x=>x.wage),1);
  const chartH=90,padB=32,barW=30,gap=10;
  const totalW=months.length*(barW+gap)-gap;
  const bars=months.map((mo,i)=>{
    const x=i*(barW+gap);
    const barH=Math.max(4,Math.round((mo.wage/max)*chartH));
    const y=chartH-barH;
    const isCur=mo.y===statY&&mo.m===statM;
    const fill=isCur?'var(--pri)':'var(--border)';
    const textFill=isCur?'var(--pri)':'var(--muted)';
    const amtLbl=mo.wage>0?`${(mo.wage/10000).toFixed(0)}만`:'';
    return `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="5" fill="${fill}" opacity="${isCur?'1':'0.7'}"/>
      ${amtLbl?`<text x="${x+barW/2}" y="${y-5}" text-anchor="middle" font-size="9" fill="${textFill}" font-weight="700">${amtLbl}</text>`:''}
      <text x="${x+barW/2}" y="${chartH+15}" text-anchor="middle" font-size="10" fill="${textFill}" font-weight="${isCur?'700':'400'}">${mo.lbl}</text>`;
  }).join('');
  document.getElementById('incomeChart').innerHTML=`<svg viewBox="-4 -18 ${totalW+8} ${chartH+padB}" width="100%" style="overflow:visible;display:block">${bars}</svg>`;
}

function exportCSV() {
  if(dataMode==='team'&&teamRole!=='leader'){alert('팀원 모드에서는 전체 데이터 내보내기가 제한돼요.');return;}
  const short = s => s ? s.slice(5).replace('-', '/') : ''; // 'YYYY-MM-DD' → 'MM/DD'
  const rows=[['구분','팀원명','현장명','작업 내용','작업기간','작업일수','일당','품수','총금액','정산상태','수령액','미수금']];
  DB.works.filter(w=>w.wage!=null).forEach(w=>{
    const dates=(w.dates||[]).slice().sort();
    const period = dates.length===0 ? '' : dates.length===1
      ? short(dates[0])
      : `${short(dates[0])} ~ ${short(dates[dates.length-1])}`;
    const exp=expAmt(w), rcv=rcvAmt(w.id);
    const unpaid=Math.max(0,exp-rcv);
    const status=w.isPaid?'정산완료':(rcv>0?'부분정산':'미정산');
    const ownerName = dataMode==='team' ? (memberName(w.ownerUid||w.createdBy)||'') : '';
    const section = w.isPersonal ? '개인(날일)' : (dataMode==='team' ? '팀' : '개인');
    rows.push([section, ownerName, w.site, w.workDesc||'', period, dates.length, w.wage, w.unit||1, exp, status, rcv, unpaid]);
  });
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob=new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`목수일지_${todayStr()}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

function printReport() {
  const now = new Date();
  const userName = userDisplayName || currentUser?.displayName || '';
  const monthLabel = `${statY}년 ${statM + 1}월`;
  const todayLabel = `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')}`;

  const statBase = (dataMode === 'team' && teamRole !== 'leader')
    ? DB.works.filter(w => w.wage != null)
    : DB.works;
  const works = statBase.filter(w => (w.dates||[]).some(d => {
    const p = parsD(d); return p.y === statY && p.m === statM;
  }));

  let mWage = 0, sUnit = 0;
  works.forEach(w => {
    const cnt = (w.dates||[]).filter(d => { const p = parsD(d); return p.y === statY && p.m === statM; }).length;
    const u = Number(w.unit||1);
    mWage += cnt * Number(w.wage) * u;
    sUnit += cnt * u;
  });
  const workDays = new Set(works.flatMap(w =>
    (w.dates||[]).filter(d => { const p = parsD(d); return p.y === statY && p.m === statM; })
  )).size;
  const mPaid = DB.payments
    .filter(p => { const d = parsD(p.date); return d.y === statY && d.m === statM; })
    .reduce((s, p) => s + Number(p.amount), 0);
  const mOutstanding = works.reduce((s, w) =>
    w.wage == null || w.isPaid ? s : s + Math.max(0, expAmt(w) - rcvAmt(w.id)), 0);
  const sUnitStr = sUnit % 1 === 0 ? sUnit : sUnit.toFixed(1);

  const worksRows = works.map(w => {
    const mDates = (w.dates||[]).filter(d => { const p = parsD(d); return p.y === statY && p.m === statM; });
    const u = Number(w.unit||1);
    const total = mDates.length * Number(w.wage) * u;
    const outstanding = Math.max(0, expAmt(w) - rcvAmt(w.id));
    const statusLabel = w.isPaid ? '정산완료' : outstanding > 0 ? `미수 ${fmtW(outstanding)}` : '정산대기';
    const statusClass = w.isPaid ? 's-paid' : outstanding > 0 ? 's-unpaid' : 's-pending';
    return `<tr>
      <td class="td-site">${w.site}</td>
      <td class="td-sub">${formatDatesShort(mDates)}</td>
      <td class="td-num">${fmtW(w.wage)}</td>
      <td class="td-num">${u !== 1 ? u + '품' : '1품'}</td>
      <td class="td-num td-bold">${fmtW(total)}</td>
      <td class="td-center"><span class="badge ${statusClass}">${statusLabel}</span></td>
    </tr>`;
  }).join('');

  const payments = DB.payments
    .filter(p => { const d = parsD(p.date); return d.y === statY && d.m === statM; })
    .sort((a, b) => a.date.localeCompare(b.date));
  const payRows = payments.map(p => {
    const w = DB.works.find(x => x.id === p.workId);
    return `<tr>
      <td class="td-sub">${p.date.slice(5).replace('-','/')}</td>
      <td class="td-site">${w ? w.site : '—'}</td>
      <td class="td-num td-bold">${fmtW(p.amount)}</td>
      <td class="td-sub">${p.note || ''}</td>
    </tr>`;
  }).join('');

  const teamLabel = (dataMode === 'team' && teamInfo) ? `${teamInfo.name} · ` : '';
  const roleSuffix = (dataMode === 'team' && teamRole !== 'leader') ? ' (내 기록 기준)' : '';

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${monthLabel} 작업보고서</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard-dynamic-subset.min.css">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Pretendard',system-ui,-apple-system,sans-serif;color:#1a1a1a;background:#fff;padding:52px 60px;font-size:13px;line-height:1.6;}
  .doc-header{display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:20px;border-bottom:2px solid #1a1a1a;margin-bottom:36px;}
  .doc-brand{font-size:12px;font-weight:700;letter-spacing:2px;color:#888;text-transform:uppercase;margin-bottom:6px;}
  .doc-title{font-size:24px;font-weight:700;letter-spacing:-0.5px;}
  .doc-sub{font-size:13px;color:#666;margin-top:4px;}
  .doc-meta{text-align:right;font-size:12px;color:#666;line-height:2;}
  .doc-meta strong{color:#1a1a1a;font-size:15px;font-weight:700;display:block;margin-bottom:2px;}
  .section{margin-bottom:36px;}
  .section-title{font-size:10px;font-weight:700;letter-spacing:1.5px;color:#aaa;text-transform:uppercase;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #f0f0f0;}
  .summary-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}
  .scard{background:#f8f8f8;border-radius:10px;padding:16px 18px;}
  .scard.dark{background:#1a1a1a;color:#fff;}
  .scard.green{background:#f0faf1;border:1px solid #c8e6c9;}
  .scard.red{background:#fff8f0;border:1px solid #ffcc80;}
  .sc-label{font-size:11px;color:#999;margin-bottom:6px;}
  .scard.dark .sc-label{color:#888;}
  .scard.green .sc-label,.scard.red .sc-label{color:#777;}
  .sc-value{font-size:20px;font-weight:700;letter-spacing:-0.5px;}
  .sc-value.lg{font-size:22px;}
  table{width:100%;border-collapse:collapse;}
  th{font-size:11px;font-weight:600;color:#aaa;text-align:left;padding:8px 12px;background:#fafafa;border-top:1px solid #f0f0f0;border-bottom:1px solid #f0f0f0;}
  td{padding:11px 12px;border-bottom:1px solid #f5f5f5;vertical-align:middle;}
  tr:last-child td{border-bottom:none;}
  .td-site{font-weight:600;}
  .td-sub{color:#888;font-size:12px;}
  .td-num{text-align:right;font-variant-numeric:tabular-nums;}
  .td-bold{font-weight:700;}
  .td-center{text-align:center;}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;}
  .s-paid{background:#e8f5e9;color:#2e7d32;}
  .s-unpaid{background:#fff3e0;color:#e65100;}
  .s-pending{background:#f5f5f5;color:#888;}
  .doc-footer{margin-top:52px;padding-top:16px;border-top:1px solid #ebebeb;font-size:11px;color:#ccc;text-align:center;letter-spacing:0.5px;}
  @media print{
    body{padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    @page{margin:15mm 18mm;size:A4;}
  }
</style>
</head>
<body>

<div class="doc-header">
  <div>
    <div class="doc-brand">목수일지</div>
    <div class="doc-title">${monthLabel} 작업보고서</div>
    <div class="doc-sub">${teamLabel}${monthLabel}${roleSuffix}</div>
  </div>
  <div class="doc-meta">
    <strong>${userName}</strong>
    작성일 ${todayLabel}
  </div>
</div>

<div class="section">
  <div class="section-title">이달 요약</div>
  <div class="summary-grid">
    <div class="scard"><div class="sc-label">작업일수</div><div class="sc-value">${workDays}일</div></div>
    <div class="scard"><div class="sc-label">품수</div><div class="sc-value">${sUnitStr}품</div></div>
    <div class="scard"><div class="sc-label">현장 수</div><div class="sc-value">${works.length}곳</div></div>
    <div class="scard dark"><div class="sc-label">총 임금</div><div class="sc-value lg">${fmtW(mWage)}</div></div>
    <div class="scard green"><div class="sc-label">수령액</div><div class="sc-value lg">${fmtW(mPaid)}</div></div>
    <div class="scard ${mOutstanding > 0 ? 'red' : 'green'}"><div class="sc-label">미수금</div><div class="sc-value lg">${mOutstanding > 0 ? fmtW(mOutstanding) : '없음'}</div></div>
  </div>
</div>

${works.length > 0 ? `
<div class="section">
  <div class="section-title">현장별 작업 내역</div>
  <table>
    <thead><tr>
      <th>현장명</th><th>작업 기간</th>
      <th style="text-align:right">일당</th><th style="text-align:right">품수</th>
      <th style="text-align:right">총금액</th><th style="text-align:center">정산</th>
    </tr></thead>
    <tbody>${worksRows}</tbody>
  </table>
</div>` : ''}

${payments.length > 0 ? `
<div class="section">
  <div class="section-title">입금 내역</div>
  <table>
    <thead><tr>
      <th>날짜</th><th>현장</th><th style="text-align:right">금액</th><th>비고</th>
    </tr></thead>
    <tbody>${payRows}</tbody>
  </table>
</div>` : ''}

<div class="doc-footer">목수일지 · carpenter-wj.github.io/carpenter-app</div>
</body>
</html>`;

  const w = window.open('', '_blank', 'width=860,height=720');
  if (!w) { alert('팝업이 차단되어 있어요. 브라우저에서 팝업 허용 후 다시 시도해 주세요.'); return; }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 600);
}

function renderStat() {
  document.getElementById('statLbl').textContent=`${statY}년 ${statM+1}월`;
  renderIncomeChart();
  renderMemberStats();
  // 팀 모드에서 일반 팀원은 일당을 볼 수 있는(=본인이 등록한) 현장만 통계에 포함
  const statBase=(dataMode==='team'&&teamRole!=='leader')?DB.works.filter(w=>w.wage!=null):DB.works;
  const works=statBase.filter(w=>getWorkStatus(w)!=='planned'&&(w.dates||[]).some(d=>{const p=parsD(d);return p.y===statY&&p.m===statM;}));
  let mWage=0, mWageBase=0, sUnit=0;
  works.forEach(w=>{
    const cnt=(w.dates||[]).filter(d=>{const p=parsD(d);return p.y===statY&&p.m===statM;}).length;
    const u=Number(w.unit||1);
    mWage+=cnt*Number(w.wage)*u;
    mWageBase+=cnt*Number(w.wage); // 품수 제외 — 순수 일당 기준
    sUnit+=cnt*u;
  });
  const workDays=new Set(works.flatMap(w=>(w.dates||[]).filter(d=>{const p=parsD(d);return p.y===statY&&p.m===statM;}))).size;
  const mPaid=DB.payments.filter(p=>{const d=parsD(p.date);return d.y===statY&&d.m===statM;}).reduce((s,p)=>s+Number(p.amount),0);
  const mOutstanding=works.reduce((s,w)=>w.wage==null||w.isPaid?s:s+Math.max(0,expAmt(w)-rcvAmt(w.id)),0);
  const allOutstanding=statBase.filter(w=>getWorkStatus(w)!=='planned').reduce((s,w)=>w.isPaid?s:s+Math.max(0,expAmt(w)-rcvAmt(w.id)),0);
  const avgWage=workDays>0?Math.round(mWageBase/workDays):0;
  const sUnitStr=sUnit%1===0?sUnit:sUnit.toFixed(1);

  const now=new Date();
  const isCurStat=statY===now.getFullYear()&&statM===now.getMonth();
  const statMonthLbl=isCurStat?'이번 달':`${statY}년 ${statM+1}월`;
  const statSuffix=(dataMode==='team'&&teamRole!=='leader')?' (내 기록 기준)':'';
  document.getElementById('statSecTitle').textContent=statMonthLbl+' 작업 내역'+statSuffix;

  const isLeaderStat = dataMode==='team' && teamRole==='leader';
  document.getElementById('statGrid').innerHTML=`
    <div class="sbox"><div class="sl">작업일수</div><div class="sv">${workDays}일</div></div>
    <div class="sbox"><div class="sl">품수</div><div class="sv">${sUnitStr}품</div></div>
    <div class="sbox"><div class="sl">현장 수</div><div class="sv">${works.length}곳</div></div>
    <div class="sbox grn"><div class="sl">${statMonthLbl} ${isLeaderStat?'지급':'수령'}</div><div class="sv">${(mPaid/10000).toFixed(1)}만</div></div>
    <div class="sbox ori"><div class="sl">${isLeaderStat?'총 인건비':'총 임금'}</div><div class="sv">${(mWage/10000).toFixed(1)}만</div></div>
    <div class="sbox"><div class="sl">평균 일당</div><div class="sv">${workDays>0?fmtW(avgWage):'—'}</div></div>
    <div class="sbox ${mOutstanding>0?'red':'grn'}">
      <div class="sl">${statMonthLbl} ${isLeaderStat?'미지급금':'미수금'}</div><div class="sv">${fmtW(mOutstanding)}</div>
    </div>
    <div class="sbox ${allOutstanding>0?'red':'grn'}">
      <div class="sl">${isLeaderStat?'전체 미지급금':'전체 미수금'}</div><div class="sv">${fmtW(allOutstanding)}</div>
    </div>`;

  const wl=document.getElementById('statWList');
  if(works.length===0){wl.innerHTML=`<div class="es"><div class="es-icon">📊</div><div class="es-title">${statMonthLbl} 작업 기록이 없어요</div><div class="es-desc">기록 탭에서 현장을 추가하면<br>수입 통계가 자동으로 계산돼요</div></div>`;return;}
  wl.innerHTML=works.map(w=>{
    const mDates=(w.dates||[]).filter(d=>{const p=parsD(d);return p.y===statY&&p.m===statM;});
    const u=Number(w.unit||1);
    const total=mDates.length*Number(w.wage)*u;
    const calc=(()=>{const parts=[fmtW(w.wage)];if(mDates.length>1)parts.push(`${mDates.length}일`);if(u!==1)parts.push(`${u}품`);return parts.length>1?parts.join(' × '):'';})();
    return `
      <div class="witem">
        <div class="wi-main">
          <div class="wi-site">${w.site}${workTypeBadge(w)}</div>
          <div class="wi-dates">${formatDatesShort(mDates)}</div>
          <div class="wi-wage">일당 ${fmtW(w.wage)}${u!==1?` · ${u}품`:''}</div>
        </div>
        <div class="wi-right">
          <div class="wi-total">${fmtW(total)}</div>
          ${calc?`<div class="wi-calc">${calc}</div>`:''}
        </div>
      </div>`;
  }).join('');
}

// ── 백업 ──
function exportData() {
  if(dataMode==='team'){alert('팀 모드에서는 백업 내보내기를 사용할 수 없어요.\n(팀원에게는 전체 데이터가 보이지 않아 백업 의미가 달라져요)');return;}
  const blob=new Blob([JSON.stringify(DB,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`목수일지_백업_${todayStr()}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}
function importData(e) {
  if(dataMode==='team'){alert('팀 모드에서는 백업 복원을 사용할 수 없어요.');e.target.value='';return;}
  const file=e.target.files[0]; if(!file)return;
  const r=new FileReader();
  r.onload=ev=>{
    try {
      const p=JSON.parse(ev.target.result);
      if(!Array.isArray(p.works)||!Array.isArray(p.payments)){alert('올바른 백업 파일이 아닙니다.');return;}
      if(!confirm(`작업 ${p.works.length}건, 입금 ${p.payments.length}건.\n현재 데이터를 덮어쓰고 복원하시겠습니까?`))return;
      DB=p; save(); alert('복원 완료!');
      renderCal(); renderWork(); renderPay(); renderStat();
    } catch{alert('파일을 읽을 수 없습니다.');}
  };
  r.readAsText(file); e.target.value='';
}

// ── 오버레이 ──
function openOv(id){document.getElementById(id).classList.add('show');}
function closeOv(id){document.getElementById(id).classList.remove('show');}
function closeAll(){document.querySelectorAll('.ov').forEach(o=>o.classList.remove('show'));}
document.querySelectorAll('.ov').forEach(o=>{
  o.addEventListener('click',e=>{
    if(e.target!==o) return;
    if(o.id==='datePickOv') closeDatePickOv();
    else o.classList.remove('show');
  });
});

// ── Firebase 인증 상태 감지 ──
auth.getRedirectResult().catch(function(e){
  if (!e || !e.message || e.message.includes('missing initial state')) return;
  alert('로그인 오류 (' + e.code + ')\n' + e.message);
});

function renderCurrentTab() {
  if(curTab==='cal') renderCal();
  else if(curTab==='work') renderWork();
  else if(curTab==='pay') renderPay();
  else if(curTab==='stat') renderStat();
}

async function refreshFromCloud() {
  if(!currentUser) return;
  const ind=document.getElementById('ptrInd');
  ind.textContent='새로고침 중...'; ind.style.opacity='1';
  try {
    if (dataMode === 'team') {
      await loadTeamData();
    } else {
      const ref=fsdb.collection('users').doc(currentUser.uid);
      const [ws,ps]=await Promise.all([ref.collection('works').get(),ref.collection('payments').get()]);
      DB.works=ws.docs.map(d=>d.data());
      DB.payments=ps.docs.map(d=>d.data());
    }
    localStorage.setItem('moksujilji2',JSON.stringify(DB));
    renderCurrentTab();
  } catch(e){ console.error('새로고침 오류:',e); }
  setTimeout(()=>{ ind.style.opacity='0'; ind.textContent='당겨서 새로고침'; },800);
}

function initPTR() {
  const ind=document.getElementById('ptrInd');
  let startY=0, pulling=false;
  document.addEventListener('touchstart',e=>{
    if(document.querySelector('.ov.show')) return;
    if(window.scrollY===0) startY=e.touches[0].clientY;
  },{passive:true});
  document.addEventListener('touchmove',e=>{
    if(!startY||document.querySelector('.ov.show')) return;
    const dy=e.touches[0].clientY-startY;
    if(dy>0){
      pulling=true;
      const pct=Math.min(dy/80,1);
      ind.style.opacity=String(pct);
      ind.textContent=dy>80?'놓으면 새로고침':'당겨서 새로고침';
    }
  },{passive:true});
  document.addEventListener('touchend',async e=>{
    if(!startY||!pulling){startY=0;return;}
    const dy=e.changedTouches[0].clientY-startY;
    startY=0; pulling=false;
    if(dy>80){ await refreshFromCloud(); }
    else { ind.style.opacity='0'; ind.textContent='당겨서 새로고침'; }
  });
}

auth.onAuthStateChanged(user => {
  const loginScreen = document.getElementById('loginScreen');
  if (user) {
    currentUser = user;
    loginScreen.style.display = 'none';
    loadData();
    initPTR();
  } else {
    currentUser = null;
    stopPendingListener();
    stopNotifListener();
    DB = { works: [], payments: [], jobs: [], notifications: [], dailyNotes: {} };
    dataMode = 'personal'; activeTeamId = null; teamInfo = null; teamRole = null; teamMembers = [];
    loginScreen.style.display = 'flex';
  }
});

document.getElementById('fab').onclick=()=>openWorkOv(null,todayStr());
if('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(()=>{});
  navigator.serviceWorker.addEventListener('message', e => {
    if(e.data && e.data.type === 'SW_UPDATED') window.location.reload();
  });
}

window.addEventListener('offline', () => {
  showToast('오프라인 상태 — 입력한 내용은 저장되며 연결 시 자동으로 동기화됩니다');
});
window.addEventListener('online', () => {
  showToast('인터넷 연결됨 — 데이터를 동기화합니다');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser && dataMode === 'team') {
    loadTeamData().then(() => renderCurrentTab()).catch(() => {});
  }
});
