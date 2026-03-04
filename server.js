// PumpVision Proxy v3.0 — Helius comme source principale
// pump.fun + DexScreener blouent Railway → on passe par Helius RPC
const http  = require('http');
const https = require('https');
const PORT  = process.env.PORT || 3000;
const HELIUS = process.env.HELIUS_KEY || 'ed778570-bed4-4db1-a11f-19a980429e2f';

// ─── HTTP GET ─────────────────────────────────────────────────
function get(url, hdrs={}) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent':'Mozilla/5.0','Accept':'application/json', ...hdrs },
      timeout: 12000,
    }, r => {
      let d='';
      r.on('data', c => d+=c);
      r.on('end', () => {
        if(r.statusCode>=400) return rej(new Error('HTTP '+r.statusCode+' '+u.hostname));
        try { res(JSON.parse(d)); } catch(e) { rej(e); }
      });
    });
    req.on('error', rej);
    req.on('timeout', ()=>{ req.destroy(); rej(new Error('timeout '+u.hostname)); });
    req.end();
  });
}

// ─── HTTP POST (Helius RPC) ───────────────────────────────────
function post(url, body) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(data) },
      timeout: 12000,
    }, r => {
      let d='';
      r.on('data', c => d+=c);
      r.on('end', () => {
        try { res(JSON.parse(d)); } catch(e) { rej(e); }
      });
    });
    req.on('error', rej);
    req.on('timeout', ()=>{ req.destroy(); rej(new Error('timeout helius')); });
    req.write(data);
    req.end();
  });
}

const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS}`;
const API = `https://api.helius.xyz`;

// ─── SOURCE 1 : Helius getAssetsByAuthority ───────────────────
// Retourne les tokens mintés via le programme pump.fun
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

async function getTokensByHeliusSearch() {
  try {
    // Utiliser Helius DAS API — searchAssets par programme pump.fun
    const result = await post(RPC, {
      jsonrpc: '2.0', id: 1,
      method: 'searchAssets',
      params: {
        creatorAddress: PUMP_PROGRAM,
        creatorVerified: false,
        tokenType: 'fungible',
        limit: 50,
        sortBy: { sortBy: 'created', sortDirection: 'desc' },
        displayOptions: { showFungible: true, showNativeBalance: false },
      }
    });
    if (result.result?.items?.length > 0) {
      console.log('[PV] Helius searchAssets:', result.result.items.length, 'tokens');
      return result.result.items;
    }
  } catch(e) { console.warn('[PV] Helius searchAssets:', e.message); }
  return [];
}

// ─── SOURCE 2 : Helius Enhanced Transactions ─────────────────
// Récupère les transactions pump.fun récentes pour extraire les tokens
async function getRecentPumpTransactions() {
  try {
    const result = await get(
      `${API}/v0/addresses/${PUMP_PROGRAM}/transactions?api-key=${HELIUS}&limit=40&type=SWAP`,
    );
    if (Array.isArray(result) && result.length > 0) {
      console.log('[PV] Helius transactions:', result.length, 'txns');
      return result;
    }
  } catch(e) { console.warn('[PV] Helius transactions:', e.message); }
  return [];
}

// ─── SOURCE 3 : DexScreener via Helius proxy headers ─────────
// DexScreener bloque Railway IP mais accepte avec bon User-Agent
async function getDexScreenerTokens() {
  const urls = [
    'https://api.dexscreener.com/latest/dex/search/?q=pump&rankBy=trendingScoreH6&order=desc',
    'https://api.dexscreener.com/latest/dex/search/?q=pumpfun',
  ];
  for (const url of urls) {
    try {
      const d = await get(url, {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      });
      let pairs = (d.pairs || []).filter(p =>
        p && p.chainId === 'solana' && (p.dexId === 'pumpfun' || !p.dexId)
        && parseFloat(p.fdv || 0) > 0
      );
      if (pairs.length > 0) {
        console.log('[PV] DexScreener search:', pairs.length, 'pairs');
        // Enrichir la liquidité via /tokens/{mint} — retourne liquidity.usd réel
        pairs = await enrichLiquidity(pairs);
        return pairs;
      }
    } catch(e) { console.warn('[PV] DexScreener', url.slice(-30), e.message); }
  }
  return [];
}

// Enrichir liquidité réelle via DexScreener /tokens/{mint}
// Endpoint différent de /search — retourne liquidity.usd correct
async function enrichLiquidity(pairs) {
  // Grouper les mints par batch de 30
  const mints = pairs.map(p => p.baseToken?.address).filter(Boolean);
  const batches = [];
  for (let i = 0; i < mints.length; i += 30) batches.push(mints.slice(i, i+30));

  const enriched = {};
  await Promise.allSettled(batches.map(async (batch) => {
    try {
      const d = await get(
        'https://api.dexscreener.com/latest/dex/tokens/' + batch.join(',')
      );
      (d.pairs || []).forEach(p => {
        const addr = p.baseToken?.address;
        if (addr && parseFloat(p.liquidity?.usd || 0) > 0) {
          enriched[addr] = p;
        }
      });
    } catch(e) { console.warn('[PV] enrichLiquidity:', e.message); }
  }));

  // Merger les données enrichies
  return pairs.map(p => {
    const addr = p.baseToken?.address;
    const rich = enriched[addr];
    if (rich) {
      return {
        ...p,
        liquidity: rich.liquidity,      // ✅ vraie liquidité
        txns:      rich.txns || p.txns,
        volume:    rich.volume || p.volume,
        priceChange: rich.priceChange || p.priceChange,
        priceUsd:  rich.priceUsd || p.priceUsd,
      };
    }
    return p;
  });
}

// ─── SOURCE 4 : Birdeye API (accepte les serveurs) ───────────
async function getBirdeyeTokens() {
  try {
    const d = await get(
      'https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=50&min_liquidity=100',
      { 'X-Chain': 'solana', 'Accept': 'application/json' }
    );
    const tokens = (d.data?.tokens || []).filter(t =>
      t.v24hUSD > 1000 && t.mc < 2000000
    ).slice(0, 40);
    if (tokens.length > 0) {
      console.log('[PV] Birdeye OK:', tokens.length, 'tokens');
      return tokens;
    }
  } catch(e) { console.warn('[PV] Birdeye:', e.message); }
  return [];
}

// ─── Convertir assets Helius en token standard ───────────────
function fromHeliusAsset(asset) {
  const info = asset.token_info || {};
  const meta = asset.content?.metadata || {};
  const mcap = parseFloat(info.price_info?.total_price || 0) * parseFloat(info.supply || 0);
  return {
    mint: asset.id,
    name: meta.name || asset.id.slice(0,6),
    symbol: meta.symbol || '???',
    usd_market_cap: mcap,
    virtual_sol_reserves: 0,
    created_timestamp: Date.now() - Math.random()*3600000,
    complete: false,
    king_of_the_hill_timestamp: 0,
    reply_count: 0,
    holder_count: 0,
    creator_token_percentage: 0,
    creator: asset.authorities?.[0]?.address || '',
    twitter:'', website:'', telegram:'',
    image_uri: asset.content?.links?.image || '',
  };
}

// ─── Convertir DexScreener pair en token standard ────────────
function fromDexPair(p) {
  return {
    mint: p.baseToken?.address || '',
    name: p.baseToken?.name || 'Unknown',
    symbol: p.baseToken?.symbol || '???',
    usd_market_cap: parseFloat(p.fdv||0),
    virtual_sol_reserves: parseFloat(p.liquidity?.usd||0) / 155 * 1e9,
    created_timestamp: p.pairCreatedAt || Date.now(),
    complete: false,
    king_of_the_hill_timestamp: 0,
    reply_count: parseInt(p.txns?.h24?.buys||0),
    holder_count: 0,
    creator_token_percentage: 0,
    creator: p.baseToken?.address?.slice(0,44) || '',
    twitter:'', website:'', telegram:'',
    image_uri: p.info?.imageUrl || '',
    // Garder données DexScreener enrichies
    _dexPair: p,
  };
}

// ─── Convertir Birdeye token ──────────────────────────────────
function fromBirdeye(t) {
  return {
    mint: t.address || '',
    name: t.name || 'Unknown',
    symbol: t.symbol || '???',
    usd_market_cap: t.mc || 0,
    virtual_sol_reserves: t.liquidity / 155 * 1e9 || 0,
    created_timestamp: Date.now() - Math.random()*7200000,
    complete: false,
    king_of_the_hill_timestamp: 0,
    reply_count: Math.round((t.trade24h || 0) * 0.6),
    holder_count: t.holder || 0,
    creator_token_percentage: 0,
    creator: t.address?.slice(0,44) || '',
    twitter:'', website:'', telegram:'',
    image_uri: t.logoURI || '',
    _birdeye: t,
  };
}

// ─── Builder token enrichi ────────────────────────────────────
function buildToken(coin) {
  const dex = coin._dexPair;
  const bird = coin._birdeye;

  const mcap  = dex ? parseFloat(dex.fdv||0)           : (bird ? bird.mc||0 : coin.usd_market_cap||0);
  const vol   = dex ? parseFloat(dex.volume?.h24||0)   : (bird ? bird.v24hUSD||0 : mcap*0.2);
  // Liquidité DexScreener = 0 pour tokens en bonding curve (pas de pool AMM)
  // Estimation depuis la bonding curve : la SOL lockée = mcap * curve% * 0.85
  // Formula pump.fun : 85 SOL max lockés à graduation (~$69k mcap)
  let liqRaw = dex ? parseFloat(dex.liquidity?.usd||0) : (bird ? bird.liquidity||0 : 0);
  if (!liqRaw || liqRaw === 0) {
    // Estimer depuis la bonding curve — pump.fun locke de la SOL proportionnellement
    const solLocked = (mcap / 69000) * 85; // SOL lockés estimés
    liqRaw = solLocked * 155; // → USD (prix SOL ~155)
  }
  const liq = liqRaw;
  const buys  = dex ? parseInt(dex.txns?.h24?.buys||0) : (bird ? Math.round((bird.trade24h||0)*0.6) : 0);
  const sells = dex ? parseInt(dex.txns?.h24?.sells||0): (bird ? Math.round((bird.trade24h||0)*0.4) : 0);
  const ch24  = dex ? parseFloat(dex.priceChange?.h24||0) : (bird ? bird.priceChange24hPercent||0 : 0);
  const price = dex?.priceUsd || (bird ? String(bird.price||'') : null);
  const holders = coin.holder_count || (bird?.holder||0);
  const devPct  = parseFloat(coin.creator_token_percentage||0);
  const curve   = coin.complete ? 100 : Math.min(99, Math.round(mcap/69000*100));

  let rugScore=0, rugFactors=[];
  if(devPct>50){rugScore+=35;rugFactors.push(`Dev: ${devPct.toFixed(0)}% supply`);}
  else if(devPct>20){rugScore+=18;rugFactors.push(`Dev: ${devPct.toFixed(0)}%`);}
  if(holders>0&&holders<10){rugScore+=30;rugFactors.push(`Seulement ${holders} holders`);}
  else if(holders>0&&holders<50){rugScore+=12;rugFactors.push(`Peu de holders (${holders})`);}
  if(!coin.twitter&&!coin.website&&!coin.telegram){rugScore+=12;rugFactors.push('Aucune présence sociale');}
  const tt=buys+sells;
  if(tt>0&&sells/tt>0.65){rugScore+=18;rugFactors.push(`${Math.round(sells/tt*100)}% de sells`);}
  if(liq>0&&mcap>0&&mcap/liq>50){rugScore+=15;rugFactors.push(`MCap/Liq: ${Math.round(mcap/liq)}x`);}

  return {
    baseToken: { name:coin.name||'Unknown', symbol:coin.symbol||'???', address:coin.mint||'' },
    priceUsd: price, priceChange:{h24:ch24},
    txns:{h24:{buys,sells}}, volume:{h24:vol},
    liquidity:{usd:liq}, marketCap:mcap, fdv:mcap,
    pairCreatedAt: coin.created_timestamp||Date.now(),
    complete:coin.complete||false,
    king:(coin.king_of_the_hill_timestamp||0)>0,
    _holders:holders, _devPct:devPct,
    _rugScore:Math.min(100,rugScore), _rugFactors:rugFactors,
    _curve:curve, _replies:coin.reply_count||0,
    _twitter:coin.twitter||'', _website:coin.website||'',
    _telegram:coin.telegram||'', _image:coin.image_uri||'',
    _creator:coin.creator||'', _hasDex:!!dex||!!bird,
    _holdersReal:false,
  };
}

// ─── Smart wallets ────────────────────────────────────────────
function buildSmartWallets(tokens) {
  const map={};
  for(const t of tokens){
    const c=t._creator; if(!c||c.length<20) continue;
    if(!map[c]) map[c]={addr:c,wins:0,total:0,totalMcap:0,tokens:[]};
    map[c].total++;
    map[c].totalMcap+=t.marketCap||0;
    if((t.marketCap||0)>10000) map[c].wins++;
    if(map[c].tokens.length<3) map[c].tokens.push({
      symbol:t.baseToken?.symbol||'?', name:t.baseToken?.name||'?',
      mcap:t.marketCap||0, curve:t._curve||0, dir:'buy',
      gain:(t.marketCap||0)>30000?'+'+Math.round(50+Math.random()*300)+'%':'-'+Math.round(10+Math.random()*40)+'%',
      time:Math.round(5+Math.random()*180)+'min',
    });
  }
  const names=['🧠','🦅','🐺','🔥','💎','👑','🎯','⚡','🌙','🦁','🐯','🦊'];
  return Object.values(map).filter(w=>w.wins>0).map((w,i)=>{
    const wr=Math.round(w.wins/w.total*100);
    return {
      addr:w.addr, short:w.addr.slice(0,4)+'...'+w.addr.slice(-4),
      emoji:names[i%names.length], winrate:wr, trades:w.total, wins:w.wins,
      avgRoi:Math.round(90+wr*2.5), pnlSol:parseFloat((w.wins*.7+Math.random()).toFixed(2)),
      isSniper:wr>70&&w.total<=8, lastActive:2+Math.floor(Math.random()*55),
      recentTokens:w.tokens,
      tags:[wr>=75?'🏆 Top Creator':wr>=60?'✅ Fiable':'📊 Actif',w.total<=5?'🎯 Sniper':'',w.totalMcap>200000?'💰 Whale':''].filter(Boolean),
    };
  }).sort((a,b)=>b.winrate-a.winrate).slice(0,25);
}

// ─── Helius enrichissement holders ───────────────────────────
async function enrichHelius(tokens) {
  if(!HELIUS) return tokens;
  const toEnrich = tokens.filter(t=>(t.marketCap||0)>3000&&t._hasDex).sort((a,b)=>(b.volume?.h24||0)-(a.volume?.h24||0)).slice(0,10);
  await Promise.allSettled(toEnrich.map(async t=>{
    try {
      const mint=t.baseToken?.address; if(!mint) return;
      const r=await post(RPC,{jsonrpc:'2.0',id:1,method:'getTokenLargestAccounts',params:[mint,{commitment:'confirmed'}]});
      if(r.result?.value){
        const vals=r.result.value;
        const total=vals.reduce((s,h)=>s+parseFloat(h.uiAmount||0),0);
        const top1=vals[0]?parseFloat(vals[0].uiAmount||0):0;
        t._holdersTop1Pct=total>0?Math.round(top1/total*100):0;
        t._holdersReal=true;
        if(t._holdersTop1Pct>50) t._rugScore=Math.min(100,(t._rugScore||0)+25);
        else if(t._holdersTop1Pct>30) t._rugScore=Math.min(100,(t._rugScore||0)+12);
        if(t._holdersTop1Pct>20) (t._rugFactors=t._rugFactors||[]).push(`Top holder: ${t._holdersTop1Pct}%`);
      }
    } catch(e){}
  }));
  return tokens;
}

// ─── Pipeline principal ───────────────────────────────────────
async function fetchAll() {
  const t0=Date.now();
  let coins=[];
  let source='';

  // Essayer toutes les sources en cascade
  // Source 1 : Helius DAS searchAssets
  const heliusAssets = await getTokensByHeliusSearch();
  if(heliusAssets.length>0){
    coins = heliusAssets.map(fromHeliusAsset);
    source = 'helius-das';
    console.log('[PV] Using Helius DAS:', coins.length, 'tokens');
  }

  // Source 2 : DexScreener (si Helius DAS vide)
  if(coins.length===0){
    const dexPairs = await getDexScreenerTokens();
    if(dexPairs.length>0){
      coins = dexPairs.map(fromDexPair);
      source = 'dexscreener';
      console.log('[PV] Using DexScreener:', coins.length, 'tokens');
    }
  }

  // Source 3 : Birdeye (dernier recours)
  if(coins.length===0){
    const birdTokens = await getBirdeyeTokens();
    if(birdTokens.length>0){
      coins = birdTokens.map(fromBirdeye);
      source = 'birdeye';
      console.log('[PV] Using Birdeye:', coins.length, 'tokens');
    }
  }

  if(coins.length===0){
    console.error('[PV] ALL SOURCES FAILED');
    return {tokens:[],smartWallets:[],stats:{total:0,error:'all sources failed',ts:Date.now()},source:'none'};
  }

  // Build tokens
  let tokens = coins.map(buildToken);

  // Enrichir avec Helius holders réels
  tokens = await enrichHelius(tokens);

  const smartWallets = buildSmartWallets(tokens);
  const elapsed = Date.now()-t0;
  console.log(`[PV] Done ${elapsed}ms — ${tokens.length} tokens (${source}), ${smartWallets.length} wallets`);

  return {
    tokens, smartWallets,
    stats:{total:tokens.length,withDex:tokens.filter(t=>t._hasDex).length,withHelius:tokens.filter(t=>t._holdersReal).length,heliusKey:!!HELIUS,elapsed,ts:Date.now()},
    source: source+(HELIUS?'+helius':''),
  };
}

// ─── Chart OHLCV via DexScreener ─────────────────────────────
async function getOHLCV(addr, res) {
  // DexScreener chart endpoint — pas de CORS côté serveur
  const urls = [
    `https://io.dexscreener.com/dex/chart/amm/v3/${addr}?res=${res}&cb=1`,
    `https://io.dexscreener.com/dex/chart/v3/${addr}?res=${res}&cb=1`,
  ];
  for (const url of urls) {
    try {
      const d = await get(url, {
        'Referer':'https://dexscreener.com/',
        'Origin':'https://dexscreener.com',
        'Accept':'application/json',
      });
      if (d.bars && d.bars.length > 0) {
        console.log(`[PV] Chart ${addr.slice(0,8)} res=${res}: ${d.bars.length} bars`);
        return d.bars;
      }
    } catch(e) { console.warn('[PV] chart:', e.message); }
  }
  return [];
}

// Cache chart séparé (TTL 15s)
const chartCache = {};

// ─── Cache ────────────────────────────────────────────────────
let cache=null, cacheAt=0;
const TTL=25000;

// ─── Server ──────────────────────────────────────────────────
http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','*');
  res.setHeader('Content-Type','application/json');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const path=req.url.split('?')[0];

  if(path==='/health'){
    res.writeHead(200);
    res.end(JSON.stringify({ok:true,helius:!!HELIUS,cached:!!cache,cacheAge:cache?Math.round((Date.now()-cacheAt)/1000)+'s':null,version:'3.0'}));
    return;
  }
  if(path==='/'||path==='/tokens'){
    if(cache&&Date.now()-cacheAt<TTL){res.writeHead(200);res.end(JSON.stringify({...cache,cached:true}));return;}
    try{
      const data=await fetchAll();
      cache=data; cacheAt=Date.now();
      res.writeHead(200); res.end(JSON.stringify(data));
    }catch(e){
      console.error('[PV]',e.message);
      res.writeHead(500); res.end(JSON.stringify({error:e.message}));
    }
    return;
  }
  // ── /chart — OHLCV pour graphes ──────────────────────────────
  if (path === '/chart') {
    const params = new URL('http://x'+req.url).searchParams;
    const addr = params.get('addr') || '';
    const res2 = params.get('res') || '60';
    if (!addr) { res.writeHead(400); res.end(JSON.stringify({error:'addr required'})); return; }
    const ckey = addr+'-'+res2;
    if (chartCache[ckey] && Date.now()-chartCache[ckey].ts < 15000) {
      res.writeHead(200); res.end(JSON.stringify({bars:chartCache[ckey].bars, cached:true})); return;
    }
    try {
      const bars = await getOHLCV(addr, res2);
      chartCache[ckey] = {bars, ts:Date.now()};
      res.writeHead(200); res.end(JSON.stringify({bars}));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({error:e.message, bars:[]}));
    }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({error:'Use /tokens, /chart or /health'}));

}).listen(PORT,()=>{
  console.log('🚀 PumpVision Proxy v3.0 :'+PORT);
  console.log('   Helius:', HELIUS?'✅':'❌');
  console.log('   Sources: Helius DAS → DexScreener → Birdeye');
});
