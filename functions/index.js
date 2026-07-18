const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const {getCheckoutAmount} = require('./pricing.js');

initializeApp();

function icsEscape(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function nextDay(ds) {
  const d = new Date(ds + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

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
  personalSnap.docs.forEach((d) => works.push({...d.data(), id: d.id}));

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
      works.push({site: job.site || '현장', dates: wg.dates || [], workDesc: wg.workDesc || '', id: d.id});
    });
  }

  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//현장일지//KO',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:현장일지 작업일정',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
  ];
  works.forEach((w) => {
    (w.dates || []).forEach((ds) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return;
      const dtStart = ds.replace(/-/g, '');
      // 현장명이 대부분 한글이라 예전엔 site를 UID에 섞으면 다 지워져서 같은 날짜에
      // 현장이 여러 곳이면 ID가 겹치는 문제가 있었음 — 문서 id 기반으로 고유성 보장
      const eventUid = `${w.id}-${ds}@moksujilji`;
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
exports.calendarFeed = onRequest({region: 'asia-northeast3', invoker: 'public'}, calendarFeedHandler);

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

// 네이티브 앱(Capacitor)에서 시스템 브라우저로 구글 로그인 후 받은 authorization
// code를 id_token으로 교환. onCall(콜러블)은 capacitor://localhost처럼 표준
// http(s)가 아닌 origin에서 CORS 처리가 막히는 것으로 확인되어(사파리 직접
// 접속은 되는데 웹뷰의 fetch만 "Load failed"), CORS를 직접 제어할 수 있는
// onRequest(일반 HTTP)로 전환하고 모든 origin을 명시적으로 허용.
exports.exchangeGoogleAuthCodeV2 = onRequest({
  region: 'asia-northeast3',
  invoker: 'public',
}, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const body = req.body || {};
    const code = body.code;
    const codeVerifier = body.codeVerifier;
    const redirectUri = body.redirectUri;
    if (!code || !codeVerifier || !redirectUri) {
      res.status(400).json({error: 'invalid-argument', message: '잘못된 요청입니다.'});
      return;
    }

    const params = new URLSearchParams({
      code,
      client_id: '774763481439-s6dk1irvkp4af0j6lgqoa6pse81dnuak.apps.googleusercontent.com',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: params.toString(),
    });
    const rawBody = await tokenRes.text();

    let tokenData;
    try {
      tokenData = JSON.parse(rawBody);
    } catch (e) {
      res.status(502).json({error: 'internal', message: '구글 응답을 처리하지 못했습니다.'});
      return;
    }

    if (!tokenRes.ok) {
      res.status(400).json({error: 'failed-precondition', message: tokenData.error_description || tokenData.error || '토큰 교환에 실패했습니다.'});
      return;
    }
    if (!tokenData.id_token) {
      res.status(502).json({error: 'internal', message: '인증 토큰을 받지 못했습니다.'});
      return;
    }

    res.status(200).json({idToken: tokenData.id_token});
  } catch (e) {
    res.status(500).json({error: 'internal', message: e && e.message ? e.message : String(e)});
  }
});

exports.confirmPortOnePayment = onCall({
  region: 'asia-northeast3',
  secrets: ['PORTONE_API_SECRET'],
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const uid = request.auth.uid;
  const {paymentId, tier} = request.data;

  if (!paymentId || !['personal', 'leader'].includes(tier)) {
    throw new HttpsError('invalid-argument', '잘못된 요청입니다.');
  }

  const db = getFirestore();
  const purchaseRef = db.collection('purchases').doc(paymentId);
  const purchaseSnap = await purchaseRef.get();
  if (purchaseSnap.exists) {
    return {success: true, tier: purchaseSnap.data().tier, alreadyProcessed: true};
  }

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const currentTier = userSnap.exists ? (userSnap.data().premiumTier || null) : null;
  const expectedAmount = getCheckoutAmount(tier, currentTier);

  const portoneRes = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}`, {
    headers: {'Authorization': `PortOne ${process.env.PORTONE_API_SECRET}`},
  });
  const payment = await portoneRes.json();
  if (!portoneRes.ok) {
    throw new HttpsError('failed-precondition', payment.message || '결제 조회에 실패했습니다.');
  }
  if (payment.status !== 'PAID') {
    throw new HttpsError('failed-precondition', '결제가 완료되지 않았습니다.');
  }
  if (!payment.amount || payment.amount.total !== expectedAmount) {
    throw new HttpsError('invalid-argument', '결제 금액이 올바르지 않습니다.');
  }

  await db.runTransaction(async (tx) => {
    tx.set(purchaseRef, {
      uid, tier, amount: expectedAmount, paymentId,
      confirmedAt: FieldValue.serverTimestamp(),
    });
    tx.set(userRef, {premiumTier: tier}, {merge: true});
  });

  return {success: true, tier};
});
