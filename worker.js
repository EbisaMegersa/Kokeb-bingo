// worker.js — Kokab Bingo · Cloudflare Worker + Durable Objects
// /api/* → this worker · everything else → public/index.html (the Mini App)
//
// Real money = zero client trust:
//  · balls are drawn HERE (Fisher–Yates over 1..75, no repeats)
//  · cartelas are generated HERE (deterministic per seed) and wins verified HERE
//  · the moment a drawn ball completes a cartela, the pot is paid HERE

/* ---------- tunables ---------- */
const CARTELAS     = 400;      // cartela pool per table per round
const START_MS     = 45_000;   // sales window after the first cartela is claimed
const DRAW_MS      = 3500;     // time between ball calls
const RESULTS_MS   = 12_000;   // winner showcase before the next round
const MAX_PER_USER = 1;        // cartelas per player per round
const RAKE_PCT     = 0;        // % of pot kept by the house (0 = winner takes all)

const J=(o,st=200)=>new Response(JSON.stringify(o),
  {status:st,headers:{'content-type':'application/json','cache-control':'no-store'}});

/* ==== cartela math — MUST stay identical to the copy in public/index.html ====
   (the server regenerates and verifies every card itself, so the client copy
   is only used for previews) */
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function hashStr(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function genCartela(no,seed){const rng=mulberry32(hashStr(seed+':'+no));const card=[];
  for(let c=0;c<5;c++){const pool=Array.from({length:15},(_,i)=>c*15+i+1);
    for(let k=0;k<5;k++){const j=k+Math.floor(rng()*(15-k));const t=pool[k];pool[k]=pool[j];pool[j]=t;}
    for(let r=0;r<5;r++)card[r*5+c]=pool[r];}
  return card;} // index 12 = centre = FREE
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

/* ================================================================
   Bank (Durable Object) — wallets & withdrawal requests
================================================================ */
export class Bank{
  constructor(s,e){this.s=s;this.e=e;}
  async fetch(req){
    const path=new URL(req.url).pathname;
    const b=await req.json().catch(()=>({}));
    const K='w:'+b.userId;
    switch(path){
      case '/balance':{
        const acc=(await this.s.storage.get(K))||{balance:0};
        return J({ok:1,balance:acc.balance,name:acc.name||b.name||null});}
      case '/credit':{
        const acc=(await this.s.storage.get(K))||{balance:0};
        acc.balance+=Math.max(0,b.amount|0); if(b.name)acc.name=b.name;
        await this.s.storage.put(K,acc); return J({ok:1,balance:acc.balance});}
      case '/debit':{
        const acc=(await this.s.storage.get(K))||{balance:0};
        if(acc.balance<(b.amount|0))return J({ok:0,error:'INSUFFICIENT_FUNDS',balance:acc.balance});
        acc.balance-=(b.amount|0); if(b.name)acc.name=b.name;
        await this.s.storage.put(K,acc); return J({ok:1,balance:acc.balance});}
      case '/withdraw-request':{
        const acc=await this.s.storage.get(K);
        if(!acc||acc.balance<(b.amount|0)||(b.amount|0)<25)return J({ok:0,error:'BAD_WITHDRAWAL'});
        const L=(await this.s.storage.get('wd'))||[];
        L.push({id:'WD'+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
                userId:b.userId,name:acc.name||'Player',amount:b.amount|0,ts:Date.now(),status:'pending'});
        await this.s.storage.put('wd',L.slice(-300)); return J({ok:1});}
      case '/withdrawals':return J({ok:1,list:(await this.s.storage.get('wd'))||[]});
      case '/withdraw-approve':{
        const L=(await this.s.storage.get('wd'))||[]; const r=L.find(x=>x.id===b.id);
        if(!r||r.status!=='pending')return J({ok:0,error:'NOT_FOUND'});
        const acc=await this.s.storage.get('w:'+r.userId);
        if(!acc||acc.balance<r.amount){r.status='failed';await this.s.storage.put('wd',L);return J({ok:0,error:'INSUFFICIENT_FUNDS'});}
        acc.balance-=r.amount; r.status='paid'; r.paidAt=Date.now();
        await this.s.storage.put('w:'+r.userId,acc); await this.s.storage.put('wd',L); return J({ok:1});}
    }
    return J({ok:0,error:'BAD_PATH'},404);
  }
}

/* ================================================================
   BingoHall (Durable Object, one per table: etb10 / etb20)
   Alarms drive the whole round: countdown → draws → payout → reset
================================================================ */
export class BingoHall{
  constructor(s,e){this.s=s;this.e=e;}
  seed(){return this.e.CARTELA_SEED||'kokab-2025-s1';}
  async load(){ if(this.g)return;
    this.g=await this.s.storage.get('game')||
      {round:1,phase:'lobby',stake:0,startAt:0,draws:[],order:[],claims:{},winner:null}; }
  save(){return this.s.storage.put('game',this.g);}
  bank(){return this.e.BANK.get(this.e.BANK.idFromName('main'));}

  async fetch(req){
    await this.load();
    const path=new URL(req.url).pathname;
    const b=req.method==='POST'?await req.json().catch(()=>({})):{};
    if(path==='/join')  return this.join(b);
    if(path==='/state') return this.state(b);
    return J({ok:0,error:'BAD_PATH'},404);
  }

  /* Claim a cartela. The claim is written synchronously (atomic under the
     DO input gate), then the wallet is debited — if it can't cover the
     ticket the claim is rolled back. */
  async join(b){
    const g=this.g;
    g.stake=b.stake;
    if(g.phase==='playing'||g.phase==='ended')return J({ok:0,error:'SALES_CLOSED'});
    if(Object.values(g.claims).filter(c=>c.userId===b.userId).length>=MAX_PER_USER)
      return J({ok:0,error:'ALREADY_IN'});
    let no=b.cartela==='auto'?0:(b.cartela|0);
    if(no===0){ const free=[];
      for(let i=1;i<=CARTELAS;i++)if(!g.claims[i])free.push(i);
      if(!free.length)return J({ok:0,error:'SOLD_OUT'});
      no=free[(Math.random()*free.length)|0]; }
    if(!(no>=1&&no<=CARTELAS))return J({ok:0,error:'BAD_CARTELA'});
    if(g.claims[no])return J({ok:0,error:'CARTELA_TAKEN'});

    g.claims[no]={userId:b.userId,name:b.name||'Player',ts:Date.now()};
    if(g.phase==='lobby'){g.phase='countdown';g.startAt=Date.now()+START_MS;}
    await this.save();
    await this.s.storage.setAlarm(g.startAt);

    const debit=await(await this.bank().fetch('https://bank/debit',
      {method:'POST',body:JSON.stringify({userId:b.userId,amount:g.stake,name:b.name})})).json();
    if(!debit.ok){ // wallet couldn't cover it → give the cartela back
      delete g.claims[no];
      if(Object.keys(g.claims).length===0&&g.phase==='countdown'){g.phase='lobby';g.startAt=0;}
      await this.save();
      return J({ok:0,error:'INSUFFICIENT_FUNDS',balance:debit.balance??0});
    }
    return J({ok:1,cartela:no,card:genCartela(no,this.seed()),balance:debit.balance});
  }

  async state(b){
    const g=this.g;
    const recent=(await this.s.storage.get('recent'))||[];
    const mine=Object.entries(g.claims).find(([,c])=>c.userId===b.userId);
    const players=new Set(Object.values(g.claims).map(c=>c.userId)).size;
    return J({ok:1,serverNow:Date.now(),round:g.round,phase:g.phase,stake:g.stake,
      startAt:g.startAt,draws:g.draws,taken:Object.keys(g.claims).map(Number),
      players,pot:Object.keys(g.claims).length*g.stake,
      my:mine?{cartela:+mine[0],card:genCartela(+mine[0],this.seed())}:null,
      winner:g.winner,recent});
  }

  async alarm(){
    await this.load();
    const g=this.g,now=Date.now();

    if(g.phase==='countdown'){                       // sales window over → play
      if(Object.keys(g.claims).length===0){g.phase='lobby';g.startAt=0;await this.save();return;}
      g.phase='playing';
      g.order=shuffle(Array.from({length:75},(_,i)=>i+1)); g.draws=[];
      await this.save(); await this.s.storage.setAlarm(now+DRAW_MS); return;
    }

    if(g.phase==='playing'){                         // draw the next ball
      if(Object.keys(g.claims).length===0){g.phase='lobby';await this.save();return;}
      g.draws.push(g.order[g.draws.length]);
      const drawn=new Set(g.draws);
      // full-house check across every claimed cartela — server-authoritative
      const winners=Object.entries(g.claims).filter(([no])=>{
        const card=genCartela(+no,this.seed());
        for(let i=0;i<25;i++){if(i===12)continue;if(!drawn.has(card[i]))return false;}
        return true;}).map(([no,c])=>({cartela:+no,...c}));

      if(winners.length||g.draws.length>=75){
        const pot=Math.floor(g.stake*Object.keys(g.claims).length*(100-RAKE_PCT)/100);
        const each=winners.length?Math.floor(pot/winners.length):0;
        g.phase='ended'; g.winner={round:g.round,winners,amountEach:each,balls:g.draws.length};
        await this.save();
        const recent=(await this.s.storage.get('recent'))||[];
        winners.forEach(w=>recent.unshift({name:w.name,amount:each,round:g.round,stake:g.stake,ts:now}));
        await this.s.storage.put('recent',recent.slice(0,8));
        const bank=this.bank();
        for(const w of winners)                       // pot lands in the wallet
          await bank.fetch('https://bank/credit',{method:'POST',body:JSON.stringify({userId:w.userId,amount:each})});
        await this.s.storage.setAlarm(now+RESULTS_MS);
      }else{
        await this.save(); await this.s.storage.setAlarm(now+DRAW_MS);
      }
      return;
    }

    if(g.phase==='ended'){                           // showcase over → fresh round
      g.round++; g.phase='lobby'; g.claims={}; g.order=[]; g.draws=[]; g.startAt=0; g.winner=null;
      await this.save(); return;
    }
  }
}

/* ================================================================
   Router — auth (Telegram initData HMAC), API surface
================================================================ */
export default{
  async fetch(req,env){
    try{
      const url=new URL(req.url);
      if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(req);

      const who=await identify(req,env);
      if(!who)return J({ok:0,error:'AUTH_REQUIRED'},401);
      const path=url.pathname;
      const body=req.method==='POST'?await req.json().catch(()=>({})):{};

      const bank=(p,o)=>env.BANK.get(env.BANK.idFromName('main'))
        .fetch('https://bank'+p,{method:'POST',body:JSON.stringify(o)});
      const hall=(st,p,o)=>env.HALL.get(env.HALL.idFromName('etb'+st))
        .fetch('https://hall'+p,{method:'POST',body:JSON.stringify(o)});

      if(path==='/api/summary'){
        const [b,s10,s20]=await Promise.all([
          bank('/balance',{userId:who.id}).then(r=>r.json()),
          hall(10,'/state',{userId:who.id}).then(r=>r.json()),
          hall(20,'/state',{userId:who.id}).then(r=>r.json())]);
        const recent=[...(s10.recent||[]),...(s20.recent||[])].sort((a,b)=>b.ts-a.ts).slice(0,8);
        return J({ok:1,user:who,balance:b.balance,demo:env.DEMO_MODE==='true',
          serverNow:Date.now(),halls:{10:s10,20:s20},recent});
      }
      if(path==='/api/state')
        return hall(url.searchParams.get('stake')==='20'?20:10,'/state',{userId:who.id});
      if(path==='/api/join')
        return hall(body.stake===20?20:10,'/join',{...body,userId:who.id,name:who.name});

      if(path==='/api/deposit'){
        // PRODUCTION: replace this with your Telebirr / Chapa webhook flow.
        if(env.DEMO_MODE!=='true')return J({ok:0,error:'PAYMENTS_NOT_CONFIGURED'},501);
        return bank('/credit',{userId:who.id,amount:500,name:who.name});
      }
      if(path==='/api/withdraw')
        return bank('/withdraw-request',{userId:who.id,amount:body.amount});

      if(path==='/api/payment-webhook'){
        // TODO(production): verify the provider's signature (e.g. Chapa's
        // 'tx_sig' header against your secret), match the pending top-up by
        // tx_ref, then: bank('/credit',{userId, amount}).
        return J({ok:0,error:'NOT_CONFIGURED'},501);
      }

      if(path.startsWith('/api/admin/')){
        if(req.headers.get('x-admin-key')!==env.ADMIN_KEY)return J({ok:0,error:'FORBIDDEN'},403);
        if(path==='/api/admin/withdrawals')return bank('/withdrawals',{});
        if(path==='/api/admin/approve')    return bank('/withdraw-approve',{id:body.id});
      }
      return J({ok:0,error:'NOT_FOUND'},404);
    }catch(e){ return J({ok:0,error:'SERVER_ERROR'},500); }
  }
}

/* Real Telegram users are verified via initData HMAC (bot-token keyed).
   In DEMO_MODE a dev header lets you simulate multiple players locally. */
async function identify(req,env){
  const init=req.headers.get('x-init-data');
  if(init&&env.TELEGRAM_BOT_TOKEN){
    if(!await verifyInitData(init,env.TELEGRAM_BOT_TOKEN))return null;
    const u=JSON.parse(new URLSearchParams(init).get('user')||'null');
    return u&&u.id?{id:'tg'+u.id,name:[u.first_name,u.username].find(Boolean)||'Player'}:null;
  }
  if(env.DEMO_MODE==='true'){
    const m=(req.headers.get('x-dev-user')||'').match(/^(.*?)#(\w+)$/);
    return {id:m?('dev'+m[2]):'dev-local',name:m&&m[1]?m[1]:'Dev Player'};
  }
  return null;
}
async function verifyInitData(initData,botToken){
  try{
    const p=new URLSearchParams(initData),hash=p.get('hash');p.delete('hash');
    const dcs=[...p.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)
      .map(([k,v])=>k+'='+v).join('\n');
    const te=new TextEncoder();
    const secretRaw=await crypto.subtle.sign('HMAC',
      await crypto.subtle.importKey('raw',te.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']),
      te.encode(botToken));
    const secret=await crypto.subtle.importKey('raw',secretRaw,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const sig=await crypto.subtle.sign('HMAC',secret,te.encode(dcs));
    return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,'0')).join('')===hash;
  }catch(e){return false;}
}
