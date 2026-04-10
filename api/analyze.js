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

  // Normaliza leads — inclui dados do Instagram quando disponível
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

    if (!p.igEnriched) return base;

    const ig = p.igEnriched;
    const postsResume = ig.recentPosts?.length
      ? ig.recentPosts.map(post => {
          const date = post.timestamp
            ? new Date(post.timestamp).toLocaleDateString('pt-BR')
            : 'data desconhecida';
          const caption = post.caption
            ? `"${post.caption.slice(0, 100)}${post.caption.length > 100 ? '...' : ''}"`
            : '(sem legenda)';
          return `  • ${date} — ${post.likes} curtidas, ${post.comments} comentários — ${caption}`;
        }).join('\n')
      : '  • Nenhum post recente encontrado';

    return {
      ...base,
      instagram: {
        username:          ig.username,
        seguidores:        ig.followers,
        seguindo:          ig.following,
        totalPosts:        ig.postsCount,
        bio:               ig.bio || '(vazia)',
        siteNaBio:         ig.site || '(nenhum)',
        categoriaInstagram:ig.businessCategory || '(não definida)',
        contaBusiness:     ig.isBusinessAccount,
        mediaLikes:        ig.avgLikes,
        mediaComentarios:  ig.avgComments,
        diasUltimoPost:    ig.daysSinceLastPost,
        ultimosPosts:      postsResume
      }
    };
  });

  const BATCH_SIZE = 20;
  const batches = [];
  for (let i = 0; i < leadsRaw.length; i += BATCH_SIZE) {
    batches.push(leadsRaw.slice(i, i + BATCH_SIZE));
  }

  const systemPrompt = 'Retorne APENAS JSON puro válido. Sem markdown. Sem backticks. Sem texto antes ou depois do JSON.';

  function buildPrompt(batch) {
    const hasIg = batch.some(l => l.instagram);

    const igCriteria = hasIg ? `
CRITÉRIOS ADICIONAIS para leads com Instagram — pontuação "alta" se:
- Menos de 500 seguidores
- Último post há mais de 30 dias
- Bio vazia ou genérica
- Média de likes abaixo de 10
- Sem site na bio
Use esses dados para tornar o diagnóstico e os scripts mais específicos e cirúrgicos.` : '';

    const igDiagInstructions = hasIg ? `
Para leads COM dados do Instagram:
- Use dados reais: seguidores, dias desde o último post, média de curtidas, conteúdo dos posts
- Diagnóstico deve mencionar dado específico do Instagram (ex: "último post há 47 dias", "3 curtidas por post em média")
- Comentário Instagram deve ser baseado em algo real do perfil — conteúdo, frequência ou engajamento
- DM WhatsApp deve ter gancho que prova que você viu o Instagram especificamente` : '';

    return `Você é um especialista em prospecção B2B e diagnóstico de presença digital de pequenos negócios brasileiros.
Analise cada negócio abaixo e gere diagnóstico e abordagem profissional. Nunca use emojis. Tom direto, sem elogios vazios.

CRITÉRIOS para pontuacao "alta":
- Sem site → SEMPRE alta
- Menos de 10 avaliações → SEMPRE alta
- Nota abaixo de 3.8 → SEMPRE alta
- Dois ou mais critérios acima → SEMPRE alta
Caso contrário: "media"
${igCriteria}

PADRÃO DE DIAGNÓSTICO:
Frase 1 — problema específico com dado real + contexto do mercado local de ${city}.
Frase 2 — mecanismo: por que isso está custando clientes ativamente, não só que está custando.

PADRÃO DE COMENTÁRIO INSTAGRAM:
Observação cirúrgica baseada em dado real do negócio. Sem emoji. Sem elogio. Sem template óbvio. O dono lê e pensa "como essa pessoa sabe isso?". Máximo 2 frases.
${igDiagInstructions}

PADRÃO DE DM WHATSAPP:
- Gancho: "Oi, pesquisei [nome do negócio] em ${city} e encontrei algo que está custando clientes ativamente."
  → Se tiver Instagram: "Oi, vi o Instagram do [nome do negócio] e encontrei algo que está custando clientes ativamente."
- Body: mecanismo em uma frase — por que aquele problema específico elimina o negócio da consideração antes do contato.
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
