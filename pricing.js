(function (root) {
  const PRICING = {
    personal: {regular: 14900, promo: 9900},
    leader: {regular: 19900, promo: 14900},
  };
  // TODO: 최종 배포일 확정되면 채워넣기 — 배포 후 1개월간 오픈 기념가 적용
  const LAUNCH_DATE = null;

  function isPromoActive() {
    if (!LAUNCH_DATE) return false; // 배포일 미확정 상태에서는 정가만 노출
    const end = new Date(LAUNCH_DATE);
    end.setMonth(end.getMonth() + 1);
    return new Date() < end;
  }

  function getPrice(tier) {
    const p = PRICING[tier];
    return isPromoActive() ? p.promo : p.regular;
  }

  // 팀장 업그레이드 시 이미 낸 개인 프리미엄 금액을 차감한 실제 결제 금액.
  function getCheckoutAmount(tier, currentTier) {
    const price = getPrice(tier);
    if (tier === 'leader' && currentTier === 'personal') {
      return Math.max(0, price - getPrice('personal'));
    }
    return price;
  }

  const api = {PRICING, LAUNCH_DATE, isPromoActive, getPrice, getCheckoutAmount};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : global);
