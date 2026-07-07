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

  const lines = [`현장명: ${site}`];
  if (address) lines.push(`주소: ${address}`);
  if (workDesc) lines.push(`작업 내용: ${workDesc}`);
  if (contact) lines.push(`담당자: ${contact}${phone ? ` (${phone})` : ''}`);
  if (memo) lines.push(`현장 메모: ${memo}`);

  const recentDates = (dates || []).sort().slice(-10);
  if (recentDates.length) lines.push(`최근 작업일: ${recentDates.join(', ')}`);

  const workerLines = (workers || []).map(w =>
    `- ${w.name}: 일당 ${Number(w.wage || 0).toLocaleString('ko-KR')}원 × ${w.unit || 1}품`
  );
  if (workerLines.length) lines.push(`\n참여 인원:\n${workerLines.join('\n')}`);

  const prompt = `다음 건설 현장 정보를 바탕으로 팀장을 위한 현장 브리핑 노트를 한국어로 작성해줘.

${lines.join('\n')}

아래 항목을 포함해서 간결하게 작성해줘:
• 현장 요약 (2~3문장)
• 주요 작업 및 특이사항
• 인건비 현황

전문적이고 실용적인 어조로, 핵심만 담아 250자 내외로 써줘.`;

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
