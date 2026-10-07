import { WebSocket } from "ws";
const URL = "ws://localhost:4399/ws";
const snacks = ["tpl-balance-game","tpl-game-whackamole","tpl-worldcup-bias","tpl-coop-click","tpl-race-tap","tpl-quiz-ox","tpl-this-or-that","tpl-mood-vote","tpl-gacha-draw","tpl-game-reaction"];
const live = new Map(); let idc = 0;
function spawn(){
  const slug = snacks[Math.floor(Math.random()*snacks.length)];
  const ws = new WebSocket(URL); const id = `demo${idc++}`;
  ws.on("open", ()=>ws.send(JSON.stringify({t:"hello",d:{slug,anonId:id}})));
  ws.on("error", ()=>{});
  const act = setInterval(()=>{ if(ws.readyState!==1) return;
    if(/balance|worldcup|quiz|this-or-that|mood/.test(slug)) ws.send(JSON.stringify({t:"action",d:{name:"vote",payload:{option:Math.random()<.5?"A":"B"},clientMsgId:"x"}}));
    else if(/coop/.test(slug)) ws.send(JSON.stringify({t:"action",d:{name:"tally",payload:{delta:1},clientMsgId:"x"}}));
    else if(/race|whack|reaction/.test(slug)) ws.send(JSON.stringify({t:"action",d:{name:"score",payload:{score:Math.floor(Math.random()*100)},clientMsgId:"x"}}));
  }, 1500 + Math.random()*2000);
  // churn: leave after 20-60s, respawn elsewhere → counts & trending shift (dynamic)
  const ttl = setTimeout(()=>{ clearInterval(act); ws.close(); live.delete(id); }, 20000 + Math.random()*40000);
  live.set(id, {ws,act,ttl});
}
for (let i=0;i<10;i++) setTimeout(spawn, i*400);
const keep = setInterval(()=>{ while(live.size < 9) spawn(); }, 3000); // maintain ~9-12 online
setTimeout(()=>{ clearInterval(keep); for(const {ws,act,ttl} of live.values()){clearInterval(act);clearTimeout(ttl);ws.close();} process.exit(0); }, 1800000); // 30 min
console.log("demo crowd running ~30min");
