export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { places, niche, city, offer } = req.body;
  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;

  // ══════════════════════════════════════════
  // NORMALIZAÇÃO + SINAIS PRÉ-CALCULADOS
  // ══════════════════════════════════════════
  const leadsRaw = places.map(p => {
    const ig = p.igEnriched || null;
    const sinais = [];

    // 1. Presença digital
    if (!p.website) sinais.push({ tipo: 'ausencia_site', peso: 9, texto: 'não possui site próprio' });
    if (!ig)        sinais.push({ tipo: 'ausencia_instagram', peso: 7, texto: 'não possui Instagram identificado' });

    const temEmail    = !!(p.email || p.contactInfo?.emails?.length);
    const temFacebook = !!(p.facebook || p.contactInfo?.facebookUrl);
    if (!temEmail)    sinais.push({ tipo: 'sem_email',    peso: 4, texto: 'sem email de contato público' });
    if (!temFacebook) sinais.push({ tipo: 'sem_facebook', peso: 3, texto: 'sem presença identificada no Facebook' });

    // 2. Reputação Google
    const nota      = p.totalScore ? parseFloat(p.totalScore.toFixed(1)) : null;
    const totalAval = p.reviewsCount || 0;
    if (nota !== null && nota < 3.5)  sinais.push({ tipo: 'nota_critica', peso: 10, texto: `nota ${nota} no Google — abaixo da média do setor` });
    else if (nota !== null && nota < 4.0) sinais.push({ tipo: 'nota_baixa', peso: 8, texto: `nota ${nota} no Google — clientes insatisfeitos visíveis` });
    if (totalAval < 5)       sinais.push({ tipo: 'avaliacoes_minimas', peso: 6, texto: `apenas ${totalAval} avaliações — invisível nas buscas locais` });
    else if (totalAval < 15) sinais.push({ tipo: 'avaliacoes_baixas',  peso: 4, texto: `${totalAval} avaliações — presença fraca no Google` });

    // 3. Instagram
    if (ig) {
      const dias      = ig.daysSinceLastPost;
      const likes     = ig.avgLikes || 0;
      const seguidores= ig.followers || 0;
      const posts     = ig.postsCount || 0;
      const bio       = ig.bio || '';

      if (dias !== null && dias > 60)  sinais.push({ tipo: 'ig_abandonado',       peso: 9, texto: `Instagram parado há ${dias} dias — conta abandonada publicamente` });
      else if (dias !== null && dias > 30) sinais.push({ tipo: 'ig_inativo',      peso: 7, texto: `último post há ${dias} dias — cadência de conteúdo quebrada` });

      if (likes < 5 && posts > 10)     sinais.push({ tipo: 'ig_sem_engajamento', peso: 8, texto: `média de ${likes} curtidas por post com ${seguidores} seguidores — conteúdo não converte` });
      else if (likes < 15 && seguidores > 500) sinais.push({ tipo: 'ig_engajamento_baixo', peso: 6, texto: `${likes} curtidas médias para ${seguidores} seguidores — taxa de engajamento abaixo de 3%` });

      if (!bio || bio === '(vazia)' || bio.length < 20) sinais.push({ tipo: 'ig_bio_vazia', peso: 5, texto: 'bio do Instagram vazia — sem proposta de valor para novos visitantes' });
      if (seguidores < 200 && posts > 5) sinais.push({ tipo: 'ig_alcance_minimo', peso: 6, texto: `${seguidores} seguidores — alcance orgânico insuficiente para gerar clientes` });

      if (ig.recentPosts?.length > 0) {
        const semLegenda = ig.recentPosts.filter(p => !p.caption || p.caption.length < 10).length;
        if (semLegenda >= 3) sinais.push({ tipo: 'ig_sem_copy', peso: 5, texto: `${semLegenda} dos últimos posts sem legenda — conteúdo sem mensagem comercial` });
        const semHashtag = ig.recentPosts.filter(p => !p.hashtags || p.hashtags.length === 0).length;
        if (semHashtag >= 4) sinais.push({ tipo: 'ig_sem_hashtag', peso: 3, texto: 'posts sem hashtags — alcance orgânico desperdiçado' });
      }
    }

    // 4. Contato
    if (!p.phone) sinais.push({ tipo: 'sem_telefone', peso: 5, texto: 'sem telefone visível no Google' });

    sinais.sort((a, b) => b.peso - a.peso);
    const sinaisPrincipais = sinais.slice(0, 3);
    const sinalDominante   = sinais[0] || null;

    const pontuacaoForcada =
      (!p.website) ||
      (nota !== null && nota < 3.8) ||
      (totalAval < 10) ||
      (ig && ig.daysSinceLastPost > 60) ||
      (ig && ig.avgLikes < 5 && ig.postsCount > 10)
        ? 'alta' : 'media';

    let postsResume = '';
    if (ig?.recentPosts?.length) {
      postsResume = ig.recentPosts
        .filter(p => !p.isPinned)
        .slice(0, 4).map(post => {
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
      nota,
      totalAvaliacoes:  totalAval,
      sinalDominante:   sinalDominante?.texto || null,
      sinaisPrincipais: sinaisPrincipais.map(s => s.texto),
      pontuacaoForcada,
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
    // Contexto do produto — adapta toda a copy quando preenchido
    const produtoCtx = offer
      ? `O prospector oferece: "${offer}". Use isso para calibrar TODA a copy:
- DM Dia 1: NÃO mencione o produto ainda. Só abra a ferida (problema) e gere curiosidade com "existe uma forma de resolver isso".
- DM Dia 3: Revele o produto diretamente. Ex: "O que eu faço é [${offer}] — e para negócios como o seu, o resultado costuma aparecer em [prazo realista]."
- DM Dia 7: Última tentativa. Mencione o produto + urgência real + CTA binário.`
      : `O prospector não especificou produto. Mantenha a copy focada no problema do lead, sem mencionar solução específica. O CTA é sempre agendar uma conversa.`;

    return `Você é um especialista em copywriting de alta conversão e prospecção B2B para pequenos negócios brasileiros.
Sua função é gerar diagnóstico preciso e uma sequência de 3 mensagens de abordagem que realmente convertem.

REGRAS ABSOLUTAS DE COPY:
1. Nunca use emojis. Tom profissional, direto, sem bajulação.
2. Nunca comece uma mensagem com o nome do lead ou com "Oi" genérico.
3. Proibido frases vagas como "vi seu perfil e adorei", "tenho uma proposta", "você sabia que".
4. Cada mensagem deve ser diferente em estrutura, ângulo e tom.
5. O sinalDominante já foi calculado — use-o como base. Não ignore.
6. Pontuacao: use exatamente o campo pontuacaoForcada de cada lead.
7. Proibido repetir a mesma estrutura de diagnóstico entre leads diferentes.

${produtoCtx}

PADRÃO DE DIAGNÓSTICO (2 frases):
Frase 1 — cite o sinalDominante com dado numérico. Ex: "O Instagram da [nome] está parado há 73 dias." ou "Com nota 3.2 no Google, [nome] expõe publicamente insatisfação de clientes."
Frase 2 — mecanismo causal específico para o setor de ${niche} em ${city}. Por que esse problema está custando clientes HOJE, não amanhã.

PADRÃO COMENTÁRIO INSTAGRAM:
Observação cirúrgica e inesperada baseada em dado real do perfil. Máximo 2 frases. Sem elogio. Deve gerar curiosidade ou leve desconforto no leitor.
Se não tem Instagram: observação sobre o que a ausência está custando no nicho específico.

SEQUÊNCIA DE 3 DMs — CADA UMA COM ESTRUTURA DIFERENTE:

DM Dia 1 — ABERTURA (gera curiosidade, não vende):
- Gancho: dado real do sinalDominante em uma frase. Factual, sem julgamento.
- Corpo: mecanismo — por que isso está afastando clientes ativamente.
- Fechamento: "Existe uma forma de resolver isso sem [objeção comum do nicho]. Posso te mostrar em 20 minutos — você teria disponibilidade amanhã ou quinta?"
- Tom: neutro, informativo, consultivo. NÃO mencione o produto.

DM Dia 3 — REVELAÇÃO (apresenta o produto/solução):
- Abertura: referência indireta ao silêncio. Ex: "Sei que a rotina é corrida." ou "Provavelmente você viu minha mensagem e ficou sem tempo."
- Corpo: apresenta o que resolve o problema de forma direta e específica para o nicho. ${offer ? `Mencione "${offer}" de forma natural.` : 'Fale em solução sem nomear produto.'}
- Prova: uma afirmação de resultado realista e crível. Ex: "Negócios similares ao seu costumam ver resultado em 30 a 60 dias."
- CTA: pergunta binária de horário.
- Tom: mais direto que o Dia 1. Ainda sem pressão.

DM Dia 7 — ÚLTIMA TENTATIVA (urgência real):
- Abertura: honestidade direta. Ex: "Essa é minha última mensagem sobre isso."
- Corpo: reforce o custo do problema — não a solução. O que vai acontecer se não resolver.
- ${offer ? `Mencione "${offer}" como a saída específica.` : 'Mencione "a solução que tenho em mãos" sem detalhar.'}
- CTA: binário e com prazo. Ex: "Se fizer sentido conversar, me responde com 'sim' e eu te mando os detalhes. Se não for o momento, tudo bem — só me avise."
- Tom: respeitoso, firme, sem desespero.

CONTEXTO: leads de "${niche}" em "${city}".

Dados dos negócios:
${JSON.stringify(batch, null, 2)}

Retorne EXATAMENTE este JSON — uma entrada por negócio na mesma ordem:
{"analises":[{
  "nome":"nome exato",
  "problemas":"Diagnóstico frase 1. Frase 2.",
  "pontuacao":"use pontuacaoForcada",
  "comentario":"comentário Instagram",
  "dm":"DM Dia 1 completa",
  "followup3":"DM Dia 3 completa",
  "followup7":"DM Dia 7 completa"
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
          max_tokens: 8000,
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
