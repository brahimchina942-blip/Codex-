// 固定示例，完全离线；不读取或假装分析用户图片。界面始终明确标为演示。
export const DEMO = {
  identity: { name: '演示客户 · Amine', phone: '' },
  messages: [
    { speaker: 'customer', original: 'Salam, je veux expédier des meubles men Yiwu l Casa. 15 CBM, bghit porte à porte.', chinese: '你好，我想把家具从义乌运到卡萨布兰卡。15立方米，需要门到门运输。', language: 'français + Arabizi', visible_time: '2026-10-14 10:20', uncertain: false },
    { speaker: 'self', original: 'Merci 😊 Tu as le poids total et des photos des meubles ?', chinese: '谢谢😊 你有总重量和家具照片吗？', language: 'français', visible_time: '2026-10-14 10:22', uncertain: false },
    { speaker: 'customer', original: 'Actually 20 CBM. Chhal total avec douane et livraison ? Le poids mazal ma 3reftch.', chinese: '实际上是20立方米。包含清关和派送的总费用是多少？总重量我还不知道。', language: 'English + français + Arabizi', visible_time: '2026-10-14 10:25', uncertain: false }
  ],
  summary: '演示客户咨询义乌到卡萨布兰卡的家具门到门运输，货量由15CBM更正为20CBM。希望确认清关和派送在内的总费用，总重量暂未确定。',
  intent: '门到门询价 · 需补总重量与货物照片',
  warnings: ['这是一组固定演示数据，不是千问对真实截图的识别结果。', '20CBM是本次最新数量，15CBM需保留为历史。门到门不能直接视为已确认DDP含税。'],
  facts: [
    { field: 'goods', value: '家具', certainty: 'stated', message_index: 0 },
    { field: 'origin', value: '义乌', certainty: 'stated', message_index: 0 },
    { field: 'destination', value: '卡萨布兰卡（Casablanca / Casa）', certainty: 'stated', message_index: 0 },
    { field: 'volume', value: '15 CBM', certainty: 'stated', message_index: 0 },
    { field: 'volume', value: '20 CBM', certainty: 'stated', message_index: 2 },
    { field: 'terms', value: '门到门，客户询问清关和派送总费用；是否含税待确认', certainty: 'stated', message_index: 2 },
    { field: 'follow_up', value: '补充总重量和货物照片，核对含税及派送范围后报价', certainty: 'inferred', message_index: 2 }
  ],
  replies: [
    { style: 'professional', text: 'Merci pour la précision. On retient donc 20 CBM. Peux-tu m’envoyer des photos des meubles et le poids total quand tu l’auras ? Je pourrai ensuite vérifier le coût total jusqu’à ton adresse à Casablanca, avec le détail du dédouanement, des taxes et de la livraison.', chinese: '谢谢更正，货量按20立方米考虑。请发家具照片，知道总重量后也告诉我。然后我会核对送到卡萨布兰卡收货地址的总费用，以及清关、税费和派送的明细。', language: 'français' },
    { style: 'friendly', text: 'Wakha 😊 donc 20 CBM. Sift lia les photos des meubles, et le poids ملي تعرفو. Nchouf lik le total jusqu’à ton adresse f Casa, et on confirme ensemble douane, taxes et livraison.', chinese: '好的😊 那就是20立方米。发家具照片给我，知道重量后再告诉我。我帮你核对到卡萨收货地址的总费用，再一起确认清关、税费和派送范围。', language: 'Darija + français' },
    { style: 'short', text: 'Noté, 20 CBM 😊 Envoie-moi les photos et le poids dès que tu l’as, puis je vérifie le total jusqu’à ton adresse à Casa.', chinese: '记下了，20立方米😊 发照片给我，知道重量后告诉我，再帮你核对送到卡萨收货地址的总费用。', language: 'français' }
  ]
};
