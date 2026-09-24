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
  const seed=[...title].reduce((n,ch)=>n+ch.charCodeAt(0),0);
  const endings=[];

  if (/purchase|buy|bought|holdings|treasury|reserve|accumulat/.test(text)) {
    endings.push(
      token ? `The number that matters now is how this changes ${token}'s concentration and exposure over time.` : "The number that matters now is how this changes the balance sheet over time.",
      "A purchase is easy to headline. The more useful signal is what the position looks like after the next few moves.",
      "This makes the next update worth checking—not for the headline, but for the numbers behind it."
    );
  } else if (/upgrade|launch|release|mainnet|testnet|integrat|deploy|update/.test(text)) {
    endings.push(
      "The real test starts after the announcement: whether the change actually gets used.",
      "A launch creates the headline. Adoption will determine whether it becomes a meaningful story.",
      "The interesting data point from here is what changes once people can actually use it."
    );
  } else if (/hack|exploit|scam|phishing|attack|security/.test(text)) {
    endings.push(
      "The headline is the incident; the longer-term signal is how quickly the damage is contained and what changes afterward.",
      "The important follow-through here is the response, not just the size of the incident.",
      "This is one of those stories where the next update could tell us more than the first headline."
    );
  } else if (/price|surge|rally|drop|fall|record|high|low|volume|market/.test(text)) {
    endings.push(
      "Price gets the attention, but the follow-through will show whether the move has substance.",
      "A big move makes the headline. The data after it will show whether the market is actually changing.",
      "The move is interesting on its own; what happens after the reaction is the part worth tracking."
    );
  } else if (/funding|raise|investment|valuation|million|billion/.test(text)) {
    endings.push(
      "The funding number is only the starting point; execution will decide what it becomes.",
      "Capital makes the headline, but the next product or adoption milestone is what gives the number context.",
      "The amount is notable. What gets built with it will be the more useful signal."
    );
  } else {
    endings.push(
      "The useful signal now is what happens next, especially if the story starts showing up in real-world behavior or numbers.",
      "What happens after the initial report will give this story much more context than the first reaction.",
      "For now, the thing worth tracking is whether this develops into a meaningful change or stays a one-day story.",
      "This is worth keeping on the radar because the next data point could materially change the picture.",
      "The detail I'd keep in mind is the part that still needs to be confirmed by what happens next."
    );
  }

  return endings[seed % endings.length];
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
