export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { places, niche, city } = req.body;
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
            content: `Você é um especialista em diagnóstico de presença digital de pequenos negócios brasileiros.

Analise cada negócio abaixo e identifique problemas reais de posicionamento e presença digital.

CRITÉRIOS OBRIGATÓRIOS para pontuacao "alta":
- Sem site (site vazio ou ausente) → SEMPRE alta
- Menos de 10 avaliações → SEMPRE alta  
- Nota abaixo de 3.8 → SEMPRE alta
- Dois ou mais dos critérios acima → SEMPRE alta
Caso contrário: "media"

Dados dos negócios de "${niche}" em "${city}":
${JSON.stringify(batch)}

Retorne EXATAMENTE este JSON com uma entrada por negócio na mesma ordem:
{"analises":[{"nome":"nome exato do negócio","problemas":"Frase 1 sobre problema específico observado nos dados. Frase 2 sobre impacto disso no negócio.","pontuacao":"alta","comentario":"Uma frase provocativa e específica para comentar no Instagram deste negócio","dm":"Oi [nome do dono], [observação específica sobre o negócio]. Isso está custando clientes todo dia. Tenho 10 minutos para te mostrar o que está acontecendo — quando podemos conversar?"}]}`
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
  
