const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {getAuth} = require('firebase-admin/auth');
const {getStorage} = require('firebase-admin/storage');
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

// 카카오는 Firebase가 기본 제공하는 로그인 프로바이더가 아니라서, 구글처럼
// id_token을 바로 Firebase에 넣을 수 없다 — 카카오 토큰을 서버에서 검증한 뒤
// Firebase 전용 커스텀 토큰을 발급해서 클라이언트가 signInWithCustomToken()으로
// 로그인하게 한다. uid는 카카오 고유 ID 기반으로 고정(kakao:{카카오ID})해서
// 같은 사람이 다시 로그인하면 항상 같은 Firebase 계정으로 연결됨.
const KAKAO_REST_API_KEY = 'a3369f716e4b4affaf82d8288c92f86c';
const KAKAO_NATIVE_APP_KEY = '4c7161f9f8b8349d951c03acd51a48e3';

// 카카오 Redirect URI는 https:// 만 등록 가능(구글과 달리 앱 커스텀 스킴을
// 직접 등록 못 함) — 그래서 이 HTTPS 주소를 카카오에 등록해두고, 카카오가
// 여기로 리다이렉트하면 곧바로 앱의 커스텀 스킴(kakao{네이티브앱키}://oauth)
// 으로 302 리다이렉트시켜서 네이티브 앱의 appUrlOpen 리스너가 받게 중계한다.
exports.kakaoAuthRelay = onRequest({
  region: 'asia-northeast3',
  invoker: 'public',
}, (req, res) => {
  const params = new URLSearchParams();
  if (req.query.code) params.set('code', String(req.query.code));
  if (req.query.state) params.set('state', String(req.query.state));
  if (req.query.error) params.set('error', String(req.query.error));
  res.redirect(302, `kakao${KAKAO_NATIVE_APP_KEY}://oauth?${params.toString()}`);
});

exports.exchangeKakaoAuthV2 = onRequest({
  region: 'asia-northeast3',
  invoker: 'public',
  secrets: ['KAKAO_CLIENT_SECRET'],
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

    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KAKAO_REST_API_KEY,
      client_secret: process.env.KAKAO_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    });
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: tokenParams.toString(),
    });
    const tokenRawBody = await tokenRes.text();
    let tokenData;
    try {
      tokenData = JSON.parse(tokenRawBody);
    } catch (e) {
      res.status(502).json({error: 'internal', message: '카카오 응답을 처리하지 못했습니다.'});
      return;
    }
    if (!tokenRes.ok || !tokenData.access_token) {
      res.status(400).json({error: 'failed-precondition', message: tokenData.error_description || tokenData.error || '토큰 교환에 실패했습니다.'});
      return;
    }

    const profileRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: {'Authorization': `Bearer ${tokenData.access_token}`},
    });
    const profile = await profileRes.json();
    if (!profileRes.ok || !profile.id) {
      res.status(502).json({error: 'internal', message: '카카오 사용자 정보를 가져오지 못했습니다.'});
      return;
    }

    const uid = `kakao:${profile.id}`;
    const nickname = (profile.kakao_account && profile.kakao_account.profile && profile.kakao_account.profile.nickname)
      || (profile.properties && profile.properties.nickname) || null;
    const customToken = await getAuth().createCustomToken(uid);
    res.status(200).json({customToken, nickname});
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

  // 결제 시작 시 클라이언트가 미리 기록해 둔 의도(paymentIntents) 문서로
  // 이 paymentId가 실제로 이 호출자 본인이 시작한 결제인지 확인.
  // 이 검증이 없으면 다른 사람의 paymentId(노출/추측 가능)를 대신 제출해
  // 자기 계정에 프리미엄을 무단으로 부여할 수 있음.
  const intentRef = db.collection('paymentIntents').doc(paymentId);
  const intentSnap = await intentRef.get();
  if (!intentSnap.exists || intentSnap.data().uid !== uid) {
    throw new HttpsError('permission-denied', '본인이 시작한 결제만 확인할 수 있습니다.');
  }

  const userRef = db.collection('users').doc(uid);
  const purchaseRef = db.collection('purchases').doc(paymentId);
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

  const result = await db.runTransaction(async (tx) => {
    const purchaseSnap = await tx.get(purchaseRef);
    if (purchaseSnap.exists) {
      return {tier: purchaseSnap.data().tier, alreadyProcessed: true};
    }
    tx.set(purchaseRef, {
      uid, tier, amount: expectedAmount, paymentId,
      confirmedAt: FieldValue.serverTimestamp(),
    });
    tx.set(userRef, {premiumTier: tier}, {merge: true});
    return {tier, alreadyProcessed: false};
  });

  return {success: true, tier: result.tier, alreadyProcessed: result.alreadyProcessed};
});

// 네이티브 앱(iOS/안드로이드) 인앱결제(RevenueCat) 확인. 상품 가격은 스토어
// 카탈로그가 고정하므로(포트원과 달리 클라이언트가 금액을 정하지 않음) 금액 검증은
// 불필요 — "이 uid가 지금 요청한 tier의 entitlement를 실제로 보유하고 있는가"만
// RevenueCat 서버에 직접 조회해서 확인한다.
exports.confirmNativePurchase = onCall({
  region: 'asia-northeast3',
  secrets: ['REVENUECAT_SECRET_API_KEY'],
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const uid = request.auth.uid;
  const {tier} = request.data || {};
  if (!['personal', 'leader'].includes(tier)) {
    throw new HttpsError('invalid-argument', '잘못된 요청입니다.');
  }

  const rcRes = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`, {
    headers: {'Authorization': `Bearer ${process.env.REVENUECAT_SECRET_API_KEY}`},
  });
  const rcData = await rcRes.json();
  if (!rcRes.ok) {
    throw new HttpsError('failed-precondition', rcData.message || '구매 확인에 실패했습니다.');
  }

  const entitlement = rcData.subscriber && rcData.subscriber.entitlements && rcData.subscriber.entitlements[tier];
  const isActive = !!entitlement && (!entitlement.expires_date || new Date(entitlement.expires_date) > new Date());
  if (!isActive) {
    throw new HttpsError('failed-precondition', '구매 내역을 확인할 수 없습니다.');
  }

  const productId = entitlement.product_identifier;
  const txns = (rcData.subscriber.non_subscriptions && rcData.subscriber.non_subscriptions[productId]) || [];
  const lastTxn = txns[txns.length - 1];
  const transactionId = (lastTxn && lastTxn.id) || `${uid}_${productId}`;
  const purchaseId = `rc_${transactionId}`;

  const db = getFirestore();
  const purchaseRef = db.collection('purchases').doc(purchaseId);
  const userRef = db.collection('users').doc(uid);

  const result = await db.runTransaction(async (tx) => {
    const purchaseSnap = await tx.get(purchaseRef);
    if (purchaseSnap.exists) {
      return {tier: purchaseSnap.data().tier, alreadyProcessed: true};
    }
    tx.set(purchaseRef, {
      uid, tier, provider: 'revenuecat', store: (lastTxn && lastTxn.store) || null,
      productId, transactionId, confirmedAt: FieldValue.serverTimestamp(),
    });
    tx.set(userRef, {premiumTier: tier}, {merge: true});
    return {tier, alreadyProcessed: false};
  });

  return {success: true, tier: result.tier};
});

// 계정 삭제(회원 탈퇴) — 애플 심사 가이드라인 5.1.1(v) 대응.
// 관리자 SDK로 처리해서 클라이언트 재인증(auth/requires-recent-login) 문제 없이
// 팀 정리 + Firestore 데이터 + Storage 사진 + Auth 계정까지 한 번에 삭제한다.
exports.deleteAccount = onCall({
  region: 'asia-northeast3',
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const uid = request.auth.uid;
  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);

  const userSnap = await userRef.get();
  const teamId = userSnap.exists ? userSnap.data().teamId : null;

  if (teamId) {
    const teamDocRef = db.collection('teams').doc(teamId);
    const teamSnap = await teamDocRef.get();
    if (teamSnap.exists) {
      if (teamSnap.data().leaderUid === uid) {
        // 팀장 계정 삭제 → 팀 해체(팀원들은 다음 로그인 시 개인으로 이관됨)
        const batch = db.batch();
        batch.update(teamDocRef, {disbanded: true, disbandedAt: FieldValue.serverTimestamp()});
        if (teamSnap.data().inviteCode) {
          batch.update(db.collection('inviteCodes').doc(teamSnap.data().inviteCode), {active: false});
        }
        await batch.commit();
      } else {
        // 팀원 계정 삭제 → 팀에서만 제거(본인 기록은 어차피 전부 삭제되니 이관 불필요)
        await teamDocRef.collection('members').doc(uid).delete();
        await teamDocRef.update({memberCount: FieldValue.increment(-1)});
      }
    }
  }

  // Firestore 하위 컬렉션 삭제 (works/payments/dailyNotes)
  for (const sub of ['works', 'payments', 'dailyNotes']) {
    const snap = await userRef.collection(sub).get();
    if (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  await userRef.delete();

  // 작업 사진(Storage) 삭제 — 실패해도 계정 삭제 자체는 계속 진행
  try {
    await getStorage().bucket().deleteFiles({prefix: `workPhotos/${uid}/`});
  } catch (e) {
    console.warn('작업 사진 삭제 실패:', e.message);
  }

  await getAuth().deleteUser(uid);

  return {success: true};
});
