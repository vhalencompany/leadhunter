export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { places, niche, city, offer } = req.body;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;

  const ctaLine = offer
    ? `Você tem disponibilidade amanhã ou quinta-feira para eu te mostrar como resolver isso com ${offer}?`
    : `Você tem disponibilidade amanhã ou quinta-feira para eu te mostrar exatamente o que está acontecendo e o que pode ser feito?`;

  // Normaliza leads — inclui Instagram e Reviews quando disponíveis
  const leadsRaw = places.map(p => {
    const base = {
      nome:            p.title || 'Sem nome',
      categoria:       p.categoryName || niche,
      endereco:        p.address || city,
      telefone:        p.phone || '',
      avaliacao:       p.totalScore ? p.totalScore.toFixed(1) : null,
      totalAvaliacoes: p.reviewsCount || 0,
      site:            p.website || ''
    };

    // ─── Enriquecimento Instagram ─────────────────────────────────────────
    if (p.igEnriched) {
      const ig = p.igEnriched;
      const postsResume = ig.recentPosts?.length
        ? ig.recentPosts.map(post => {
            const date = post.timestamp
              ? new Date(post.timestamp).toLocaleDateString('pt-BR')
              : 'data desconhecida';
            const caption = post.caption
              ? `"${post.caption.slice(0, 100)}${post.caption.length > 100 ? '...' : ''}"`
              : '(sem legenda)';
            return `  • ${date} — ${post.likes} curtidas — ${caption}`;
          }).join('\n')
        : '  • Nenhum post recente';

      base.instagram = {
        username:           ig.username,
        seguidores:         ig.followers,
        totalPosts:         ig.postsCount,
        bio:                ig.bio || '(vazia)',
        siteNaBio:          ig.site || '(nenhum)',
        categoriaInstagram: ig.businessCategory || '(não definida)',
        mediaLikes:         ig.avgLikes,
        diasUltimoPost:     ig.daysSinceLastPost,
        ultimosPosts:       postsResume
      };
    }

    // ─── Enriquecimento Reviews ───────────────────────────────────────────
    if (p.reviewsEnriched) {
      const rv = p.reviewsEnriched;
      const reviewsResume = rv.reviews
        .filter(r => r.texto && r.texto.length > 10)
        .slice(0, 10)
        .map(r => {
          const nota = r.nota ? `${r.nota}★` : '?★';
          const texto = r.texto.slice(0, 150);
          const resposta = r.respostaOwner ? ' [owner respondeu]' : '';
          return `  • ${nota} — "${texto}"${resposta}`;
        })
        .join('\n');

      // Separa reviews positivas e negativas para o prompt
      const negativas = rv.reviews.filter(r => r.nota && r.nota <= 3);
      const positivas = rv.reviews.filter(r => r.nota && r.nota >= 4);

      base.reviews = {
        totalAnalisadas: rv.totalScraped,
        mediaCalculada:  rv.avgRating,
        qtdNegativas:    negativas.length,
        qtdPositivas:    positivas.length,
        resumo:          reviewsResume || '(sem reviews com texto)'
      };
    }

    return base;
  });

  const BATCH_SIZE = 20;
  const batches = [];
  for (let i = 0; i < leadsRaw.length; i += BATCH_SIZE) {
    batches.push(leadsRaw.slice(i, i + BATCH_SIZE));
  }

  const systemPrompt = 'Retorne APENAS JSON puro válido. Sem markdown. Sem backticks. Sem texto antes ou depois do JSON.';

  function buildPrompt(batch) {
    const hasIg      = batch.some(l => l.instagram);
    const hasReviews = batch.some(l => l.reviews);

    const reviewsCriteria = hasReviews ? `
CRITÉRIOS ADICIONAIS para leads com reviews reais:
- Se reviews negativas mencionam recorrentemente o mesmo problema → pontuação "alta" obrigatória
- Use os textos reais das reviews no diagnóstico — cite o problema exato que os clientes mencionam
- Nunca invente problemas. Se as reviews são boas, diga isso no diagnóstico e foque em outros vetores` : '';

    const igCriteria = hasIg ? `
CRITÉRIOS ADICIONAIS para leads com Instagram:
- Menos de 500 seguidores → alta
- Último post há mais de 30 dias → alta
- Média de likes abaixo de 10 → alta
- Bio vazia → alta` : '';

    const reviewsInstructions = hasReviews ? `
Para leads COM reviews reais:
- Diagnóstico deve mencionar o problema exato que os clientes citam nas reviews (ex: "3 das 10 reviews mencionam demora no atendimento")
- Se há reviews negativas recorrentes, o mecanismo deve explicar por que esse problema específico está custando novos clientes
- Comentário Instagram deve referenciar algo que os clientes reclamam, não algo genérico
- DM WhatsApp deve ter gancho baseado no problema real das reviews: "Vi que seus clientes mencionam [problema] — isso está afastando novos clientes antes do primeiro contato."` : '';

    const igInstructions = hasIg ? `
Para leads COM Instagram:
- Use dados reais: seguidores, dias desde último post, média de curtidas
- Gancho da DM: "Oi, vi o Instagram do [nome do negócio]..." em vez de "pesquisei no Maps..."` : '';

    return `Você é um especialista em prospecção B2B e diagnóstico de presença digital de pequenos negócios brasileiros.
Analise cada negócio abaixo e gere diagnóstico e abordagem profissional. Nunca use emojis. Tom direto, sem elogios vazios.

CRITÉRIOS para pontuacao "alta":
- Sem site → SEMPRE alta
- Menos de 10 avaliações → SEMPRE alta
- Nota abaixo de 3.8 → SEMPRE alta
- Dois ou mais critérios acima → SEMPRE alta
Caso contrário: "media"
${reviewsCriteria}
${igCriteria}

PADRÃO DE DIAGNÓSTICO:
Frase 1 — problema específico com dado real (use reviews reais se disponíveis) + contexto do mercado local de ${city}.
Frase 2 — mecanismo: por que isso está custando clientes ativamente, não só que está custando.

PADRÃO DE COMENTÁRIO INSTAGRAM:
Observação cirúrgica baseada em dado real. Sem emoji. Sem elogio. Sem template óbvio. Máximo 2 frases.
${reviewsInstructions}
${igInstructions}

PADRÃO DE DM WHATSAPP:
- Gancho baseado no dado mais forte disponível (review real > dado Instagram > dado Maps)
- Body: mecanismo em uma frase
- CTA: "${ctaLine}"

Dados dos negócios de "${niche}" em "${city}":
${JSON.stringify(batch)}

Retorne EXATAMENTE este JSON com uma entrada por negócio na mesma ordem:
{"analises":[{"nome":"nome exato do negócio","problemas":"Frase 1. Frase 2.","pontuacao":"alta ou media","comentario":"comentário Instagram sem emoji","dm":"DM WhatsApp completa com gancho + body + CTA"}]}`;
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
          system: systemPrompt,
          messages: [{ role: 'user', content: buildPrompt(batch) }]
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
