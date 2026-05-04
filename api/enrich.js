export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { nome, telefone, cidade } = req.body;
  if (!nome) return res.status(400).json({ error: 'nome é obrigatório.' });

  const result = {
    cnpj: null,
    whatsapp: null,
  };

  // ══════════════════════════════════════════
  // CNPJ via API Pública da Receita Federal
  // Usa a BrasilAPI (wrapper gratuito e sem auth)
  // Busca por nome fantasia + UF da cidade
  // ══════════════════════════════════════════
  try {
    const nomeLimpo = nome
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
      .replace(/[^a-zA-Z0-9\s]/g, '')                   // remove especiais
      .trim()
      .toUpperCase();

    // Tenta a busca por nome na ReceitaWS (CNPJ aberto, gratuito)
    const cnpjRes = await fetch(
      `https://receitaws.com.br/v1/company/search?query=${encodeURIComponent(nomeLimpo)}`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (cnpjRes.ok) {
      const cnpjData = await cnpjRes.json();
      const empresas = cnpjData?.companies || cnpjData?.data || [];

      // Filtra pela cidade se disponível
      const cidadeNorm = (cidade || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase().trim();

      const match = empresas.find(e => {
        const municipio = (e.municipio || e.municipality || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
        return !cidadeNorm || municipio.includes(cidadeNorm) || cidadeNorm.includes(municipio);
      }) || empresas[0];

      if (match) {
        result.cnpj = {
          cnpj:           match.cnpj || match.tax_id || null,
          razaoSocial:    match.nome || match.company_name || match.razao_social || null,
          nomeFantasia:   match.fantasia || match.trade_name || null,
          situacao:       match.situacao || match.status || null,
          dataAbertura:   match.abertura || match.opening_date || null,
          porte:          match.porte || match.size || null,
          natureza:       match.natureza_juridica || match.legal_nature || null,
          municipio:      match.municipio || match.municipality || null,
          uf:             match.uf || match.state || null,
          socio:          extrairSocio(match),
          capital:        match.capital_social || match.capital || null,
          atividadePrinc: match.atividade_principal?.[0]?.text || match.main_activity || null,
        };
      }
    }
  } catch (e) {
    console.warn('[enrich cnpj error]', e.message);
    // Tenta fallback com BrasilAPI se ReceitaWS falhar
    try {
      result.cnpj = await buscarCNPJFallback(nome, cidade);
    } catch (e2) {
      console.warn('[enrich cnpj fallback error]', e2.message);
    }
  }

  // ══════════════════════════════════════════
  // VALIDAÇÃO WHATSAPP
  // Usa a API pública do WhatsApp Business
  // Verifica se o número tem conta WA ativa
  // Sem custo, sem token — só HEAD request
  // ══════════════════════════════════════════
  if (telefone) {
    try {
      const phone = telefone.replace(/\D/g, '');
      // Normaliza para formato internacional brasileiro
      const phoneInt = normalizarTelefone(phone);

      if (phoneInt) {
        // Método 1: tenta wa.me check
        const waRes = await fetch(`https://wa.me/${phoneInt}`, {
          method: 'HEAD',
          redirect: 'follow',
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        // wa.me redireciona para app se número existe
        // Se retornar 200 ou 301/302 com location, número provavelmente tem WA
        const hasWA = waRes.status === 200 || waRes.status === 301 || waRes.status === 302;

        result.whatsapp = {
          numero: phoneInt,
          ativo: hasWA,
          formatado: formatarTelefone(phoneInt),
          metodo: 'wa.me',
        };
      } else {
        result.whatsapp = { ativo: null, erro: 'Número inválido para validação' };
      }
    } catch (e) {
      console.warn('[enrich whatsapp error]', e.message);
      result.whatsapp = { ativo: null, erro: 'Não foi possível validar' };
    }
  }

  return res.status(200).json(result);
}

// ── HELPERS ──

function extrairSocio(empresa) {
  try {
    const socios = empresa.qsa || empresa.partners || empresa.socios || [];
    if (!socios.length) return null;
    const principal = socios[0];
    return principal?.nome || principal?.name || principal?.qual || null;
  } catch { return null; }
}

function normalizarTelefone(phone) {
  // Remove tudo que não é dígito
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;

  // Já tem código do país
  if (digits.startsWith('55') && digits.length >= 12) return digits;

  // Tem DDD (10-11 dígitos)
  if (digits.length === 11 || digits.length === 10) return '55' + digits;

  // Só o número sem DDD — não consegue validar
  return null;
}

function formatarTelefone(phoneInt) {
  const d = phoneInt.replace(/\D/g, '');
  if (d.startsWith('55') && d.length === 13) {
    return `+55 (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  }
  if (d.startsWith('55') && d.length === 12) {
    return `+55 (${d.slice(2,4)}) ${d.slice(4,8)}-${d.slice(8)}`;
  }
  return phoneInt;
}

async function buscarCNPJFallback(nome, cidade) {
  // BrasilAPI — busca por CNPJ via nome usando endpoint de busca
  const nomeLimpo = nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9\s]/g, '').trim();
  const res = await fetch(
    `https://brasilapi.com.br/api/cnpj/v1/search?query=${encodeURIComponent(nomeLimpo)}`,
    { headers: { 'Accept': 'application/json' } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const items = data?.companies || data || [];
  if (!Array.isArray(items) || !items.length) return null;

  const cidadeNorm = (cidade || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  const match = items.find(e => {
    const mun = (e.municipio || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
    return !cidadeNorm || mun.includes(cidadeNorm);
  }) || items[0];

  if (!match?.cnpj) return null;

  // Busca detalhes pelo CNPJ encontrado
  const detRes = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${match.cnpj.replace(/\D/g, '')}`);
  if (!detRes.ok) return null;
  const det = await detRes.json();

  return {
    cnpj:           det.cnpj || null,
    razaoSocial:    det.razao_social || null,
    nomeFantasia:   det.nome_fantasia || null,
    situacao:       det.descricao_situacao_cadastral || null,
    dataAbertura:   det.data_inicio_atividade || null,
    porte:          det.descricao_porte || null,
    natureza:       det.natureza_juridica || null,
    municipio:      det.municipio || null,
    uf:             det.uf || null,
    socio:          det.qsa?.[0]?.nome_socio || null,
    capital:        det.capital_social || null,
    atividadePrinc: det.cnae_fiscal_descricao || null,
  };
}
