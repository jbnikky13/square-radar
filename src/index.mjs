import fs from "node:fs/promises";
import { campaignOutput, discoverCreatorPadCampaign, loadCampaignHistory, saveCampaignHistory } from "./creatorpad.mjs";
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
  const seed=Math.abs([...title].reduce((n,ch)=>n+ch.charCodeAt(0),0));
  const topic=token || "this story";

  // Real social posts do not need a formal conclusion. A useful ending usually
  // does one of four things: adds the writer's take, points to the next signal,
  // asks a specific question, or simply stops. Choose from story-specific
  // patterns rather than generic "AI conclusion" sentences.
  const candidates=[];

  if (/hack|exploit|scam|phishing|attack|security|breach/.test(text)) {
    candidates.push(
      "The interesting part now is what changes after the incident.",
      "The next signal will be how the affected team responds.",
      "It also raises a practical question: where was the weakest point in the setup?",
      "For now, the bigger story is what this exposes about the system around the attack."
    );
  }

  if (/launch|released|release|upgrade|mainnet|testnet|integrat|deploy|update/.test(text)) {
    candidates.push(
      `The real test for ${topic} starts with what people actually use.`,
      "The announcement is one thing; adoption will tell the bigger story.",
      "Now the interesting part is seeing this move from announcement to actual usage.",
      "The next few updates should show whether this changes anything beyond the headline."
    );
  }

  if (/price|surge|rally|drop|fall|record|high|low|volume|market|trading/.test(text)) {
    candidates.push(
      "The move is interesting. The follow-through matters more.",
      "One session tells us less than what happens next.",
      "The next few sessions should give this move more context.",
      "That makes the reaction worth watching, without treating one move as the whole story."
    );
  }

  if (/funding|raise|investment|valuation|million|billion|acqui|deal|partnership/.test(text)) {
    candidates.push(
      "The bigger question is what gets built with that capital.",
      "The funding is the headline; execution is what comes next.",
      "What happens with the money will probably matter more than the announcement itself.",
      "The interesting follow-up is whether the deal changes the product, market or users."
    );
  }

  if (/regulat|law|sec|government|policy|ban|legal|court/.test(text)) {
    candidates.push(
      "The next move from regulators will probably add the missing context.",
      "This is one of those stories where the follow-up matters as much as the announcement.",
      "The practical impact will become clearer once the next regulatory step happens.",
      "For the market, the details of implementation may matter more than the headline."
    );
  }

  // A few conversational endings are useful, but they must be specific to the story.
  if (candidates.length === 0) {
    candidates.push(
      `The part I'm watching now is what this changes for ${topic}.`,
      "The useful thing to watch from here is what actually changes in practice.",
      "The headline is clear; the next data point should add the missing context.",
      "This is interesting less for the headline itself than for what happens next.",
      "There may be more to this once the first real-world effects show up."
    );
  }

  // Roughly 1 in 5 posts should end naturally rather than forcing a takeaway.
  if (seed % 5 === 0) return "";

  return candidates[seed % candidates.length];
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
    ...(ending ? ["", ending] : []),
    "",
  ].join("\n");
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
const creatorPadEnabled = process.env.CREATORPAD_ENABLED !== "false";
if (creatorPadEnabled) {
  try {
    const campaign=await discoverCreatorPadCampaign();
    const hp=path.join(root,"data","creatorpad-history.json");
    const history=await loadCampaignHistory(hp);
    const runDate=localDate(now);
    const duplicate=campaign && history.some(x=>x.id===campaign.id && x.end===campaign.end && x.date===runDate);
    if(campaign&&!duplicate){
      const report=campaignOutput(campaign,localDate(now));
      await fs.mkdir(path.join(root,"output"),{recursive:true});
      await fs.writeFile(path.join(root,"output",localDate(now)+"-creatorpad.txt"),report+"\n","utf8");
      const media=await chooseMedia(localDate(now),"creatorpad");
      const result=await publishSquare(campaign.post,media);
      history.push({id:campaign.id,title:campaign.title,end:campaign.end,date:runDate,postedAt:new Date().toISOString(),squareId:result.id||null,squareLink:result.link||null});
      await saveCampaignHistory(hp,history);
      await sendTelegram(report+(result.link&&result.link!=="unavailable"?"\n\n🟢 POSTED TO BINANCE SQUARE\n"+result.link:"\n\n🟢 BINANCE SQUARE PUBLISH REQUEST SUCCEEDED"));
      console.log("SquareRadar CreatorPad complete:",campaign.title,result.id||"id-unavailable");
    } else {
      await sendTelegram(campaignOutput(campaign,localDate(now))+(campaign?"\n\nℹ️ No duplicate campaign post was published.":""));
      console.log("SquareRadar CreatorPad:",campaign?"active campaign already handled":"no active public campaign found");
    }
  } catch(error) {
    await sendTelegram("🟠 SQUARERADAR CREATORPAD ERROR\n"+error.message);
    console.error("CreatorPad discovery failed:",error);
  }
}
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
const draft=selected ? draftFor(selected,config.series) : "";
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
