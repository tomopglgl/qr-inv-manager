import { useState, useEffect, useRef, useCallback } from "react";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc,
  query, orderBy, limit, serverTimestamp, where,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ═══════════════════════════════════════════════════════════════════
// 🔥 Firebase設定 — ここを書き換えてください
// ═══════════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey:            "AIzaSyC8_PLU-ULrueIVbmXL67Z1egkP0STKbec",
  authDomain:        "sku-tool-558af.firebaseapp.com",
  projectId:         "sku-tool-558af",
  storageBucket:     "sku-tool-558af.firebasestorage.app",
  messagingSenderId: "240546265244",
  appId:             "1:240546265244:web:141424d177069477d89559",
};

const IS_CONFIGURED = !firebaseConfig.apiKey.includes("YOUR");
let db = null;
if (IS_CONFIGURED) {
  try { db = getFirestore(initializeApp(firebaseConfig)); } catch {}
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const GENRES = ["食品","電子機器","衣類","雑貨","医薬品","書籍","その他"];
const UNIT_PRESETS = ["個","枚","本","冊","箱","袋","缶","kg","g","L","ml","セット","台","足"];

// 発送方法の定義
const SHIPPING_METHODS = [
  // 自動割当型（マスターが事前にQR登録）
  { id:"yupacket_post",      name:"ゆうパケットポスト",     type:"auto",   icon:"📮", color:"#e53e3e" },
  { id:"yupacket_post_mini", name:"ゆうパケットポストmini", type:"auto",   icon:"📮", color:"#dd6b20" },
  // メンバー撮影型（メンバーがQR撮影→マスター承認）
  { id:"nekoposu",           name:"ネコポス",               type:"member", icon:"🐱", color:"#d69e2e" },
  { id:"yupacket_plus",      name:"ゆうパケットプラス",      type:"member", icon:"📦", color:"#38a169" },
  { id:"mercari",            name:"メルカリ便",             type:"member", icon:"🛍", color:"#2b6cb0" },
  { id:"size60",             name:"60cm発送",               type:"member", icon:"📫", color:"#6b46c1" },
];

function genId()  { return Math.random().toString(36).slice(2)+Date.now().toString(36); }
function tsToStr(ts) {
  if (!ts) return "";
  if (ts.toDate) return ts.toDate().toLocaleString("ja-JP",{hour12:false});
  return String(ts);
}

// ═══════════════════════════════════════════════════════════════════
// EXCEL EXPORT
// ═══════════════════════════════════════════════════════════════════
function exportToExcel(rows, filename) {
  const headers = ["ラベル","商品名","年月日時","個数","ジャンル","メンバー名","金額(円)","読込日時"];
  const csvRows = [headers, ...rows.map(r => [
    r.label||"", r.productName||"", r.datetime||"", r.quantity||"",
    r.genre||"", r.memberName||"", r.amount||"", r.readAt||""
  ])];
  const bom = "\uFEFF";
  const csv = bom + csvRows.map(row => row.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}


// ═══════════════════════════════════════════════════════════════════
// IMAGE COMPRESSION - Firestoreの1MB制限対策
// ═══════════════════════════════════════════════════════════════════
function compressImage(dataUrl, maxWidth=600, quality=0.7) {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataUrl;
  });
}

// ═══════════════════════════════════════════════════════════════════
// OCR - Claude AIで画像から番号を読み取る
// ═══════════════════════════════════════════════════════════════════
async function extractShippingNumbers(imageBase64) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: imageBase64.split(",")[1] }
            },
            {
              type: "text",
              text: `この画像から発送ラベルの番号を読み取ってください。
以下の形式でJSONのみ返してください（他のテキスト不要）:
{
  "postConfirmCode": "ポスト発送確認符号（例: UK09UL〜）または空文字",
  "trackingNumber": "お問い合わせ番号・ご依頼主控え番号（例: UP55PK〜、DF2504〜）または空文字",
  "shippingMethod": "発送方法名（ゆうパケットポスト、ゆうパケットポストmini、ネコポス、ゆうパケットプラス、メルカリ便、60cm発送 のいずれか）または空文字"
}`
            }
          ]
        }]
      })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || "{}";
    const clean = text.replace(/```json|```/g,"").trim();
    return JSON.parse(clean);
  } catch(e) {
    console.error("OCR error:", e);
    return { postConfirmCode:"", trackingNumber:"", shippingMethod:"" };
  }
}

// ═══════════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ═══════════════════════════════════════════════════════════════════
const C = {
  bg:"#0d1117", surface:"#161b22", surface2:"#21262d",
  border:"#30363d",
  text:"#e6edf3", muted:"#8b949e", faint:"#484f58",
  accent:"#2f81f7",   accentDim:"rgba(47,129,247,0.12)",   accentBorder:"rgba(47,129,247,0.4)",
  green:"#3fb950",    greenDim:"rgba(63,185,80,0.12)",     greenBorder:"rgba(63,185,80,0.4)",
  red:"#f85149",      redDim:"rgba(248,81,73,0.12)",       redBorder:"rgba(248,81,73,0.4)",
  orange:"#d29922",   orangeDim:"rgba(210,153,34,0.12)",   orangeBorder:"rgba(210,153,34,0.4)",
  purple:"#bc8cff",   purpleDim:"rgba(188,140,255,0.12)",  purpleBorder:"rgba(188,140,255,0.4)",
};

const GS = `
@import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=Noto+Sans+JP:wght@300;400;500;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:${C.bg};font-family:'Noto Sans JP',sans-serif;color:${C.text};-webkit-font-smoothing:antialiased}
input,select{font-family:inherit;color:${C.text}}
button{font-family:inherit;cursor:pointer}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-thumb{background:${C.border};border-radius:99px}
::-webkit-scrollbar-track{background:transparent}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes pop{from{opacity:0;transform:scale(0.95)}to{opacity:1;transform:scale(1)}}
@keyframes toast{0%{opacity:0;transform:translateX(16px)}10%{opacity:1;transform:translateX(0)}85%{opacity:1}100%{opacity:0}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@keyframes slideDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
`;

const inputS = { width:"100%",padding:"10px 14px",background:C.surface2,border:`1px solid ${C.border}`,borderRadius:10,fontSize:14,color:C.text,outline:"none" };
const labelS = { display:"block",fontSize:11,fontWeight:700,color:C.muted,marginBottom:5,letterSpacing:"0.06em",textTransform:"uppercase" };

// ═══════════════════════════════════════════════════════════════════
// SETUP SCREEN
// ═══════════════════════════════════════════════════════════════════
function SetupScreen() {
  return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <style>{GS}</style>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:20,padding:40,maxWidth:440,width:"100%",textAlign:"center",animation:"pop 0.3s ease"}}>
        <div style={{fontSize:52,marginBottom:16}}>🔥</div>
        <h2 style={{fontFamily:"'Sora',sans-serif",fontSize:22,fontWeight:700,marginBottom:8}}>Firebase未接続</h2>
        <p style={{color:C.muted,fontSize:14,lineHeight:1.8,marginBottom:20}}>
          <strong style={{color:C.accent}}>SETUP.md</strong> の手順に従って設定してください。
        </p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [loading,   setLoading]   = useState(true);
  const [user,      setUser]      = useState(null);
  const [members,   setMembers]   = useState([]);
  const [appMode,   setAppMode]   = useState("inventory");
  const [toast,     setToast]     = useState(null);
  const [notices,   setNotices]   = useState([]);
  const [showBell,  setShowBell]  = useState(false);
  const [invItems,  setInvItems]  = useState([]);
  const [invHist,   setInvHist]   = useState([]);
  const [qrItems,   setQrItems]   = useState([]);
  const [qrLog,     setQrLog]     = useState([]);
  // 発送管理
  const [shippingQRs,    setShippingQRs]    = useState([]); // 事前登録QRコード
  const [shippingOrders, setShippingOrders] = useState([]); // 発送オーダー

  if (!IS_CONFIGURED) return <SetupScreen />;

  useEffect(() => {
    const unsubs = [];
    unsubs.push(onSnapshot(collection(db,"members"), snap => {
      setMembers(snap.docs.map(d=>({id:d.id,...d.data()})));
      setLoading(false);
    }));
    unsubs.push(onSnapshot(query(collection(db,"inv_items"),orderBy("createdAt","desc")), snap =>
      setInvItems(snap.docs.map(d=>({id:d.id,...d.data()})))));
    unsubs.push(onSnapshot(query(collection(db,"inv_history"),orderBy("createdAt","desc"),limit(300)), snap =>
      setInvHist(snap.docs.map(d=>({id:d.id,...d.data()})))));
    unsubs.push(onSnapshot(query(collection(db,"qr_items"),orderBy("uploadedAt","desc")), snap =>
      setQrItems(snap.docs.map(d=>({id:d.id,...d.data()})))));
    unsubs.push(onSnapshot(query(collection(db,"qr_log"),orderBy("createdAt","desc"),limit(200)), snap =>
      setQrLog(snap.docs.map(d=>({id:d.id,...d.data()})))));
    unsubs.push(onSnapshot(query(collection(db,"notices"),orderBy("createdAt","desc"),limit(100)), snap =>
      setNotices(snap.docs.map(d=>({id:d.id,...d.data()})))));
    unsubs.push(onSnapshot(query(collection(db,"shipping_qrs"),orderBy("createdAt","desc")), snap =>
      setShippingQRs(snap.docs.map(d=>({id:d.id,...d.data()})))));
    unsubs.push(onSnapshot(query(collection(db,"shipping_orders"),orderBy("createdAt","desc"),limit(500)), snap =>
      setShippingOrders(snap.docs.map(d=>({id:d.id,...d.data()})))));
    return () => unsubs.forEach(u=>u());
  }, []);

  const showToast = useCallback((msg, color=C.green) => {
    setToast({msg,color,id:Math.random()});
    setTimeout(()=>setToast(null),3000);
  },[]);

  const addNotice = useCallback(async (type, msg, targetRole="master") => {
    await addDoc(collection(db,"notices"),{type,msg,targetRole,read:false,createdAt:serverTimestamp()});
  },[]);

  const myNotices   = notices.filter(n=>!n.read&&(n.targetRole==="all"||n.targetRole===user?.role));
  const unreadCount = myNotices.length;

  const markAllRead = async () => {
    const unread = notices.filter(n=>!n.read&&(n.targetRole==="all"||n.targetRole===user?.role));
    await Promise.all(unread.map(n=>updateDoc(doc(db,"notices",n.id),{read:true})));
  };

  if (loading) return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
      <style>{GS}</style>
      <div style={{width:36,height:36,border:`3px solid ${C.border}`,borderTopColor:C.accent,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
      <p style={{color:C.muted,fontSize:13}}>接続中...</p>
    </div>
  );

  if (!user) return <LoginScreen members={members} onLogin={setUser}/>;

  const isMaster = user.role==="master";

  return (
    <div style={{minHeight:"100vh",background:C.bg}}>
      <style>{GS}</style>

      {toast&&(
        <div key={toast.id} style={{position:"fixed",top:16,right:16,zIndex:9999,background:toast.color,color:"#fff",padding:"11px 18px",borderRadius:12,fontSize:13,fontWeight:600,boxShadow:"0 8px 32px rgba(0,0,0,0.5)",animation:"toast 3s forwards",maxWidth:300,border:"1px solid rgba(255,255,255,0.15)"}}>
          {toast.msg}
        </div>
      )}

      {showBell&&(
        <NoticePanel
          notices={notices.filter(n=>n.targetRole==="all"||n.targetRole===user.role)}
          onClose={()=>{setShowBell(false);markAllRead();}}
          onDelete={id=>deleteDoc(doc(db,"notices",id))}
          onClear={async()=>{
            const mine=notices.filter(n=>n.targetRole==="all"||n.targetRole===user.role);
            await Promise.all(mine.map(n=>deleteDoc(doc(db,"notices",n.id))));
          }}
        />
      )}

      {/* Header */}
      <header style={{background:`${C.surface}f0`,backdropFilter:"blur(12px)",borderBottom:`1px solid ${C.border}`,padding:"0 16px",height:54,display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:50}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{display:"flex",gap:2,background:C.surface2,borderRadius:10,padding:3,border:`1px solid ${C.border}`}}>
            {[
              {id:"inventory",icon:"🗃",label:"在庫"},
              {id:"shipping", icon:"🚚",label:"発送"},
              {id:"qr",       icon:"📷",label:"QR"},
              {id:"sales",    icon:"💰",label:"売上"},
            ].map(m=>(
              <button key={m.id} onClick={()=>setAppMode(m.id)} style={{padding:"5px 10px",borderRadius:7,border:"none",background:appMode===m.id?C.accent:"transparent",color:appMode===m.id?"#fff":C.muted,fontSize:11,fontWeight:appMode===m.id?700:400,display:"flex",alignItems:"center",gap:4,transition:"all 0.15s"}}>
                <span>{m.icon}</span><span>{m.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <button onClick={()=>{setShowBell(v=>!v);if(!showBell)markAllRead();}} style={{position:"relative",background:"none",border:`1px solid ${C.border}`,borderRadius:8,padding:"5px 10px",fontSize:15,color:C.muted}}>
            🔔
            {unreadCount>0&&<span style={{position:"absolute",top:-6,right:-6,background:C.red,color:"#fff",fontSize:9,fontWeight:700,width:17,height:17,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",animation:"pulse 1.5s infinite"}}>{unreadCount>9?"9+":unreadCount}</span>}
          </button>
          <span style={{fontSize:10,fontWeight:700,padding:"3px 9px",borderRadius:20,background:isMaster?C.purpleDim:C.accentDim,color:isMaster?C.purple:C.accent,border:`1px solid ${isMaster?C.purpleBorder:C.accentBorder}`}}>
            {isMaster?"👑 MASTER":"MEMBER"}
          </span>
          <span style={{fontSize:12,color:C.muted}}>{user.name}</span>
          <button onClick={()=>setUser(null)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:8,padding:"5px 10px",fontSize:12,color:C.muted}}>ログアウト</button>
        </div>
      </header>

      {appMode==="inventory"&&<LowStockBanner items={invItems}/>}

      <main style={{maxWidth:900,margin:"0 auto",padding:16}}>
        {appMode==="inventory"&&<InventoryApp items={invItems} history={invHist} members={members} user={user} isMaster={isMaster} showToast={showToast} addNotice={addNotice} shippingQRs={shippingQRs} shippingOrders={shippingOrders}/>}
        {appMode==="shipping"&&<ShippingApp shippingQRs={shippingQRs} shippingOrders={shippingOrders} members={members} user={user} isMaster={isMaster} showToast={showToast} addNotice={addNotice} invItems={invItems}/>}
        {appMode==="qr"&&<QRApp qrItems={qrItems} qrLog={qrLog} members={members} user={user} isMaster={isMaster} showToast={showToast} addNotice={addNotice}/>}
        {appMode==="sales"&&<SalesApp qrItems={qrItems} shippingOrders={shippingOrders} members={members} user={user} isMaster={isMaster}/>}
      </main>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════
function LoginScreen({ members, onLogin }) {
  const [name,setName]=useState(""); const [pw,setPw]=useState(""); const [err,setErr]=useState("");
  function doLogin() {
    const u=members.find(m=>m.name===name.trim()&&m.password===pw);
    if (!name.trim()){setErr("ユーザー名を入力してください");return;}
    if (!u){setErr("ユーザー名またはパスワードが違います");return;}
    onLogin(u);
  }
  return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <style>{GS}</style>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:20,padding:40,width:"100%",maxWidth:380,animation:"pop 0.3s ease",boxShadow:"0 24px 64px rgba(0,0,0,0.6)"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:64,height:64,borderRadius:18,background:`linear-gradient(135deg,${C.accent},#1a4fa0)`,marginBottom:14,boxShadow:"0 8px 24px rgba(47,129,247,0.3)"}}>
            <span style={{fontSize:30}}>📦</span>
          </div>
          <h1 style={{fontFamily:"'Sora',sans-serif",fontSize:22,fontWeight:700,marginBottom:6}}>在庫 & QR管理</h1>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:C.greenDim,borderRadius:20,padding:"3px 12px",border:`1px solid ${C.greenBorder}`}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:C.green,animation:"pulse 2s infinite"}}/>
            <span style={{fontSize:11,color:C.green,fontWeight:600}}>リアルタイム同期中</span>
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <label style={labelS}>ユーザー名</label>
          <input value={name} onChange={e=>{setName(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&doLogin()} style={inputS} placeholder="ユーザー名を入力"/>
        </div>
        <div style={{marginBottom:16}}>
          <label style={labelS}>パスワード</label>
          <input type="password" value={pw} onChange={e=>{setPw(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&doLogin()} style={inputS} placeholder="パスワードを入力"/>
        </div>
        {err&&<p style={{color:C.red,fontSize:12,marginBottom:12}}>{err}</p>}
        <button onClick={doLogin} style={{width:"100%",padding:"13px",background:`linear-gradient(135deg,${C.accent},#1a4fa0)`,color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:700}}>
          ログイン
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LOW STOCK BANNER
// ═══════════════════════════════════════════════════════════════════
function LowStockBanner({ items }) {
  const empty=items.filter(i=>i.qty===0);
  const low  =items.filter(i=>i.qty>0&&i.qty<=i.minAlert);
  if (!empty.length&&!low.length) return null;
  return (
    <div style={{animation:"slideDown 0.3s ease"}}>
      {empty.length>0&&<div style={{background:C.redDim,borderBottom:`1px solid ${C.redBorder}`,padding:"9px 16px",display:"flex",gap:8,alignItems:"center"}}>
        <span>🚨</span><p style={{fontSize:12,fontWeight:700,color:C.red}}>在庫ゼロ: {empty.map(i=>i.name).join("、")}</p>
      </div>}
      {low.length>0&&<div style={{background:C.orangeDim,borderBottom:`1px solid ${C.orangeBorder}`,padding:"9px 16px",display:"flex",gap:8,alignItems:"center"}}>
        <span>⚠️</span><p style={{fontSize:12,fontWeight:700,color:C.orange}}>在庫少: {low.map(i=>`${i.name}(残${i.qty}${i.unit})`).join("、")}</p>
      </div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// NOTICE PANEL
// ═══════════════════════════════════════════════════════════════════
function NoticePanel({ notices, onClose, onDelete, onClear }) {
  const icon ={operation:"👤",lowstock:"⚠️",empty:"🚨",qr_save:"✅",qr_lock:"🔒",shipping:"🚚"};
  const color={operation:C.purple,lowstock:C.orange,empty:C.red,qr_save:C.green,qr_lock:C.accent,shipping:C.green};
  return (
    <>
      <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:199,background:"rgba(0,0,0,0.5)"}}/>
      <div style={{position:"fixed",top:62,right:12,zIndex:200,width:340,maxWidth:"calc(100vw - 24px)",background:C.surface,borderRadius:16,border:`1px solid ${C.border}`,boxShadow:"0 16px 48px rgba(0,0,0,0.6)",animation:"pop 0.2s ease",maxHeight:"70vh",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"13px 16px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <h3 style={{fontSize:14,fontWeight:700}}>🔔 通知</h3>
          <div style={{display:"flex",gap:8}}>
            {notices.length>0&&<button onClick={onClear} style={{fontSize:11,background:"none",border:`1px solid ${C.border}`,borderRadius:8,padding:"3px 10px",color:C.muted}}>全消去</button>}
            <button onClick={onClose} style={{fontSize:18,background:"none",border:"none",color:C.muted,lineHeight:1}}>×</button>
          </div>
        </div>
        <div style={{overflowY:"auto",flex:1}}>
          {notices.length===0
            ?<p style={{padding:32,textAlign:"center",color:C.muted,fontSize:13}}>通知はありません</p>
            :notices.map(n=>(
              <div key={n.id} style={{padding:"11px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",gap:10,alignItems:"flex-start",background:n.read?"transparent":`${color[n.type]||C.accent}18`}}>
                <span style={{fontSize:17,flexShrink:0}}>{icon[n.type]||"📢"}</span>
                <div style={{flex:1,minWidth:0}}>
                  <p style={{fontSize:12,fontWeight:n.read?400:600,color:color[n.type]||C.text,lineHeight:1.5}}>{n.msg}</p>
                  <p style={{fontSize:10,color:C.muted,marginTop:3}}>{tsToStr(n.createdAt)}</p>
                </div>
                <button onClick={()=>onDelete(n.id)} style={{background:"none",border:"none",color:C.faint,fontSize:14,cursor:"pointer",lineHeight:1,flexShrink:0}} onMouseEnter={e=>e.currentTarget.style.color=C.red} onMouseLeave={e=>e.currentTarget.style.color=C.faint}>×</button>
              </div>
            ))
          }
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ▌ SHIPPING APP（新機能）
// ═══════════════════════════════════════════════════════════════════
function ShippingApp({ shippingQRs, shippingOrders, members, user, isMaster, showToast, addNotice, invItems }) {
  const [tab, setTab] = useState(isMaster ? "register" : "my_orders");

  const masterTabs = [
    {id:"register",   label:"QR登録",       icon:"➕"},
    {id:"auto_stock", label:"自動割当在庫",  icon:"📋"},
    {id:"pending",    label:`承認待ち (${shippingOrders.filter(o=>o.status==="pending").length})`, icon:"⏳"},
    {id:"completed",  label:"完了済み",      icon:"✅"},
  ];
  const memberTabs = [
    {id:"my_orders",  label:"自分の発送",    icon:"📦"},
    {id:"upload",     label:"QRアップロード",icon:"📷"},
  ];
  const tabs = isMaster ? masterTabs : memberTabs;

  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",gap:2,marginBottom:14,background:C.surface,borderRadius:12,padding:4,border:`1px solid ${C.border}`,flexWrap:"wrap"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,padding:"8px 6px",borderRadius:8,border:"none",minWidth:80,background:tab===t.id?C.surface2:"transparent",color:tab===t.id?C.text:C.muted,fontSize:12,fontWeight:tab===t.id?700:400,display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
            <span>{t.icon}</span><span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* マスター: QR登録 */}
      {tab==="register"&&isMaster&&(
        <ShippingQRRegister shippingQRs={shippingQRs} showToast={showToast}/>
      )}

      {/* マスター: 自動割当在庫確認 */}
      {tab==="auto_stock"&&isMaster&&(
        <AutoStockView shippingQRs={shippingQRs} invItems={invItems}/>
      )}

      {/* マスター: 承認待ち */}
      {tab==="pending"&&isMaster&&(
        <PendingOrders orders={shippingOrders.filter(o=>o.status==="pending")} showToast={showToast} addNotice={addNotice}/>
      )}

      {/* マスター: 完了済み */}
      {tab==="completed"&&isMaster&&(
        <CompletedOrders orders={shippingOrders.filter(o=>o.status==="completed")} isMaster={isMaster}/>
      )}

      {/* メンバー: 自分の発送 */}
      {tab==="my_orders"&&!isMaster&&(
        <MyOrders orders={shippingOrders.filter(o=>o.memberName===user.name)} user={user}/>
      )}

      {/* メンバー: QRアップロード（メンバー撮影型） */}
      {tab==="upload"&&!isMaster&&(
        <MemberQRUpload user={user} showToast={showToast} addNotice={addNotice} invItems={invItems.filter(i=>!i.visibleTo||i.visibleTo.length===0||i.visibleTo.includes(user.name))}/>
      )}
    </div>
  );
}

// ── 自動割当型QR登録（マスター） ─────────────────────────────────
function ShippingQRRegister({ shippingQRs, showToast }) {
  const [method, setMethod]   = useState("yupacket_post");
  const [label,  setLabel]    = useState("");
  const [imgData,setImgData]  = useState(null);
  const [preview,setPreview]  = useState(null);
  const [ocrResult,setOcr]    = useState(null);
  const [ocring, setOcring]   = useState(false);
  const [postCode, setPostCode]   = useState("");
  const [trackNum, setTrackNum]   = useState("");
  const [saving,  setSaving]  = useState(false);
  const fileRef = useRef();

  const autoMethods = SHIPPING_METHODS.filter(m=>m.type==="auto");

  async function handleFile(e) {
    const file = e.target.files[0]; if(!file) return;
    const r = new FileReader();
    r.onload = async ev => {
      const raw = ev.target.result;
      setPreview(raw);
      if (!label) setLabel(file.name.replace(/\.[^/.]+$/,""));
      // 画像を圧縮してFirestore制限対策
      const compressed = await compressImage(raw, 600, 0.7);
      setImgData(compressed);
    };
    r.readAsDataURL(file);
  }

  async function runOCR() {
    if (!imgData) return;
    setOcring(true);
    try {
      const result = await extractShippingNumbers(imgData);
      setOcr(result);
      if (result.postConfirmCode) setPostCode(result.postConfirmCode);
      if (result.trackingNumber)  setTrackNum(result.trackingNumber);
      showToast("AI読み取り完了！内容を確認してください", C.green);
    } catch(e) {
      showToast("AI読み取りに失敗しました。手動で入力してください", C.orange);
    }
    setOcring(false);
  }

  async function handleSave() {
    if (!imgData){showToast("QR画像をアップロードしてください",C.red);return;}
    setSaving(true);
    await addDoc(collection(db,"shipping_qrs"),{
      methodId:method,
      methodName:SHIPPING_METHODS.find(m=>m.id===method)?.name||method,
      label:label||`QR-${Date.now()}`,
      imageData:imgData,
      postConfirmCode:postCode,
      trackingNumber:trackNum,
      status:"available", // available / assigned / used
      assignedTo:null,
      assignedItemId:null,
      createdAt:serverTimestamp(),
    });
    showToast("QRコードを登録しました");
    setLabel(""); setImgData(null); setPreview(null);
    setPostCode(""); setTrackNum(""); setOcr(null);
    if(fileRef.current) fileRef.current.value="";
    setSaving(false);
  }

  // 登録済みQRをメソッド別に集計
  const stats = autoMethods.map(m=>({
    ...m,
    available: shippingQRs.filter(q=>q.methodId===m.id&&q.status==="available").length,
    assigned:  shippingQRs.filter(q=>q.methodId===m.id&&q.status==="assigned").length,
    used:      shippingQRs.filter(q=>q.methodId===m.id&&q.status==="used").length,
  }));

  return (
    <div>
      {/* 在庫状況 */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
        {stats.map(s=>(
          <div key={s.id} style={{background:C.surface,borderRadius:12,border:`1px solid ${C.border}`,padding:14}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
              <span style={{fontSize:18}}>{s.icon}</span>
              <span style={{fontSize:12,fontWeight:700,color:C.text}}>{s.name}</span>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <span style={{fontSize:11,background:C.greenDim,color:C.green,padding:"2px 8px",borderRadius:20,border:`1px solid ${C.greenBorder}`}}>使用可 {s.available}</span>
              <span style={{fontSize:11,background:C.orangeDim,color:C.orange,padding:"2px 8px",borderRadius:20,border:`1px solid ${C.orangeBorder}`}}>割当済 {s.assigned}</span>
              <span style={{fontSize:11,background:C.accentDim,color:C.accent,padding:"2px 8px",borderRadius:20,border:`1px solid ${C.accentBorder}`}}>使用済 {s.used}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 登録フォーム */}
      <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:20}}>
        <h3 style={{fontSize:15,fontWeight:700,marginBottom:14}}>📮 自動割当QRを登録</h3>

        <div style={{marginBottom:14}}>
          <label style={labelS}>発送方法</label>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {autoMethods.map(m=>(
              <button key={m.id} onClick={()=>setMethod(m.id)} style={{padding:"8px 14px",borderRadius:10,border:`1px solid ${method===m.id?m.color:C.border}`,background:method===m.id?`${m.color}20`:C.surface2,color:method===m.id?m.color:C.muted,fontSize:13,fontWeight:method===m.id?700:400,display:"flex",alignItems:"center",gap:6}}>
                <span>{m.icon}</span>{m.name}
              </button>
            ))}
          </div>
        </div>

        <div style={{border:`2px dashed ${C.border}`,borderRadius:12,padding:24,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",marginBottom:14,minHeight:120,background:C.surface2,position:"relative"}}
          onClick={()=>fileRef.current?.click()}>
          {preview
            ?<img src={preview} style={{maxHeight:140,maxWidth:"100%",borderRadius:8}}/>
            :<div style={{textAlign:"center"}}><div style={{fontSize:32,marginBottom:6}}>📷</div><p style={{color:C.muted,fontSize:13}}>QR画像をアップロード（OCR自動読み取り）</p></div>
          }
          {ocring&&<div style={{position:"absolute",inset:0,background:"rgba(13,17,23,0.8)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
            <div style={{width:20,height:20,border:`2px solid ${C.border}`,borderTopColor:C.accent,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            <span style={{color:C.text,fontSize:13}}>AI読み取り中...</span>
          </div>}
        </div>
        <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{display:"none"}}/>

        {/* AI読み取りボタン */}
        {imgData&&!ocring&&(
          <button onClick={runOCR} style={{padding:"9px 18px",background:C.accentDim,color:C.accent,border:`1px solid ${C.accentBorder}`,borderRadius:10,fontSize:13,fontWeight:700,marginBottom:14,display:"flex",alignItems:"center",gap:6}}>
            🤖 AIで番号を自動読み取り（任意）
          </button>
        )}
        {ocring&&(
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:C.accentDim,border:`1px solid ${C.accentBorder}`,borderRadius:10,marginBottom:14}}>
            <div style={{width:16,height:16,border:`2px solid ${C.border}`,borderTopColor:C.accent,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
            <span style={{fontSize:13,color:C.accent}}>AI読み取り中...</span>
          </div>
        )}
        {ocrResult&&(
          <div style={{background:C.greenDim,border:`1px solid ${C.greenBorder}`,borderRadius:10,padding:"10px 14px",marginBottom:14}}>
            <p style={{fontSize:12,color:C.green,fontWeight:600}}>✅ AI読み取り完了（下の入力欄を確認・修正してください）</p>
          </div>
        )}

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
          <div>
            <label style={labelS}>ポスト発送確認符号</label>
            <input value={postCode} onChange={e=>setPostCode(e.target.value)} style={inputS} placeholder="例: UK09UL〜（手動入力可）"/>
          </div>
          <div>
            <label style={labelS}>お問い合わせ番号</label>
            <input value={trackNum} onChange={e=>setTrackNum(e.target.value)} style={inputS} placeholder="例: UP55PK〜（手動入力可）"/>
          </div>
        </div>

        <div style={{marginBottom:16}}>
          <label style={labelS}>ラベル名（任意）</label>
          <input value={label} onChange={e=>setLabel(e.target.value)} style={inputS} placeholder="例: QR-001"/>
        </div>

        <button onClick={handleSave} disabled={!imgData||saving} style={{padding:"11px 24px",background:imgData?C.accent:C.surface2,color:imgData?"#fff":C.faint,border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:imgData?"pointer":"not-allowed"}}>
          {saving?"登録中...":"📮 登録する"}
        </button>
      </div>

      {/* 登録済み一覧 */}
      <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:20,marginTop:12}}>
        <h4 style={{fontSize:13,fontWeight:700,color:C.muted,marginBottom:10}}>登録済みQR一覧 ({shippingQRs.filter(q=>q.type==="auto"||["yupacket_post","yupacket_post_mini"].includes(q.methodId)).length}件)</h4>
        <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:240,overflowY:"auto"}}>
          {shippingQRs.filter(q=>["yupacket_post","yupacket_post_mini"].includes(q.methodId)).map(qr=>(
            <div key={qr.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:C.surface2,borderRadius:10,border:`1px solid ${C.border}`}}>
              <img src={qr.imageData} style={{width:36,height:36,objectFit:"contain",background:"#fff",borderRadius:4,padding:2,flexShrink:0}}/>
              <div style={{flex:1,minWidth:0}}>
                <p style={{fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{qr.methodName} — {qr.postConfirmCode||qr.trackingNumber||qr.label}</p>
                <p style={{fontSize:10,color:C.muted}}>{tsToStr(qr.createdAt)}</p>
              </div>
              <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:20,
                background:qr.status==="available"?C.greenDim:qr.status==="assigned"?C.orangeDim:C.accentDim,
                color:qr.status==="available"?C.green:qr.status==="assigned"?C.orange:C.accent,
                border:`1px solid ${qr.status==="available"?C.greenBorder:qr.status==="assigned"?C.orangeBorder:C.accentBorder}`,
                whiteSpace:"nowrap"}}>
                {qr.status==="available"?"使用可":qr.status==="assigned"?"割当済":"使用済"}
              </span>
              {qr.status==="available"&&<button onClick={async()=>{if(!confirm("削除しますか？"))return;await deleteDoc(doc(db,"shipping_qrs",qr.id));}} style={{padding:"4px 8px",background:C.redDim,color:C.red,border:`1px solid ${C.redBorder}`,borderRadius:6,fontSize:11}}>削除</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 自動割当在庫確認（マスター） ──────────────────────────────────
function AutoStockView({ shippingQRs, invItems }) {
  return (
    <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:20}}>
      <h3 style={{fontSize:15,fontWeight:700,marginBottom:14}}>📋 発送方法別QR在庫</h3>
      {SHIPPING_METHODS.filter(m=>m.type==="auto").map(m=>{
        const qrs = shippingQRs.filter(q=>q.methodId===m.id);
        const available = qrs.filter(q=>q.status==="available");
        const assigned  = qrs.filter(q=>q.status==="assigned");
        const used      = qrs.filter(q=>q.status==="used");
        return (
          <div key={m.id} style={{marginBottom:16,borderBottom:`1px solid ${C.border}`,paddingBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <span style={{fontSize:18}}>{m.icon}</span>
              <span style={{fontSize:14,fontWeight:700}}>{m.name}</span>
              <span style={{fontSize:11,background:C.greenDim,color:C.green,padding:"2px 10px",borderRadius:20,border:`1px solid ${C.greenBorder}`}}>使用可: {available.length}枚</span>
            </div>
            {available.length===0&&<p style={{fontSize:12,color:C.red}}>⚠️ QRコードが不足しています。登録してください。</p>}
            <div style={{display:"flex",flexDirection:"column",gap:4,maxHeight:150,overflowY:"auto"}}>
              {available.slice(0,5).map(qr=>(
                <div key={qr.id} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",background:C.surface2,borderRadius:8,fontSize:12}}>
                  <span style={{color:C.green,flexShrink:0}}>✓</span>
                  <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{qr.postConfirmCode||qr.trackingNumber||qr.label}</span>
                  <span style={{color:C.muted,fontSize:10}}>{tsToStr(qr.createdAt)}</span>
                </div>
              ))}
              {available.length>5&&<p style={{fontSize:11,color:C.muted,textAlign:"center"}}>他 {available.length-5}件...</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 承認待ちオーダー（マスター） ─────────────────────────────────
function PendingOrders({ orders, showToast, addNotice }) {
  if (!orders.length) return <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:40,textAlign:"center"}}><p style={{color:C.muted}}>承認待ちはありません</p></div>;

  async function approve(order) {
    await updateDoc(doc(db,"shipping_orders",order.id),{status:"completed",approvedAt:serverTimestamp()});
    await addNotice("shipping",`「${order.itemName}」の発送が完了しました（${order.memberName}）`,"all");
    showToast(`${order.memberName}の発送を承認しました`,C.green);
  }
  async function reject(order) {
    await updateDoc(doc(db,"shipping_orders",order.id),{status:"rejected",rejectedAt:serverTimestamp()});
    // QRコードを解放
    if (order.shippingQRId) await updateDoc(doc(db,"shipping_qrs",order.shippingQRId),{status:"available",assignedTo:null,assignedItemId:null});
    showToast("差し戻しました",C.orange);
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {orders.map(order=>(
        <div key={order.id} style={{background:C.surface,borderRadius:14,border:`1px solid ${C.orangeBorder}`,padding:16}}>
          <div style={{display:"flex",alignItems:"flex-start",gap:12,marginBottom:12}}>
            {order.imageData&&<img src={order.imageData} style={{width:64,height:64,objectFit:"contain",background:"#fff",borderRadius:8,padding:3,flexShrink:0}}/>}
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                <span style={{fontSize:13,fontWeight:700}}>{order.itemName}</span>
                <span style={{fontSize:11,background:C.orangeDim,color:C.orange,padding:"2px 8px",borderRadius:20,border:`1px solid ${C.orangeBorder}`}}>{order.methodName}</span>
              </div>
              <p style={{fontSize:12,color:C.accent,fontWeight:600}}>{order.memberName}</p>
              <p style={{fontSize:11,color:C.muted}}>{tsToStr(order.createdAt)}</p>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:12}}>
            {[
              ["ポスト確認符号", order.postConfirmCode],
              ["お問い合わせ番号", order.trackingNumber],
              ["個数", order.quantity],
              ["金額", order.amount?`¥${Number(order.amount).toLocaleString()}`:""],
            ].filter(([,v])=>v).map(([k,v])=>(
              <div key={k} style={{background:C.surface2,borderRadius:8,padding:"6px 10px",border:`1px solid ${C.border}`}}>
                <p style={{fontSize:10,color:C.muted,marginBottom:2}}>{k}</p>
                <p style={{fontSize:13,fontWeight:600}}>{v}</p>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>approve(order)} style={{flex:2,padding:"10px",background:C.green,color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700}}>✅ 承認・完了</button>
            <button onClick={()=>reject(order)} style={{flex:1,padding:"10px",background:C.orangeDim,color:C.orange,border:`1px solid ${C.orangeBorder}`,borderRadius:10,fontSize:14,fontWeight:700}}>↩ 差し戻し</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 完了済みオーダー ──────────────────────────────────────────────
function CompletedOrders({ orders, isMaster }) {
  if (!orders.length) return <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:40,textAlign:"center"}}><p style={{color:C.muted}}>完了済みはありません</p></div>;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {orders.map(order=>(
        <div key={order.id} style={{background:C.surface,borderRadius:12,border:`1px solid ${C.greenBorder}`,padding:14}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:20}}>✅</span>
            <div style={{flex:1}}>
              <p style={{fontSize:13,fontWeight:700}}>{order.itemName}</p>
              <p style={{fontSize:11,color:C.muted}}>{order.methodName} — {order.memberName} — {tsToStr(order.approvedAt||order.createdAt)}</p>
            </div>
            {order.amount&&<span style={{fontSize:13,fontWeight:700,color:C.green}}>¥{Number(order.amount).toLocaleString()}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 自分の発送一覧（メンバー） ────────────────────────────────────
function MyOrders({ orders, user }) {
  const pending   = orders.filter(o=>o.status==="pending");
  const completed = orders.filter(o=>o.status==="completed");
  const rejected  = orders.filter(o=>o.status==="rejected");
  return (
    <div>
      {pending.length>0&&(
        <div style={{marginBottom:16}}>
          <h3 style={{fontSize:14,fontWeight:700,color:C.orange,marginBottom:8}}>⏳ 承認待ち ({pending.length})</h3>
          {pending.map(o=>(
            <div key={o.id} style={{background:C.surface,borderRadius:12,border:`1px solid ${C.orangeBorder}`,padding:14,marginBottom:8}}>
              <p style={{fontSize:13,fontWeight:700}}>{o.itemName}</p>
              <p style={{fontSize:11,color:C.muted}}>{o.methodName} — {tsToStr(o.createdAt)}</p>
            </div>
          ))}
        </div>
      )}
      {rejected.length>0&&(
        <div style={{marginBottom:16}}>
          <h3 style={{fontSize:14,fontWeight:700,color:C.red,marginBottom:8}}>↩ 差し戻し ({rejected.length})</h3>
          {rejected.map(o=>(
            <div key={o.id} style={{background:C.surface,borderRadius:12,border:`1px solid ${C.redBorder}`,padding:14,marginBottom:8}}>
              <p style={{fontSize:13,fontWeight:700}}>{o.itemName}</p>
              <p style={{fontSize:11,color:C.red}}>差し戻されました。再アップロードしてください。</p>
            </div>
          ))}
        </div>
      )}
      {completed.length>0&&(
        <div>
          <h3 style={{fontSize:14,fontWeight:700,color:C.green,marginBottom:8}}>✅ 完了済み ({completed.length})</h3>
          {completed.map(o=>(
            <div key={o.id} style={{background:C.surface,borderRadius:12,border:`1px solid ${C.greenBorder}`,padding:14,marginBottom:8}}>
              <p style={{fontSize:13,fontWeight:700}}>{o.itemName}</p>
              <p style={{fontSize:11,color:C.muted}}>{o.methodName} — {tsToStr(o.approvedAt||o.createdAt)}</p>
              {o.amount&&<p style={{fontSize:12,color:C.green,fontWeight:700}}>¥{Number(o.amount).toLocaleString()}</p>}
            </div>
          ))}
        </div>
      )}
      {orders.length===0&&<div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:40,textAlign:"center"}}><p style={{color:C.muted}}>発送履歴はありません</p></div>}
    </div>
  );
}

// ── メンバー撮影型QRアップロード ─────────────────────────────────
function MemberQRUpload({ user, showToast, addNotice, invItems }) {
  const [selItem,   setSelItem]   = useState("");
  const [method,    setMethod]    = useState("nekoposu");
  const [imgData,   setImgData]   = useState(null);
  const [preview,   setPreview]   = useState(null);
  const [ocring,    setOcring]    = useState(false);
  const [postCode,  setPostCode]  = useState("");
  const [trackNum,  setTrackNum]  = useState("");
  const [quantity,  setQuantity]  = useState("");
  const [amount,    setAmount]    = useState("");
  const [ocrResult, setOcr]       = useState(null);
  const [saving,    setSaving]    = useState(false);
  const fileRef = useRef();

  const memberMethods = SHIPPING_METHODS.filter(m=>m.type==="member");

  async function handleFile(e) {
    const file = e.target.files[0]; if(!file) return;
    const r = new FileReader();
    r.onload = async ev => {
      const raw = ev.target.result;
      setPreview(raw);
      const compressed = await compressImage(raw, 600, 0.7);
      setImgData(compressed);
    };
    r.readAsDataURL(file);
  }

  async function runOCR() {
    if (!imgData) return;
    setOcring(true);
    try {
      const result = await extractShippingNumbers(imgData);
      setOcr(result);
      if (result.postConfirmCode) setPostCode(result.postConfirmCode);
      if (result.trackingNumber)  setTrackNum(result.trackingNumber);
      showToast("AI読み取り完了！内容を確認してください", C.green);
    } catch(e) {
      showToast("AI読み取りに失敗しました。手動で入力してください", C.orange);
    }
    setOcring(false);
  }

  async function handleSubmit() {
    if (!selItem){showToast("商品を選んでください",C.red);return;}
    if (!imgData){showToast("QR画像をアップロードしてください",C.red);return;}
    setSaving(true);
    const item = invItems.find(i=>i.id===selItem);
    await addDoc(collection(db,"shipping_orders"),{
      memberName:user.name,
      memberId:user.id,
      itemId:selItem,
      itemName:item?.name||selItem,
      methodId:method,
      methodName:SHIPPING_METHODS.find(m=>m.id===method)?.name||method,
      imageData:imgData,
      postConfirmCode:postCode,
      trackingNumber:trackNum,
      quantity,
      amount,
      status:"pending",
      shippingQRId:null,
      createdAt:serverTimestamp(),
    });
    await addNotice("shipping",`${user.name} が「${item?.name}」のQRをアップロードしました（${SHIPPING_METHODS.find(m=>m.id===method)?.name}）`,"master");
    showToast("送信しました！マスターの承認をお待ちください",C.green);
    setSelItem(""); setImgData(null); setPreview(null);
    setPostCode(""); setTrackNum(""); setQuantity(""); setAmount(""); setOcr(null);
    if(fileRef.current) fileRef.current.value="";
    setSaving(false);
  }

  return (
    <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:20}}>
      <h3 style={{fontSize:15,fontWeight:700,marginBottom:14}}>📷 QRコードをアップロード</h3>
      <p style={{fontSize:12,color:C.muted,marginBottom:16}}>ネコポス・ゆうパケットプラス・メルカリ便・60cm発送はQR画像を撮影してアップしてください。</p>

      <div style={{marginBottom:14}}>
        <label style={labelS}>発送方法</label>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {memberMethods.map(m=>(
            <button key={m.id} onClick={()=>setMethod(m.id)} style={{padding:"7px 12px",borderRadius:10,border:`1px solid ${method===m.id?m.color:C.border}`,background:method===m.id?`${m.color}20`:C.surface2,color:method===m.id?m.color:C.muted,fontSize:12,fontWeight:method===m.id?700:400,display:"flex",alignItems:"center",gap:5}}>
              <span>{m.icon}</span>{m.name}
            </button>
          ))}
        </div>
      </div>

      <div style={{marginBottom:14}}>
        <label style={labelS}>商品を選ぶ</label>
        <select value={selItem} onChange={e=>setSelItem(e.target.value)} style={inputS}>
          <option value="">選択してください</option>
          {invItems.map(i=><option key={i.id} value={i.id}>{i.name}（残{i.qty}{i.unit}）</option>)}
        </select>
      </div>

      <div style={{border:`2px dashed ${C.border}`,borderRadius:12,padding:24,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",marginBottom:14,minHeight:120,background:C.surface2,position:"relative"}}
        onClick={()=>fileRef.current?.click()}>
        {preview
          ?<img src={preview} style={{maxHeight:140,maxWidth:"100%",borderRadius:8}}/>
          :<div style={{textAlign:"center"}}><div style={{fontSize:32,marginBottom:6}}>📷</div><p style={{color:C.muted,fontSize:13}}>QRラベルの画像をアップロード</p></div>
        }
        {ocring&&<div style={{position:"absolute",inset:0,background:"rgba(13,17,23,0.8)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
          <div style={{width:20,height:20,border:`2px solid ${C.border}`,borderTopColor:C.accent,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
          <span style={{color:C.text,fontSize:13}}>AI読み取り中...</span>
        </div>}
      </div>
      <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{display:"none"}}/>

      {ocrResult&&(
        <div style={{background:C.greenDim,border:`1px solid ${C.greenBorder}`,borderRadius:10,padding:"10px 14px",marginBottom:14}}>
          <p style={{fontSize:12,color:C.green,fontWeight:600}}>✅ AI読み取り完了（修正可能）</p>
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <div>
          <label style={labelS}>ポスト発送確認符号</label>
          <input value={postCode} onChange={e=>setPostCode(e.target.value)} style={inputS} placeholder="例: UK09UL〜（自動入力・修正可）"/>
        </div>
        <div>
          <label style={labelS}>お問い合わせ番号</label>
          <input value={trackNum} onChange={e=>setTrackNum(e.target.value)} style={inputS} placeholder="例: UP55PK〜（自動入力・修正可）"/>
        </div>
        <div>
          <label style={labelS}>個数</label>
          <input type="number" value={quantity} onChange={e=>setQuantity(e.target.value)} style={inputS} placeholder="例: 1"/>
        </div>
        <div>
          <label style={labelS}>金額（円）</label>
          <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} style={inputS} placeholder="例: 3000"/>
        </div>
      </div>

      <button onClick={handleSubmit} disabled={!imgData||!selItem||saving} style={{width:"100%",padding:"12px",background:imgData&&selItem?C.accent:C.surface2,color:imgData&&selItem?"#fff":C.faint,border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:imgData&&selItem?"pointer":"not-allowed"}}>
        {saving?"送信中...":"📤 マスターに送信する"}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ▌ INVENTORY APP
// ═══════════════════════════════════════════════════════════════════
function InventoryApp({ items, history, members, user, isMaster, showToast, addNotice, shippingQRs, shippingOrders }) {
  const [page,   setPage]   = useState("home");
  const [selItem,setSelItem]= useState(null);
  const [modal,  setModal]  = useState(null);

  const visibleItems = isMaster ? items : items.filter(i=>!i.visibleTo||i.visibleTo.length===0||i.visibleTo.includes(user.name));

  const changeQty = useCallback(async (item, delta) => {
    const newQty = Math.max(0, item.qty+delta);
    await updateDoc(doc(db,"inv_items",item.id),{qty:newQty});
    await addDoc(collection(db,"inv_history"),{userId:user.id,userName:user.name,role:user.role,itemId:item.id,itemName:item.name,delta,before:item.qty,after:newQty,createdAt:serverTimestamp()});

    // 在庫-1時に自動割当型QRがあれば割り当て
    if (delta < 0 && item.shippingMethodId) {
      const method = SHIPPING_METHODS.find(m=>m.id===item.shippingMethodId);
      if (method?.type==="auto") {
        const available = shippingQRs.filter(q=>q.methodId===item.shippingMethodId&&q.status==="available")
          .sort((a,b)=>a.createdAt?.seconds-b.createdAt?.seconds);
        if (available.length>0) {
          const qr = available[0];
          await updateDoc(doc(db,"shipping_qrs",qr.id),{status:"assigned",assignedTo:user.name,assignedItemId:item.id});
          await addDoc(collection(db,"shipping_orders"),{
            memberName:user.name,memberId:user.id,
            itemId:item.id,itemName:item.name,
            methodId:method.id,methodName:method.name,
            imageData:qr.imageData,
            postConfirmCode:qr.postConfirmCode,
            trackingNumber:qr.trackingNumber,
            shippingQRId:qr.id,
            quantity:Math.abs(delta),
            amount:"",
            status:"pending",
            createdAt:serverTimestamp(),
          });
          await addNotice("shipping",`${user.name} が「${item.name}」を-${Math.abs(delta)}。QR自動割当: ${qr.postConfirmCode||qr.trackingNumber}`,"master");
          showToast(`在庫-${Math.abs(delta)} & QR自動割当完了！`,C.green);
        } else {
          showToast(`⚠️ 在庫-${Math.abs(delta)}。${method.name}のQRコードが不足しています！`,C.orange);
          await addNotice("shipping",`⚠️ 「${item.name}」の${method.name}QRコードが不足しています！`,isMaster?"all":"master");
        }
        return;
      }
    }

    if (user.role==="member"&&delta<0) await addNotice("operation",`${user.name} が「${item.name}」を ${Math.abs(delta)}${item.unit} 使用（残:${newQty}${item.unit}）`,"master");
    if (newQty<=item.minAlert&&item.qty>item.minAlert) await addNotice("lowstock",`⚠️「${item.name}」在庫が少なくなりました（残:${newQty}${item.unit}）`,"all");
    if (newQty===0&&item.qty>0) await addNotice("empty",`🚨「${item.name}」の在庫がなくなりました！`,"all");
    showToast(delta>0?`${item.name} +${delta}`:`${item.name} ${Math.abs(delta)}${item.unit} 使用`,delta>0?C.green:C.red);
  },[user,showToast,addNotice,shippingQRs]);

  const navs=[{id:"home",icon:"🏠",label:"ホーム"},{id:"history",icon:"📋",label:"履歴"},...(isMaster?[{id:"members",icon:"👥",label:"メンバー"}]:[])];

  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <nav style={{display:"flex",gap:2,marginBottom:14,background:C.surface,borderRadius:12,padding:4,border:`1px solid ${C.border}`}}>
        {navs.map(n=>(
          <button key={n.id} onClick={()=>{setPage(n.id);setSelItem(null);}} style={{flex:1,padding:"8px 4px",borderRadius:8,border:"none",background:page===n.id?C.surface2:"transparent",color:page===n.id?C.text:C.muted,fontSize:12,fontWeight:page===n.id?700:400,display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
            <span>{n.icon}</span><span>{n.label}</span>
          </button>
        ))}
      </nav>

      {modal&&<InvModal modal={modal} setModal={setModal} items={items} showToast={showToast} members={members}/>}

      {page==="home"&&!selItem&&<InvHome items={visibleItems} isMaster={isMaster} onSelect={it=>{setSelItem(it);setPage("detail");}} onAdd={()=>setModal({type:"addItem"})} changeQty={changeQty}/>}
      {page==="detail"&&selItem&&<InvDetail item={items.find(i=>i.id===selItem.id)||selItem} isMaster={isMaster} changeQty={changeQty} history={history.filter(h=>h.itemId===selItem.id)} onBack={()=>{setPage("home");setSelItem(null);}} onEdit={()=>setModal({type:"editItem",item:items.find(i=>i.id===selItem.id)||selItem})} onDelete={async()=>{await deleteDoc(doc(db,"inv_items",selItem.id));setPage("home");setSelItem(null);showToast("削除しました",C.red);}}/>}
      {page==="history"&&<InvHistory history={history} isMaster={isMaster} user={user} showToast={showToast}/>}
      {page==="members"&&isMaster&&<InvMembers members={members} showToast={showToast} onAdd={()=>setModal({type:"addUser"})}/>}
    </div>
  );
}

function InvHome({ items, isMaster, onSelect, onAdd, changeQty }) {
  const [search,setSearch]=useState(""); const [sortBy,setSortBy]=useState("category"); const [cat,setCat]=useState("すべて");
  const allCats=["すべて",...new Set(items.map(i=>i.category).filter(Boolean))].sort();
  let filtered=items.filter(i=>(cat==="すべて"||i.category===cat)&&(i.name.toLowerCase().includes(search.toLowerCase())||(i.category||"").toLowerCase().includes(search.toLowerCase())));
  if (sortBy==="name") filtered=[...filtered].sort((a,b)=>a.name.localeCompare(b.name,"ja"));
  else if (sortBy==="qty") filtered=[...filtered].sort((a,b)=>a.qty-b.qty);
  else filtered=[...filtered].sort((a,b)=>(a.category||"").localeCompare(b.category||"","ja"));
  const grouped=sortBy==="category"?[...new Set(filtered.map(i=>i.category||"その他"))].map(c=>({c,items:filtered.filter(i=>(i.category||"その他")===c)})):[{c:null,items:filtered}];
  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="商品を検索…" style={{...inputS,flex:1,minWidth:120}}/>
        <select value={cat} onChange={e=>setCat(e.target.value)} style={{...inputS,width:"auto"}}>{allCats.map(c=><option key={c}>{c}</option>)}</select>
        <select value={sortBy} onChange={e=>setSortBy(e.target.value)} style={{...inputS,width:"auto"}}>
          <option value="category">カテゴリ順</option><option value="name">名前順</option><option value="qty">在庫数順</option>
        </select>
        {isMaster&&<button onClick={onAdd} style={{padding:"9px 16px",background:C.accent,color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700,whiteSpace:"nowrap"}}>＋ 追加</button>}
      </div>
      {filtered.length===0&&<p style={{color:C.muted,textAlign:"center",padding:40}}>商品が見つかりません</p>}
      {grouped.map(({c,items:gi})=>(
        <div key={c||"all"} style={{marginBottom:20}}>
          {c&&<div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <span style={{fontSize:11,fontWeight:700,color:C.accent,background:C.accentDim,padding:"3px 12px",borderRadius:20,border:`1px solid ${C.accentBorder}`}}>{c}</span>
            <div style={{flex:1,height:1,background:C.border}}/><span style={{fontSize:10,color:C.muted}}>{gi.length}件</span>
          </div>}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>{gi.map(it=><InvCard key={it.id} item={it} isMaster={isMaster} onSelect={()=>onSelect(it)} changeQty={changeQty}/>)}</div>
        </div>
      ))}
    </div>
  );
}

function InvCard({ item, isMaster, onSelect, changeQty }) {
  const empty=item.qty===0, low=item.qty>0&&item.qty<=item.minAlert;
  const bc=empty?C.redBorder:low?C.orangeBorder:C.border;
  const shipMethod = SHIPPING_METHODS.find(m=>m.id===item.shippingMethodId);
  return (
    <div style={{background:C.surface,borderRadius:14,overflow:"hidden",border:`1px solid ${bc}`}}>
      <div onClick={onSelect} style={{width:"100%",aspectRatio:"4/3",cursor:"pointer",background:item.image?`url(${item.image}) center/cover`:C.surface2,display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
        {!item.image&&<span style={{fontSize:34,opacity:0.2}}>📦</span>}
        {empty&&<div style={{position:"absolute",top:7,right:7,background:C.red,color:"#fff",fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:20}}>在庫ゼロ</div>}
        {!empty&&low&&<div style={{position:"absolute",top:7,right:7,background:C.orange,color:"#fff",fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:20}}>要補充</div>}
        {shipMethod&&<div style={{position:"absolute",bottom:7,left:7,background:`${shipMethod.color}dd`,color:"#fff",fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:20}}>{shipMethod.icon} {shipMethod.name}</div>}
      </div>
      <div style={{padding:"10px 10px 12px"}}>
        <p onClick={onSelect} style={{fontSize:13,fontWeight:700,cursor:"pointer",marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</p>
        <p style={{fontSize:10,color:C.muted,marginBottom:10}}>¥{(item.price||0).toLocaleString()} / {item.unit}</p>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <button onClick={()=>changeQty(item,-1)} disabled={item.qty===0} style={{width:32,height:32,borderRadius:8,border:"none",fontSize:18,fontWeight:700,background:item.qty===0?C.surface2:C.redDim,color:item.qty===0?C.faint:C.red,cursor:item.qty===0?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>－</button>
          <div style={{textAlign:"center"}}><span style={{fontSize:20,fontWeight:700,color:empty?C.red:low?C.orange:C.text}}>{item.qty}</span><span style={{fontSize:10,color:C.muted,marginLeft:3}}>{item.unit}</span></div>
          {isMaster?<button onClick={()=>changeQty(item,+1)} style={{width:32,height:32,borderRadius:8,border:"none",fontSize:18,fontWeight:700,background:C.greenDim,color:C.green,display:"flex",alignItems:"center",justifyContent:"center"}}>＋</button>:<div style={{width:32}}/>}
        </div>
      </div>
    </div>
  );
}

function InvDetail({ item, isMaster, changeQty, history, onBack, onEdit, onDelete }) {
  const empty=item.qty===0, low=item.qty>0&&item.qty<=item.minAlert;
  const shipMethod = SHIPPING_METHODS.find(m=>m.id===item.shippingMethodId);
  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <button onClick={onBack} style={{background:"none",border:"none",color:C.muted,fontSize:13,marginBottom:14,display:"flex",alignItems:"center",gap:5}}>← 一覧に戻る</button>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
        <div>
          <div style={{width:"100%",aspectRatio:"1/1",borderRadius:16,background:item.image?`url(${item.image}) center/cover`:C.surface2,display:"flex",alignItems:"center",justifyContent:"center",border:`1px solid ${C.border}`,marginBottom:10}}>
            {!item.image&&<span style={{fontSize:48,opacity:0.15}}>📦</span>}
          </div>
          {isMaster&&<div style={{display:"flex",gap:8}}>
            <button onClick={onEdit} style={{flex:1,padding:"9px",background:C.surface2,border:`1px solid ${C.border}`,borderRadius:10,fontSize:13,fontWeight:600,color:C.text}}>✏️ 編集</button>
            <button onClick={onDelete} style={{flex:1,padding:"9px",background:C.redDim,border:`1px solid ${C.redBorder}`,borderRadius:10,fontSize:13,fontWeight:600,color:C.red}}>🗑 削除</button>
          </div>}
        </div>
        <div>
          <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
            {item.category&&<span style={{fontSize:11,background:C.accentDim,color:C.accent,padding:"2px 10px",borderRadius:20,border:`1px solid ${C.accentBorder}`,fontWeight:700}}>{item.category}</span>}
            {shipMethod&&<span style={{fontSize:11,padding:"2px 10px",borderRadius:20,fontWeight:700,background:`${shipMethod.color}20`,color:shipMethod.color,border:`1px solid ${shipMethod.color}60`}}>{shipMethod.icon} {shipMethod.name}</span>}
            {empty&&<span style={{fontSize:11,background:C.redDim,color:C.red,padding:"2px 10px",borderRadius:20,border:`1px solid ${C.redBorder}`,fontWeight:700}}>在庫ゼロ</span>}
            {!empty&&low&&<span style={{fontSize:11,background:C.orangeDim,color:C.orange,padding:"2px 10px",borderRadius:20,border:`1px solid ${C.orangeBorder}`,fontWeight:700}}>要補充</span>}
          </div>
          <h2 style={{fontFamily:"'Sora',sans-serif",fontSize:20,fontWeight:700,marginBottom:6}}>{item.name}</h2>
          {item.note&&<p style={{color:C.muted,fontSize:13,marginBottom:12}}>{item.note}</p>}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
            {[{l:"単価",v:`¥${(item.price||0).toLocaleString()}`},{l:"単位",v:item.unit},{l:"アラート",v:`${item.minAlert}${item.unit}`},{l:"在庫総額",v:`¥${((item.qty||0)*(item.price||0)).toLocaleString()}`}].map(d=>(
              <div key={d.l} style={{background:C.surface2,borderRadius:10,padding:"8px 12px",border:`1px solid ${C.border}`}}>
                <p style={{fontSize:10,color:C.muted,marginBottom:2}}>{d.l}</p><p style={{fontSize:14,fontWeight:700}}>{d.v}</p>
              </div>
            ))}
          </div>
          <div style={{background:empty?C.redDim:low?C.orangeDim:C.surface2,borderRadius:14,padding:16,textAlign:"center",border:`1px solid ${empty?C.redBorder:low?C.orangeBorder:C.border}`}}>
            <p style={{fontSize:11,color:C.muted,marginBottom:6}}>現在の在庫</p>
            <p style={{fontSize:44,fontWeight:700,color:empty?C.red:low?C.orange:C.text,lineHeight:1,fontFamily:"'Sora',sans-serif"}}>{item.qty}<span style={{fontSize:14,color:C.muted,fontWeight:400}}> {item.unit}</span></p>
            <div style={{display:"flex",justifyContent:"center",gap:16,marginTop:14}}>
              <button onClick={()=>changeQty(item,-1)} disabled={item.qty===0} style={{width:48,height:48,borderRadius:12,border:"none",fontSize:22,fontWeight:700,background:item.qty===0?C.surface2:C.redDim,color:item.qty===0?C.faint:C.red,cursor:item.qty===0?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>－</button>
              {isMaster&&<button onClick={()=>changeQty(item,+1)} style={{width:48,height:48,borderRadius:12,border:"none",fontSize:22,fontWeight:700,background:C.greenDim,color:C.green,display:"flex",alignItems:"center",justifyContent:"center"}}>＋</button>}
            </div>
          </div>
        </div>
      </div>
      {history.length>0&&(
        <div>
          <h3 style={{fontSize:14,fontWeight:700,marginBottom:10,color:C.muted}}>この商品の操作履歴</h3>
          <div style={{background:C.surface,borderRadius:12,border:`1px solid ${C.border}`,overflow:"hidden"}}>
            {history.slice(0,10).map((h,i)=>(
              <div key={h.id} style={{padding:"9px 14px",borderBottom:i<9?`1px solid ${C.border}`:"none",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:14}}>{h.delta>0?"📥":"📤"}</span>
                <span style={{flex:1,fontSize:13,color:C.muted}}>{h.userName} {h.delta>0?`+${h.delta}`:h.delta} ({h.before}→{h.after})</span>
                <span style={{fontSize:10,color:C.faint}}>{tsToStr(h.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InvHistory({ history, isMaster, user, showToast }) {
  const [confirm,setConfirm]=useState(false);
  const visible=isMaster?history:history.filter(h=>h.userId===user.id);
  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <h2 style={{fontSize:16,fontWeight:700}}>{isMaster?"全操作履歴":"自分の操作履歴"}</h2>
        {isMaster&&visible.length>0&&<button onClick={()=>setConfirm(true)} style={{padding:"7px 14px",background:C.redDim,color:C.red,border:`1px solid ${C.redBorder}`,borderRadius:8,fontSize:12}}>🗑 全削除</button>}
      </div>
      {confirm&&(
        <div style={{background:C.redDim,border:`1px solid ${C.redBorder}`,borderRadius:12,padding:"13px 16px",marginBottom:14,display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
          <p style={{flex:1,fontSize:13,color:C.red,fontWeight:600}}>全履歴を削除しますか？</p>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>setConfirm(false)} style={{padding:"7px 14px",background:C.surface2,border:`1px solid ${C.border}`,borderRadius:8,fontSize:12,color:C.muted}}>キャンセル</button>
            <button onClick={async()=>{await Promise.all(history.map(h=>deleteDoc(doc(db,"inv_history",h.id))));setConfirm(false);showToast("全履歴を削除しました",C.red);}} style={{padding:"7px 14px",background:C.red,color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700}}>削除する</button>
          </div>
        </div>
      )}
      {visible.length===0?<p style={{color:C.muted,textAlign:"center",padding:40}}>履歴がありません</p>
        :<div style={{background:C.surface,borderRadius:12,border:`1px solid ${C.border}`,overflow:"hidden"}}><div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead><tr style={{background:C.surface2}}>{["日時",...(isMaster?["操作者","役割"]:[]),"商品名","変化","前→後"].map((h,i)=><th key={i} style={{padding:"9px 12px",textAlign:"left",fontSize:10,fontWeight:700,color:C.muted,whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
            <tbody>{visible.map((h,i)=>(
              <tr key={h.id} style={{borderTop:`1px solid ${C.border}`,background:i%2===0?C.surface:`${C.surface2}80`}}>
                <td style={{padding:"9px 12px",color:C.muted,fontSize:10,whiteSpace:"nowrap"}}>{tsToStr(h.createdAt)}</td>
                {isMaster&&<><td style={{padding:"9px 12px",fontWeight:600}}>{h.userName}</td><td style={{padding:"9px 12px"}}><span style={{fontSize:10,padding:"1px 7px",borderRadius:20,fontWeight:700,background:h.role==="master"?C.purpleDim:C.accentDim,color:h.role==="master"?C.purple:C.accent}}>{h.role==="master"?"M":"一般"}</span></td></>}
                <td style={{padding:"9px 12px",fontWeight:600,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{h.itemName}</td>
                <td style={{padding:"9px 12px",fontWeight:700,color:h.delta>0?C.green:C.red}}>{h.delta>0?`＋${h.delta}`:h.delta}</td>
                <td style={{padding:"9px 12px",color:C.muted}}>{h.before}→{h.after}</td>
              </tr>
            ))}</tbody>
          </table>
        </div></div>
      }
    </div>
  );
}

function InvMembers({ members, showToast, onAdd }) {
  const [showPw,setShowPw]=useState({});
  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <h2 style={{fontSize:16,fontWeight:700}}>メンバー管理</h2>
        <button onClick={onAdd} style={{padding:"8px 16px",background:C.accent,color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700}}>＋ 追加</button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {members.map(m=>(
          <div key={m.id} style={{background:C.surface,borderRadius:12,border:`1px solid ${C.border}`,padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:38,height:38,borderRadius:"50%",background:m.role==="master"?C.purpleDim:C.accentDim,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,border:`1px solid ${m.role==="master"?C.purpleBorder:C.accentBorder}`,flexShrink:0}}>{m.role==="master"?"👑":"👤"}</div>
            <div style={{flex:1,minWidth:0}}>
              <p style={{fontWeight:700,fontSize:14}}>{m.name}</p>
              <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                <p style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{showPw[m.id]?m.password:"●".repeat(m.password?.length||6)}</p>
                <button onClick={()=>setShowPw(p=>({...p,[m.id]:!p[m.id]}))} style={{background:"none",border:"none",fontSize:12,color:C.muted}}>{showPw[m.id]?"🙈":"👁"}</button>
              </div>
            </div>
            <span style={{fontSize:10,padding:"2px 9px",borderRadius:20,fontWeight:700,background:m.role==="master"?C.purpleDim:C.accentDim,color:m.role==="master"?C.purple:C.accent,border:`1px solid ${m.role==="master"?C.purpleBorder:C.accentBorder}`,whiteSpace:"nowrap"}}>{m.role==="master"?"マスター":"メンバー"}</span>
            {m.role!=="master"&&<button onClick={async()=>{if(!confirm(`${m.name}を削除しますか？`))return;await deleteDoc(doc(db,"members",m.id));showToast("削除しました");}} style={{padding:"5px 11px",background:C.redDim,color:C.red,border:`1px solid ${C.redBorder}`,borderRadius:8,fontSize:12}}>削除</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function InvModal({ modal, setModal, items, showToast, members }) {
  const close=()=>setModal(null);
  if (modal.type==="addItem"||modal.type==="editItem") return <InvItemForm close={close} existing={modal.item} items={items} showToast={showToast} members={members}/>;
  if (modal.type==="addUser") return <InvAddUser close={close} showToast={showToast}/>;
  return null;
}

function InvItemForm({ close, existing, items, showToast, members=[] }) {
  const isEdit=!!existing;
  const existingCats=[...new Set(items.map(i=>i.category).filter(Boolean))].sort();
  const initUnit=existing?.unit||"個";
  const isPreset=UNIT_PRESETS.includes(initUnit);
  const [form,setForm]=useState({name:existing?.name||"",category:existing?.category||"",unit:isPreset?initUnit:"個",qty:existing?.qty??0,minAlert:existing?.minAlert??5,price:existing?.price??0,note:existing?.note||"",image:existing?.image||null});
  const [customUnit,setCustomUnit]=useState(isPreset?"":initUnit);
  const [catInput,setCatInput]=useState(existing?.category||"");
  const [showCats,setShowCats]=useState(false);
  const [visibleTo,setVisibleTo]=useState(existing?.visibleTo||[]);
  const [shippingMethodId,setShippingMethodId]=useState(existing?.shippingMethodId||"");
  const fileRef=useRef();
  const filteredCats=existingCats.filter(c=>c.toLowerCase().includes(catInput.toLowerCase())&&c!==catInput);
  const finalUnit=customUnit||form.unit;

  async function save() {
    if (!form.name.trim()){showToast("商品名を入力してください",C.red);return;}
    const payload={...form,unit:finalUnit,category:catInput.trim()||"未分類",qty:Number(form.qty),minAlert:Number(form.minAlert),price:Number(form.price),visibleTo,shippingMethodId};
    if (isEdit){await updateDoc(doc(db,"inv_items",existing.id),payload);showToast("更新しました");}
    else{await addDoc(collection(db,"inv_items"),{...payload,createdAt:serverTimestamp()});showToast("追加しました");}
    close();
  }

  return (
    <Overlay onClose={close}>
      <h2 style={{fontFamily:"'Sora',sans-serif",fontSize:18,fontWeight:700,marginBottom:16}}>{isEdit?"商品を編集":"商品を追加"}</h2>
      <div onClick={()=>fileRef.current.click()} style={{width:"100%",height:90,borderRadius:12,cursor:"pointer",background:form.image?`url(${form.image}) center/cover`:C.surface2,border:`2px dashed ${C.border}`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",marginBottom:12,gap:4}}>
        {!form.image&&<><span style={{fontSize:22}}>📷</span><span style={{fontSize:12,color:C.muted}}>画像を追加（任意）</span></>}
        <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>setForm(p=>({...p,image:ev.target.result}));r.readAsDataURL(f);}}/>
      </div>
      {form.image&&<button onClick={()=>setForm(p=>({...p,image:null}))} style={{padding:"5px 12px",background:C.surface2,border:`1px solid ${C.border}`,borderRadius:8,fontSize:12,color:C.red,marginBottom:10}}>画像を削除</button>}
      <Fg label="商品名 *"><input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} style={inputS} placeholder="例: コーヒー豆"/></Fg>
      <div style={{marginBottom:12,position:"relative"}}>
        <label style={labelS}>カテゴリ</label>
        <input value={catInput} onChange={e=>{setCatInput(e.target.value);setShowCats(true);}} onFocus={()=>setShowCats(true)} onBlur={()=>setTimeout(()=>setShowCats(false),160)} style={inputS} placeholder="例: 食品"/>
        {showCats&&filteredCats.length>0&&<div style={{position:"absolute",top:"100%",left:0,right:0,background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,zIndex:100,boxShadow:"0 8px 24px rgba(0,0,0,0.4)",overflow:"hidden"}}>
          {filteredCats.map(c=><div key={c} onMouseDown={()=>{setCatInput(c);setShowCats(false);}} style={{padding:"9px 14px",cursor:"pointer",fontSize:13,borderBottom:`1px solid ${C.border}`,color:C.text}} onMouseEnter={e=>e.currentTarget.style.background=C.surface2} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>{c}</div>)}
        </div>}
        {existingCats.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:6}}>{existingCats.map(c=><button key={c} onClick={()=>setCatInput(c)} style={{padding:"2px 10px",fontSize:11,border:`1px solid ${catInput===c?C.accent:C.border}`,borderRadius:20,background:catInput===c?C.accentDim:C.surface2,color:catInput===c?C.accent:C.muted}}>{c}</button>)}</div>}
      </div>

      {/* 発送方法設定 */}
      <div style={{marginBottom:12}}>
        <label style={labelS}>発送方法（在庫-1時に自動連携）</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
          <button onClick={()=>setShippingMethodId("")} style={{padding:"4px 12px",fontSize:11,border:`1px solid ${!shippingMethodId?C.accent:C.border}`,borderRadius:20,background:!shippingMethodId?C.accentDim:C.surface2,color:!shippingMethodId?C.accent:C.muted}}>設定なし</button>
          {SHIPPING_METHODS.map(m=>(
            <button key={m.id} onClick={()=>setShippingMethodId(m.id)} style={{padding:"4px 12px",fontSize:11,border:`1px solid ${shippingMethodId===m.id?m.color:C.border}`,borderRadius:20,background:shippingMethodId===m.id?`${m.color}20`:C.surface2,color:shippingMethodId===m.id?m.color:C.muted,display:"flex",alignItems:"center",gap:4}}>
              <span>{m.icon}</span>{m.name}
              {m.type==="auto"&&<span style={{fontSize:9,color:C.muted}}>(自動)</span>}
              {m.type==="member"&&<span style={{fontSize:9,color:C.muted}}>(撮影)</span>}
            </button>
          ))}
        </div>
      </div>

      <div style={{marginBottom:12}}>
        <label style={labelS}>単位</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:6}}>{UNIT_PRESETS.map(u=><button key={u} onClick={()=>{setForm(p=>({...p,unit:u}));setCustomUnit("");}} style={{padding:"3px 10px",fontSize:11,border:`1px solid ${form.unit===u&&!customUnit?C.accent:C.border}`,borderRadius:20,background:form.unit===u&&!customUnit?C.accentDim:C.surface2,color:form.unit===u&&!customUnit?C.accent:C.muted}}>{u}</button>)}</div>
        <input value={customUnit} onChange={e=>setCustomUnit(e.target.value)} placeholder="その他（自由入力）" style={{...inputS,fontSize:12}}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
        <Fg label="数量"><input type="number" value={form.qty} onChange={e=>setForm(p=>({...p,qty:e.target.value}))} style={inputS}/></Fg>
        <Fg label="アラート閾値"><input type="number" value={form.minAlert} onChange={e=>setForm(p=>({...p,minAlert:e.target.value}))} style={inputS}/></Fg>
        <div style={{gridColumn:"1/-1"}}><Fg label="単価 (円)"><input type="number" value={form.price} onChange={e=>setForm(p=>({...p,price:e.target.value}))} style={inputS}/></Fg></div>
      </div>
      <Fg label="メモ"><input value={form.note} onChange={e=>setForm(p=>({...p,note:e.target.value}))} style={inputS} placeholder="任意"/></Fg>

      <div style={{marginBottom:12}}>
        <label style={labelS}>公開するメンバー（未選択 = 全員に公開）</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
          {members.filter(m=>m.role==="member").map(m=>(
            <button key={m.id} onClick={()=>setVisibleTo(p=>p.includes(m.name)?p.filter(n=>n!==m.name):[...p,m.name])} style={{padding:"4px 12px",fontSize:11,border:`1px solid ${visibleTo.includes(m.name)?C.accent:C.border}`,borderRadius:20,background:visibleTo.includes(m.name)?C.accentDim:C.surface2,color:visibleTo.includes(m.name)?C.accent:C.muted}}>
              {visibleTo.includes(m.name)?"✓ ":""}{m.name}
            </button>
          ))}
        </div>
        {visibleTo.length===0&&<p style={{fontSize:11,color:C.muted,marginTop:4}}>全メンバーに公開されます</p>}
      </div>

      <div style={{display:"flex",gap:10,marginTop:16}}>
        <button onClick={close} style={{flex:1,padding:"11px",background:C.surface2,border:`1px solid ${C.border}`,borderRadius:10,fontSize:14,color:C.muted}}>キャンセル</button>
        <button onClick={save} style={{flex:2,padding:"11px",background:C.accent,color:"#fff",border:"none",borderRadius:10,fontWeight:700,fontSize:14}}>{isEdit?"更新する":"追加する"}</button>
      </div>
    </Overlay>
  );
}

function InvAddUser({ close, showToast }) {
  const [form,setForm]=useState({name:"",password:"",role:"member"});
  async function save() {
    if (!form.name.trim()||!form.password.trim()){showToast("名前とパスワードを入力してください",C.red);return;}
    await addDoc(collection(db,"members"),{...form,createdAt:serverTimestamp()});
    showToast(`${form.name} を追加しました`);
    close();
  }
  return (
    <Overlay onClose={close}>
      <h2 style={{fontFamily:"'Sora',sans-serif",fontSize:18,fontWeight:700,marginBottom:16}}>メンバー追加</h2>
      <Fg label="名前 *"><input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} style={inputS}/></Fg>
      <Fg label="パスワード *"><input value={form.password} onChange={e=>setForm(p=>({...p,password:e.target.value}))} style={inputS}/></Fg>
      <div style={{marginBottom:16}}>
        <label style={labelS}>役割</label>
        <select value={form.role} onChange={e=>setForm(p=>({...p,role:e.target.value}))} style={inputS}>
          <option value="member">メンバー（在庫を減らすのみ）</option>
          <option value="master">マスター（全操作可）</option>
        </select>
      </div>
      <div style={{display:"flex",gap:10}}>
        <button onClick={close} style={{flex:1,padding:"11px",background:C.surface2,border:`1px solid ${C.border}`,borderRadius:10,fontSize:14,color:C.muted}}>キャンセル</button>
        <button onClick={save} style={{flex:2,padding:"11px",background:C.accent,color:"#fff",border:"none",borderRadius:10,fontWeight:700,fontSize:14}}>追加する</button>
      </div>
    </Overlay>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ▌ QR APP（既存）
// ═══════════════════════════════════════════════════════════════════
function QRApp({ qrItems, qrLog, members, user, isMaster, showToast, addNotice }) {
  const [tab,setTab]=useState("unread"); const [selectedItem,setSelected]=useState(null);
  const unreadItems=qrItems.filter(i=>i.status==="unread");
  const myReadItems=qrItems.filter(i=>i.status==="read"&&i.formData?.memberName===user.name);
  const allReadItems=qrItems.filter(i=>i.status==="read");

  async function handleSelect(item) {
    if (item.lockedBy&&item.lockedBy!==user.name) return;
    await updateDoc(doc(db,"qr_items",item.id),{lockedBy:user.name});
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"選択",detail:`QR選択: ${item.label}`,createdAt:serverTimestamp()});
    setSelected({...item,lockedBy:user.name});
  }
  async function handleSave(formData) {
    const readAt=new Date().toLocaleString("ja-JP",{hour12:false});
    await updateDoc(doc(db,"qr_items",selectedItem.id),{status:"read",lockedBy:null,formData,readAt:serverTimestamp()});
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"保存",detail:`保存: ${selectedItem.label}`,createdAt:serverTimestamp()});
    await addNotice("qr_save",`${user.name} が「${selectedItem.label}」を読み込み完了`,"master");
    exportToExcel([{label:selectedItem.label,...formData,readAt}],`QR_${formData.memberName}_${readAt.replace(/[/:]/g,"-")}.csv`);
    showToast("保存＆Excelダウンロード完了 ✅",C.green);
    setSelected(null); setTab(isMaster?"read":"myread");
  }
  async function handleCancel() {
    await updateDoc(doc(db,"qr_items",selectedItem.id),{lockedBy:null}); setSelected(null);
  }
  async function handleDelete(item) {
    if (!confirm("削除しますか？"))return;
    await deleteDoc(doc(db,"qr_items",item.id));
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"削除",detail:`QR削除: ${item.label}`,createdAt:serverTimestamp()});
    showToast("削除しました",C.red);
  }
  async function handleRelease(item) {
    await updateDoc(doc(db,"qr_items",item.id),{lockedBy:null});
    showToast("ロックを解除しました",C.orange);
  }

  if (selectedItem) return <QRFormView item={selectedItem} user={user} onSave={handleSave} onCancel={handleCancel}/>;

  const masterTabs=[{id:"upload",label:"QR登録",cnt:null},{id:"unread",label:"未読み込み",cnt:unreadItems.length},{id:"read",label:"読み込み済",cnt:allReadItems.length},{id:"log",label:"操作ログ",cnt:null}];
  const memberTabs=[{id:"unread",label:"未読み込み",cnt:unreadItems.length},{id:"myread",label:"自分の読込済",cnt:myReadItems.length}];
  const tabs=isMaster?masterTabs:memberTabs;

  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",gap:2,marginBottom:14,background:C.surface,borderRadius:12,padding:4,border:`1px solid ${C.border}`,flexWrap:"wrap"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,padding:"8px 6px",borderRadius:8,border:"none",minWidth:80,background:tab===t.id?C.surface2:"transparent",color:tab===t.id?C.text:C.muted,fontSize:12,fontWeight:tab===t.id?700:400,display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
            {t.label}{t.cnt!==null&&<span style={{background:tab===t.id?C.accent:C.surface2,color:tab===t.id?"#fff":C.muted,fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:20,border:`1px solid ${C.border}`}}>{t.cnt}</span>}
          </button>
        ))}
      </div>
      {tab==="upload"&&isMaster&&<QRUploader qrItems={qrItems} user={user} showToast={showToast}/>}
      {tab==="unread"&&<QRList items={unreadItems} user={user} isMaster={isMaster} onSelect={handleSelect} onDelete={handleDelete} onRelease={handleRelease}/>}
      {tab==="read"&&isMaster&&<QRList items={allReadItems} user={user} isMaster={isMaster} readOnly onDelete={handleDelete} onRelease={handleRelease}/>}
      {tab==="myread"&&!isMaster&&<QRReadList items={myReadItems}/>}
      {tab==="log"&&isMaster&&(
        <div>
          <h3 style={{fontSize:15,fontWeight:700,marginBottom:12}}>操作ログ</h3>
          {qrLog.length===0?<p style={{color:C.muted,textAlign:"center",padding:40}}>ログがありません</p>
            :<div style={{background:C.surface,borderRadius:12,border:`1px solid ${C.border}`,overflow:"hidden"}}>
              {qrLog.map((e,i)=>(
                <div key={e.id} style={{padding:"10px 14px",borderBottom:i<qrLog.length-1?`1px solid ${C.border}`:"none",display:"grid",gridTemplateColumns:"140px 70px 1fr",gap:8,alignItems:"center"}}>
                  <span style={{fontSize:10,color:C.faint}}>{tsToStr(e.createdAt)}</span>
                  <span style={{fontSize:12,fontWeight:600,color:C.accent}}>{e.userName}</span>
                  <span style={{fontSize:12,color:C.muted}}><span style={{color:C.orange,fontWeight:600}}>{e.action}</span> {e.detail}</span>
                </div>
              ))}
            </div>
          }
        </div>
      )}
    </div>
  );
}

function QRUploader({ qrItems, user, showToast }) {
  const [label,setLabel]=useState(""); const [preview,setPreview]=useState(null); const [imgData,setImgData]=useState(null); const [uploading,setUploading]=useState(false);
  const fileRef=useRef();
  function handleFile(e) {
    const file=e.target.files[0]; if(!file)return;
    const r=new FileReader();
    r.onload=ev=>{setPreview(ev.target.result);setImgData(ev.target.result);if(!label)setLabel(file.name.replace(/\.[^/.]+$/,""));};
    r.readAsDataURL(file);
  }
  async function upload() {
    if (!imgData)return; setUploading(true);
    const lbl=label||`QR-${Date.now()}`;
    await addDoc(collection(db,"qr_items"),{label:lbl,imageData:imgData,status:"unread",lockedBy:null,formData:null,uploadedAt:serverTimestamp()});
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"QR登録",detail:`登録: ${lbl}`,createdAt:serverTimestamp()});
    showToast(`「${lbl}」を登録しました`);
    setLabel("");setPreview(null);setImgData(null);
    if(fileRef.current)fileRef.current.value="";
    setUploading(false);
  }
  return (
    <div>
      <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:20,marginBottom:12}}>
        <h3 style={{fontSize:15,fontWeight:700,marginBottom:14}}>QRコード登録</h3>
        <div style={{border:`2px dashed ${C.border}`,borderRadius:12,padding:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",marginBottom:14,minHeight:140,background:C.surface2}} onClick={()=>fileRef.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f){const ev={target:{files:[f]}};handleFile(ev);}}}>
          {preview?<img src={preview} style={{maxHeight:160,maxWidth:"100%",borderRadius:8}}/>:<div style={{textAlign:"center"}}><div style={{fontSize:36,marginBottom:8}}>📷</div><p style={{color:C.muted,fontSize:13}}>クリックまたはドラッグでアップロード</p></div>}
        </div>
        <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{display:"none"}}/>
        <Fg label="ラベル名"><input value={label} onChange={e=>setLabel(e.target.value)} style={inputS} placeholder="例: 荷物001"/></Fg>
        <button onClick={upload} disabled={!imgData||uploading} style={{padding:"11px 24px",background:imgData?C.accent:C.surface2,color:imgData?"#fff":C.faint,border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:imgData?"pointer":"not-allowed"}}>
          {uploading?"登録中...":"📦 登録する"}
        </button>
      </div>
      <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:20}}>
        <h4 style={{fontSize:13,fontWeight:700,color:C.muted,marginBottom:10}}>登録済み ({qrItems.length}件)</h4>
        <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:220,overflowY:"auto"}}>
          {qrItems.map(item=>(
            <div key={item.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:C.surface2,borderRadius:10,border:`1px solid ${C.border}`}}>
              <img src={item.imageData} style={{width:40,height:40,objectFit:"contain",borderRadius:6,background:"#fff",padding:2}}/>
              <div style={{flex:1,minWidth:0}}><p style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.label}</p><p style={{fontSize:10,color:C.muted}}>{tsToStr(item.uploadedAt)}</p></div>
              <span style={{fontSize:11,fontWeight:600,padding:"2px 9px",borderRadius:20,background:item.status==="read"?C.greenDim:C.surface,color:item.status==="read"?C.green:C.muted,border:`1px solid ${item.status==="read"?C.greenBorder:C.border}`}}>{item.status==="read"?"✅ 済":"⏳ 未"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function QRList({ items, user, isMaster, onSelect, onDelete, onRelease, readOnly=false }) {
  if (!items.length) return <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:40,textAlign:"center"}}><p style={{color:C.muted}}>該当するQRコードはありません</p></div>;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {items.map(item=>{
        const isLockedByOther=item.lockedBy&&item.lockedBy!==user?.name;
        const isLockedByMe=item.lockedBy===user?.name;
        return (
          <div key={item.id} style={{background:C.surface,borderRadius:14,border:`1px solid ${isLockedByOther?C.redBorder:isLockedByMe?C.orangeBorder:C.border}`,padding:16,opacity:isLockedByOther?0.6:1,transition:"opacity 0.2s"}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <img src={item.imageData} style={{width:52,height:52,objectFit:"contain",borderRadius:8,background:"#fff",padding:3,flexShrink:0}}/>
              <div style={{flex:1,minWidth:0}}>
                <p style={{fontWeight:700,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.label}</p>
                <p style={{fontSize:11,color:C.muted}}>{tsToStr(item.uploadedAt)}</p>
                {isLockedByOther&&<p style={{fontSize:11,color:C.red,marginTop:2}}>🔒 {item.lockedBy} が使用中</p>}
                {isLockedByMe&&<p style={{fontSize:11,color:C.orange,marginTop:2}}>✏️ あなたが選択中</p>}
                {item.status==="read"&&item.formData?.memberName&&<p style={{fontSize:11,color:C.green,marginTop:2}}>✅ {item.formData.memberName} が読み込み済</p>}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>
                {!readOnly&&onSelect&&<button onClick={()=>onSelect(item)} disabled={isLockedByOther} style={{padding:"7px 14px",background:isLockedByOther?C.surface2:isLockedByMe?C.orangeDim:C.accentDim,color:isLockedByOther?C.faint:isLockedByMe?C.orange:C.accent,border:`1px solid ${isLockedByOther?C.border:isLockedByMe?C.orangeBorder:C.accentBorder}`,borderRadius:8,fontSize:12,fontWeight:700,cursor:isLockedByOther?"not-allowed":"pointer"}}>
                  {isLockedByMe?"再開":"選択"}
                </button>}
                {isMaster&&!readOnly&&isLockedByOther&&<button onClick={()=>onRelease(item)} style={{padding:"5px 10px",background:C.orangeDim,color:C.orange,border:`1px solid ${C.orangeBorder}`,borderRadius:8,fontSize:11}}>🔓 解除</button>}
                {isMaster&&<button onClick={()=>onDelete(item)} style={{padding:"5px 10px",background:C.redDim,color:C.red,border:`1px solid ${C.redBorder}`,borderRadius:8,fontSize:11}}>🗑 削除</button>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function QRReadList({ items }) {
  if (!items.length) return <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:40,textAlign:"center"}}><p style={{color:C.muted}}>まだ読み込み済みはありません</p></div>;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {items.map(item=>(
        <div key={item.id} style={{background:C.surface,borderRadius:14,border:`1px solid ${C.greenBorder}`,padding:16}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:item.formData?10:0}}>
            <span style={{fontSize:26}}>✅</span>
            <div><p style={{fontWeight:700,fontSize:14}}>{item.label}</p><p style={{fontSize:11,color:C.green}}>{tsToStr(item.readAt)}</p></div>
          </div>
          {item.formData&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            {[["商品名",item.formData.productName],["年月日時",item.formData.datetime],["個数",item.formData.quantity],["ジャンル",item.formData.genre],["金額",item.formData.amount?`¥${Number(item.formData.amount).toLocaleString()}`:""]].map(([k,v])=>v&&(
              <div key={k} style={{background:C.surface2,borderRadius:8,padding:"6px 10px",border:`1px solid ${C.border}`}}>
                <p style={{fontSize:10,color:C.muted,marginBottom:2}}>{k}</p><p style={{fontSize:13,fontWeight:600}}>{v}</p>
              </div>
            ))}
          </div>}
        </div>
      ))}
    </div>
  );
}

function QRFormView({ item, user, onSave, onCancel }) {
  const [showQR,setShowQR]=useState(false); const [checked,setChecked]=useState(false);
  const [form,setForm]=useState({productName:"",datetime:new Date().toISOString().slice(0,16),quantity:"",genre:"",memberName:user.name,amount:""});
  const isComplete=form.productName&&form.datetime&&form.quantity&&form.genre&&form.amount;
  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button onClick={onCancel} style={{padding:"7px 14px",background:C.surface2,border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,color:C.muted}}>← 戻る</button>
        <h2 style={{fontSize:16,fontWeight:700}}>{item.label}</h2>
      </div>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:20}}>
        <h3 style={{fontSize:15,fontWeight:700,marginBottom:16}}>📋 情報入力</h3>
        {[{key:"productName",label:"商品名",type:"text",ph:"例: Tシャツ 白 M"},{key:"datetime",label:"年月日時",type:"datetime-local"},{key:"quantity",label:"個数",type:"number",ph:"例: 3"},{key:"memberName",label:"メンバー名",type:"text"},{key:"amount",label:"金額",type:"number",ph:"例: 5000"}].map(f=>(
          <Fg key={f.key} label={f.label}><input type={f.type} value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} style={inputS} placeholder={f.ph} readOnly={f.key==="memberName"}/></Fg>
        ))}
        <div style={{marginBottom:16}}>
          <label style={labelS}>ジャンル</label>
          <select value={form.genre} onChange={e=>setForm(p=>({...p,genre:e.target.value}))} style={inputS}>
            <option value="">選択してください</option>
            {GENRES.map(g=><option key={g}>{g}</option>)}
          </select>
        </div>
        <button onClick={()=>setShowQR(!showQR)} disabled={!isComplete} style={{padding:"10px 20px",background:isComplete?C.accentDim:C.surface2,color:isComplete?C.accent:C.faint,border:`1px solid ${isComplete?C.accentBorder:C.border}`,borderRadius:10,fontSize:14,fontWeight:700,cursor:isComplete?"pointer":"not-allowed",marginBottom:16}}>
          {showQR?"🙈 QRを隠す":"🔍 QRコードを表示"}
        </button>
        {showQR&&isComplete&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:24,background:"#fff",borderRadius:14,marginBottom:16,border:`1px solid ${C.border}`}}>
            <img src={item.imageData} style={{width:200,height:200,objectFit:"contain"}}/>
            <p style={{color:"#555",fontSize:12,marginTop:10}}>スキャンしてください</p>
          </div>
        )}
        <div style={{display:"flex",alignItems:"center",gap:10,padding:14,background:C.surface2,borderRadius:10,marginBottom:16,border:`1px solid ${C.border}`,cursor:"pointer"}} onClick={()=>setChecked(!checked)}>
          <input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} style={{width:18,height:18,accentColor:C.accent,cursor:"pointer"}}/>
          <label style={{color:C.text,fontSize:14,cursor:"pointer",fontWeight:checked?600:400}}>読み込みチェック完了</label>
        </div>
        <button onClick={()=>onSave(form)} disabled={!checked||!isComplete} style={{width:"100%",padding:"13px",background:checked&&isComplete?C.green:C.surface2,color:checked&&isComplete?"#fff":C.faint,border:"none",borderRadius:10,fontSize:15,fontWeight:700,cursor:checked&&isComplete?"pointer":"not-allowed",transition:"all 0.2s"}}>
          💾 保存して完了
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 💰 SALES APP
// ═══════════════════════════════════════════════════════════════════
function SalesApp({ qrItems, shippingOrders, members, user, isMaster }) {
  const [period,setPeriod]=useState("all"); const [selMember,setSelMember]=useState("all");
  const readItems=qrItems.filter(i=>i.status==="read"&&i.formData);
  const completedOrders=shippingOrders.filter(o=>o.status==="completed");

  function filterByPeriod(items) {
    if (period==="all") return items;
    const now=new Date();
    return items.filter(i=>{
      const d=i.readAt?.toDate?i.readAt.toDate():i.approvedAt?.toDate?i.approvedAt.toDate():new Date(0);
      if (period==="today") return d.toDateString()===now.toDateString();
      if (period==="month") return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
      return true;
    });
  }

  const filteredQR=filterByPeriod(readItems).filter(i=>selMember==="all"||i.formData?.memberName===selMember);
  const filteredShip=filterByPeriod(completedOrders).filter(o=>selMember==="all"||o.memberName===selMember);
  const displayQR=isMaster?filteredQR:filteredQR.filter(i=>i.formData?.memberName===user.name);
  const displayShip=isMaster?filteredShip:filteredShip.filter(o=>o.memberName===user.name);

  const memberNames=[...new Set([...readItems.map(i=>i.formData?.memberName),...completedOrders.map(o=>o.memberName)].filter(Boolean))];
  const grandTotal=[...displayQR.map(i=>Number(i.formData?.amount||0)),...displayShip.map(o=>Number(o.amount||0))].reduce((s,v)=>s+v,0);

  const memberStats=memberNames.map(name=>{
    const qrAmt=filterByPeriod(readItems).filter(i=>i.formData?.memberName===name).reduce((s,i)=>s+Number(i.formData?.amount||0),0);
    const shipAmt=filterByPeriod(completedOrders).filter(o=>o.memberName===name).reduce((s,o)=>s+Number(o.amount||0),0);
    return {name,total:qrAmt+shipAmt,count:filterByPeriod(readItems).filter(i=>i.formData?.memberName===name).length+filterByPeriod(completedOrders).filter(o=>o.memberName===name).length};
  }).sort((a,b)=>b.total-a.total);

  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <h2 style={{fontSize:16,fontWeight:700}}>💰 売上集計</h2>
        <button onClick={()=>exportToExcel([...displayQR.map(i=>({label:i.label,productName:i.formData?.productName,datetime:i.formData?.datetime,quantity:i.formData?.quantity,genre:i.formData?.genre,memberName:i.formData?.memberName,amount:i.formData?.amount,readAt:tsToStr(i.readAt)})),...displayShip.map(o=>({label:o.itemName,productName:o.itemName,datetime:tsToStr(o.createdAt),quantity:o.quantity,genre:o.methodName,memberName:o.memberName,amount:o.amount,readAt:tsToStr(o.approvedAt)}))],`売上_${new Date().toLocaleDateString("ja-JP").replace(/\//g,"-")}.csv`)} style={{padding:"8px 16px",background:C.green,color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700}}>📥 Excelダウンロード</button>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:2,background:C.surface,borderRadius:10,padding:3,border:`1px solid ${C.border}`}}>
          {[{id:"all",label:"全期間"},{id:"month",label:"今月"},{id:"today",label:"今日"}].map(p=>(
            <button key={p.id} onClick={()=>setPeriod(p.id)} style={{padding:"5px 12px",borderRadius:7,border:"none",background:period===p.id?C.accent:"transparent",color:period===p.id?"#fff":C.muted,fontSize:12,fontWeight:period===p.id?700:400}}>{p.label}</button>
          ))}
        </div>
        {isMaster&&<select value={selMember} onChange={e=>setSelMember(e.target.value)} style={{...inputS,width:"auto"}}>
          <option value="all">全メンバー</option>
          {memberNames.map(n=><option key={n} value={n}>{n}</option>)}
        </select>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
        <div style={{background:C.surface,borderRadius:14,padding:16,border:`1px solid ${C.greenBorder}`}}>
          <p style={{fontSize:11,color:C.muted,marginBottom:4}}>合計金額</p>
          <p style={{fontSize:28,fontWeight:700,color:C.green,fontFamily:"'Sora',sans-serif"}}>¥{grandTotal.toLocaleString()}</p>
        </div>
        <div style={{background:C.surface,borderRadius:14,padding:16,border:`1px solid ${C.border}`}}>
          <p style={{fontSize:11,color:C.muted,marginBottom:4}}>件数</p>
          <p style={{fontSize:28,fontWeight:700,fontFamily:"'Sora',sans-serif"}}>{displayQR.length+displayShip.length}<span style={{fontSize:14,color:C.muted,fontWeight:400}}> 件</span></p>
        </div>
      </div>
      {isMaster&&selMember==="all"&&memberStats.length>0&&(
        <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:16,marginBottom:16}}>
          <h3 style={{fontSize:14,fontWeight:700,marginBottom:12,color:C.muted}}>メンバー別売上</h3>
          {memberStats.map((m,i)=>(
            <div key={m.name} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:i<memberStats.length-1?`1px solid ${C.border}`:"none"}}>
              <span style={{fontSize:12,color:C.muted,minWidth:20}}>{i+1}</span>
              <span style={{flex:1,fontSize:14,fontWeight:600}}>{m.name}</span>
              <span style={{fontSize:12,color:C.muted}}>{m.count}件</span>
              <span style={{fontSize:15,fontWeight:700,color:C.green}}>¥{m.total.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════
function Overlay({ children, onClose }) {
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.surface,borderRadius:20,padding:24,width:"100%",maxWidth:480,maxHeight:"92vh",overflowY:"auto",animation:"pop 0.2s ease",boxShadow:"0 24px 64px rgba(0,0,0,0.6)",border:`1px solid ${C.border}`}}>
        {children}
      </div>
    </div>
  );
}

function Fg({ label, children }) {
  return <div style={{marginBottom:12}}><label style={labelS}>{label}</label>{children}</div>;
}
