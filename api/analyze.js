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

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: 'Retorne APENAS JSON puro válido. Sem markdown. Sem backticks.',
        messages: [{
          role: 'user',
          content: `Analise estes negócios reais de "${niche}" em "${city}" para prospecção. Dados: ${JSON.stringify(leadsRaw)}. Sem site=problema grave, poucas avaliações=invisível, nota abaixo 3.8=reputação fraca. Retorne: {"analises":[{"nome":"nome exato","problemas":"2 frases sobre problemas reais","pontuacao":"alta ou media","comentario":"1 frase provocativa para Instagram","dm":"mensagem 3 frases WhatsApp: Oi+nome, algo específico observado, diagnóstico gratuito 10min, CTA direto"}]}`
        }]
      })
    });

    const data = await aiRes.json();
    const raw = data.content.map(i => i.text || '').join('');
    try {
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      return res.status(200).json(parsed);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      return res.status(200).json(m ? JSON.parse(m[0]) : { analises: [] });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
