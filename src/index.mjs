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
  if(/binance|ethereum|bitcoin|stablecoin|defi|wallet|solana|base|arc|rwa|ai|on-chain|token|layer 2|security|hack|exploit/.test(text)) s+=24;
  if(/launch|released|upgrade|update|funding|raises|integrat|adopt|transaction|volume|users|mainnet|testnet|proposal|governance/.test(text)) s+=22;
  if(/nigeria|africa|kenya|ghana|south africa|egypt/.test(text)) s+=series==="Africa Crypto Lens"?45:10;
  if(/hack|exploit|scam|security|phishing/.test(text)) s+=10;
  const age=item.pubDate ? Date.now()-new Date(item.pubDate).getTime() : Infinity;
  if(age<12*3600e3) s+=22; else if(age<48*3600e3) s+=12; else if(age<7*24*3600e3) s+=4;
  if(item.imageUrl) s+=5;
  if(item.description && item.description.length>80) s+=4;
  return s;
}
function choose(items,series) {
  const usable=items.filter(x=>x.title!=="FEED_ERROR" && x.title.length>12);
  const ranked=usable.sort((a,b)=>score(b,series)-score(a,series));
  const chosen=[];
  for(const item of ranked) {
    if(chosen.every(x=>similarity(x.title+" "+x.description,item.title+" "+item.description)<0.5)) chosen.push(item);
    if(chosen.length>=3) break;
  }
  return chosen;
}
function draftFor(item,series) {
  const desc=(item.description||"").replace(/\s+/g," ").trim();
  const title=item.title.replace(/^[^:]+:\s*/,"").trim();
  const cleanDesc=desc.length>520?desc.slice(0,517)+"...":desc;
  const hooks={
    "Crypto Investigation":`The headline says ${title}. I'm more interested in what it means underneath the headline.`,
    "I Tested It":"I wanted to see what actually happens when you move from the headline to the real-world test.",
    "Africa Crypto Lens":`Most crypto coverage starts with the US or Europe. Here's the part of ${title} I'd watch from Africa.`,
    "$10 Experiment":`Could I turn a $10 crypto experiment into something actually useful? Here's what I'm testing.`,
    "Crypto Nobody Explained Properly":`Forget the jargon for a minute. Here's what ${title} actually means.`,
    "What I'm Watching":`This isn't a prediction. It's one of the crypto developments I think is worth keeping an eye on: ${title}.`,
    "5 Things I Learned This Week":`One crypto headline taught me something I didn't expect this week: ${title}.`
  };
  const question={
    "Crypto Investigation":"What would you check before believing the headline?",
    "I Tested It":"What would you test next?",
    "$10 Experiment":"If you had $10 and one experiment, what would you test?",
    "Africa Crypto Lens":"How does this look from your side of the world?",
    "Crypto Nobody Explained Properly":"What should I break down next?",
    "What I'm Watching":"What crypto story are you watching right now?",
    "5 Things I Learned This Week":"Which lesson would you add?"
  }[series]||"What would you investigate next?";
  return [
    hooks[series]||`Here's the part of ${title} worth paying attention to:`,
    "",
    `THE STORY\\n${cleanDesc||title}`,
    "",
    `THE DETAIL I NOTICED\\n${title}`,
    "",
    `WHY IT MATTERS\n${series === "Africa Crypto Lens" ? "There may be a useful local angle here, but it needs to be separated from the broader global story." : "The useful question is what changes in practice if the reported development is real."}`,
    "",
    "WHAT I'D CHECK NEXT",
    "Primary announcement → exact numbers → timeline → what actually changed.",
    "",
    `YOUR TAKE\\n${question}`
  ].join("\n");
}

function pack(series,emoji,brief,items,date) {
  const blocks=items.slice(0,3).map((item,i)=>{
    const draft=draftFor(item,series);
    return [
      `━━━━━━━━━━━━━━━━━━━━`,
      `🧩 OPTION ${i+1}`,
      `🔥 ${item.title}`,
      `\n📍 THE ANGLE\n${brief}`,
      `\n✍️ POST DRAFT\n\n${draft}`,
      `\n🔗 SOURCE\n${item.source}: ${item.link}`
    ].join("\n");
  }).join("\n");
  return [
    `🟣 SQUARERADAR • ${date}`,
    `\n${emoji} ${series.toUpperCase()}`,
    "\n🎯 PICK YOUR POST",
    "Three different stories. Three different angles. Pick the one that fits your voice today.",
    blocks,
    "\n━━━━━━━━━━━━━━━━━━━━",
    "🧠 POSTING RULE",
    "Don't copy the source. Use the facts, add your own observation, and make the question yours.",
    "\n⚠️ VERIFY",
    "Open the source and verify names, numbers, dates and claims before posting."
  ].join("\n");
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
const config=schedule[day];
const feeds=[...FEEDS,...(day==="wednesday"?NIGERIA_FEEDS:[])];
const batches=await Promise.all(feeds.map(fetchFeed));
const selected=await Promise.all(choose(batches.flat(),config.series).map(enrichImage));
const output=pack(config.series,config.emoji,config.brief,selected,localDate(now));
await fs.mkdir(path.join(root,"output"),{recursive:true});
await fs.writeFile(path.join(root,"output",localDate(now)+"-"+day+".txt"),output+"\n","utf8");
await sendTelegram(output);
console.log("SquareRadar complete:",day,config.series);
