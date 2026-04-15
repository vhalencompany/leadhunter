export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const {
    runId, datasetId, qty,
    igEnrichRunId, igEnrichDatasetId,
    igPostRunId, igPostDatasetId,
    googleDatasetId, googleQty
  } = req.body;

  const APIFY = process.env.APIFY_TOKEN;

  if (!runId || !datasetId) {
    return res.status(400).json({ error: 'runId e datasetId são obrigatórios.' });
  }

  const FAILED = ['FAILED', 'ABORTED', 'TIMED-OUT'];

  try {
    // FASE 1 — aguardando Google Maps
    if (!igEnrichRunId) {
      const st = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY}`);
      const stData = await st.json();
      const status = stData?.data?.status;

      if (FAILED.includes(status)) return res.status(200).json({ status: 'failed', reason: status });
      if (status !== 'SUCCEEDED') return res.status(200).json({ status: 'running', phase: 1 });

      const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY}&limit=${qty}`);
      const places = await itemsRes.json();

      const igUsernames = extractInstagramUsernames(places);

      // Sem Instagram para enriquecer — retorna done imediatamente
      if (igUsernames.length === 0) {
        return res.status(200).json({ status: 'done', places });
      }

      const [profileRes, postRes] = await Promise.all([
        fetch(`https://api.apify.com/v2/acts/apify~instagram-profile-scraper/runs?token=${APIFY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usernames: igUsernames })
        }),
        fetch(`https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${APIFY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            directUrls: igUsernames.map(u => `https://www.instagram.com/${u}/`),
            resultsType: 'posts',
            resultsLimit: 6
          })
        })
      ]);

      const profileData = profileRes?.ok ? await profileRes.json() : null;
      const postData = postRes?.ok ? await postRes.json() : null;

      const newIgEnrichRunId = profileData?.data?.id || null;
      const newIgPostRunId = postData?.data?.id || null;

      // Se ambos falharam ao iniciar — retorna done com dados do Google
      if (!newIgEnrichRunId && !newIgPostRunId) {
        return res.status(200).json({ status: 'done', places });
      }

      return res.status(200).json({
        status: 'running', phase: 2,
        igEnrichRunId: newIgEnrichRunId,
        igEnrichDatasetId: profileData?.data?.defaultDatasetId || null,
        igPostRunId: newIgPostRunId,
        igPostDatasetId: postData?.data?.defaultDatasetId || null,
        googleDatasetId: datasetId,
        googleQty: qty
      });
    }

    // FASE 2 — polling Instagram
    const hasIgEnrich = !!igEnrichRunId;
    const hasIgPost = !!igPostRunId;

    // Guard: chegou na fase 2 sem nenhum run válido — nunca mais fica em loop
    if (!hasIgEnrich && !hasIgPost) {
      const googleItems = await fetch(`https://api.apify.com/v2/datasets/${googleDatasetId}/items?token=${APIFY}&limit=${googleQty}`).then(r => r.json());
      return res.status(200).json({ status: 'done', places: googleItems });
    }

    const statusChecks = await Promise.all([
      hasIgEnrich
        ? fetch(`https://api.apify.com/v2/actor-runs/${igEnrichRunId}?token=${APIFY}`).then(r => r.json())
        : Promise.resolve({ data: { status: 'SUCCEEDED' } }),
      hasIgPost
        ? fetch(`https://api.apify.com/v2/actor-runs/${igPostRunId}?token=${APIFY}`).then(r => r.json())
        : Promise.resolve({ data: { status: 'SUCCEEDED' } })
    ]);

    const profileStatus = statusChecks[0]?.data?.status;
    const postStatus = statusChecks[1]?.data?.status;

    const allDone = profileStatus === 'SUCCEEDED' && postStatus === 'SUCCEEDED';
    const anyStillRunning =
      (!FAILED.includes(profileStatus) && profileStatus !== 'SUCCEEDED') ||
      (!FAILED.includes(postStatus) && postStatus !== 'SUCCEEDED');

    if (!allDone) {
      // Todos falharam — retorna com dados do Google sem enriquecimento
      if (!anyStillRunning) {
        const googleItems = await fetch(`https://api.apify.com/v2/datasets/${googleDatasetId}/items?token=${APIFY}&limit=${googleQty}`).then(r => r.json());
        return res.status(200).json({ status: 'done', places: googleItems });
      }
      return res.status(200).json({
        status: 'running', phase: 2,
        igEnrichRunId, igEnrichDatasetId,
        igPostRunId, igPostDatasetId,
        googleDatasetId, googleQty
      });
    }

    // Tudo pronto — busca e monta os dados finais
    const [googleItems, profileItems, postItems] = await Promise.all([
      fetch(`https://api.apify.com/v2/datasets/${googleDatasetId}/items?token=${APIFY}&limit=${googleQty}`).then(r => r.json()),
      igEnrichDatasetId ? fetch(`https://api.apify.com/v2/datasets/${igEnrichDatasetId}/items?token=${APIFY}&limit=200`).then(r => r.json()) : Promise.resolve([]),
      igPostDatasetId ? fetch(`https://api.apify.com/v2/datasets/${igPostDatasetId}/items?token=${APIFY}&limit=500`).then(r => r.json()) : Promise.resolve([])
    ]);

    const profileByUsername = buildProfileIndex(profileItems);
    const postsByUsername = buildPostsIndex(postItems);

    const enrichedPlaces = googleItems.map(place => {
      const enriched = { ...place };
      const igUsername = extractUsernameFromPlace(place);
      if (igUsername) {
        const profile = profileByUsername[igUsername] || {};
        const posts = postsByUsername[igUsername] || [];
        enriched.igEnriched = {
          username: igUsername,
          url: `https://www.instagram.com/${igUsername}/`,
          followers: profile.followersCount ?? profile.followers ?? 0,
          following: profile.followsCount ?? 0,
          postsCount: profile.postsCount ?? profile.mediaCount ?? 0,
          bio: profile.biography ?? '',
          site: profile.externalUrl ?? profile.websiteUrl ?? '',
          isBusinessAccount: profile.isBusinessAccount ?? null,
          businessCategory: profile.businessCategoryName ?? '',
          verified: profile.verified ?? false,
          recentPosts: posts.slice(0, 6).map(p => ({
            caption: (p.caption || p.text || '').slice(0, 200),
            likes: p.likesCount ?? p.likes ?? 0,
            comments: p.commentsCount ?? p.comments ?? 0,
            timestamp: p.timestamp ?? p.takenAt ?? null,
            hashtags: p.hashtags ?? [],
          })),
          avgLikes: calcAvg(posts, 'likesCount') || calcAvg(posts, 'likes'),
          avgComments: calcAvg(posts, 'commentsCount') || calcAvg(posts, 'comments'),
          lastPostDate: posts[0]?.timestamp ?? posts[0]?.takenAt ?? null,
          daysSinceLastPost: posts[0]
            ? Math.floor((Date.now() - new Date(posts[0].timestamp ?? posts[0].takenAt)) / 86400000)
            : null,
        };
      }
      return enriched;
    });

    return res.status(200).json({ status: 'done', places: enrichedPlaces });

  } catch (e) {
    console.error('[status error]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

function extractInstagramUsernames(places) {
  const usernames = [], seen = new Set();
  for (const p of places) {
    const u = extractUsernameFromPlace(p);
    if (u && !seen.has(u)) { seen.add(u); usernames.push(u); }
  }
  return usernames;
}

function extractUsernameFromPlace(place) {
  const socialLinks = place.socialLinks || [];
  let igUrl = socialLinks.find(s => s && s.toLowerCase().includes('instagram.com')) || '';
  if (!igUrl) {
    const site = place.website || '';
    if (site.toLowerCase().includes('instagram.com')) igUrl = site;
  }
  if (!igUrl) return null;
  const match = igUrl.match(/instagram\.com\/([^/?#\s]+)/i);
  const username = match?.[1];
  if (!username || ['p', 'reel', 'explore', 'stories', 'tv'].includes(username)) return null;
  return username.toLowerCase();
}

function buildProfileIndex(profiles) {
  const idx = {};
  for (const p of profiles) {
    const key = (p.username || '').toLowerCase();
    if (key) idx[key] = p;
  }
  return idx;
}

function buildPostsIndex(posts) {
  const idx = {};
  for (const p of posts) {
    const key = (p.ownerUsername || p.username || '').toLowerCase();
    if (!key) continue;
    if (!idx[key]) idx[key] = [];
    idx[key].push(p);
  }
  for (const key of Object.keys(idx)) {
    idx[key].sort((a, b) => new Date(b.timestamp ?? b.takenAt ?? 0) - new Date(a.timestamp ?? a.takenAt ?? 0));
  }
  return idx;
}

function calcAvg(posts, field) {
  const vals = posts.map(p => p[field]).filter(v => typeof v === 'number');
  if (!vals.length) return 0;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}
