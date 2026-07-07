const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const Anthropic = require('@anthropic-ai/sdk');

initializeApp();

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
