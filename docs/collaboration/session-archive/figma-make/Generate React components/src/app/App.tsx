import { useState } from "react";
import {
  ChevronLeft, ChevronRight, Search, Mic, CalendarDays, Users,
  Plus, Trash2, MoreHorizontal, Mail, Lock, Eye, EyeOff,
  Settings, MapPin, Clock, Edit2, Play, Pause,
  Share2, FileText, RotateCcw, RotateCw,
} from "lucide-react";

// ─── Exact colors extracted from design images ────────────────────────────────
const C = {
  // Backgrounds
  appBg:      "#FFF5F8",   // warm light pink — all main screens
  card:       "#FFFFFF",
  inputBg:    "#F0ECFF",   // very light lavender — input fills
  tasksBg:    "#FFF0F8",   // soft pink — 今日待办 card
  waveformBg: "#F4F0FF",   // light purple — waveform player bg

  // Login screen gradient
  loginTop:   "#F7EFFE",
  loginBot:   "#FFF3FA",

  // Logo circle gradient
  logoFrom:   "#CEAAF5",   // lavender
  logoTo:     "#F0BEE0",   // pink

  // Purple palette
  purple:     "#7B5CB8",   // primary — mic button, active tabs, links
  purpleDark: "#2E1880",   // very dark indigo — selected date circle
  gradFrom:   "#9268E0",   // button gradient start
  gradTo:     "#6A38B2",   // button gradient end
  purpleLight:"#EDE8FF",   // light fill — icon boxes, section bg

  // Text
  text:       "#1C1B33",   // primary — all main labels
  sub:        "#9490B5",   // secondary — time, subtitles
  faint:      "#B8B4D4",   // inactive tabs, placeholders

  // Semantic
  green:      "#52C41A",
  orange:     "#FF9500",
  blue:       "#5B8CFF",
  pink:       "#FF8FAB",
  pinkBorder: "#FFB5CC",
  red:        "#FF4D4F",
  teal:       "#26C6DA",

  border:     "rgba(150,100,200,0.1)",
} as const;

const PURPLE_GRAD = `linear-gradient(145deg, ${C.gradFrom} 0%, ${C.gradTo} 100%)`;

// ─── Navigation ───────────────────────────────────────────────────────────────
type Screen =
  | { name: "login" }
  | { name: "schedule" }
  | { name: "event-detail"; eventId: string }
  | { name: "calendar" }
  | { name: "meetings" }
  | { name: "recording"; meetingId: string }
  | { name: "transcription"; meetingId: string }
  | { name: "profile" }
  | { name: "account" }
  | { name: "privacy" };

// ─── Data ─────────────────────────────────────────────────────────────────────
interface CalEvent {
  id: string; title: string; startDate: string;
  endDate?: string; startTime?: string; endTime?: string;
  color: string; spanning?: boolean; category?: string;
  location?: string; detail?: string; status?: string;
}
const EVENTS: CalEvent[] = [
  { id:"1",  title:"评审会",       startDate:"2026-07-01", color:C.blue },
  { id:"2",  title:"UI学习",       startDate:"2026-07-02", color:C.green },
  { id:"3",  title:"约会",         startDate:"2026-07-03", color:C.pink },
  { id:"4",  title:"项目复盘",     startDate:"2026-07-05", color:C.orange },
  { id:"5",  title:"UI学习",       startDate:"2026-07-06", color:C.green },
  { id:"6",  title:"健身",         startDate:"2026-07-07", color:"#5CB85C" },
  { id:"7",  title:"文档整理",     startDate:"2026-07-09", color:C.orange },
  { id:"8",  title:"约会",         startDate:"2026-07-10", color:C.pink },
  { id:"9",  title:"周会",         startDate:"2026-07-12", color:C.blue },
  { id:"10", title:"健身",         startDate:"2026-07-13", color:"#5CB85C" },
  { id:"11", title:"需求评审",     startDate:"2026-07-14", color:C.red },
  { id:"12", title:"健身",         startDate:"2026-07-15", color:"#5CB85C" },
  { id:"13", title:"笔记本制作", startDate:"2026-07-19", endDate:"2026-07-25",
    color:"#9B59B6", spanning:true, status:"进行中" },
  { id:"14", title:"产品设计评审会", startDate:"2026-07-20",
    startTime:"10:00", endTime:"11:30", color:C.green,
    category:"工作", location:"会议室B / 线上会议",
    detail:"本次评审会将聚焦新版本产品的视觉设计方案，包括首页改版、任务中心、数据看板等模块。请提前准备好设计稿及交互说明。" },
  { id:"15", title:"健身·核心训练", startDate:"2026-07-20",
    startTime:"18:30", endTime:"19:30", color:C.orange },
  { id:"16", title:"周会",       startDate:"2026-07-26", color:C.blue },
  { id:"17", title:"健身",       startDate:"2026-07-27", color:"#5CB85C" },
  { id:"18", title:"方案评审",   startDate:"2026-07-29", color:C.orange },
];

interface Meeting {
  id: string; title: string; date: string; time: string;
  duration: string; tags: { label: string; color: string }[];
  bars: number[];
}
const MEETINGS: Meeting[] = [
  { id:"m1", title:"产品设计评审会",
    date:"2026年7月20日（周一）", time:"10:00 – 11:30", duration:"01:32:45",
    tags:[{ label:"产品项目", color:C.blue },{ label:"评审会", color:C.orange }],
    bars:[4,9,15,7,19,11,5,17,8,6,13,10,7,14,9,4,16,12,8,5,18,10,6,15,9] },
  { id:"m2", title:"UI 设计方案讨论会",
    date:"2026年7月20日（周一）", time:"14:00 – 15:15", duration:"01:15:22",
    tags:[{ label:"AI项目会议", color:"#9B59B6" },{ label:"设计", color:C.teal }],
    bars:[7,12,5,17,9,4,14,8,11,6,15,7,12,4,11,9,5,13,8,6] },
  { id:"m3", title:"运营周会第 21 期",
    date:"2026年7月19日（周日）", time:"09:30 – 10:30", duration:"01:00:18",
    tags:[{ label:"运营周会", color:C.orange }],
    bars:[5,13,8,4,17,10,6,15,9,3,12,7,5,14,8,10,6,11] },
  { id:"m4", title:"用户反馈收集会",
    date:"2026年7月19日（周日）", time:"16:00 – 17:10", duration:"01:10:05",
    tags:[{ label:"产品项目", color:C.blue },{ label:"用户反馈", color:C.pink }],
    bars:[9,5,14,7,11,17,4,8,13,6,10,15,3,12,7,9,5,14] },
  { id:"m5", title:"市场策略同步会",
    date:"2026年7月19日（周日）", time:"18:30 – 19:30", duration:"01:00:12",
    tags:[{ label:"市场会议", color:C.teal },{ label:"产品项目", color:C.blue }],
    bars:[6,12,8,4,15,10,7,13,5,9,17,6,11,4,8,12,7,14] },
];

// ─── Sparkle SVG ──────────────────────────────────────────────────────────────
function Sparkle({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={{ display:"block" }}>
      <path
        d="M10 0 L11.8 8.2 L20 10 L11.8 11.8 L10 20 L8.2 11.8 L0 10 L8.2 8.2 Z"
        fill={color}
      />
    </svg>
  );
}

// ─── Waveform ─────────────────────────────────────────────────────────────────
function Waveform({ bars, color, height = 28, splitAt }: {
  bars: number[]; color: string; height?: number; splitAt?: number;
}) {
  const max = Math.max(...bars);
  return (
    <div style={{ display:"flex", alignItems:"center", gap:2, height }}>
      {bars.map((v, i) => (
        <div key={i} style={{
          width:3, borderRadius:2, flexShrink:0,
          height:`${(v / max) * height}px`,
          background: splitAt && i < splitAt ? "#4A90D9" : color,
          opacity:0.85,
        }} />
      ))}
    </div>
  );
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
function Avatar({ size = 36 }: { size?: number }) {
  return (
    <div style={{
      width:size, height:size, borderRadius:"50%",
      background:"linear-gradient(135deg, #F5A7D0, #C9A6F5)",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize:size*0.36, color:"#fff", fontWeight:700, flexShrink:0,
      border:"2px solid #fff", boxShadow:"0 2px 10px rgba(180,100,220,0.25)",
    }}>王</div>
  );
}

// ─── Tag ─────────────────────────────────────────────────────────────────────
function Tag({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ background:`${color}1A`, borderRadius:6, padding:"3px 9px",
      fontSize:12, color, fontWeight:600, display:"inline-block" }}>
      {label}
    </span>
  );
}

// ─── Back header ──────────────────────────────────────────────────────────────
function BackHeader({ title, onBack, right }: {
  title: string; onBack: () => void; right?: React.ReactNode;
}) {
  return (
    <div style={{
      height:52, display:"flex", alignItems:"center", justifyContent:"space-between",
      padding:"0 16px", flexShrink:0, background:C.card,
      borderBottom:`1px solid ${C.border}`,
    }}>
      <button onClick={onBack} style={{ background:"none",border:"none",cursor:"pointer",
        color:C.sub, display:"flex", padding:4 }}>
        <ChevronLeft size={22} strokeWidth={2} />
      </button>
      <span style={{ fontSize:16, fontWeight:700, color:C.text }}>{title}</span>
      <div style={{ minWidth:36, display:"flex", justifyContent:"flex-end" }}>{right}</div>
    </div>
  );
}

// ─── Bottom Tab Bar — white card, rounded top, floating mic ──────────────────
function BottomTabBar({ active, nav }: { active:"schedule"|"meetings"; nav:(s:Screen)=>void }) {
  return (
    <div style={{ position:"relative", flexShrink:0 }}>
      {/* Floating mic button — center, raised 28px above card top */}
      <div style={{
        position:"absolute", top:-28, left:"50%", transform:"translateX(-50%)", zIndex:10,
      }}>
        <button style={{
          width:58, height:58, borderRadius:"50%",
          background: PURPLE_GRAD,
          border:"none", cursor:"pointer",
          display:"flex", alignItems:"center", justifyContent:"center",
          boxShadow:"0 6px 24px rgba(106,56,178,0.55)",
        }}>
          <Mic size={24} color="#FFFFFF" strokeWidth={2} />
        </button>
      </div>

      {/* White card with curved top corners */}
      <div style={{
        height:72,
        background:"#FFFFFF",
        borderRadius:"24px 24px 0 0",
        boxShadow:"0 -6px 24px rgba(100,60,180,0.08)",
        display:"flex", alignItems:"center",
        padding:"0 0 10px",
      }}>
        <button onClick={()=>nav({name:"schedule"})} style={{
          flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4,
          background:"none", border:"none", cursor:"pointer",
          color: active==="schedule" ? C.purple : C.faint,
        }}>
          <CalendarDays size={22} strokeWidth={1.8} />
          <span style={{ fontSize:11, fontWeight:500 }}>日程</span>
        </button>

        {/* Gap for the floating mic */}
        <div style={{ width:80, flexShrink:0 }} />

        <button onClick={()=>nav({name:"meetings"})} style={{
          flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4,
          background:"none", border:"none", cursor:"pointer",
          color: active==="meetings" ? C.purple : C.faint,
        }}>
          <Users size={22} strokeWidth={1.8} />
          <span style={{ fontSize:11, fontWeight:500 }}>会议</span>
        </button>
      </div>
    </div>
  );
}

// ─── Calendar Grid ────────────────────────────────────────────────────────────
function CalGrid({ year, month, selDay, onDay, onPrev, onNext, onTitle }: {
  year:number; month:number; selDay:number;
  onDay:(d:number)=>void; onPrev:()=>void; onNext:()=>void; onTitle?:()=>void;
}) {
  const WD = ["日","一","二","三","四","五","六"];
  const fDow = new Date(year, month-1, 1).getDay();
  const dim  = new Date(year, month, 0).getDate();
  const pDim = new Date(year, month-1, 0).getDate();

  const cells:{d:number;cur:boolean}[] = [];
  for (let i=0;i<fDow;i++) cells.push({d:pDim-fDow+1+i,cur:false});
  for (let d=1;d<=dim;d++) cells.push({d,cur:true});
  while (cells.length%7) cells.push({d:cells.length-dim-fDow+1,cur:false});
  const rows = Array.from({length:cells.length/7},(_,i)=>cells.slice(i*7,i*7+7));

  const ds = (d:number) => `${year}-${String(month).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const ptEvts = (d:number) => EVENTS.filter(e=>!e.spanning&&e.startDate===ds(d));
  const spans = (row:{d:number;cur:boolean}[]) => {
    const out:{e:CalEvent;sc:number;ec:number}[] = [];
    for (const e of EVENTS) {
      if (!e.spanning||!e.endDate) continue;
      let sc=-1,ec=-1;
      row.forEach((c,i)=>{
        if (!c.cur) return;
        const s=ds(c.d);
        if (s>=e.startDate&&s<=e.endDate!){if(sc<0)sc=i;ec=i;}
      });
      if (sc>=0) out.push({e,sc,ec});
    }
    return out;
  };

  return (
    <div style={{background:C.card,borderRadius:20,margin:"0 14px",padding:"16px 8px 12px",
      boxShadow:"0 2px 18px rgba(100,50,180,0.08)"}}>

      {/* Month header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        padding:"0 6px",marginBottom:14}}>
        <button onClick={onPrev} style={{background:"none",border:"none",cursor:"pointer",
          color:C.sub,padding:4,display:"flex"}}>
          <ChevronLeft size={20}/>
        </button>
        <button onClick={onTitle} disabled={!onTitle}
          style={{background:"none",border:"none",cursor:onTitle?"pointer":"default",
            padding:"2px 8px",display:"flex",alignItems:"center",gap:4}}>
          <span style={{fontSize:15,fontWeight:700,color:C.text}}>{year}年{month}月</span>
          {onTitle&&<ChevronRight size={13} color={C.purple} strokeWidth={2.5}/>}
        </button>
        <div style={{display:"flex",alignItems:"center",gap:2}}>
          <button onClick={onNext} style={{background:"none",border:"none",cursor:"pointer",
            color:C.sub,padding:4,display:"flex"}}>
            <ChevronRight size={20}/>
          </button>
          <button style={{background:"none",border:"none",cursor:"pointer",
            color:C.sub,padding:4,display:"flex"}}>
            <Search size={15}/>
          </button>
        </div>
      </div>

      {/* Weekday row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",marginBottom:4}}>
        {WD.map(d=>(
          <div key={d} style={{textAlign:"center",fontSize:11,color:C.faint,
            fontWeight:500,padding:"2px 0"}}>{d}</div>
        ))}
      </div>

      {/* Date rows */}
      {rows.map((row,ri)=>{
        const sp = spans(row);
        return (
          <div key={ri}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)"}}>
              {row.map((cell,ci)=>{
                const sel = cell.cur&&cell.d===selDay;
                const evts = cell.cur ? ptEvts(cell.d) : [];
                return (
                  <div key={ci} onClick={()=>cell.cur&&onDay(cell.d)}
                    style={{display:"flex",flexDirection:"column",alignItems:"center",
                      cursor:cell.cur?"pointer":"default",padding:"2px 0",minHeight:50}}>
                    <div style={{width:28,height:28,borderRadius:"50%",
                      background:sel?C.purpleDark:"transparent",
                      display:"flex",alignItems:"center",justifyContent:"center",marginBottom:2}}>
                      <span style={{fontSize:13,fontWeight:sel?700:400,lineHeight:1,
                        color:sel?"#fff":cell.cur?C.text:"#D5D0ED"}}>
                        {cell.d}
                      </span>
                    </div>
                    {evts.slice(0,2).map(e=>(
                      <div key={e.id} style={{
                        fontSize:9,color:e.color,background:`${e.color}1E`,
                        borderRadius:3,padding:"1px 3px",marginBottom:1,
                        maxWidth:"93%",overflow:"hidden",textOverflow:"ellipsis",
                        whiteSpace:"nowrap",fontWeight:600,lineHeight:1.5,
                      }}>{e.title}</div>
                    ))}
                  </div>
                );
              })}
            </div>
            {sp.map(({e,sc,ec},si)=>(
              <div key={si} style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",
                marginBottom:5,marginTop:-1}}>
                {Array.from({length:7}).map((_,ci)=>{
                  const inSp=ci>=sc&&ci<=ec, isS=ci===sc, isE=ci===ec;
                  return (
                    <div key={ci} style={{
                      height:16,
                      background:inSp?`${e.color}22`:"transparent",
                      borderRadius:isS&&isE?8:isS?"8px 0 0 8px":isE?"0 8px 8px 0":0,
                      display:"flex",alignItems:"center",paddingLeft:isS?5:0,
                    }}>
                      {isS&&<span style={{fontSize:9,color:e.color,fontWeight:700,
                        whiteSpace:"nowrap"}}>{e.title}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 1 · 登录
// ═══════════════════════════════════════════════════════════════════════════════
function LoginScreen({ nav }: { nav:(s:Screen)=>void }) {
  const [showPwd,setShowPwd]=useState(false);

  return (
    <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",
      alignItems:"center",padding:"52px 28px 36px",
      background:`linear-gradient(170deg, ${C.loginTop} 0%, ${C.loginBot} 100%)`}}>

      {/* Logo + sparkles */}
      <div style={{position:"relative",marginBottom:10}}>
        {/* Big sparkle — top right */}
        <div style={{position:"absolute",top:-12,right:-20,zIndex:1}}>
          <Sparkle size={18} color="#C8A8F0"/>
        </div>
        {/* Small sparkle — bottom left */}
        <div style={{position:"absolute",bottom:6,left:-18,zIndex:1}}>
          <Sparkle size={10} color="#E0B0DA"/>
        </div>
        {/* Circle */}
        <div style={{width:88,height:88,borderRadius:"50%",
          background:`linear-gradient(135deg, ${C.logoFrom}, ${C.logoTo})`,
          display:"flex",alignItems:"center",justifyContent:"center",
          boxShadow:"0 8px 32px rgba(180,100,220,0.3)"}}>
          <span style={{fontSize:15,fontWeight:700,color:"#fff",letterSpacing:0.3}}>Logo</span>
        </div>
      </div>

      {/* App name */}
      <div style={{fontSize:20,fontWeight:800,color:"#3A2288",
        marginBottom:32,letterSpacing:4}}>老记</div>

      {/* Headings */}
      <div style={{fontSize:26,fontWeight:800,color:C.text,marginBottom:8}}>欢迎回来</div>
      <div style={{fontSize:13,color:C.sub,marginBottom:36,textAlign:"center",lineHeight:1.9}}>
        登录账号，继续管理你的日程与会议记录
      </div>

      {/* Email input */}
      <div style={{width:"100%",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:12,background:C.inputBg,
          borderRadius:14,padding:"0 16px",height:52}}>
          <Mail size={17} color={C.sub} strokeWidth={1.8}/>
          <input placeholder="邮箱 / 手机号"
            style={{flex:1,border:"none",background:"transparent",outline:"none",
              fontSize:14,color:C.text,fontFamily:"inherit"}}/>
        </div>
      </div>

      {/* Password input */}
      <div style={{width:"100%",marginBottom:10}}>
        <div style={{display:"flex",alignItems:"center",gap:12,background:C.inputBg,
          borderRadius:14,padding:"0 16px",height:52}}>
          <Lock size={17} color={C.sub} strokeWidth={1.8}/>
          <input type={showPwd?"text":"password"} placeholder="密码"
            style={{flex:1,border:"none",background:"transparent",outline:"none",
              fontSize:14,color:C.text,fontFamily:"inherit"}}/>
          <button onClick={()=>setShowPwd(p=>!p)}
            style={{background:"none",border:"none",cursor:"pointer",
              color:C.sub,display:"flex",padding:0}}>
            {showPwd?<EyeOff size={17} strokeWidth={1.8}/>:<Eye size={17} strokeWidth={1.8}/>}
          </button>
        </div>
      </div>

      {/* Forgot */}
      <div style={{width:"100%",textAlign:"right",marginBottom:28}}>
        <button style={{background:"none",border:"none",cursor:"pointer",
          color:C.purple,fontSize:13,fontFamily:"inherit"}}>忘记密码?</button>
      </div>

      {/* 登录 button */}
      <button onClick={()=>nav({name:"schedule"})} style={{
        width:"100%",height:52,borderRadius:26,background:PURPLE_GRAD,
        border:"none",cursor:"pointer",fontSize:16,fontWeight:700,color:"#fff",
        marginBottom:14,boxShadow:"0 6px 22px rgba(106,56,178,0.45)",fontFamily:"inherit",
      }}>登录</button>

      {/* 注册 button */}
      <button style={{
        width:"100%",height:52,borderRadius:26,background:"transparent",
        border:`2px solid ${C.pinkBorder}`,cursor:"pointer",
        fontSize:15,fontWeight:600,color:C.pink,marginBottom:22,fontFamily:"inherit",
      }}>注册</button>

      {/* Divider */}
      <div style={{display:"flex",alignItems:"center",width:"100%",gap:12,marginBottom:22}}>
        <div style={{flex:1,height:1,background:"#E4DCF4"}}/>
        <span style={{fontSize:12,color:C.faint}}>或</span>
        <div style={{flex:1,height:1,background:"#E4DCF4"}}/>
      </div>

      {/* 游客体验 */}
      <button style={{
        width:"100%",height:48,borderRadius:24,background:"transparent",
        border:"1.5px solid #D5D0EE",cursor:"pointer",
        fontSize:14,fontWeight:500,color:"#7A78A0",marginBottom:32,fontFamily:"inherit",
      }}>游客体验</button>

      {/* Terms */}
      <div style={{fontSize:11,color:C.faint,textAlign:"center",lineHeight:1.9}}>
        登录即代表你同意<span style={{color:C.purple}}>《用户协议》</span>与
        <span style={{color:C.purple}}>《隐私政策》</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 2 · 日程首页
// ═══════════════════════════════════════════════════════════════════════════════
function ScheduleScreen({ nav }: { nav:(s:Screen)=>void }) {
  const [year,setYear]=useState(2026),[month,setMonth]=useState(7),[selDay,setSelDay]=useState(20);
  const prev=()=>month===1?(setMonth(12),setYear(y=>y-1)):setMonth(m=>m-1);
  const next=()=>month===12?(setMonth(1),setYear(y=>y+1)):setMonth(m=>m+1);
  return (
    <>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 16px 10px",flexShrink:0}}>
        <span style={{fontSize:22,fontWeight:800,color:C.text}}>日程</span>
        <div style={{flex:1,height:34,background:C.inputBg,borderRadius:17,
          display:"flex",alignItems:"center",padding:"0 12px",gap:8}}>
          <Search size={13} color={C.sub}/>
          <span style={{fontSize:12,color:C.faint}}>搜索日程、会议、时间</span>
        </div>
        <button onClick={()=>nav({name:"profile"})}
          style={{background:"none",border:"none",cursor:"pointer",padding:0}}>
          <Avatar size={36}/>
        </button>
      </div>

      <div style={{flex:1,overflowY:"auto",paddingBottom:8}}>
        {/* 今日待办 */}
        <div style={{margin:"0 14px 16px",background:C.tasksBg,borderRadius:18,padding:"14px 16px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <span style={{fontSize:14,fontWeight:700,color:C.text}}>今日待办</span>
            <span style={{fontSize:12,color:C.sub}}>2026年7月20日 周一</span>
          </div>
          {[
            {color:C.green,  title:"产品设计评审会", time:"10:00",id:"14"},
            {color:C.blue,   title:"UI 设计学习",    time:"14:00",id:"2"},
            {color:C.orange, title:"健身·核心训练",  time:"18:30",id:"15"},
          ].map((t,i)=>(
            <div key={t.id} onClick={()=>nav({name:"event-detail",eventId:t.id})}
              style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",
                cursor:"pointer",borderTop:i>0?`1px solid rgba(255,150,200,0.2)`:"none"}}>
              <div style={{width:10,height:10,borderRadius:"50%",background:t.color,flexShrink:0}}/>
              <span style={{flex:1,fontSize:14,fontWeight:500,color:C.text}}>{t.title}</span>
              <span style={{fontSize:13,color:C.sub,fontWeight:500}}>{t.time}</span>
            </div>
          ))}
        </div>

        <CalGrid year={year} month={month} selDay={selDay} onDay={setSelDay}
          onPrev={prev} onNext={next} onTitle={()=>nav({name:"calendar"})}/>
      </div>

      <BottomTabBar active="schedule" nav={nav}/>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 3 · 日程详情
// ═══════════════════════════════════════════════════════════════════════════════
function EventDetailScreen({ eventId, nav }: { eventId:string; nav:(s:Screen)=>void }) {
  const ev = EVENTS.find(e=>e.id===eventId)??EVENTS[13];
  return (
    <>
      <BackHeader title="日程详情" onBack={()=>nav({name:"schedule"})}
        right={<button style={{background:"none",border:"none",cursor:"pointer",
          color:C.sub,display:"flex"}}><MoreHorizontal size={20}/></button>}/>

      <div style={{flex:1,overflowY:"auto",padding:"26px 20px",background:C.card}}>
        {/* Title */}
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:28}}>
          <div style={{width:14,height:14,borderRadius:"50%",background:ev.color,flexShrink:0}}/>
          <span style={{flex:1,fontSize:21,fontWeight:800,color:C.text}}>{ev.title}</span>
          {ev.category&&(
            <div style={{background:`${ev.color}22`,borderRadius:8,padding:"4px 12px",flexShrink:0}}>
              <span style={{fontSize:12,fontWeight:700,color:ev.color}}>{ev.category}</span>
            </div>
          )}
        </div>

        {[
          {Icon:CalendarDays,text:"2026年7月20日（周一）"},
          {Icon:Clock,text:`${ev.startTime??""} – ${ev.endTime??"全天"}`},
          {Icon:MapPin,text:ev.location??"—"},
        ].map(({Icon,text})=>(
          <div key={text} style={{display:"flex",alignItems:"center",gap:14,marginBottom:18}}>
            <div style={{width:40,height:40,borderRadius:12,background:C.purpleLight,
              display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <Icon size={18} color={C.purple} strokeWidth={1.8}/>
            </div>
            <span style={{fontSize:15,color:"#4A4666"}}>{text}</span>
          </div>
        ))}

        {ev.detail&&<>
          <div style={{fontSize:16,fontWeight:700,color:C.text,margin:"28px 0 14px"}}>详细内容</div>
          <p style={{fontSize:14,color:"#4A4666",lineHeight:2,margin:0}}>{ev.detail}</p>
        </>}
      </div>

      <BottomTabBar active="schedule" nav={nav}/>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 4 · 日历视图
// ═══════════════════════════════════════════════════════════════════════════════
function CalendarScreen({ nav }: { nav:(s:Screen)=>void }) {
  const [year,setYear]=useState(2026),[month,setMonth]=useState(7),[selDay,setSelDay]=useState(20);
  const prev=()=>month===1?(setMonth(12),setYear(y=>y-1)):setMonth(m=>m-1);
  const next=()=>month===12?(setMonth(1),setYear(y=>y+1)):setMonth(m=>m+1);
  const ds=`${year}-${String(month).padStart(2,"0")}-${String(selDay).padStart(2,"0")}`;
  const WDN=["周日","周一","周二","周三","周四","周五","周六"];
  const wday=WDN[new Date(year,month-1,selDay).getDay()];
  const dayEvts=EVENTS.filter(e=>e.spanning&&e.endDate
    ?ds>=e.startDate&&ds<=e.endDate:e.startDate===ds);

  return (
    <>
      <BackHeader title={`日历 · ${year}年${month}月`} onBack={()=>nav({name:"schedule"})}
        right={<button style={{background:"none",border:"none",cursor:"pointer",
          color:C.sub,display:"flex"}}><Search size={19}/></button>}/>

      <div style={{flex:1,overflowY:"auto",paddingBottom:8}}>
        <div style={{height:14}}/>
        <CalGrid year={year} month={month} selDay={selDay} onDay={setSelDay}
          onPrev={prev} onNext={next}/>

        <div style={{height:1,background:C.border,margin:"14px 14px 0"}}/>

        <div style={{padding:"0 14px"}}>
          <div style={{fontSize:14,fontWeight:700,color:C.text,padding:"14px 4px 12px"}}>
            {month}月{selDay}日（{wday}）
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {dayEvts.length===0
              ?<div style={{textAlign:"center",padding:"28px 0",color:C.faint,fontSize:13}}>今日暂无日程</div>
              :dayEvts.map(e=>{
                const tl=e.startTime&&e.endTime?`${e.startTime} – ${e.endTime}`
                  :e.spanning&&e.endDate?`${e.startDate.slice(5).replace("-","月")}日 – ${e.endDate.slice(5).replace("-","月")}日`:"全天";
                return (
                  <div key={e.id} onClick={()=>nav({name:"event-detail",eventId:e.id})}
                    style={{background:C.card,borderRadius:14,padding:"12px 14px",
                      display:"flex",alignItems:"center",gap:10,
                      boxShadow:"0 1px 10px rgba(80,40,160,0.06)",cursor:"pointer"}}>
                    <div style={{width:9,height:9,borderRadius:"50%",background:e.color,flexShrink:0}}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:600,color:C.text,marginBottom:3,
                        overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                        {e.title}{e.status&&<span style={{fontWeight:400,color:C.sub,fontSize:12}}>（{e.status}）</span>}
                      </div>
                      <div style={{fontSize:12,color:"#A09CC0"}}>{tl}</div>
                    </div>
                    <button style={{background:"none",border:"none",cursor:"pointer",
                      color:C.faint,padding:4,display:"flex"}}><MoreHorizontal size={16}/></button>
                  </div>
                );
              })}
          </div>
          <div style={{display:"flex",gap:12,marginTop:18,marginBottom:4}}>
            <button style={{flex:1,height:42,border:`1.5px solid ${C.purple}`,borderRadius:21,
              background:"transparent",color:C.purple,fontSize:13,fontWeight:600,
              cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
              gap:5,fontFamily:"inherit"}}>
              <Plus size={14} strokeWidth={2.5}/>新增事件
            </button>
            <button style={{flex:1,height:42,border:`1.5px solid ${C.red}`,borderRadius:21,
              background:"transparent",color:C.red,fontSize:13,fontWeight:600,
              cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
              gap:5,fontFamily:"inherit"}}>
              <Trash2 size={14} strokeWidth={2.5}/>删除事件
            </button>
          </div>
        </div>
      </div>
      <BottomTabBar active="schedule" nav={nav}/>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 5 · 会议记录
// ═══════════════════════════════════════════════════════════════════════════════
function MeetingListScreen({ nav }: { nav:(s:Screen)=>void }) {
  const groups=[{label:"今天",items:MEETINGS.slice(0,2)},{label:"昨日",items:MEETINGS.slice(2)}];
  return (
    <>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        padding:"14px 16px 10px",flexShrink:0}}>
        <span style={{fontSize:22,fontWeight:800,color:C.text}}>会议记录</span>
        <button onClick={()=>nav({name:"profile"})}
          style={{background:"none",border:"none",cursor:"pointer",padding:0}}>
          <Avatar size={36}/>
        </button>
      </div>
      <div style={{margin:"0 14px 12px",height:38,background:C.inputBg,borderRadius:19,
        display:"flex",alignItems:"center",padding:"0 14px",gap:8,flexShrink:0}}>
        <Search size={14} color={C.sub}/>
        <span style={{fontSize:13,color:C.faint}}>搜索会议、主题、标签</span>
      </div>
      <div style={{flex:1,overflowY:"auto",paddingBottom:8}}>
        {groups.map(({label,items})=>(
          <div key={label}>
            <div style={{fontSize:12,color:C.sub,fontWeight:600,
              padding:"6px 18px",letterSpacing:0.5}}>{label}</div>
            {items.map(m=>(
              <div key={m.id} onClick={()=>nav({name:"recording",meetingId:m.id})}
                style={{margin:"0 14px 10px",background:C.card,borderRadius:16,
                  padding:"14px",cursor:"pointer",boxShadow:"0 1px 10px rgba(80,40,160,0.06)"}}>
                <div style={{display:"flex",alignItems:"flex-start",
                  justifyContent:"space-between",marginBottom:6}}>
                  <div>
                    <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:4}}>{m.title}</div>
                    <div style={{fontSize:12,color:C.sub}}>{m.time}&nbsp;&nbsp;{m.duration}</div>
                  </div>
                  <button style={{background:"none",border:"none",cursor:"pointer",
                    color:C.faint,padding:0,display:"flex"}}>
                    <MoreHorizontal size={18}/>
                  </button>
                </div>
                <div style={{margin:"10px 0 8px"}}>
                  <Waveform bars={m.bars} color={C.purple} height={30}/>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {m.tags.map(t=><Tag key={t.label} label={t.label} color={t.color}/>)}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <BottomTabBar active="meetings" nav={nav}/>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 6 · 录音详情
// ═══════════════════════════════════════════════════════════════════════════════
function RecordingScreen({ meetingId, nav }: { meetingId:string; nav:(s:Screen)=>void }) {
  const m=MEETINGS.find(x=>x.id===meetingId)??MEETINGS[0];
  const [playing,setPlaying]=useState(false);
  const bigBars=[...m.bars,...m.bars,...m.bars.slice(0,10)];

  return (
    <>
      <BackHeader title="录音详情" onBack={()=>nav({name:"meetings"})}
        right={<button style={{background:"none",border:"none",cursor:"pointer",
          color:C.sub,display:"flex"}}><MoreHorizontal size={20}/></button>}/>

      <div style={{flex:1,overflowY:"auto",padding:"22px 20px"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
          <span style={{fontSize:21,fontWeight:800,color:C.text}}>{m.title}</span>
          <button style={{background:"none",border:"none",cursor:"pointer",
            color:C.sub,display:"flex"}}><Edit2 size={15}/></button>
        </div>
        <div style={{fontSize:13,color:C.sub,marginBottom:10}}>{m.date}&nbsp;&nbsp;{m.time}</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:24}}>
          {m.tags.map(t=><Tag key={t.label} label={t.label} color={t.color}/>)}
        </div>

        {/* Waveform player card */}
        <div style={{background:C.waveformBg,borderRadius:20,padding:"20px 18px 18px",marginBottom:22}}>
          <div style={{marginBottom:14}}>
            <Waveform bars={bigBars} color={C.purple} height={64} splitAt={Math.floor(bigBars.length*0.26)}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:22}}>
            <span style={{fontSize:12,color:C.sub}}>00:24:10</span>
            <span style={{fontSize:12,color:C.sub}}>{m.duration}</span>
          </div>

          {/* Controls */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:28}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
              <button style={{background:"none",border:"none",cursor:"pointer",
                color:C.purple,display:"flex"}}>
                <RotateCcw size={24} strokeWidth={1.8}/>
              </button>
              <span style={{fontSize:10,color:C.sub,fontWeight:600}}>15</span>
            </div>

            <button onClick={()=>setPlaying(p=>!p)} style={{
              width:56,height:56,borderRadius:"50%",background:PURPLE_GRAD,
              border:"none",cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"center",
              boxShadow:"0 4px 18px rgba(106,56,178,0.5)"}}>
              {playing
                ?<Pause size={22} color="#fff" strokeWidth={2}/>
                :<Play  size={22} color="#fff" strokeWidth={2} style={{marginLeft:2}}/>}
            </button>

            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
              <button style={{background:"none",border:"none",cursor:"pointer",
                color:C.purple,display:"flex"}}>
                <RotateCw size={24} strokeWidth={1.8}/>
              </button>
              <span style={{fontSize:10,color:C.sub,fontWeight:600}}>15</span>
            </div>

            <button style={{background:C.purpleLight,borderRadius:8,padding:"6px 10px",
              border:"none",cursor:"pointer",fontFamily:"inherit"}}>
              <span style={{fontSize:12,color:C.purple,fontWeight:700}}>1.0x 倍速</span>
            </button>
          </div>
        </div>

        {/* 2×2 tiles */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          {[
            {label:"转写",icon:<FileText size={30} color="#5B8CFF"/>,bg:"#EEF3FF",
              onClick:()=>nav({name:"transcription",meetingId})},
            {label:"总结",icon:<span style={{fontSize:28}}>📋</span>,bg:"#FFF4E8",onClick:()=>{}},
            {label:"分享",icon:<Share2 size={30} color="#26C6DA"/>,bg:"#E8FAFC",onClick:()=>{}},
            {label:"删除",icon:<Trash2 size={30} color="#FF4D4F"/>,bg:"#FFF0F0",
              onClick:()=>nav({name:"meetings"})},
          ].map(({label,icon,bg,onClick})=>(
            <button key={label} onClick={onClick} style={{height:96,background:bg,
              borderRadius:18,border:"none",cursor:"pointer",
              display:"flex",flexDirection:"column",alignItems:"center",
              justifyContent:"center",gap:8,fontFamily:"inherit"}}>
              {icon}
              <span style={{fontSize:15,fontWeight:600,color:C.text}}>{label}</span>
            </button>
          ))}
        </div>
      </div>
      <BottomTabBar active="meetings" nav={nav}/>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 7 · 会议转写
// ═══════════════════════════════════════════════════════════════════════════════
function SCard({ num,title,badge,children }:
  {num:number;title:string;badge?:string;children:React.ReactNode}) {
  return (
    <div style={{background:C.card,borderRadius:16,padding:"14px 16px",marginBottom:12,
      boxShadow:"0 1px 8px rgba(80,40,160,0.05)"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        <div style={{width:22,height:22,borderRadius:"50%",background:C.purpleDark,
          display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <span style={{fontSize:11,fontWeight:700,color:"#fff"}}>{num}</span>
        </div>
        <span style={{fontSize:14,fontWeight:700,color:C.text}}>{title}</span>
        {badge&&<span style={{fontSize:10,background:"#FFE8F0",color:C.pink,
          borderRadius:6,padding:"1px 7px",fontWeight:600}}>{badge}</span>}
      </div>
      {children}
    </div>
  );
}

function TranscriptionScreen({ meetingId, nav }: { meetingId:string; nav:(s:Screen)=>void }) {
  const m=MEETINGS.find(x=>x.id===meetingId)??MEETINGS[0];
  return (
    <>
      <BackHeader title="会议转写" onBack={()=>nav({name:"recording",meetingId})}
        right={<button style={{background:"none",border:"none",cursor:"pointer",
          color:C.sub,display:"flex"}}><MoreHorizontal size={20}/></button>}/>
      <div style={{flex:1,overflowY:"auto",padding:"14px"}}>
        <SCard num={1} title="日期">
          <span style={{fontSize:14,color:C.text}}>{m.date}&nbsp;&nbsp;{m.time}</span>
        </SCard>
        <SCard num={2} title="录音">
          <div style={{background:C.purpleLight,borderRadius:12,padding:"12px 14px",
            display:"flex",alignItems:"center",gap:12}}>
            <button style={{width:32,height:32,borderRadius:"50%",background:C.purple,
              border:"none",cursor:"pointer",display:"flex",alignItems:"center",
              justifyContent:"center",flexShrink:0}}>
              <Play size={13} color="#fff"/>
            </button>
            <div style={{flex:1}}><Waveform bars={m.bars} color={C.purple} height={28}/></div>
            <div style={{fontSize:11,color:C.sub,textAlign:"right",flexShrink:0}}>
              <div>00:24:10</div><div>{m.duration}</div>
            </div>
          </div>
        </SCard>
        <SCard num={3} title="录音标题">
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
            background:"#F6F2FF",borderRadius:10,padding:"10px 14px"}}>
            <span style={{fontSize:14,fontWeight:500,color:C.text}}>{m.title}</span>
            <Edit2 size={14} color={C.sub}/>
          </div>
        </SCard>
        <SCard num={4} title="转写文本">
          <p style={{fontSize:13,color:"#4A4666",lineHeight:2,margin:0}}>
            本次评审主要围绕新版的交互流程展开，整体方向正确，用户路径更加简洁，整体流程更加清晰。建议在步骤三增加引导提示，帮助用户更快捷理解下一步操作。关于配色，建议使用品牌色的新变化来增强整体感，同时，建议优化按钮的视觉层级与状态反馈，确保在不同场景下的可用性与一致性。
          </p>
          <p style={{fontSize:13,color:"#4A4666",lineHeight:2,margin:"12px 0 0"}}>
            此外，需要考虑无障碍设计的适配，例如字体对比度、触控区域大小等细节，并在下次会议前提供可行性方案，后续我们将按用户测试，验证优化后的效果，并根据反馈迭代优化。
          </p>
        </SCard>
        <SCard num={5} title="AI 会议总结" badge="AI 生成">
          <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
            <div style={{width:32,height:32,borderRadius:"50%",background:C.purpleLight,
              display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:16}}>
              🤖
            </div>
            <p style={{fontSize:13,color:"#4A4666",lineHeight:1.9,margin:0}}>
              会议围绕新版交互流程展开，与会者一致以整体方向正确、结构性强的意见为主，建议进一步提升操作指引。在配色上使用品牌新变化增强层次感，下一步完善原型细节并进行用户测试验证。
            </p>
          </div>
        </SCard>
        <div style={{display:"flex",gap:8,marginTop:4,marginBottom:14}}>
          {[{l:"导出 TXT",c:C.blue},{l:"导出 DOCX",c:C.purple},{l:"分享转写",c:C.teal}].map(({l,c})=>(
            <button key={l} style={{flex:1,height:38,background:`${c}14`,
              border:`1px solid ${c}44`,borderRadius:10,cursor:"pointer",
              fontSize:11,color:c,fontWeight:600,fontFamily:"inherit"}}>{l}</button>
          ))}
        </div>
      </div>
      <BottomTabBar active="meetings" nav={nav}/>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 8 · 个人主页
// ═══════════════════════════════════════════════════════════════════════════════
function ProfileScreen({ nav }: { nav:(s:Screen)=>void }) {
  return (
    <>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        padding:"14px 18px 10px",flexShrink:0}}>
        <div style={{width:32}}/>
        <span style={{fontSize:18,fontWeight:800,color:C.text}}>我</span>
        <button onClick={()=>nav({name:"account"})}
          style={{background:"none",border:"none",cursor:"pointer",color:C.sub,display:"flex"}}>
          <Settings size={22} strokeWidth={1.8}/>
        </button>
      </div>
      <div style={{flex:1,overflowY:"auto",paddingBottom:8}}>
        {/* User card */}
        <div style={{margin:"0 14px 12px",background:C.card,borderRadius:20,
          padding:"18px 16px",display:"flex",alignItems:"center",gap:14,
          boxShadow:"0 2px 14px rgba(100,50,180,0.08)"}}>
          <Avatar size={62}/>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5}}>
              <span style={{fontSize:18,fontWeight:800,color:C.text}}>王多鱼</span>
              <div style={{background:"linear-gradient(90deg,#FFD700,#FFA500)",
                borderRadius:6,padding:"2px 8px"}}>
                <span style={{fontSize:10,fontWeight:800,color:"#fff"}}>♦ VIP</span>
              </div>
            </div>
            <span style={{fontSize:12,color:C.sub}}>wangduoyu@email.com</span>
          </div>
        </div>

        {/* VIP card */}
        <div style={{margin:"0 14px 12px",
          background:"linear-gradient(115deg,#FFD6EA,#FFF2F8)",
          borderRadius:18,padding:"14px 18px",display:"flex",
          alignItems:"center",justifyContent:"space-between",border:"1px solid #FFD6EA"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:38,height:38,borderRadius:"50%",background:"#FFE0EE",
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⭐</div>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:"#C2437A",marginBottom:3}}>高级会员</div>
              <div style={{fontSize:11,color:"#C2437A",opacity:0.75}}>有效期至 2026-07-20</div>
            </div>
          </div>
          <button style={{background:"linear-gradient(90deg,#FF8FAB,#FF5C8A)",border:"none",
            borderRadius:18,padding:"8px 18px",color:"#fff",fontSize:13,fontWeight:700,
            cursor:"pointer",fontFamily:"inherit",
            boxShadow:"0 3px 12px rgba(255,92,138,0.4)"}}>去续费</button>
        </div>

        {/* Stats */}
        <div style={{margin:"0 14px 12px",background:C.card,borderRadius:18,
          padding:"18px 16px",boxShadow:"0 1px 8px rgba(80,40,160,0.06)"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr"}}>
            {[
              {l:"本月完成日程",v:"28",u:"个",d:"+20%"},
              {l:"会议记录数量",v:"36",u:"篇",d:"+15%"},
              {l:"重要日期提醒",v:"12",u:"次",d:"+10%"},
            ].map((s,i)=>(
              <div key={s.l} style={{textAlign:"center",padding:"0 6px",
                borderRight:i<2?`1px solid ${C.border}`:"none"}}>
                <div style={{fontSize:10,color:C.sub,marginBottom:8,lineHeight:1.5}}>{s.l}</div>
                <div style={{fontSize:26,fontWeight:800,color:C.text,lineHeight:1}}>
                  {s.v}<span style={{fontSize:11,fontWeight:500}}> {s.u}</span>
                </div>
                <div style={{fontSize:11,color:C.green,marginTop:5}}>↑ {s.d}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Menu */}
        <div style={{margin:"0 14px",background:C.card,borderRadius:18,overflow:"hidden",
          boxShadow:"0 1px 8px rgba(80,40,160,0.06)"}}>
          {[
            {e:"💌",l:"邮箱设置",v:"wangduoyu@email.com",to:()=>nav({name:"account"})},
            {e:"📱",l:"手机号设置",v:"138 **** 8888",to:()=>nav({name:"account"})},
            {e:"🖼️",l:"头像设置",v:"",to:()=>nav({name:"account"})},
            {e:"🔒",l:"隐私设置",v:"",to:()=>nav({name:"privacy"})},
            {e:"❓",l:"操作指南与关于我们",v:"帮助中心 / 关于我们",to:()=>nav({name:"privacy"})},
          ].map((item,i,arr)=>(
            <button key={item.l} onClick={item.to}
              style={{width:"100%",display:"flex",alignItems:"center",gap:12,
                padding:"14px 16px",background:"none",border:"none",cursor:"pointer",
                borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none",fontFamily:"inherit"}}>
              <span style={{fontSize:20,width:28,textAlign:"center",flexShrink:0}}>{item.e}</span>
              <span style={{flex:1,fontSize:14,fontWeight:500,color:C.text,textAlign:"left"}}>{item.l}</span>
              {item.v&&<span style={{fontSize:12,color:C.sub}}>{item.v}</span>}
              <ChevronRight size={16} color={C.faint}/>
            </button>
          ))}
        </div>
      </div>
      <BottomTabBar active="schedule" nav={nav}/>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 9 · 账号与资料
// ═══════════════════════════════════════════════════════════════════════════════
function AccountScreen({ nav }: { nav:(s:Screen)=>void }) {
  return (
    <>
      <BackHeader title="账号与资料" onBack={()=>nav({name:"profile"})}
        right={<button style={{background:"none",border:"none",cursor:"pointer",
          color:C.purple,fontSize:15,fontWeight:700,fontFamily:"inherit"}}>保存</button>}/>
      <div style={{flex:1,overflowY:"auto",padding:"18px 14px"}}>
        <div style={{background:C.card,borderRadius:16,padding:"16px",marginBottom:12,
          boxShadow:"0 1px 8px rgba(80,40,160,0.06)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <span style={{fontSize:15,fontWeight:600,color:C.text}}>头像</span>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <div style={{position:"relative"}}>
                <Avatar size={52}/>
                <div style={{position:"absolute",bottom:-2,right:-2,width:18,height:18,
                  borderRadius:"50%",background:C.purple,display:"flex",
                  alignItems:"center",justifyContent:"center",border:"2px solid #fff",fontSize:10}}>📷</div>
              </div>
              <span style={{fontSize:13,color:C.sub}}>点击更换头像</span>
              <ChevronRight size={16} color={C.faint}/>
            </div>
          </div>
        </div>

        <div style={{background:C.card,borderRadius:16,overflow:"hidden",marginBottom:28,
          boxShadow:"0 1px 8px rgba(80,40,160,0.06)"}}>
          {[
            {l:"昵称",v:"王多鱼"},
            {l:"邮箱",v:"wangduoyu@email.com"},
            {l:"手机号",v:"138 **** 8888"},
            {l:"密码与安全",v:"修改密码 / 安全设置"},
            {l:"通知与提醒",v:"消息推送 / 邮件通知"},
          ].map((f,i,arr)=>(
            <div key={f.l} style={{display:"flex",alignItems:"center",padding:"14px 16px",
              borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none"}}>
              <span style={{flex:1,fontSize:15,fontWeight:600,color:C.text}}>{f.l}</span>
              <span style={{fontSize:13,color:C.sub,marginRight:8}}>{f.v}</span>
              <ChevronRight size={16} color={C.faint}/>
            </div>
          ))}
        </div>

        <button style={{width:"100%",height:52,borderRadius:26,background:"#352070",
          border:"none",cursor:"pointer",fontSize:16,fontWeight:700,color:"#fff",
          marginBottom:18,fontFamily:"inherit",
          boxShadow:"0 4px 16px rgba(53,32,112,0.35)"}}>保存修改</button>

        <div style={{textAlign:"center"}}>
          <button style={{background:"none",border:"none",cursor:"pointer",
            fontSize:14,color:C.red,fontWeight:500,fontFamily:"inherit"}}>退出登录</button>
        </div>
      </div>
      <BottomTabBar active="schedule" nav={nav}/>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCREEN 10 · 隐私与帮助
// ═══════════════════════════════════════════════════════════════════════════════
function PrivacyScreen({ nav }: { nav:(s:Screen)=>void }) {
  const [faceId,setFaceId]=useState(true);
  const [appLock,setAppLock]=useState(false);

  function Toggle({on,set}:{on:boolean;set:()=>void}) {
    return (
      <div onClick={e=>{e.stopPropagation();set();}}
        style={{width:46,height:26,borderRadius:13,background:on?C.purple:"#CCC8E0",
          position:"relative",cursor:"pointer",flexShrink:0,transition:"background 0.2s"}}>
        <div style={{position:"absolute",top:3,left:on?23:3,width:20,height:20,
          borderRadius:"50%",background:"#fff",transition:"left 0.2s",
          boxShadow:"0 1px 4px rgba(0,0,0,0.18)"}}/>
      </div>
    );
  }

  function Section({title,items}:{title:string;items:React.ReactNode[]}) {
    return (
      <div style={{marginBottom:20}}>
        <div style={{fontSize:13,fontWeight:700,color:C.sub,marginBottom:8,paddingLeft:4}}>{title}</div>
        <div style={{background:C.card,borderRadius:16,overflow:"hidden",
          boxShadow:"0 1px 8px rgba(80,40,160,0.06)"}}>
          {items}
        </div>
      </div>
    );
  }

  function Row({e,label,desc,right,border}:
    {e:string;label:string;desc:string;right:React.ReactNode;border?:boolean}) {
    return (
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",
        borderBottom:border?`1px solid ${C.border}`:"none"}}>
        <span style={{fontSize:18,width:28,textAlign:"center",flexShrink:0}}>{e}</span>
        <div style={{flex:1}}>
          <div style={{fontSize:14,fontWeight:600,color:C.text}}>{label}</div>
          <div style={{fontSize:11,color:C.sub,marginTop:2}}>{desc}</div>
        </div>
        {right}
      </div>
    );
  }

  const arrow = <ChevronRight size={16} color={C.faint}/>;

  return (
    <>
      <BackHeader title="隐私与帮助" onBack={()=>nav({name:"profile"})}/>
      <div style={{flex:1,overflowY:"auto",padding:"14px"}}>
        <Section title="隐私与权限管理" items={[
          <Row key="1" border e="🗂️" label="数据权限管理" desc="管理个人数据的访问权限" right={arrow}/>,
          <Row key="2" border e="🎙️" label="录音隐私设置" desc="管理录音的存储与使用权限" right={arrow}/>,
          <Row key="3" border e="📤" label="文件分享权限" desc="设置文件分享范围与有效期" right={arrow}/>,
          <Row key="4" border e="🔐" label="指纹 / Face ID" desc="开启后可快速解锁应用"
            right={<Toggle on={faceId} set={()=>setFaceId(v=>!v)}/>}/>,
          <Row key="5" e="🔒" label="应用锁定" desc="设置应用独立密码"
            right={<Toggle on={appLock} set={()=>setAppLock(v=>!v)}/>}/>,
        ]}/>
        <Section title="帮助与支持" items={[
          <Row key="1" border e="❓" label="帮助中心" desc="常见问题与解决方案" right={arrow}/>,
          <Row key="2" border e="📖" label="使用指南" desc="新手教程与功能介绍" right={arrow}/>,
          <Row key="3" border e="ℹ️" label="版本信息" desc="当前版本 1.2.0"
            right={<div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:10,background:C.purpleLight,color:C.purple,
                borderRadius:6,padding:"2px 7px",fontWeight:600}}>新版本可用</span>
              {arrow}
            </div>}/>,
          <Row key="4" e="📞" label="联系我们" desc="反馈问题与建议" right={arrow}/>,
        ]}/>
      </div>
      <BottomTabBar active="schedule" nav={nav}/>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [screen,setScreen]=useState<Screen>({name:"login"});
  const nav=(s:Screen)=>{
    setScreen(s);
    setTimeout(()=>{const el=document.getElementById("ps");if(el)el.scrollTop=0;},0);
  };

  const render=()=>{
    switch(screen.name){
      case "login":         return <LoginScreen nav={nav}/>;
      case "schedule":      return <ScheduleScreen nav={nav}/>;
      case "event-detail":  return <EventDetailScreen eventId={screen.eventId} nav={nav}/>;
      case "calendar":      return <CalendarScreen nav={nav}/>;
      case "meetings":      return <MeetingListScreen nav={nav}/>;
      case "recording":     return <RecordingScreen meetingId={screen.meetingId} nav={nav}/>;
      case "transcription": return <TranscriptionScreen meetingId={screen.meetingId} nav={nav}/>;
      case "profile":       return <ProfileScreen nav={nav}/>;
      case "account":       return <AccountScreen nav={nav}/>;
      case "privacy":       return <PrivacyScreen nav={nav}/>;
    }
  };

  return (
    <div style={{minHeight:"100vh",
      background:"linear-gradient(150deg,#EDD8FF 0%,#FFE0F2 100%)",
      display:"flex",justifyContent:"center"}}>
      <div style={{width:"100%",maxWidth:390,minHeight:"100vh",background:C.appBg,
        display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{height:44,flexShrink:0}}/>
        <div id="ps" style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {render()}
        </div>
      </div>
    </div>
  );
}
