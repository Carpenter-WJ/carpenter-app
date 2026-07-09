const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const Anthropic = require('@anthropic-ai/sdk');

initializeApp();

function icsEscape(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function nextDay(ds) {
  const d = new Date(ds + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// TODO: 배포 실패 원인 파악 전까지 비활성화 (Cloud Run 권한 문제로 추정, GitHub Actions 로그 확인 필요)
async function calendarFeedHandler(req, res) {
  const uid = req.query.uid;
  const token = req.query.token;
  if (!uid || !token) {
    res.status(400).send('잘못된 요청입니다.');
    return;
  }

  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : null;

  if (!userData || !userData.calendarFeedToken || userData.calendarFeedToken !== token) {
    res.status(403).send('유효하지 않은 구독 링크입니다.');
    return;
  }

  const works = [];
  const personalSnap = await userRef.collection('works').get();
  personalSnap.docs.forEach((d) => works.push(d.data()));

  if (userData.teamId) {
    const teamRef = db.collection('teams').doc(userData.teamId);
    const [wagesSnap, jobsSnap] = await Promise.all([
      teamRef.collection('wages').where('ownerUid', '==', uid).get(),
      teamRef.collection('jobs').get(),
    ]);
    const jobById = {};
    jobsSnap.docs.forEach((d) => { jobById[d.id] = d.data(); });
    wagesSnap.docs.forEach((d) => {
      const wg = d.data();
      const job = jobById[wg.jobId] || {};
      works.push({site: job.site || '현장', dates: wg.dates || [], workDesc: wg.workDesc || ''});
    });
  }

  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//목수일지//KO',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:목수일지 작업일정',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
  ];
  works.forEach((w) => {
    (w.dates || []).forEach((ds) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return;
      const dtStart = ds.replace(/-/g, '');
      const eventUid = `${ds}-${w.site || ''}`.replace(/[^a-zA-Z0-9-]/g, '') + `-${uid}@moksujilji`;
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${eventUid}`);
      lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`);
      lines.push(`DTSTART;VALUE=DATE:${dtStart}`);
      lines.push(`DTEND;VALUE=DATE:${nextDay(ds)}`);
      lines.push(`SUMMARY:${icsEscape(w.site || '현장')}${w.workDesc ? icsEscape(' - ' + w.workDesc) : ''}`);
      lines.push('END:VEVENT');
    });
  });
  lines.push('END:VCALENDAR');

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(lines.join('\r\n'));
}
// exports.calendarFeed = onRequest({region: 'asia-northeast3'}, calendarFeedHandler);

exports.generateSiteBriefing = onCall({
  region: 'asia-northeast3',
  secrets: ['ANTHROPIC_API_KEY'],
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const uid = request.auth.uid;
  const {site, workDesc, address, contact, phone, memo, dates, workers} = request.data;

  if (!site) {
    throw new HttpsError('invalid-argument', '현장명이 없습니다.');
  }

  const db = getFirestore();
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : {};
  const isPremium = userData.premiumTier === 'leader';

  if (!isPremium) {
    const usedThisMonth = (userData.aiCalls || {})[monthKey] || 0;
    if (usedThisMonth >= 1) {
      throw new HttpsError('resource-exhausted', 'free_limit_reached');
    }
  }

  const info = [`현장명: ${site}`];
  if (workDesc) info.push(`작업 내용: ${workDesc}`);
  if (address) info.push(`주소: ${address}`);
  if (contact) info.push(`담당자: ${contact}${phone ? ` (${phone})` : ''}`);
  if (memo) info.push(`메모: ${memo}`);

  const recentDates = (dates || []).sort().slice(-10);
  if (recentDates.length) info.push(`진행 날짜: ${recentDates.join(', ')}`);

  const prompt = `아래 현장 정보를 바탕으로 팀장용 메모를 작성해줘.

${info.join('\n')}

출력 형식 예시:
가벽 설치 및 마감 작업 진행 예정.
주소: 서울시 강남구 테헤란로 123, 5층
담당자: 김철수 (010-1234-5678)
특이사항: 지하 주차장 이용 가능, 출입 비번 1234

지켜야 할 규칙:
- 예시처럼 제목·헤더 없이 내용만 줄바꿈으로 나열
- 특수기호(**, ##, -, * 등) 사용 금지
- 일당·인건비 내용 포함 금지
- 200자 내외`;

  const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{role: 'user', content: prompt}],
  });

  const briefing = response.content[0].text;

  if (!isPremium) {
    await userRef.set(
      {aiCalls: {[monthKey]: FieldValue.increment(1)}},
      {merge: true}
    );
  }

  return {briefing, isPremium};
});
