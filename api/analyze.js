export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { places, niche, city, offer } = req.body;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;

  // ══════════════════════════════════════════
  // SINAIS PRÉ-CALCULADOS
  // ══════════════════════════════════════════
  const leadsRaw = places.map(p => {
    const ig = p.igEnriched || null;
    const sinais = [];

    if (!p.website) sinais.push({ tipo: 'ausencia_site', peso: 9, texto: 'não possui site próprio' });
    if (!ig)        sinais.push({ tipo: 'ausencia_instagram', peso: 6, texto: 'não possui Instagram identificado' });

    const nota      = p.totalScore ? parseFloat(p.totalScore.toFixed(1)) : null;
    const totalAval = p.reviewsCount || 0;

    if (nota !== null && nota < 3.5)       sinais.push({ tipo: 'nota_critica',       peso: 10, texto: `nota ${nota} no Google` });
    else if (nota !== null && nota < 4.0)  sinais.push({ tipo: 'nota_baixa',         peso: 8,  texto: `nota ${nota} no Google` });
    if (totalAval < 5)                     sinais.push({ tipo: 'avaliacoes_minimas',  peso: 6,  texto: `apenas ${totalAval} avaliações no Google` });
    else if (totalAval < 15)               sinais.push({ tipo: 'avaliacoes_baixas',   peso: 4,  texto: `${totalAval} avaliações no Google` });

    if (ig) {
      const dias  = ig.daysSinceLastPost;
      const likes = ig.avgLikes || 0;
      const segs  = ig.followers || 0;
      const posts = ig.postsCount || 0;
      const bio   = ig.bio || '';

      if (dias !== null && dias > 60)      sinais.push({ tipo: 'ig_abandonado',       peso: 9, texto: `Instagram parado há ${dias} dias` });
      else if (dias !== null && dias > 30) sinais.push({ tipo: 'ig_inativo',          peso: 7, texto: `último post no Instagram há ${dias} dias` });

      if (likes < 5 && posts > 10)         sinais.push({ tipo: 'ig_sem_engajamento', peso: 8, texto: `média de ${likes} curtidas por post com ${segs} seguidores` });
      else if (likes < 15 && segs > 500)   sinais.push({ tipo: 'ig_baixo_eng',       peso: 5, texto: `${likes} curtidas médias para ${segs} seguidores` });

      if (!bio || bio === '(vazia)' || bio.length < 20) sinais.push({ tipo: 'ig_bio_vazia', peso: 4, texto: 'bio do Instagram vazia' });
      if (segs < 200 && posts > 5)         sinais.push({ tipo: 'ig_alcance_minimo',  peso: 5, texto: `apenas ${segs} seguidores no Instagram` });

      if (ig.recentPosts?.length > 0) {
        const semLegenda = ig.recentPosts.filter(pt => !pt.isPinned && (!pt.caption || pt.caption.length < 10)).length;
        if (semLegenda >= 3) sinais.push({ tipo: 'ig_sem_copy', peso: 4, texto: `${semLegenda} posts recentes sem legenda` });
      }
    }

    if (!p.phone) sinais.push({ tipo: 'sem_telefone', peso: 5, texto: 'sem telefone visível' });

    sinais.sort((a, b) => b.peso - a.peso);
    const sinalDominante   = sinais[0] || null;
    const sinaisPrincipais = sinais.slice(0, 3).map(s => s.texto);

    const pontuacaoForcada =
      (!p.website) ||
      (nota !== null && nota < 3.8) ||
      (totalAval < 10) ||
      (ig && ig.daysSinceLastPost > 60) ||
      (ig && ig.avgLikes < 5 && ig.postsCount > 10)
        ? 'alta' : 'media';

    // Posts recentes filtrados (sem fixados)
    let postsResume = '';
    if (ig?.recentPosts?.length) {
      postsResume = ig.recentPosts
        .filter(pt => !pt.isPinned)
        .slice(0, 3)
        .map(pt => {
          const date = pt.timestamp ? new Date(pt.timestamp).toLocaleDateString('pt-BR') : '?';
          const cap  = pt.caption ? `"${pt.caption.slice(0, 70)}..."` : '(sem legenda)';
          return `• ${date} — ${pt.likes} curtidas — ${cap}`;
        }).join('\n');
    }

    // Contexto humano para gancho — evita mencionar Google Maps
    const contextoGancho = ig
      ? `Instagram @${ig.username} (${ig.followers} seguidores, último post há ${ig.daysSinceLastPost ?? '?'} dias)`
      : p.phone
      ? `negócio encontrado via pesquisa local em ${city}`
      : `${p.categoryName || niche} no bairro ${p.neighborhood || city}`;

    return {
      nome:             p.title || 'Sem nome',
      categoria:        p.categoryName || niche,
      bairro:           p.neighborhood || '',
      cidade:           city,
      telefone:         p.phone || '',
      site:             p.website || '',
      nota,
      totalAvaliacoes:  totalAval,
      sinalDominante:   sinalDominante?.texto || null,
      sinaisPrincipais,
      pontuacaoForcada,
      contextoGancho,
      instagram: ig ? {
        username:       ig.username,
        seguidores:     ig.followers,
        totalPosts:     ig.postsCount,
        mediaLikes:     ig.avgLikes,
        diasUltimoPost: ig.daysSinceLastPost,
        bio:            ig.bio || '(vazia)',
        postsRecentes:  postsResume,
      } : null,
    };
  });

  const BATCH_SIZE = 20;
  const batches = [];
  for (let i = 0; i < leadsRaw.length; i += BATCH_SIZE) {
    batches.push(leadsRaw.slice(i, i + BATCH_SIZE));
  }

  const systemPrompt = 'Retorne APENAS JSON puro válido. Sem markdown. Sem backticks. Sem texto antes ou depois do JSON.';

  function buildPrompt(batch) {
    const produtoCtx = offer
      ? `O prospector oferece: "${offer}". Use isso apenas na DM — de forma natural, sem forçar.`
      : `O prospector não especificou produto. Mantenha o foco no problema do lead. CTA: agendar conversa.`;

    return `Você é especialista em copywriting de alta conversão para prospecção B2B de pequenos negócios brasileiros.

REGRAS ABSOLUTAS — sem exceção:
1. NUNCA mencione "Google Maps", "Google Meu Negócio", "vi você no Google" ou qualquer variação. Isso entrega a fonte e soa robótico.
2. O gancho deve usar o campo "contextoGancho" de cada lead — é o dado mais humano disponível (Instagram, bairro, categoria, pesquisa local).
3. Nunca use emojis. Tom direto, sem bajulação, sem frases vagas.
4. Nunca comece DM com "Oi [nome]," ou "Olá!". Comece com o gancho direto.
5. Nunca use frases genéricas: "vi seu perfil", "tenho uma proposta incrível", "você sabia que".
6. Use o campo "sinalDominante" como base do diagnóstico. Não ignore.
7. Use "pontuacaoForcada" exatamente — não recalcule.
8. Cada lead deve ter diagnóstico e DM com estrutura diferente dos outros.

${produtoCtx}

PADRÃO DE DIAGNÓSTICO (2 frases obrigatórias):
Frase 1: Dado real do sinalDominante com número. Ex: "O Instagram da [nome] registra média de 2 curtidas por post com 800 seguidores." ou "Com nota 3.4, [nome] exibe publicamente insatisfação de clientes."
Frase 2: Mecanismo causal — por que esse problema específico está custando clientes HOJE no setor de ${niche} em ${city}.

PADRÃO DE COMENTÁRIO INSTAGRAM:
- Se tem Instagram: observação cirúrgica sobre bio, cadência, engajamento ou tipo de conteúdo. Máximo 2 frases. Sem elogio.
- Se não tem: por que a ausência de Instagram prejudica especificamente esse tipo de negócio.

PADRÃO DE DM WHATSAPP (3 partes):
Gancho (1 frase): Use o contextoGancho. Exemplos naturais:
  - Se tem IG: "Passei pelo Instagram do [nome] essa semana..."
  - Se é do bairro: "Conheço o [nome] lá no [bairro]..."
  - Se é por pesquisa: "Estava pesquisando [categoria] em [cidade] e o [nome] apareceu..."
Nunca use "encontrei você no Google Maps" ou similar.

Corpo (1 frase): O sinalDominante como problema com custo real. Específico, não genérico.

CTA: ${offer
  ? `"Trabalho com ${offer} para negócios como o seu. Teria 20 minutos amanhã ou quinta para eu te mostrar o que encontrei?"`
  : `"Encontrei algo que pode mudar isso. Teria 20 minutos amanhã ou quinta para conversar?"`}

CONTEXTO: leads de "${niche}" em "${city}".

Dados:
${JSON.stringify(batch, null, 2)}

Retorne EXATAMENTE:
{"analises":[{
  "nome":"nome exato",
  "problemas":"Frase 1. Frase 2.",
  "pontuacao":"use pontuacaoForcada",
  "comentario":"comentário Instagram",
  "dm":"DM WhatsApp completa"
}]}`;
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
          model:      'claude-sonnet-4-5',
          max_tokens: 6000,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: buildPrompt(batch) }]
        })
      });

      const data = await aiRes.json();
      const raw  = data.content.map(i => i.text || '').join('');
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
