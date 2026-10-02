#!/usr/bin/env node
import { parseArgs, printPublishSuccess, publish, resolveApiKey, uploadImage } from "./lib.mjs";
const args=process.argv.slice(2);
if(args.includes("--help")){console.log("Usage: node post-image.mjs --text <content> --images <a.png,b.png> [--title <title>] [--cover <cover>]" );process.exit(0);}
const {text}=parseArgs(args,["text"]);
const {images}=parseArgs(args,["images"]);
const {title}=parseArgs(args,[],["title"]);
const {cover}=parseArgs(args,[],["cover"]);
const key=resolveApiKey(args);
try{
 const paths=images?images.split(",").map(x=>x.trim()).filter(Boolean):[];
 if(title){
   if(!cover||paths.length) throw new Error("Article mode requires exactly one --cover and no --images");
   const coverUrl=await uploadImage(key,cover);
   printPublishSuccess(await publish(key,{contentType:2,bodyTextOnly:text,title,cover:coverUrl}));
 }else{
   if(!paths.length||paths.length>4) throw new Error("Short image posts require 1-4 images");
   const urls=[];
   for(const p of paths) urls.push(await uploadImage(key,p));
   printPublishSuccess(await publish(key,{contentType:1,bodyTextOnly:text,imageList:urls}));
 }
}catch(e){console.error("\nFailed: "+e.message);process.exit(1);}
