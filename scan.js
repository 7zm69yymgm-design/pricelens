// Vercel serverless function. Place at: api/scan.js
// Needs two Environment Variables in Vercel: GEMINI_API_KEY and SERPAPI_KEY

const GEMINI_MODEL = 'gemini-flash-latest';

async function identifyProduct(image, apiKey) {
  const prompt =
    'Identify the main retail product shown in this photo. ' +
    'Reply ONLY with JSON in this shape: ' +
    '{"found": boolean, "name": string, "brand": string, "category": string, ' +
    '"description": string (max 2 short sentences), "key_features": string[] (max 5), ' +
    '"search_query": string (precise shopping search query with brand and model)}. ' +
    'If there is no clear product, set found to false.';

  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
      })
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Gemini error (' + r.status + '): ' + t.slice(0, 200));
  }
  const data = await r.json();
  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content.parts[0].text;
  if (!text) throw new Error('Gemini ne koi jawab nahi diya');
  return JSON.parse(text);
}

async function searchPrices(query, country, apiKey) {
  const url =
    'https://serpapi.com/search.json?engine=google_shopping&hl=en' +
    '&q=' + encodeURIComponent(query) +
    (country ? '&gl=' + encodeURIComponent(country) : '') +
    '&api_key=' + encodeURIComponent(apiKey);
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok || data.error) {
    if (data && /hasn't returned any results|no results/i.test(data.error || '')) return [];
    throw new Error('SerpApi error: ' + ((data && data.error) || r.status));
  }
  return (data.shopping_results || [])
    .filter(x => typeof x.extracted_price === 'number')
    .map(x => ({
      store: x.source || 'Store',
      title: x.title || '',
      price: x.price,
      value: x.extracted_price,
      link: x.product_link || x.link || '',
      thumbnail: x.thumbnail || '',
      rating: x.rating || null
    }))
    .sort((a, b) => a.value - b.value)
    .slice(0, 10);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const SERPAPI_KEY = process.env.SERPAPI_KEY;
  if (!GEMINI_API_KEY || !SERPAPI_KEY) {
    return res.status(500).json({ error: 'API keys Vercel ke Environment Variables mein nahi mili.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    if (!body.image) return res.status(400).json({ error: 'Tasveer nahi mili' });

    const requested = String(body.country || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 2);
    const detected = String(req.headers['x-vercel-ip-country'] || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 2);
    const country = requested || detected || 'us';

    const product = await identifyProduct(body.image, GEMINI_API_KEY);
    if (!product.found || !product.name) {
      return res.status(404).json({ error: 'Product saaf nazar nahi aaya. Product ko frame ke beech mein rakh kar dobara scan karo.' });
    }

    const query = product.search_query || [product.brand, product.name].filter(Boolean).join(' ');
    let usedCountry = country;
    let note = '';
    let offers = await searchPrices(query, country, SERPAPI_KEY);

    if (!offers.length) {
      offers = await searchPrices(query, 'us', SERPAPI_KEY);
      if (offers.length) {
        usedCountry = 'us';
        note = 'Is country ke liye Google Shopping mein results nahi mile, is liye US ki prices dikhayi ja rahi hain.';
      }
    }

    return res.status(200).json({ product, country: usedCountry, note, offers });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
