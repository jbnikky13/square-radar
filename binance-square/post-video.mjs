#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs, printPublishSuccess, publish, resolveApiKey } from "./lib.mjs";
const args=process.argv.slice(2);
if(args.includes("--help")){console.log("Usage: node post-video.mjs --video <file.mp4> [--duration <seconds>] [--text <content>]");process.exit(0);}
const {video}=parseArgs(args,["video"]);
const {duration}=parseArgs(args,[],["duration"]);
const {text}=parseArgs(args,[],["text"]);
const key=resolveApiKey(args);
function run(cmd,args){const r=spawnSync(cmd,args,{encoding:"utf8"});if(r.status!==0)throw new Error((r.stderr||r.stdout||"").trim()||cmd+" failed");return r.stdout.trim();}
async function uploadVideo(apiKey,filePath){
 const stat=fs.statSync(filePath);
 const name=filePath.split(/[\\/]/).pop();
 const data=await (async()=>{const res=await fetch("https://www.binance.com/bapi/composite/v2/public/pgc/openApi/video/preSign",{method:"POST",headers:{"X-Square-OpenAPI-Key":apiKey,"Content-Type":"application/json",clienttype:"binanceSkill"},body:JSON.stringify({fileName:name,size:stat.size})});const j=await res.json();if(j.code!=="000000")throw new Error("API error ["+j.code+"]: "+j.message);return j.data;})();
 const bytes=fs.readFileSync(filePath);
 const up=await fetch(data.presignedUrl,{method:"PUT",headers:{"Content-Type":"video/"+(name.split(".").pop()||"mp4")},body:bytes});if(!up.ok)throw new Error("Video upload failed: "+up.status);
 for(let i=0;i<36;i++){const res=await fetch("https://www.binance.com/bapi/composite/v2/public/pgc/openApi/image/imageStatus",{method:"POST",headers:{"X-Square-OpenAPI-Key":apiKey,"Content-Type":"application/json",clienttype:"binanceSkill"},body:JSON.stringify({fileTicket:data.fileTicket})});const j=await res.json();if(j.code==="000000"&&j.data?.status===1)return data.fileTicket;if(j.data?.status===2)throw new Error("Video processing failed: "+(j.data.failedReason||"unknown"));await new Promise(r=>setTimeout(r,5000));}
 throw new Error("Video processing timed out");
}
try{
 const dur=Number(duration||run("ffprobe",["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",video]));
 if(!Number.isFinite(dur)||dur<=0||dur>600)throw new Error("Video duration must be >0 and <=600 seconds");
 const cover="/tmp/square-radar-cover.jpg";run("ffmpeg",["-y","-i",video,"-frames:v","1","-q:v","2",cover]);
 const coverUrl=await uploadImage(key,cover);
 const fileTicket=await uploadVideo(key,video);
 const body={contentType:3,fileTicket,cover:coverUrl,videoTimeSeconds:dur,isPublish:true};if(text?.trim())body.bodyTextOnly=text;
 printPublishSuccess(await publish(key,body));
}catch(e){console.error("\nFailed: "+e.message);process.exit(1);}
