export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { places, niche, city, offer } = req.body;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;

  const leadsRaw = places.map(p => ({
    nome: p.title || 'Sem nome',
    categoria: p.categoryName || niche,
    endereco: p.address || city,
    telefone: p.phone || '',
    avaliacao: p.totalScore ? p.totalScore.toFixed(1) : null,
    totalAvaliacoes: p.reviewsCount || 0,
    site: p.website || ''
  }));

  const ctaLine = offer
    ? `Você tem disponibilidade amanhã ou quinta-feira para eu te mostrar como resolver isso com ${offer}?`
    : `Você tem disponibilidade amanhã ou quinta-feira para eu te mostrar exatamente o que está acontecendo e o que pode ser feito?`;

  const BATCH_SIZE = 20;
  const batches = [];
  for (let i = 0; i < leadsRaw.length; i += BATCH_SIZE) {
    batches.push(leadsRaw.slice(i, i + BATCH_SIZE));
  }

  try {
    const results = [];

    for (const batch of batches) {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 6000,
          system: 'Retorne APENAS JSON puro válido. Sem markdown. Sem backticks. Sem texto antes ou depois do JSON.',
          messages: [{
            role: 'user',
            content: `Você é um especialista em prospecção B2B e diagnóstico de presença digital de pequenos negócios brasileiros.

Analise cada negócio abaixo e gere diagnóstico e abordagem profissional. Nunca use emojis. Tom direto, sem elogios vazios.

CRITÉRIOS para pontuacao "alta":
- Sem site → SEMPRE alta
- Menos de 10 avaliações → SEMPRE alta
- Nota abaixo de 3.8 → SEMPRE alta
- Dois ou mais critérios acima → SEMPRE alta
Caso contrário: "media"

PADRÃO DE DIAGNÓSTICO:
Frase 1 — problema específico com dado real + contexto do mercado local de ${city}.
Frase 2 — mecanismo: por que isso está custando clientes ativamente, não só que está custando.

PADRÃO DE COMENTÁRIO INSTAGRAM:
Observação cirúrgica baseada em dado real do negócio. Sem emoji. Sem elogio. Sem template óbvio. O dono lê e pensa "como essa pessoa sabe isso?". Máximo 2 frases.

PADRÃO DE DM WHATSAPP:
- Gancho: "Oi, pesquisei [nome do negócio] em ${city} e encontrei algo que está custando clientes ativamente."
- Body: mecanismo em uma frase — por que aquele problema específico elimina o negócio da consideração antes do contato.
- CTA: "${ctaLine}"

Dados dos negócios de "${niche}" em "${city}":
${JSON.stringify(batch)}

Retorne EXATAMENTE este JSON com uma entrada por negócio na mesma ordem:
{"analises":[{"nome":"nome exato do negócio","problemas":"Frase 1. Frase 2.","pontuacao":"alta ou media","comentario":"comentário Instagram sem emoji","dm":"DM WhatsApp completa com gancho + body + CTA"}]}`
          }]
        })
      });

      const data = await aiRes.json();
      const raw = data.content.map(i => i.text || '').join('');

      let parsed = null;
      try {
        parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      } catch {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]);
      }

      if (parsed?.analises) results.push(...parsed.analises);
    }

    return res.status(200).json({ analises: results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
