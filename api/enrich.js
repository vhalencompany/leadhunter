export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { telefone } = req.body;

  if (!telefone) {
    return res.status(200).json({ whatsapp: { ativo: null, erro: 'Número não informado' } });
  }

  try {
    const phoneInt = normalizarTelefone(telefone);
    if (!phoneInt) {
      return res.status(200).json({ whatsapp: { ativo: null, erro: 'Número inválido para validação' } });
    }

    const waRes = await fetch(`https://wa.me/${phoneInt}`, {
      method: 'HEAD', redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const hasWA = waRes.status === 200 || waRes.status === 301 || waRes.status === 302;
    return res.status(200).json({
      whatsapp: { numero: phoneInt, ativo: hasWA, formatado: formatarTelefone(phoneInt) }
    });

  } catch (e) {
    console.warn('[enrich error]', e.message);
    return res.status(200).json({ whatsapp: { ativo: null, erro: 'Não foi possível validar' } });
  }
}

function normalizarTelefone(tel) {
  const d = (tel || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('55') && d.length >= 12) return d;
  if (d.length === 11 || d.length === 10) return '55' + d;
  return null;
}

function formatarTelefone(p) {
  const d = p.replace(/\D/g, '');
  if (d.startsWith('55') && d.length === 13) return `+55 (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.startsWith('55') && d.length === 12) return `+55 (${d.slice(2,4)}) ${d.slice(4,8)}-${d.slice(8)}`;
  return p;
}
