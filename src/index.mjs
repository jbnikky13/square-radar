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
  return (s || "").replace(/<[^>]*>/g," ").replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g," ").trim();
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
function score(item,series) {
  const text=(item.title+" "+item.description).toLowerCase();
  let s=0;
  if(/binance|ethereum|bitcoin|stablecoin|defi|wallet|solana|base|arc|rwa|ai|on-chain|token|layer 2|security|hack|exploit/.test(text)) s+=28;
  if(/launch|released|upgrade|update|funding|raises|integrat|adopt|transaction|volume|users|mainnet|testnet/.test(text)) s+=20;
  if(/nigeria|africa|kenya|ghana|south africa|egypt/.test(text)) s+=series==="Africa Crypto Lens"?45:10;
  if(/hack|exploit|scam|security|phishing/.test(text)) s+=8;
  if(item.source.includes("Google News")) s+=4;
  const age=item.pubDate ? Date.now()-new Date(item.pubDate).getTime() : Infinity;
  if(age<48*3600e3) s+=15;
  return s;
}
function choose(items,series) {
  const usable=items.filter(x=>x.title!=="FEED_ERROR").sort((a,b)=>score(b,series)-score(a,series));
  const chosen=[];
  for(const item of usable) {
    if(chosen.every(x=>similarity(x.title,item.title)<0.65)) chosen.push(item);
    if(chosen.length >= (series==="What I'm Watching"?5:3)) break;
  }
  return chosen;
}
function pack(series,emoji,brief,items,date) {
  const primary=items[0];
  const supporting=items.slice(1,3);
  const facts=items.slice(0,3).map((x,i)=>`${i+1}. ${x.title} — ${x.source}. ${x.description||"See source for details."}`).join("\n");
  const links=items.slice(0,3).map(x=>`• ${x.source}: ${x.link}`).join("\n");
  const images=items.filter(x=>x.imageUrl).slice(0,3).map((x,i)=>`${i+1}. ${x.source}\n   Image: ${x.imageUrl}\n   Article: ${x.link}`).join("\n\n");
  let angle="Turn the source material into an original observation. Do not simply rewrite the headline. Focus on: "+brief;
  if(series==="I Tested It") angle="Only report a test you actually completed. If you have not tested it, label this as a proposed experiment.";
  if(series==="$10 Experiment") angle="Make the post a transparent mini-experiment: starting amount, exact steps, fees, risks, result, and lesson. Never invent a result.";
  if(series==="What I'm Watching") angle="Create a watchlist, not a prediction. For each item, explain what happened and what evidence would make it worth watching next.";
  if(series==="Crypto Investigation") angle="Lead with the surprising detail, then explain the evidence, why it matters, and what remains unconfirmed.";
  if(series==="Crypto Nobody Explained Properly") angle="Explain one mechanism in plain language using one concrete example. Remove jargon that does not help the reader.";
  if(series==="Africa Crypto Lens") angle="Start with the African/Nigerian relevance, then separate local evidence from broader global claims.";
  const hookMap={
    "Africa Crypto Lens":"🌍 Everyone talks about crypto from a global perspective. But here's what this story looks like from Africa:",
    "I Tested It":"🧪 I wanted to know what actually happens when you try this. So here's what I found:",
    "$10 Experiment":"💰 I gave myself a $10 limit and one rule: learn something useful without pretending I knew the outcome:",
    "Crypto Investigation":"🔎 This headline caught my attention. But the detail underneath it is much more interesting:",
    "Crypto Nobody Explained Properly":"🧠 This sounds complicated. It really isn't once you see what is happening underneath:",
    "What I'm Watching":"👀 Five things caught my attention today. Here's what I'm actually watching:",
    "5 Things I Learned This Week":"📊 I went through this week's crypto stories. These are the 5 things that actually taught me something:"
  };
  const questionMap={
    "I Tested It":"Would you test this yourself? What would you check first?",
    "$10 Experiment":"If you had $10 for a crypto experiment, what would you test?",
    "Africa Crypto Lens":"How is this playing out where you live?",
    "Crypto Investigation":"What would you investigate next?",
    "Crypto Nobody Explained Properly":"What crypto concept should I break down next?",
    "What I'm Watching":"Which of these deserves a deeper investigation?",
    "5 Things I Learned This Week":"Which one should I investigate more next?"
  };
  const visual=series==="What I'm Watching" ? "A clean 5-item watchlist card." : "Use the source image only if it directly represents the story. Otherwise use an original screenshot, chart, explorer view, or product screen.";
  return [
    `🟣 SQUARERADAR • ${date}`,
    `\n${emoji} TODAY'S SERIES\n${series}`,
    `\n🔥 THE CONTENT OPPORTUNITY\n${primary?.title||"No strong topic found today."}`,
    `\n💡 WHY THIS ONE?\n${primary?.description||"No strong current source was available. Consider an educational post instead."}`,
    `\n🧠 THE ANGLE\n${angle}`,
    `\n🎣 HOOK\n${hookMap[series]||"🔎 Here's the part of this story worth looking at:"}`,
    `\n📝 POST STRUCTURE\n1. Hook\n2. What happened\n3. The interesting detail\n4. Why it matters\n5. What is still unknown\n6. Your observation\n7. Question`,
    `\n🔍 RESEARCH NOTES\n${facts||"No source facts available."}`,
    `\n🖼️ VISUAL\n${visual}`,
    `\n✅ SOURCE-TRACEABLE IMAGES\n${images||"None found. Use an original visual instead."}`,
    `\n💬 END WITH\n${questionMap[series]||"What would you investigate next?"}`,
    `\n🔗 SOURCES\n${links||"No sources available."}`,
    `\n⚠️ BEFORE POSTING\nOpen the source, verify the facts, check the image rights/usage terms, and rewrite in your own voice. Do not present a proposed experiment as a completed test.`
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
