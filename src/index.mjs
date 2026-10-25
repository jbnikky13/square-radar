import fs from "node:fs/promises";
import path from "node:path";
import { parseItems } from "./rss.mjs";

const root = process.cwd();
const schedule = JSON.parse(await fs.readFile(path.join(root, "data", "schedule.json"), "utf8"));

const FEEDS = [
  ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"],
  ["Cointelegraph", "https://cointelegraph.com/rss"],
  ["Decrypt", "https://decrypt.co/feed"],
  ["Google News Crypto", "https://news.google.com/rss/search?q=crypto%20blockchain%20when:2d&hl=en-US&gl=US&ceid=US:en"]
];
const NIGERIA_FEEDS = [
  ["Google News Nigeria Crypto", "https://news.google.com/rss/search?q=Nigeria%20crypto%20OR%20stablecoin%20OR%20blockchain%20when:7d&hl=en-NG&gl=NG&ceid=NG:en"],
  ["Google News Africa Crypto", "https://news.google.com/rss/search?q=Africa%20crypto%20OR%20stablecoin%20OR%20fintech%20when:7d&hl=en-US&gl=US&ceid=US:en"]
];
const MARKET_FEEDS = [
  ["Reuters Business", "https://news.google.com/rss/search?q=when:24h+site:reuters.com/business&ceid=US:en&hl=en-US&gl=US"],
  ["Reuters Markets", "https://news.google.com/rss/search?q=when:24h+site:reuters.com/markets&ceid=US:en&hl=en-US&gl=US"],
  ["Reuters Technology", "https://news.google.com/rss/search?q=when:24h+site:reuters.com/technology&ceid=US:en&hl=en-US&gl=US"],
  ["Yahoo Finance Stocks", "https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL,MSFT,NVDA,TSLA,AMZN,GOOGL,META&region=US&lang=en-US"],
  ["Google News Stocks", "https://news.google.com/rss/search?q=stocks%20OR%20ETFs%20OR%20earnings%20OR%20IPO%20when:24h&hl=en-US&gl=US&ceid=US:en"],
  ["Google News Nigeria Business", "https://news.google.com/rss/search?q=Nigeria%20business%20OR%20banks%20OR%20fintech%20OR%20markets%20when:24h&hl=en-NG&gl=NG&ceid=NG:en"],
  ["Google News Africa Business", "https://news.google.com/rss/search?q=Africa%20business%20OR%20markets%20OR%20fintech%20when:24h&hl=en-US&gl=US&ceid=US:en"]
];
const STOPWORDS = new Set("the a an and or of to in for on with from by as is are was were this that it its be has have had new latest after before about into over more less how what why when where".split(" "));

function dayName(date) {
  return new Intl.DateTimeFormat("en-US", {timeZone:"Africa/Lagos",weekday:"long"}).format(date).toLowerCase();
}
function localDate(date) {
  return new Intl.DateTimeFormat("en-CA", {timeZone:"Africa/Lagos",year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
}
function clean(s) {
  return (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
// Retrieve full publisher text where accessible; fall back to the RSS description
// when a site blocks automated access or only exposes a short excerpt.
function htmlToStory(html) {
  // Prefer structured article text when publishers expose it in JSON-LD.
  const structured = [];
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const visit = value => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (typeof value.articleBody === "string") structured.push(clean(value.articleBody));
        if (value["@graph"]) visit(value["@graph"]);
        if (value.mainEntity) visit(value.mainEntity);
        if (value.mainEntityOfPage) visit(value.mainEntityOfPage);
      };
      visit(parsed);
    } catch { /* Ignore malformed structured data and continue with HTML extraction. */ }
  }
  const usefulStructured = structured.sort((a,b) => b.length-a.length)[0] || "";
  if (usefulStructured.split(/\s+/).filter(Boolean).length >= 70) return usefulStructured;

  const source = html
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|button|iframe|figure)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
  const containers = [...source.matchAll(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/gi)].map(m => m[1]);
  // Some publishers omit semantic article tags; always inspect the full document too.
  const blocks = [...containers, source];
  const candidates = blocks.map(block => {
    const parts = [...block.matchAll(/<(?:p|h[1-6]|li|blockquote)[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote)>/gi)]
      .map(m => clean(m[1]))
      .filter(t => t.length >= 35 && !/cookie policy|subscribe to our newsletter|sign up for|advertisement|all rights reserved|read more stories/i.test(t));
    return [...new Set(parts)].join("\n\n");
  });
  return candidates.sort((a,b) => b.length-a.length)[0]?.trim() || "";
}

async function getFullStory(item) {
  const fallback = clean(item.description || "").replace(/\.{2,}/g, ".").trim();
  if (!item.link || !/^https?:\/\//i.test(item.link)) {
    console.log("[story-detail] fallback=no-valid-article-link source=" + item.source + " title=" + item.title);
    return fallback;
  }
  try {
    const res = await fetch(item.link, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; SquareRadar/1.0)",
        "accept": "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(9000),
      redirect: "follow"
    });
    if (!res.ok) {
      console.log("[story-detail] fallback=http-status-" + res.status + " source=" + item.source + " title=" + item.title);
      return fallback;
    }
    const article = htmlToStory(await res.text());
    const articleWords = article.split(/\s+/).filter(Boolean).length;
    const articleSentences = article.split(/[.!?]+/).filter(s => s.trim().split(/\s+/).length >= 6).length;
    const minimumChars = Math.min(450, fallback.length * 1.1);
    if (articleWords >= 70 && articleSentences >= 3 && article.length >= minimumChars) {
      console.log("[story-detail] extracted source=" + item.source + " words=" + articleWords + " sentences=" + articleSentences);
      return article.slice(0, 12000);
    }
    console.log("[story-detail] fallback=quality-gate source=" + item.source + " title=" + item.title +
      " extracted_words=" + articleWords + " extracted_sentences=" + articleSentences +
      " extracted_chars=" + article.length + " required_chars=" + Math.ceil(minimumChars) +
      " rss_chars=" + fallback.length);
  } catch (error) {
    console.log("[story-detail] fallback=fetch-error source=" + item.source + " title=" + item.title + " error=" + error.message);
  }
  return fallback;
}

async function enrichImage(item) {
  if (item.imageUrl) return item;
  try {
    const res=await fetch(item.link,{headers:{"user-agent":"SquareRadar/1.0"}});
    if(!res.ok) return item;
    const html=await res.text();
    const m=html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)||html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    return m ? {...item,imageUrl:m[1]} : item;
  } catch { return item; }
}
async function fetchFeed(pair) {
  const source=pair[0], url=pair[1];
  try {
    const res=await fetch(url,{headers:{"user-agent":"SquareRadar/1.0"}});
    if(!res.ok) throw new Error("HTTP "+res.status);
    return parseItems(await res.text(),source);
  } catch(e) {
    return [{source,title:"FEED_ERROR",description:e.message,link:url,pubDate:""}];
  }
}
function tokens(text) {
  return [...new Set((text.toLowerCase().match(/[a-z0-9$#-]{3,}/g)||[]).filter(x=>!STOPWORDS.has(x)))];
}
function similarity(a,b) {
  const A=new Set(tokens(a)), B=new Set(tokens(b));
  return [...A].filter(x=>B.has(x)).length/Math.max(1,Math.min(A.size,B.size));
}
function sourceQuality(source) {
  if(/Binance|official|foundation|blog|docs/i.test(source)) return 18;
  if(/CoinDesk|Decrypt|Cointelegraph|The Block/i.test(source)) return 14;
  if(/Google News/i.test(source)) return 4;
  return 8;
}
function marketScore(item) {
  const text=(item.title+" "+item.description).toLowerCase();
  let s=sourceQuality(item.source);
  if(/stock|stocks|share|shares|equity|etf|earnings|ipo|revenue|profit|loss|valuation|dividend|merger|acquisition|ceo|company|business|bank|fintech|manufactur|oil|gas|commodity|bond|treasury|inflation|interest rate|fed|central bank/.test(text)) s+=34;
  if(/record|surge|fall|drop|raises|cuts|beats|misses|guidance|deal|launch|investment|funding/.test(text)) s+=24;
  if(/nigeria|africa|lagos|naira|ngx|cbn|zenith|gtco|uba|access holdings|dangote|seplat/.test(text)) s+=24;
  const age=item.pubDate ? Date.now()-new Date(item.pubDate).getTime() : Infinity;
  if(age<12*3600e3) s+=25; else if(age<48*3600e3) s+=14; else if(age<7*24*3600e3) s+=4;
  return s;
}

function score(item,series) {
  if(/Business & Markets|Stocks & Companies/.test(series)) return marketScore(item);
  const text=(item.title+" "+item.description).toLowerCase();
  let s=sourceQuality(item.source);
  if(/bitcoin|ethereum|solana|stablecoin|defi|wallet|base|arc|rwa|ai|on-chain|token|layer 2|security|hack|exploit/.test(text)) s+=24;
  if(/launch|released|upgrade|update|funding|raises|integrat|adopt|transaction|volume|users|mainnet|testnet|proposal|governance|record|surge|collapse|warning/.test(text)) s+=24;
  if(/nigeria|africa|kenya|ghana|south africa|egypt/.test(text)) s+=series==="Africa Crypto Lens"?45:10;
  if(/hack|exploit|scam|security|phishing/.test(text)) s+=12;
  const age=item.pubDate ? Date.now()-new Date(item.pubDate).getTime() : Infinity;
  if(age<12*3600e3) s+=25; else if(age<48*3600e3) s+=14; else if(age<7*24*3600e3) s+=4;
  if(item.description && item.description.length>100) s+=5;
  if(/\b(\d+%|\$\d+|million|billion|first|largest|fastest|slower|faster|new|unexpected|despite|but|why|surge|drop|record)\b/i.test(text)) s+=18;
  return s;
}
function storySimilarity(item, historyItem) {
  const titleScore = similarity(item.title || "", historyItem.title || "");
  const descScore = similarity(
    (item.title || "") + " " + (item.description || ""),
    (historyItem.title || "") + " " + (historyItem.description || "")
  );
  return Math.max(titleScore, descScore);
}

function chooseCandidates(items,series,history,limit=10) {
  const valid = items.filter(x => x.title !== "FEED_ERROR" && x.title.length > 12);
  const usable = valid.filter(x => !history.some(h => h.link && x.link && h.link === x.link));
  const exactHistoryRejected = valid.length - usable.length;
  const rankedAll = usable.map(item => ({
    item,
    novelty: history.length
      ? 1 - Math.max(...history.map(h => storySimilarity(item, h)))
      : 1
  }));
  const noveltyRejected = rankedAll.filter(x => x.novelty < 0.32).length;
  const ranked = rankedAll
    .filter(x => x.novelty >= 0.32)
    .sort((a,b) => (score(b.item,series) + b.novelty*18) - (score(a.item,series) + a.novelty*18));
  const candidates = ranked.slice(0, limit).map(x => x.item);
  console.log("[candidate-pipeline] valid=" + valid.length +
    " exact_history_rejected=" + exactHistoryRejected +
    " novelty_rejected=" + noveltyRejected +
    " novelty_eligible=" + ranked.length +
    " shortlist=" + candidates.length +
    " novelty_threshold=0.32");
  // Do not let a single short or inaccessible article block the entire slot.
  // Try a bounded shortlist in score order so every run remains predictable.
  return candidates;
}

function loadHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const cutoff=Date.now()-4*24*3600e3;
  return raw.filter(x=>x && x.title && (!x.timestamp || new Date(x.timestamp).getTime()>=cutoff)).slice(-60);
}

function rememberStory(history,item,config,date) {
  const next=[...history,{
    title:item.title,
    description:item.description||"",
    link:item.link||"",
    source:item.source||"",
    series:config.series,
    slot:config.slot,
    date,
    timestamp:new Date().toISOString()
  }];
  return next.slice(-60);
}
function punchTitle(title) {
  return title.replace(/^[^:]+:\s*/,"").replace(/\.$/,"").trim();
}
const TOKEN_ALIASES = [
  ["bitcoin","BTC"],["btc","BTC"],["ethereum","ETH"],["ether","ETH"],["eth","ETH"],
  ["solana","SOL"],["sol","SOL"],["xrp","XRP"],["ripple","XRP"],["bnb","BNB"],
  ["binance coin","BNB"],["dogecoin","DOGE"],["doge","DOGE"],["cardano","ADA"],["ada","ADA"],
  ["avalanche","AVAX"],["avax","AVAX"],["chainlink","LINK"],["link","LINK"],
  ["polkadot","DOT"],["dot","DOT"],["tron","TRX"],["trx","TRX"],["polygon","POL"],
  ["matic","POL"],["zcash","ZEC"],["zec","ZEC"],["near protocol","NEAR"],["near","NEAR"],
  ["sui","SUI"],["aptos","APT"],["arbitrum","ARB"],["optimism","OP"],["cosmos","ATOM"],
  ["uniswap","UNI"],["aave","AAVE"],["maker","MKR"],["litecoin","LTC"],
  ["shiba inu","SHIB"],["shib","SHIB"],["base","BASE"]
];

function tokenTag(item) {
  const text=(item.title+" "+item.description).toLowerCase();

  // Prefer explicit token symbols/names. This prevents unrelated company names
  // from being mistaken for crypto assets.
  for (const [name,symbol] of TOKEN_ALIASES) {
    const escaped=name.replace(/[.*+?^$()|[\]\\]/g,"\\$&");
    if (new RegExp("\\b"+escaped+"\\b","i").test(text)) return "$"+symbol;
  }

  const explicit=(item.title+" "+item.description).match(/\$[A-Z]{2,10}\b/g);
  return explicit ? explicit[0].toUpperCase() : null;
}

function storyEnding(item, fact, token, title) {
  // No generic CTA, question, "watch next", or AI-style conclusion.
  // The post should end with the final useful fact from the source.
  return "";
}

const MAX_POST_CHARS = 1800;

// Build a concise, fact-led post instead of copying the full article.
function summarizeStory(text, title, maxChars = 1450) {
  const source = clean(text).replace(/(?:read more|subscribe|sign up|follow us|advertisement|related stories|all rights reserved)[^.!?]*/gi, " ").replace(/\s+/g, " ").trim();
  const titleTokens = new Set(tokens(title || ""));
  const candidates = source.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim())
    .filter(s => s.length >= 45 && s.length <= 420)
    .filter(s => !/^(cookie|disclaimer|privacy policy|terms of use|share this|click here|read more|subscribe)/i.test(s))
    .filter(s => s.split(/\s+/).length >= 8);
  const unique = [];
  for (const sentence of candidates) if (!unique.some(s => similarity(s, sentence) > 0.82)) unique.push(sentence);
  const ranked = unique.map((sentence, index) => {
    const lower = sentence.toLowerCase();
    const overlap = tokens(sentence).filter(t => titleTokens.has(t)).length;
    const numbers = (sentence.match(/\d+(?:[.,]\d+)?%?|\$\s?\d+/g) || []).length;
    const action = /announced|launched|approved|raised|fell|rose|surged|dropped|reported|acquired|invested|revenue|profit|loss|volume|users|valuation|forecast|expects|plans|will\s/i.test(lower) ? 3 : 0;
    const boilerplate = /according to the report|in a statement|the post said|read more|click here/i.test(lower) ? 4 : 0;
    return { sentence, index, score: overlap * 2 + Math.min(numbers, 3) * 2 + action + Math.min(sentence.length / 180, 1) - boilerplate };
  }).sort((a,b) => b.score - a.score || a.index - b.index);
  const chosen = []; let length = 0;
  for (const item of ranked) { if (chosen.length >= 5) break; const extra = item.sentence.length + (chosen.length ? 1 : 0); if (length + extra > maxChars) continue; chosen.push(item); length += extra; }
  chosen.sort((a,b) => a.index - b.index);
  return chosen.map(x => x.sentence).join(" ").slice(0, maxChars).trim();
}

function marketDraftFor(item, storyText) {
  const title = punchTitle(item.title);
  const facts = summarizeStory(storyText, title, 1320);
  if (!facts) return null;
  const opener = /earnings|revenue|profit|guidance/i.test(title) ? "The numbers are the part worth paying attention to."
    : /ipo|merger|acquisition|deal/i.test(title) ? "The business move matters beyond the headline."
    : /nigeria|naira|lagos|africa|cbn|ngx/i.test(title + " " + facts) ? "This has a real business angle for African markets."
    : "The detail that stands out is what this could change.";
  const post = [opener, "", facts].join("\n");
  return post.length <= MAX_POST_CHARS ? post : post.slice(0, MAX_POST_CHARS).trim();
}

function isDetailedStory(text, item) {
  const words = clean(text).split(/\s+/).filter(Boolean);
  const sentences = clean(text).split(/[.!?]+/).filter(s => s.trim().split(/\s+/).length >= 6);
  return words.length >= 70 && sentences.length >= 3;
}

async function draftFor(item, series) {
  const storyText = await getFullStory(item);
  if (!isDetailedStory(storyText, item)) {
    const words = clean(storyText).split(/\s+/).filter(Boolean).length;
    const sentences = clean(storyText).split(/[.!?]+/).filter(s => s.trim().split(/\s+/).length >= 6).length;
    console.log("[candidate-rejected] reason=insufficient-detail title=" + item.title + " words=" + words + " sentences=" + sentences + " minimum_words=70 minimum_sentences=3");
    return null;
  }
  const title = punchTitle(item.title);
  const facts = summarizeStory(storyText, title, 1320);
  if (!facts || facts.split(/\s+/).length < 35) {
    console.log("[candidate-rejected] reason=summary-too-thin title=" + item.title + " summary_words=" + (facts ? facts.split(/\s+/).length : 0) + " minimum_words=35");
    return null;
  }
  if (/Business & Markets|Stocks & Companies/.test(series)) return marketDraftFor(item, storyText);
  const token = tokenTag(item);
  const opener = token ? `${token} has a detail here worth noticing.`
    : /hack|exploit|security|phishing/i.test(title) ? "The security detail matters more than the headline."
    : /nigeria|africa|lagos|naira/i.test(title + " " + facts) ? "There is a practical angle to this for African markets."
    : /launch|upgrade|release|mainnet|integration/i.test(title) ? "The important part is what this changes in practice."
    : "One detail in this update deserves a closer look.";
  const post = [opener, "", facts].join("\n");
  return post.length <= MAX_POST_CHARS ? post : post.slice(0, MAX_POST_CHARS).trim();
}
function pack(series,emoji,brief,item,date,draft) {
  if(!item) return `🟣 SQUARERADAR • ${date}\n\nNo story passed today's attention filter.\n\nI'd rather skip a post than force a weak one.\n`;
  return [
    `🟣 SQUARERADAR • ${date}`,
    "\n🔥 TODAY'S STORY",
    item.title,
    "\n━━━━━━━━━━━━━━━━━━━━",
    "\n✍️ COPY-READY POST",
    draft,
    ...(tokenTag(item) ? [`\n🏷️ TOKEN\n${tokenTag(item)}`] : []),
    `\n🔗 SOURCE\n${item.source}: ${item.link}`
  ].join("\n");
}


async function chooseMedia(date, slot="story") {
  const dirs = {
    image: path.join(root, "media", "images"),
    video: path.join(root, "media", "videos")
  };
  const list = async dir => {
    try { return (await fs.readdir(dir)).filter(x => /\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i.test(x)); }
    catch { return []; }
  };
  const images = await list(dirs.image);
  const videos = await list(dirs.video);
  const seed = [...(date+"|"+slot)].reduce((n,c)=>n+c.charCodeAt(0),0);
  const mode = seed % 10;
  if (videos.length && mode === 0) return {type:"video", path:path.join(dirs.video,videos[seed%videos.length]), name:videos[seed%videos.length]};
  if (images.length && mode <= 2) return {type:"image", path:path.join(dirs.image,images[seed%images.length]), name:images[seed%images.length]};
  return null;
}

async function publishSquare(text, media=null) {
  if (!process.env.BINANCE_SQUARE_OPENAPI_KEY) {
    throw new Error("BINANCE_SQUARE_OPENAPI_KEY is not configured");
  }
  const { spawn } = await import("node:child_process");
  const script = media?.type === "image" ? "post-image.mjs" : media?.type === "video" ? "post-video.mjs" : "post-text.mjs";
  const args = ["--text", text];
  if (media?.type === "image") args.push("--images", media.path);
  if (media?.type === "video") args.push("--video", media.path);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(root, "binance-square", script),
      ...args
    ], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error((stderr || stdout).trim() || `Square publisher exited with code ${code}`));
      const id = (stdout.match(/ID:\s*(\S+)/)||[])[1];
      const link = (stdout.match(/Link:\s*(\S+)/)||[])[1];
      resolve({id, link, stdout});
    });
  });
}

async function sendTelegram(message) {
  const token=process.env.TELEGRAM_BOT_TOKEN, chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId){console.log(message);return;}
  const url="https://api.telegram.org/bot"+token+"/sendMessage";
  const chunks=[];
  for(let i=0;i<message.length;i+=3800) chunks.push(message.slice(i,i+3800));
  for(const chunk of chunks){
    const res=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text:chunk,disable_web_page_preview:true})});
    if(!res.ok){
      const detail=await res.text().catch(()=> "");
      throw new Error("Telegram send failed: "+res.status+" "+detail.slice(0,500));
    }
  }
}
const now=new Date();
const day=dayName(now);
const hour=Number(new Intl.DateTimeFormat("en-US",{timeZone:"Africa/Lagos",hour:"2-digit",hour12:false}).format(now));
const slot=hour<10?"morning":hour<17?"afternoon":"evening";
const config=schedule[day]?.[slot] ? {...schedule[day][slot], slot} : null;
if(!config) { console.log("SquareRadar: no scheduled slot for",day,slot); process.exit(0); }
const marketSeries = /Business & Markets|Stocks & Companies/.test(config.series);
const feeds = marketSeries ? [...MARKET_FEEDS,...(day==="wednesday"?NIGERIA_FEEDS:[])] : [...FEEDS,...(day==="wednesday"?NIGERIA_FEEDS:[])];
const batches=await Promise.all(feeds.map(fetchFeed));
const allItems=batches.flat();
const feedErrors = allItems.filter(item => item.title === "FEED_ERROR");
console.log("[source-pipeline] feeds=" + feeds.length +
  " items=" + (allItems.length - feedErrors.length) +
  " feed_errors=" + feedErrors.length +
  " per_feed=" + JSON.stringify(batches.map((batch, index) => ({
    source: feeds[index][0],
    items: batch.filter(item => item.title !== "FEED_ERROR").length,
    error: batch.find(item => item.title === "FEED_ERROR")?.description || null
  }))));
const historyPath=path.join(root,"data","story-history.json");
let history=[];
try {
  history=loadHistory(JSON.parse(await fs.readFile(historyPath,"utf8")));
} catch {
  history=[];
}

const preDedupeItems = allItems.filter(item => item.title !== "FEED_ERROR" && item.title.length > 12);
const uniqueItems = preDedupeItems.filter((item,index,array) =>
  !array.slice(0,index).some(prev => similarity(prev.title,item.title) >= 0.82)
);
console.log("[dedupe-pipeline] eligible_feed_items=" + preDedupeItems.length +
  " duplicate_titles_removed=" + (preDedupeItems.length - uniqueItems.length) +
  " unique_items=" + uniqueItems.length +
  " history_entries=" + history.length);

const candidates=chooseCandidates(uniqueItems,config.series,history);
let selected=null;
let draft="";

for (const candidate of candidates) {
  try {
    const candidateDraft=await draftFor(candidate,config.series);
    if (!candidateDraft) continue;
    selected=candidate;
    draft=candidateDraft;
    break;
  } catch (error) {
    // One publisher timeout or extraction error must not suppress other candidates.
    console.log("SquareRadar candidate failed; trying next story:", candidate.title, error.message);
  }
}

if (!selected) {
  console.log("SquareRadar: all", candidates.length, "ranked candidates failed story-detail checks");
}
const output=pack(config.series,config.emoji,config.brief,selected,localDate(now),draft);
await fs.mkdir(path.join(root,"output"),{recursive:true});
await fs.writeFile(path.join(root,"output",localDate(now)+"-"+day+".txt"),output+"\n","utf8");

if (!selected) {
  await sendTelegram(output);
  console.log("SquareRadar skipped:",day,slot,"no sufficiently novel story");
  process.exit(0);
}

const postText = draft;
const squareResult = await publishSquare(postText);

const updatedHistory=rememberStory(history,selected,config,localDate(now));
await fs.writeFile(historyPath,JSON.stringify(updatedHistory,null,2)+"\n","utf8");

await sendTelegram(output + (squareResult.link && squareResult.link !== "unavailable" ? `\n\n🟢 POSTED TO BINANCE SQUARE\n${squareResult.link}` : "\n\n🟢 BINANCE SQUARE PUBLISH REQUEST SUCCEEDED"));
console.log("SquareRadar complete:",day,slot,config.series, squareResult.id || "id-unavailable");
