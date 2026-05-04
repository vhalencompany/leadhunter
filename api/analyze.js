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

  // ══════════════════════════════════════════
  // NORMALIZAÇÃO + SINAIS PRÉ-CALCULADOS
  // Calculamos os sinais aqui no backend para
  // não depender da IA interpretar números brutos.
  // Isso força diversidade no diagnóstico.
  // ══════════════════════════════════════════
  const leadsRaw = places.map(p => {
    const ig = p.igEnriched || null;

    // ── Sinais calculados ──────────────────
    const sinais = [];

    // 1. Presença digital
    if (!p.website) sinais.push({ tipo: 'ausencia_site', peso: 9, texto: 'não possui site próprio' });
    if (!ig) sinais.push({ tipo: 'ausencia_instagram', peso: 7, texto: 'não possui Instagram identificado' });

    // 2. Reputação Google
    const nota = p.totalScore ? parseFloat(p.totalScore.toFixed(1)) : null;
    const totalAval = p.reviewsCount || 0;
    if (nota !== null && nota < 3.5) sinais.push({ tipo: 'nota_critica', peso: 10, texto: `nota ${nota} no Google — abaixo da média do setor` });
    else if (nota !== null && nota < 4.0) sinais.push({ tipo: 'nota_baixa', peso: 8, texto: `nota ${nota} no Google — clientes insatisfeitos visíveis` });
    if (totalAval < 5) sinais.push({ tipo: 'avaliacoes_minimas', peso: 6, texto: `apenas ${totalAval} avaliações — invisível nas buscas locais` });
    else if (totalAval < 15) sinais.push({ tipo: 'avaliacoes_baixas', peso: 4, texto: `${totalAval} avaliações — presença fraca no Google` });

    // 3. Instagram — conteúdo e engajamento
    if (ig) {
      const dias = ig.daysSinceLastPost;
      const likes = ig.avgLikes || 0;
      const seguidores = ig.followers || 0;
      const posts = ig.postsCount || 0;
      const bio = ig.bio || '';

      if (dias !== null && dias > 60) sinais.push({ tipo: 'ig_abandonado', peso: 9, texto: `Instagram parado há ${dias} dias — conta abandonada publicamente` });
      else if (dias !== null && dias > 30) sinais.push({ tipo: 'ig_inativo', peso: 7, texto: `último post há ${dias} dias — cadência de conteúdo quebrada` });

      if (likes < 5 && posts > 10) sinais.push({ tipo: 'ig_sem_engajamento', peso: 8, texto: `média de ${likes} curtidas por post com ${seguidores} seguidores — conteúdo não está convertendo` });
      else if (likes < 15 && seguidores > 500) sinais.push({ tipo: 'ig_engajamento_baixo', peso: 6, texto: `${likes} curtidas médias para ${seguidores} seguidores — taxa de engajamento abaixo de 3%` });

      if (!bio || bio === '(vazia)' || bio.length < 20) sinais.push({ tipo: 'ig_bio_vazia', peso: 5, texto: 'bio do Instagram vazia — sem proposta de valor para novos visitantes' });

      if (seguidores < 200 && posts > 5) sinais.push({ tipo: 'ig_alcance_minimo', peso: 6, texto: `${seguidores} seguidores — alcance orgânico insuficiente para gerar clientes` });

      // Detecta padrão de conteúdo fraco nos posts
      if (ig.recentPosts && ig.recentPosts.length > 0) {
        const semLegenda = ig.recentPosts.filter(p => !p.caption || p.caption.length < 10).length;
        if (semLegenda >= 3) sinais.push({ tipo: 'ig_sem_copy', peso: 5, texto: `${semLegenda} dos últimos posts sem legenda — conteúdo sem mensagem comercial` });

        const semHashtag = ig.recentPosts.filter(p => !p.hashtags || p.hashtags.length === 0).length;
        if (semHashtag >= 4) sinais.push({ tipo: 'ig_sem_hashtag', peso: 3, texto: 'posts sem hashtags — alcance orgânico desperdiçado' });
      }
    }

    // 4. Contato
    if (!p.phone) sinais.push({ tipo: 'sem_telefone', peso: 5, texto: 'sem telefone visível no Google — clientes não conseguem contato direto' });

    // ── Ordena sinais por peso e pega os 3 mais fortes ──
    sinais.sort((a, b) => b.peso - a.peso);
    const sinaisPrincipais = sinais.slice(0, 3);
    const sinalDominante = sinais[0] || null;

    // ── Pontuação ──────────────────────────────────────
    const pontuacaoForcada =
      (!p.website) ||
      (nota !== null && nota < 3.8) ||
      (totalAval < 10) ||
      (ig && ig.daysSinceLastPost > 60) ||
      (ig && ig.avgLikes < 5 && ig.postsCount > 10)
        ? 'alta' : 'media';

    // ── Resumo dos posts para contexto ─────────────────
    let postsResume = '';
    if (ig?.recentPosts?.length) {
      postsResume = ig.recentPosts.slice(0, 4).map(post => {
        const date = post.timestamp
          ? new Date(post.timestamp).toLocaleDateString('pt-BR')
          : 'data desconhecida';
        const caption = post.caption
          ? `"${post.caption.slice(0, 80)}${post.caption.length > 80 ? '...' : ''}"`
          : '(sem legenda)';
        return `  • ${date} — ${post.likes} curtidas — ${caption}`;
      }).join('\n');
    }

    return {
      nome:             p.title || 'Sem nome',
      categoria:        p.categoryName || niche,
      cidade:           city,
      telefone:         p.phone || '',
      site:             p.website || '',
      nota:             nota,
      totalAvaliacoes:  totalAval,

      // Sinais pré-calculados — a IA deve usar esses, não reinventar
      sinalDominante:   sinalDominante?.texto || null,
      sinaisPrincipais: sinaisPrincipais.map(s => s.texto),
      pontuacaoForcada,

      // Dados Instagram estruturados
      instagram: ig ? {
        username:       ig.username,
        seguidores:     ig.followers,
        totalPosts:     ig.postsCount,
        mediaLikes:     ig.avgLikes,
        diasUltimoPost: ig.daysSinceLastPost,
        bio:            ig.bio || '(vazia)',
        ultimosPosts:   postsResume
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
    return `Você é um especialista em prospecção B2B e diagnóstico de presença digital de pequenos negócios brasileiros.
Analise cada negócio abaixo e gere diagnóstico e abordagem profissional.

REGRAS ABSOLUTAS:
1. Nunca use emojis.
2. Nunca use o diagnóstico padrão de "poucas avaliações" se houver um sinal mais forte disponível.
3. O campo "sinalDominante" já foi calculado — use-o como base do diagnóstico. Não ignore.
4. O campo "sinaisPrincipais" lista os problemas mais graves em ordem — o diagnóstico deve refletir essa hierarquia.
5. O campo "pontuacaoForcada" já foi calculado — use-o exatamente como fornecido, não recalcule.
6. Cada diagnóstico deve ser diferente dos outros — proibido repetir a mesma estrutura de frase.
7. Tom direto, B2B, sem elogios vazios, sem frases genéricas.

PADRÃO DE DIAGNÓSTICO (2 frases obrigatórias):
Frase 1 — cite o sinalDominante com dado numérico real. Ex: "O Instagram da [nome] está parado há 73 dias" ou "A nota 3.2 no Google expõe publicamente insatisfação de clientes" ou "Sem site próprio, [nome] depende 100% de indicação para captar clientes novos."
Frase 2 — mecanismo causal: por que esse problema específico está custando clientes ativamente hoje. Seja específico para o setor de ${niche} em ${city}.

PADRÃO DE COMENTÁRIO INSTAGRAM:
- Se tem Instagram: observação baseada em dado real do perfil (engajamento, bio, frequência, tipo de conteúdo). Máximo 2 frases. Sem elogio.
- Se não tem Instagram: observação sobre ausência de presença social no contexto do nicho.

PADRÃO DE DM WHATSAPP:
- Linha 1 (gancho): use o sinalDominante. Ex: "Vi que o Instagram do [nome] não recebe posts há [X] dias." ou "Notei que o [nome] tem nota [X] no Google com clientes mencionando [problema]."
- Linha 2 (mecanismo): uma frase explicando o custo real desse problema para o negócio.
- Linha 3 (CTA): "${ctaLine}"

CONTEXTO: leads de "${niche}" em "${city}". Cada negócio tem dados únicos — use-os.

Dados dos negócios:
${JSON.stringify(batch, null, 2)}

Retorne EXATAMENTE este JSON:
{"analises":[{"nome":"nome exato do negócio","problemas":"Frase 1. Frase 2.","pontuacao":"use o campo pontuacaoForcada de cada lead","comentario":"comentário Instagram sem emoji","dm":"DM WhatsApp completa"}]}`;
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
