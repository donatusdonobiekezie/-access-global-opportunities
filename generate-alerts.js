// ACCESS Premium in-app alert generator
// Server-only Vercel endpoint. Run from a protected Cron.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function headers(){return {apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,"Content-Type":"application/json"};}
async function sb(path, options={}){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/${path}`,{...options,headers:{...headers(),...(options.headers||{})}});
  const text=await r.text();
  let data=null; try{data=text?JSON.parse(text):null;}catch{}
  if(!r.ok) throw new Error(`${r.status}: ${text}`);
  return data;
}
function norm(v){return String(v||'').toLowerCase().trim();}
function countryMatch(o,c){
  const wanted=norm(c||'Nigeria');
  const vals=[o.country,...(Array.isArray(o.countries)?o.countries:[])].filter(Boolean).map(norm);
  const text=vals.join(' | ');
  if(vals.includes(wanted)||text.includes(wanted)) return true;
  if(wanted==='nigeria' && /worldwide|world wide|anywhere|global|africa|remote|location varies|multiple locations/.test(text)) return true;
  return /worldwide|world wide|anywhere|global|remote|location varies|multiple locations/.test(text);
}
export default async function handler(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  if(CRON_SECRET && req.headers.authorization!==`Bearer ${CRON_SECRET}` && req.headers['x-vercel-cron']!=='1') return res.status(401).json({error:'Unauthorized'});
  try{
    const subs=await sb('subscriptions?select=user_id&plan=eq.premium&status=eq.active');
    const prefs=await sb('alert_preferences?select=user_id,enabled,country,categories,opportunity_types,keywords');
    const prefMap=new Map((prefs||[]).map(p=>[p.user_id,p]));
    const since=new Date(Date.now()-26*60*60*1000).toISOString();
    const opps=await sb(`opportunities?select=id,title,company,category,opportunity_type,country,countries,compensation_text,created_at,verification_status&verification_status=eq.verified&active=eq.true&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=250`);
    const rows=[];
    for(const s of subs||[]){
      const p=prefMap.get(s.user_id)||{enabled:true,country:'Nigeria',categories:[],opportunity_types:[],keywords:[]};
      if(p.enabled===false) continue;
      for(const o of opps||[]){
        if(!countryMatch(o,p.country)) continue;
        const cats=(p.categories||[]).filter(Boolean).map(norm);
        const types=(p.opportunity_types||[]).filter(Boolean).map(norm);
        const keys=(p.keywords||[]).filter(Boolean).map(norm);
        if(cats.length && !cats.includes(norm(o.category))) continue;
        if(types.length && !types.includes(norm(o.opportunity_type))) continue;
        if(keys.length){const hay=[o.title,o.company,o.category,o.opportunity_type,o.compensation_text].filter(Boolean).join(' ').toLowerCase(); if(!keys.some(k=>hay.includes(k))) continue;}
        rows.push({user_id:s.user_id,opportunity_id:o.id,title:`New opportunity: ${o.title}`,message:`${o.company||'A provider'} has a verified opportunity matching your ACCESS alert preferences.`,notification_type:'new_opportunity'});
      }
    }
    let inserted=0;
    for(let i=0;i<rows.length;i+=100){const chunk=rows.slice(i,i+100); if(chunk.length){const data=await sb('notifications?on_conflict=user_id,opportunity_id,notification_type',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify(chunk)}); inserted += Array.isArray(data)?data.length:0;}}
    return res.status(200).json({ok:true,premium_users:(subs||[]).length,checked_opportunities:(opps||[]).length,created_notifications:inserted});
  }catch(e){return res.status(500).json({ok:false,error:e.message});}
}
