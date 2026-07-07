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
  const isPremium = userData.isPremium || false;

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

  const prompt = `다음 건설 현장 정보를 바탕으로 팀장을 위한 현장 브리핑 노트를 작성해줘.

${info.join('\n')}

작성 규칙:
- 섹션 제목 없이 바로 내용만 작성
- 작업 내용, 현장 주소, 담당자 연락처, 특이사항(메모) 순서로 각 항목을 한 줄씩 서술
- 마크다운 기호(**, ##, -, * 등) 절대 사용 금지
- 인건비·일당·임금 정보는 포함하지 않음
- 200자 내외로 간결하게
- 한국어로 작성`;

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
