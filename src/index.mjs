import fs from "node:fs/promises";
import path from "node:path";

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
function extractMedia(block) {
  const m = block.match(/<(?:media:content|media:thumbnail|enclosure)[^>]*(?:url|href)=["']([^"']+)["']/i);
  return m ? m[1] : "";
}
function parseItems(xml, source) {
  const items=[];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block=match[1];
    const get=(tag)=>{
      const m=block.match(new RegExp("<"+tag+"[^>]*>([\\s\\S]*?)<\\/"+tag+">","i"));
      return m ? clean(m[1]) : "";
    };
    const link=get("link") || ((block.match(/<link>([^<]+)/i)||[])[1]||"");
    const title=get("title");
    if (title && link) items.push({source,title,description:get("description"),link,pubDate:get("pubDate")||get("published")||get("updated"),imageUrl:extractMedia(block)});
  }
  return items;
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
function score(item,series) {
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

function chooseOne(items,series,history) {
  const usable=items
    .filter(x=>x.title!=="FEED_ERROR" && x.title.length>12)
    .filter(x=>!history.some(h=>h.link && x.link && h.link===x.link));

  if (!usable.length) return null;

  const ranked=usable
    .map(item => ({
      item,
      novelty: history.length
        ? 1 - Math.max(...history.map(h=>storySimilarity(item,h)))
        : 1
    }))
    .filter(x=>x.novelty>=0.32)
    .sort((a,b)=>(score(b.item,series) + b.novelty*18) - (score(a.item,series) + a.novelty*18));

  return ranked[0]?.item || null;
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
  const text=(title+" "+fact).toLowerCase();
  const cleanFact=(fact||"").replace(/\s+/g," ").trim().replace(/[.!?]+$/,"");
  const numberMatch=(title+" "+fact).match(/(?:\$[\d,.]+|\d+(?:\.\d+)?%|\d+(?:\.\d+)?\s*(?:million|billion|thousand))/i);
  const number=numberMatch ? numberMatch[0] : "";
  const entityMatch=(title.match(/\b[A-Z][A-Za-z0-9.-]{2,}(?:\s+[A-Z][A-Za-z0-9.-]{2,}){0,2}\b/g)||[])
    .filter(x=>!/^The$|^This$|^Today$|^AI$/.test(x))[0];
  const subject=token || entityMatch || "this development";

  // Endings are deliberately optional. A post can stop after its useful context
  // instead of forcing a conclusion, question, CTA, or recurring sign-off.
  const mode=Math.floor(Math.random()*7);

  if (mode===0) return "";
  if (mode===1) {
    if (number) return `The number that stands out is ${number}; what it means will become clearer with the next update.`;
    return `The detail that stands out is the one most likely to matter after the initial reaction fades.`;
  }
  if (mode===2) {
    if (/hack|exploit|scam|phishing|attack|security/.test(text)) {
      return "The incident matters, but the response that follows is likely to be the more useful signal.";
    }
    if (/launch|upgrade|release|mainnet|testnet|integrat|deploy|update/.test(text)) {
      return "The announcement is only the first checkpoint; actual usage will add the missing context.";
    }
    return `For ${subject}, the next measurable change should tell us more than today's headline does.`;
  }
  if (mode===3) {
    if (/price|surge|rally|drop|fall|record|high|low|volume|market/.test(text)) {
      return "The move is the headline. The follow-through is what will separate a reaction from a trend.";
    }
    if (/funding|raise|investment|valuation|million|billion/.test(text)) {
      return "The capital is the easy part to report; what gets built or changed with it is harder to fake.";
    }
    return "The headline is clear. The practical effect still needs to show up in the data.";
  }
  if (mode===4) {
    return `One thing worth watching from here: whether ${subject} changes what people actually do.`;
  }
  if (mode===5) {
    return `There is still a gap between the announcement and the outcome, and ${cleanFact ? "that gap is what I would watch next." : "the next update should narrow it."}`;
  }

  if (/purchase|buy|bought|holdings|treasury|reserve|accumulat/.test(text)) {
    return token
      ? `The interesting follow-up is whether this changes ${token}'s exposure in a meaningful way.`
      : "The interesting follow-up is whether the position changes the underlying exposure in a meaningful way.";
  }

  return cleanFact
    ? `That leaves one useful question: what changes because of this, beyond the headline itself?`
    : "Worth watching how this develops before drawing a bigger conclusion.";
}

function draftFor(item,series) {
  const desc=clean(item.description||"").replace(/\.{2,}/g,".").trim();
  const sentences=desc.split(/(?<=[.!?])\s+/).filter(Boolean);
  const fact=sentences[0]||desc;
  const token=tokenTag(item);
  const title=punchTitle(item.title);

  const openings=token ? [
    `Okay, ${token} just gave me something to look at.`,
    `This ${token} story is more interesting than the headline makes it sound.`,
    `I saw this about ${token} today and had to dig a little deeper.`,
    `One ${token} detail caught my attention today.`
  ] : [
    "This one caught my attention today.",
    "I saw this today and had to dig a little deeper.",
    "This is the kind of story that gets buried under the headline.",
    "Here's something I think is worth looking at."
  ];

  const opener=openings[Math.abs([...title].reduce((n,ch)=>n+ch.charCodeAt(0),0))%openings.length];
  const contextLines=token ? [
    `The story matters beyond the headline because it could affect how ${token} is held, used or understood.`,
    `There's more to this than the headline: the next signal is how ${token} holders, users or builders respond.`,
    `The bigger context is what this changes around ${token}, rather than simply the fact that it happened.`
  ] : [
    "The story matters beyond the headline because the follow-through could affect how the market or users respond.",
    "There's more to this than the headline: the next signal is what people and companies actually do with it.",
    "The bigger context is what this changes in practice, rather than simply the fact that it happened."
  ];
  const seed=Math.abs([...title].reduce((n,ch)=>n+ch.charCodeAt(0),0));
  const context=contextLines[seed%contextLines.length];
  const ending=storyEnding(item,fact,token,title);

  return [
    opener,
    "",
    fact,
    "",
    context,
    "",
    ending,
    "",
  ].join("\n");
}
function pack(series,emoji,brief,item,date) {
  if(!item) return `🟣 SQUARERADAR • ${date}\n\nNo story passed today's attention filter.\n\nI'd rather skip a post than force a weak one.\n`;
  return [
    `🟣 SQUARERADAR • ${date}`,
    "\n🔥 TODAY'S STORY",
    item.title,
    "\n━━━━━━━━━━━━━━━━━━━━",
    "\n✍️ COPY-READY POST",
    draftFor(item,series),
    ...(tokenTag(item) ? [`\n🏷️ TOKEN\n${tokenTag(item)}`] : []),
    `\n🔗 SOURCE\n${item.source}: ${item.link}`
  ].join("\n");
}

async function publishSquare(text) {
  if (!process.env.BINANCE_SQUARE_OPENAPI_KEY) {
    throw new Error("BINANCE_SQUARE_OPENAPI_KEY is not configured");
  }
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(root, "binance-square", "post-text.mjs"),
      "--text", text
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
const feeds=[...FEEDS,...(day==="wednesday"?NIGERIA_FEEDS:[])];
const batches=await Promise.all(feeds.map(fetchFeed));
const allItems=batches.flat();
const historyPath=path.join(root,"data","story-history.json");
let history=[];
try {
  history=loadHistory(JSON.parse(await fs.readFile(historyPath,"utf8")));
} catch {
  history=[];
}

const uniqueItems=allItems.filter((item,index,array)=>
  item.title!=="FEED_ERROR" &&
  item.title.length>12 &&
  !array.slice(0,index).some(prev=>similarity(prev.title,item.title)>=0.82)
);

const selected=chooseOne(uniqueItems,config.series,history);
const output=pack(config.series,config.emoji,config.brief,selected,localDate(now));
await fs.mkdir(path.join(root,"output"),{recursive:true});
await fs.writeFile(path.join(root,"output",localDate(now)+"-"+day+".txt"),output+"\n","utf8");

if (!selected) {
  await sendTelegram(output);
  console.log("SquareRadar skipped:",day,slot,"no sufficiently novel story");
  process.exit(0);
}

const postText = draftFor(selected, config.series);
const squareResult = await publishSquare(postText);

const updatedHistory=rememberStory(history,selected,config,localDate(now));
await fs.writeFile(historyPath,JSON.stringify(updatedHistory,null,2)+"\n","utf8");

await sendTelegram(output + (squareResult.link && squareResult.link !== "unavailable" ? `\n\n🟢 POSTED TO BINANCE SQUARE\n${squareResult.link}` : "\n\n🟢 BINANCE SQUARE PUBLISH REQUEST SUCCEEDED"));
console.log("SquareRadar complete:",day,slot,config.series, squareResult.id || "id-unavailable");
