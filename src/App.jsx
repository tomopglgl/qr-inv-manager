// @version 6.4 - 2026-04-05
import { useState, useEffect, useRef, useCallback } from "react";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc, setDoc,
  query, orderBy, limit, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ═══════════════════════════════════════════════════════════════════
// 🔥 Firebase設定 — SETUP.md を読んでここを書き換えてください
// ═══════════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey:            "AIzaSyC8_PLU-ULrueIVbmXL67Z1egkP0STKbec"、
  認証ドメイン:        「sku-tool-558af.firebaseapp.com」、
  プロジェクトID:         「sku-tool-558af」、
  ストレージバケット:     「sku-tool-558af.firebasestorage.app」、
  メッセージ送信者ID:「240546265244」、
  アプリID:             "1:240546265244:web:141424d177069477d89559"、
};

const IS_CONFIGURED = !firebaseConfig.apiKey.includes("YOUR");
let db = null;
if (IS_CONFIGURED) {
  try { db = getFirestore(initializeApp(firebaseConfig)); } catch {}
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const GENRES = ["衣類","小物アクセサリー","ライト/照明","バッグ","消耗品","工具","スマホアクセサリー"];
const SHIPPING_METHODS = [
  { id:"yupacket_post",      name:"ゆうパケットポスト",     icon:"📮", color:"#e53e3e" },
  { id:"yupacket_post_mini", name:"ゆうパケットポストmini", icon:"📮", color:"#dd6b20" },
  { id:"nekoposu",           name:"ネコポス",               icon:"🐱", color:"#d69e2e" },
  { id:"yupacket_plus",      name:"ゆうパケットプラス",      icon:"📦", color:"#38a169" },
  { id:"mercari",            name:"メルカリ便",             icon:"🛍", color:"#2b6cb0" },
  { id:"size60",             name:"60cm発送",               icon:"📫", color:"#6b46c1" },
  { id:"other",              name:"その他",                 icon:"📋", color:"#718096" },
];
// メンバーが登録できる発送方法
const MEMBER_SHIPPING_METHODS = ["nekoposu","yupacket_plus","size60"];
const UNIT_PRESETS = ["個","枚","本","冊","箱","袋","缶","kg","g","L","ml","セット","台","足"];
function genId()  { return Math.random().toString(36).slice(2)+Date.now().toString(36); }
function tsToStr(ts) {
  if (!ts) return "";
  if (ts.toDate) return ts.toDate().toLocaleString("ja-JP",{hour12:false});
  return String(ts);
}


// ═══════════════════════════════════════════════════════════════════
// EXCEL EXPORT (CSV形式 - Excelで開ける)
// ═══════════════════════════════════════════════════════════════════
function exportToExcel(rows, filename) {
  const headers = ["ラベル","商品名","年月日時","個数","ジャンル","メンバー名","金額(円)","読込日時"];
  const csvRows = [headers, ...rows.map(r => [
    r.label||"", r.productName||"", r.datetime||"", r.quantity||"",
    r.genre||"", r.memberName||"", r.amount||"", r.readAt||""
  ])];
  const bom = "\uFEFF";
  const csv = bom + csvRows.map(row => row.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// 発送方法バッジコンポーネント
function ShippingBadge({ methodId, size="sm" }) {
  const m = methodId ? SHIPPING_METHODS.find(sm=>sm.id===methodId) : null;
  if (!m) return null;
  if (size === "sm") return (
    <span style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:9,fontWeight:600,padding:"1px 7px",borderRadius:20,background:m.color+"20",color:m.color,marginBottom:3}}>
      {m.icon} {m.name}
    </span>
  );
  return (
    <span style={{fontSize:11,padding:"2px 10px",borderRadius:20,fontWeight:700,background:m.color+"20",color:m.color,border:"1px solid "+m.color+"50",display:"inline-flex",alignItems:"center",gap:4}}>
      <span>{m.icon}</span>{m.name}
    </span>
  );
}


// ═══════════════════════════════════════════════════════════════════
// 画像圧縮（Firestore 1MB制限対策）
// ═══════════════════════════════════════════════════════════════════
function compressImage(dataUrl, maxWidth=600, quality=0.65) {
  return new Promise(resolve => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ═══════════════════════════════════════════════════════════════════
// 画像拡大モーダル（共通）
// ═══════════════════════════════════════════════════════════════════
function ImageZoom({ src, onClose, title="" }) {
  if (!src) return null;
  return (
    <div
      onClick={onClose}
      style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.97)",zIndex:9999,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:12}}
    >
      <div onClick={e=>e.stopPropagation()} style={{display:"flex",flexDirection:"column",alignItems:"center",width:"100%",maxWidth:600}}>
        {title&&<p style={{fontSize:13,fontWeight:700,color:"#fff",marginBottom:10,textAlign:"center"}}>{title}</p>}
        <div style={{background:"#fff",borderRadius:12,padding:8,width:"min(92vw,92vh)",height:"min(92vw,92vh)",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <img src={src} style={{width:"100%",height:"100%",objectFit:"contain"}}/>
        </div>
        <button onClick={onClose} style={{marginTop:16,padding:"12px 48px",background:"#fff",color:"#000",border:"none",borderRadius:30,fontSize:15,fontWeight:700,cursor:"pointer"}}>
          ✕ 閉じる
        </button>
      </div>
    </div>
  );
}

// タッチ/クリックで拡大できる画像
function ZoomableImage({ src, style={}, label="" }) {
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <img
        src={src}
        style={{...style, cursor:"zoom-in"}}
        onClick={()=>setOpen(true)}
        title="タップで拡大"
      />
      {open&&<ImageZoom src={src} onClose={()=>setOpen(false)} title={label}/>}
    </>
  );
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
        <h2 style={{fontFamily:"'Sora',sans-serif",fontSize:22,fontWeight:700,marginBottom:8,color:C.text}}>Firebase未接続</h2>
        <p style={{color:C.muted,fontSize:14,lineHeight:1.8,marginBottom:20}}>
          <strong style={{color:C.accent}}>SETUP.md</strong> の手順に従って<br/>
          上部の firebaseConfig を書き換えてください。
        </p>
        {["Firebase Console でプロジェクト作成","Firestore Database を有効化（テストモード）","ウェブアプリを登録して config をコピー","App.jsx 上部の YOUR_〜 を書き換え","SETUP.md の手順で初期メンバーデータを投入"].map((s,i)=>(
          <div key={i} style={{background:C.surface2,borderRadius:8,padding:"10px 14px",marginBottom:6,textAlign:"left",fontSize:13,color:C.muted,display:"flex",gap:10,alignItems:"center"}}>
            <span style={{color:C.accent,fontWeight:700,fontFamily:"'Sora',sans-serif",minWidth:18}}>{i+1}</span>
            <span>{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [loading,  setLoading]  = useState(true);
  const [user,     setUser]     = useState(null);
  const [members,  setMembers]  = useState([]);
  const [appMode,  setAppMode]  = useState("inventory");
  const [toast,    setToast]    = useState(null);
  const [notices,  setNotices]  = useState([]);
  const [showBell, setShowBell] = useState(false);
  const [invItems, setInvItems] = useState([]);
  const [invHist,  setInvHist]  = useState([]);
  const [qrItems,  setQrItems]  = useState([]);
  const [qrLog,    setQrLog]    = useState([]);
  const [soldImageMap, setSoldImageMap] = useState({});

  if (!IS_CONFIGURED) return <SetupScreen />;

  useEffect(() => {
    const unsubs = [];
    unsubs.push(onSnapshot(collection(db,"members"), snap => {
      setMembers(snap.docs.map(d=>({id:d.id,...d.data()})));
      setLoading(false);
    }));
    unsubs.push(onSnapshot(query(collection(db,"inv_items"),orderBy("createdAt","desc")), snap =>
      setInvItems(snap.docs.map(d=>({id:d.id,...d.data()})))
    ));
    unsubs.push(onSnapshot(query(collection(db,"inv_history"),orderBy("createdAt","desc"),limit(300)), snap =>
      setInvHist(snap.docs.map(d=>({id:d.id,...d.data()})))
    ));
    unsubs.push(onSnapshot(query(collection(db,"qr_items"),orderBy("uploadedAt","desc")), snap =>
      setQrItems(snap.docs.map(d=>({id:d.id,...d.data()})))
    ));
    unsubs.push(onSnapshot(query(collection(db,"qr_log"),orderBy("createdAt","desc"),limit(200)), snap =>
      setQrLog(snap.docs.map(d=>({id:d.id,...d.data()})))
    ));
    unsubs.push(onSnapshot(query(collection(db,"notices"),orderBy("createdAt","desc"),limit(100)), snap =>
      setNotices(snap.docs.map(d=>({id:d.id,...d.data()})))
    ));
    // sold_images監視（画像を別コレクションに保存）
    const soldUnsub = onSnapshot(
      collection(db,"sold_images"),
      snap => {
        const map = {};
        snap.docs.forEach(d=>{ if(d.data().imageData) map[d.id]=d.data().imageData; });
        setSoldImageMap(map);
      },
      err => console.warn("sold_images:", err.code)
    );
    unsubs.push(soldUnsub);
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

      {/* ── Header ── */}
      <header style={{background:`${C.surface}f0`,backdropFilter:"blur(12px)",borderBottom:`1px solid ${C.border}`,padding:"0 16px",height:54,display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:50}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{display:"flex",gap:2,background:C.surface2,borderRadius:10,padding:3,border:`1px solid ${C.border}`}}>
            {[{id:"inventory",icon:"🗃",label:"在庫管理"},{id:"qr",icon:"📷",label:"QR発送"},{id:"sales",icon:"💰",label:"売上"}].map(m=>(
              <button key={m.id} onClick={()=>setAppMode(m.id)} style={{padding:"5px 12px",borderRadius:7,border:"none",background:appMode===m.id?C.accent:"transparent",color:appMode===m.id?"#fff":C.muted,fontSize:12,fontWeight:appMode===m.id?700:400,display:"flex",alignItems:"center",gap:5,transition:"all 0.15s"}}>
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

      <main style={{maxWidth:860,margin:"0 auto",padding:16}}>
        {appMode==="inventory"&&<InventoryApp items={invItems} history={invHist} members={members} user={user} isMaster={isMaster} showToast={showToast} addNotice={addNotice}/>}
        {appMode==="qr"&&<QRApp qrItems={qrItems} qrLog={qrLog} members={members} user={user} isMaster={isMaster} showToast={showToast} addNotice={addNotice} invItems={invItems} invHist={invHist} soldImageMap={soldImageMap}/>}
        {appMode==="sales"&&<SalesApp qrItems={qrItems} members={members} user={user} isMaster={isMaster}/>}
      </main>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════════
function LoginScreen({ members, onLogin }) {
  const [name,setName]=useState("");
  const [pw,  setPw]  =useState("");
  const [err, setErr] =useState("");
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
          <h1 style={{fontFamily:"'Sora',sans-serif",fontSize:22,fontWeight:700,marginBottom:6,color:C.text}}>在庫 & QR管理</h1>
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
        <button onClick={doLogin} style={{width:"100%",padding:"13px",background:`linear-gradient(135deg,${C.accent},#1a4fa0)`,color:"#fff",border:"none",borderRadius:12,fontSize:15,fontWeight:700,boxShadow:"0 4px 16px rgba(47,129,247,0.4)"}}>
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
  const icon ={operation:"👤",lowstock:"⚠️",empty:"🚨",qr_save:"✅",qr_lock:"🔒"};
  const color={operation:C.purple,lowstock:C.orange,empty:C.red,qr_save:C.green,qr_lock:C.accent};
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
// ▌ INVENTORY APP
// ═══════════════════════════════════════════════════════════════════
function InventoryApp({ items, history, members, user, isMaster, showToast, addNotice }) {
  const [page,   setPage]   = useState("home");
  const [selItem,setSelItem]= useState(null);
  const [modal,  setModal]  = useState(null);
  // メンバーには公開設定された商品のみ表示
  const visibleItems = isMaster ? items : items.filter(i => !i.visibleTo || i.visibleTo.length===0 || i.visibleTo.includes(user.name));

  const changeQty = useCallback(async (item, delta) => {
    const newQty = Math.max(0, item.qty+delta);
    await updateDoc(doc(db,"inv_items",item.id),{qty:newQty});
    await addDoc(collection(db,"inv_history"),{userId:user.id,userName:user.name,role:user.role,itemId:item.id,itemName:item.name,delta,before:item.qty,after:newQty,createdAt:serverTimestamp()});
    if (user.role==="member"&&delta<0) await addNotice("operation",`${user.name} が「${item.name}」を ${Math.abs(delta)}${item.unit} 使用（残:${newQty}${item.unit}）`,"master");
    if (newQty<=item.minAlert&&item.qty>item.minAlert) await addNotice("lowstock",`⚠️「${item.name}」在庫が少なくなりました（残:${newQty}${item.unit}）`,"all");
    if (newQty===0&&item.qty>0) await addNotice("empty",`🚨「${item.name}」の在庫がなくなりました！`,"all");
    showToast(delta>0?`${item.name} +${delta}`:` ${item.name} ${Math.abs(delta)}${item.unit} 使用`,delta>0?C.green:C.red);
  },[user,showToast,addNotice]);

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
  const [search,setSearch]=useState("");
  const [sortBy,setSortBy]=useState("category");
  const [cat,   setCat]   =useState("すべて");
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
  return (
    <div style={{background:C.surface,borderRadius:14,overflow:"hidden",border:`1px solid ${bc}`}}>
      <div onClick={onSelect} style={{width:"100%",aspectRatio:"4/3",cursor:"pointer",background:item.image?`url(${item.image}) center/cover`:C.surface2,display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
        {!item.image&&<span style={{fontSize:34,opacity:0.2}}>📦</span>}
        {empty&&<div style={{position:"absolute",top:7,right:7,background:C.red,color:"#fff",fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:20}}>在庫ゼロ</div>}
        {!empty&&low&&<div style={{position:"absolute",top:7,right:7,background:C.orange,color:"#fff",fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:20}}>要補充</div>}
      </div>
      <div style={{padding:"10px 10px 12px"}}>
        <p onClick={onSelect} style={{fontSize:13,fontWeight:700,cursor:"pointer",marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</p>
        <ShippingBadge methodId={item.shippingMethodId} size="sm"/>
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
            <ShippingBadge methodId={item.shippingMethodId} size="lg"/>
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

      {/* 発送方法 */}
      <div style={{marginBottom:12}}>
        <label style={labelS}>発送方法（メンバーに表示される）</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
          <button type="button" onClick={()=>setShippingMethodId("")} style={{padding:"4px 12px",fontSize:11,border:`1px solid ${!shippingMethodId?C.accent:C.border}`,borderRadius:20,background:!shippingMethodId?C.accentDim:C.surface2,color:!shippingMethodId?C.accent:C.muted}}>
            設定なし
          </button>
          {SHIPPING_METHODS.map(m=>(
            <button type="button" key={m.id} onClick={()=>setShippingMethodId(m.id)} style={{padding:"4px 12px",fontSize:11,border:`1px solid ${shippingMethodId===m.id?m.color:C.border}`,borderRadius:20,background:shippingMethodId===m.id?m.color+"20":C.surface2,color:shippingMethodId===m.id?m.color:C.muted,display:"flex",alignItems:"center",gap:4}}>
              <span>{m.icon}</span>{m.name}
            </button>
          ))}
        </div>
      </div>

      <div style={{marginBottom:12}}>
        <label style={labelS}>公開するメンバー（未選択 = 全員に公開）</label>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
          {members.filter(m=>m.role==="member").map(m=>(
            <button key={m.id} type="button" onClick={()=>setVisibleTo(p=>p.includes(m.name)?p.filter(n=>n!==m.name):[...p,m.name])}
              style={{padding:"4px 12px",fontSize:12,border:`1px solid ${visibleTo.includes(m.name)?C.accent:C.border}`,borderRadius:20,background:visibleTo.includes(m.name)?C.accentDim:C.surface2,color:visibleTo.includes(m.name)?C.accent:C.muted,cursor:"pointer"}}>
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
// ▌ QR APP
// ═══════════════════════════════════════════════════════════════════
function QRApp({ qrItems, qrLog, members, user, isMaster, showToast, addNotice, invItems=[], invHist=[], soldImageMap={} }) {
  const [tab,        setTab]        = useState("unread");
  const [selectedItem,setSelected]  = useState(null);

  // 表示できるQRを絞り込む
  // マスター：全て表示
  // メンバー：自分登録分 + マスター登録(全員 or 自分指定) のみ
  const visibleQRs = isMaster
    ? qrItems
    : qrItems.filter(i=>{
        // マスター登録：全員向け or 自分指定のみ表示（未読み込みも読み込み済みも）
        if (!i.registeredBy || i.registeredRole==="master") {
          return !i.assignedMember || i.assignedMember===user.name;
        }
        // メンバー登録：自分が登録したもののみ
        return i.registeredBy===user.name;
      });
  const unreadItems  = visibleQRs.filter(i=>i.status==="unread");
  const myReadItems  = visibleQRs.filter(i=>i.status==="read"&&i.formData?.memberName===user.name);
  const allReadItems = visibleQRs.filter(i=>i.status==="read");
  const myInvItems   = isMaster ? invItems : invItems.filter(i=>!i.visibleTo||i.visibleTo.length===0||i.visibleTo.includes(user.name));

  async function handleSelect(item) {
    if (item.lockedBy&&item.lockedBy!==user.name) return;
    // 使用メンバー指定がある場合、指定メンバーとマスターのみ選択可
    if (item.assignedMember&&item.assignedMember!==user.name&&!isMaster) {
      showToast(`このQRコードは ${item.assignedMember} 専用です`, C.red);
      return;
    }
    await updateDoc(doc(db,"qr_items",item.id),{lockedBy:user.name});
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"選択",detail:`QR選択: ${item.label}`,createdAt:serverTimestamp()});
    setSelected({...item,lockedBy:user.name});
  }
  async function handleSave(formData) {
    const readAt = new Date().toLocaleString("ja-JP",{hour12:false});
    // soldImageを別コレクションに分けて保存（Firestoreの1MB制限回避）
    const {soldImage, ...formDataWithoutImage} = formData;
    if (soldImage) {
      // 圧縮してsold_imagesコレクションに保存（IDはqrItemIdと同じ）
      const compressed = await compressImage(soldImage, 500, 0.6);
      await setDoc(doc(db,"sold_images",selectedItem.id), {
        imageData: compressed,
        memberName: formData.memberName,
        createdAt: serverTimestamp()
      });
    }
    await updateDoc(doc(db,"qr_items",selectedItem.id),{
      status:"read", lockedBy:null,
      formData: formDataWithoutImage,
      readAt: serverTimestamp()
    });
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"保存",detail:`保存: ${selectedItem.label} / ${formData.productName}`,createdAt:serverTimestamp()});
    await addNotice("qr_save",`${user.name} が「${selectedItem.label}」を読み込み完了しました`,"master");
    // 自動Excelエクスポート
    exportToExcel([{
      label:selectedItem.label,
      productName:formData.productName,
      datetime:formData.datetime,
      quantity:formData.quantity,
      genre:formData.genre,
      memberName:formData.memberName,
      amount:formData.amount,
      readAt
    }], `QR_${formData.memberName}_${readAt.replace(/[/:]/g,"-")}.csv`);
    showToast("保存＆Excelダウンロード完了 ✅",C.green);
    setSelected(null);
    setTab(isMaster?"read":"myread");
  }
  async function handleCancel() {
    await updateDoc(doc(db,"qr_items",selectedItem.id),{lockedBy:null});
    setSelected(null);
  }
  async function handleDelete(item) {
    if (!confirm("このQRコードを削除しますか？"))return;
    await deleteDoc(doc(db,"qr_items",item.id));
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"削除",detail:`QR削除: ${item.label}`,createdAt:serverTimestamp()});
    showToast("削除しました",C.red);
  }
  async function handleRelease(item) {
    await updateDoc(doc(db,"qr_items",item.id),{lockedBy:null});
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"ロック解除",detail:`強制解除: ${item.label}`,createdAt:serverTimestamp()});
    showToast("ロックを解除しました",C.orange);
  }
  async function handleShipDelete(item) {
    await deleteDoc(doc(db,"qr_items",item.id));
    // sold_imagesも削除
    try { await deleteDoc(doc(db,"sold_images",item.id)); } catch(e) {}
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"発送完了削除",detail:`削除: ${item.label}`,createdAt:serverTimestamp()});
    showToast("削除しました",C.red);
  }
  async function handleShip(item) {
    const memberName = item.formData?.memberName||"";
    await updateDoc(doc(db,"qr_items",item.id),{status:"shipped",shippedAt:serverTimestamp()});
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"発送完了",detail:`発送完了: ${item.label} / ${item.formData?.productName||""}`,createdAt:serverTimestamp()});
    // マスターに通知
    await addNotice("shipping",`🚚「${item.label}」が発送完了になりました（読込: ${memberName}）`,"master");
    // 読み込んだメンバーにも通知
    if (memberName) {
      await addNotice("shipping",`🚚「${item.label}」が発送完了になりました`,"all");
    }
    showToast("発送完了にしました 🚚",C.green);
  }

  if (selectedItem) return <QRFormView item={selectedItem} user={user} onSave={handleSave} onCancel={handleCancel} invItems={myInvItems} invHistory={invHist}/>;

  const shippedItems = visibleQRs.filter(i=>i.status==="shipped");
  const masterTabs=[
    {id:"upload", label:"QR登録",   cnt:null},
    {id:"unread", label:"未読み込み", cnt:unreadItems.length},
    {id:"read",   label:"読み込み済", cnt:allReadItems.length},
    {id:"shipped",label:"発送完了",  cnt:shippedItems.length},
    {id:"log",    label:"操作ログ",  cnt:null},
  ];
  const myShippedItems = visibleQRs.filter(i=>i.status==="shipped"&&i.formData?.memberName===user.name);
  const memberTabs=[
    {id:"upload",   label:"QR登録",    cnt:null},
    {id:"unread",   label:"未読み込み", cnt:unreadItems.length},
    {id:"myread",   label:"読み込み済", cnt:myReadItems.length},
    {id:"myshipped",label:"発送完了",   cnt:myShippedItems.length},
  ];
  const tabs=isMaster?masterTabs:memberTabs;

  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",gap:2,marginBottom:14,background:C.surface,borderRadius:12,padding:4,border:`1px solid ${C.border}`,flexWrap:"wrap"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,padding:"8px 6px",borderRadius:8,border:"none",minWidth:80,background:tab===t.id?C.surface2:"transparent",color:tab===t.id?C.text:C.muted,fontSize:12,fontWeight:tab===t.id?700:400,display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
            {t.label}
            {t.cnt!==null&&<span style={{background:tab===t.id?C.accent:C.surface2,color:tab===t.id?"#fff":C.muted,fontSize:10,fontWeight:700,padding:"1px 7px",borderRadius:20,border:`1px solid ${C.border}`}}>{t.cnt}</span>}
          </button>
        ))}
      </div>

      {tab==="upload"&&<QRUploader qrItems={qrItems} user={user} showToast={showToast} isMaster={isMaster} members={members}/>}
      {tab==="unread"&&<QRList items={unreadItems} user={user} isMaster={isMaster} onSelect={handleSelect} onDelete={handleDelete} onRelease={handleRelease} members={members}/>}
      {tab==="read"&&isMaster&&<QRList items={allReadItems} user={user} isMaster={isMaster} readOnly onDelete={handleDelete} onRelease={handleRelease} members={members} onShip={handleShip} soldImageMap={soldImageMap}/>}
      {tab==="shipped"&&isMaster&&<ShippedList items={shippedItems} soldImageMap={soldImageMap} isMaster={isMaster} members={members} onDelete={handleShipDelete}/>}
      {tab==="myread"&&!isMaster&&<QRReadList items={myReadItems} soldImageMap={soldImageMap}/>}
      {tab==="myshipped"&&!isMaster&&<ShippedList items={myShippedItems} soldImageMap={soldImageMap}/>}
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

function QRUploader({ qrItems, user, showToast, isMaster, members=[] }) {
  const [label,       setLabel]      = useState("");
  const [catInput,    setCatInput]   = useState("");
  const [showCats,    setShowCats]   = useState(false);
  const [preview,     setPreview]    = useState(null);
  const [imgData,     setImgData]    = useState(null);
  const [uploading,   setUploading]  = useState(false);
  const [assignedTo,  setAssignedTo] = useState("all"); // "all" or メンバー名
  const fileRef = useRef();

  // メンバーは指定発送方法のみ表示
  const availableMethods = isMaster
    ? SHIPPING_METHODS
    : SHIPPING_METHODS.filter(m=>MEMBER_SHIPPING_METHODS.includes(m.id));

  // 既存QRから取得したカテゴリ一覧
  const existingCats = [...new Set(qrItems.map(i=>i.category).filter(Boolean))].sort();
  const filteredCats = existingCats.filter(c=>c.toLowerCase().includes(catInput.toLowerCase())&&c!==catInput);
  const memberList = members.filter(m=>m.role==="member");

  function handleFile(e) {
    const file=e.target.files[0]; if(!file)return;
    const r=new FileReader();
    r.onload=ev=>{setPreview(ev.target.result);setImgData(ev.target.result);};
    r.readAsDataURL(file);
  }

  async function upload() {
    if (!imgData){showToast("QR画像をアップロードしてください",C.red);return;}
    setUploading(true);
    const lbl = label||`QR-${Date.now()}`;
    const cat = catInput.trim()||"未分類";
    await addDoc(collection(db,"qr_items"),{
      label:lbl, category:cat,
      imageData:imgData, status:"unread",
      lockedBy:null, formData:null,
      linkedItemId:null,
      registeredBy:user.name,
      registeredRole:user.role,
      assignedTo: assignedTo==="all" ? null : assignedTo,
      uploadedAt:serverTimestamp()
    });
    await addDoc(collection(db,"qr_log"),{userName:user.name,action:"QR登録",detail:`登録: ${lbl} [${cat}]`,createdAt:serverTimestamp()});
    showToast(`「${lbl}」を登録しました`);
    setLabel(""); setCatInput(""); setPreview(null); setImgData(null);
    if(fileRef.current) fileRef.current.value="";
    setUploading(false);
  }

  return (
    <div>
      <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:20,marginBottom:12}}>
        <h3 style={{fontSize:15,fontWeight:700,marginBottom:14}}>QRコード登録</h3>

        {/* 画像アップロード */}
        <div style={{border:`2px dashed ${C.border}`,borderRadius:12,padding:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",marginBottom:14,minHeight:140,background:C.surface2}}
          onClick={()=>fileRef.current?.click()}
          onDragOver={e=>e.preventDefault()}
          onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f){const ev={target:{files:[f]}};handleFile(ev);}}}>
          {preview
            ?<img src={preview} style={{maxHeight:160,maxWidth:"100%",borderRadius:8}}/>
            :<div style={{textAlign:"center"}}><div style={{fontSize:36,marginBottom:8}}>📷</div><p style={{color:C.muted,fontSize:13}}>クリックまたはドラッグでアップロード</p></div>
          }
        </div>
        <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{display:"none"}}/>

        {/* ラベル名 */}
        <div style={{marginBottom:14}}>
          <label style={labelS}>ラベル名</label>
          <input value={label} onChange={e=>setLabel(e.target.value)} style={inputS} placeholder="例: 荷物001（空白の場合は自動生成）"/>
        </div>

        {/* メンバー指定（マスターのみ） */}
        {isMaster&&memberList.length>0&&(
          <div style={{marginBottom:14}}>
            <label style={labelS}>使用メンバー指定</label>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:4}}>
              <button type="button" onClick={()=>setAssignedTo("all")} style={{padding:"5px 14px",fontSize:12,border:`1px solid ${assignedTo==="all"?C.accent:C.border}`,borderRadius:20,background:assignedTo==="all"?C.accentDim:C.surface2,color:assignedTo==="all"?C.accent:C.muted,fontWeight:assignedTo==="all"?700:400}}>
                全員
              </button>
              {memberList.map(m=>(
                <button type="button" key={m.id} onClick={()=>setAssignedTo(m.name)} style={{padding:"5px 14px",fontSize:12,border:`1px solid ${assignedTo===m.name?C.green:C.border}`,borderRadius:20,background:assignedTo===m.name?C.greenDim:C.surface2,color:assignedTo===m.name?C.green:C.muted,fontWeight:assignedTo===m.name?700:400}}>
                  👤 {m.name}
                </button>
              ))}
            </div>
            {assignedTo!=="all"&&<p style={{fontSize:11,color:C.green,marginTop:4}}>✓ {assignedTo} 専用のQRコードとして登録されます</p>}
          </div>
        )}

        {/* カテゴリ */}
        <div style={{marginBottom:16,position:"relative"}}>
          <label style={labelS}>カテゴリ ★</label>
          <input
            value={catInput}
            onChange={e=>{setCatInput(e.target.value);setShowCats(true);}}
            onFocus={()=>setShowCats(true)}
            onBlur={()=>setTimeout(()=>setShowCats(false),160)}
            style={inputS}
            placeholder="例: ゆうパケットポスト、ネコポス"
          />
          {/* サジェスト */}
          {showCats&&filteredCats.length>0&&(
            <div style={{position:"absolute",top:"100%",left:0,right:0,background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,zIndex:100,boxShadow:"0 8px 24px rgba(0,0,0,0.4)",overflow:"hidden"}}>
              {filteredCats.map(c=>(
                <div key={c} onMouseDown={()=>{setCatInput(c);setShowCats(false);}} style={{padding:"9px 14px",cursor:"pointer",fontSize:13,borderBottom:`1px solid ${C.border}`,color:C.text}} onMouseEnter={e=>e.currentTarget.style.background=C.surface2} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>{c}</div>
              ))}
            </div>
          )}
          {/* 発送方法クイック選択 */}
          <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:8}}>
            {availableMethods.map(m=>(
              <button key={m.id} onClick={()=>setCatInput(m.name)} style={{padding:"4px 11px",fontSize:11,border:`1px solid ${catInput===m.name?m.color:C.border}`,borderRadius:20,background:catInput===m.name?m.color+"20":C.surface2,color:catInput===m.name?m.color:C.muted,display:"flex",alignItems:"center",gap:4,fontWeight:catInput===m.name?700:400}}>
                <span>{m.icon}</span>{m.name}
              </button>
            ))}
          </div>
          {!isMaster&&<p style={{fontSize:11,color:C.muted,marginTop:6}}>※ メンバーはネコポス・ゆうパケットプラス・60cm発送のみ登録できます</p>}

        </div>

        <button onClick={upload} disabled={!imgData||uploading} style={{padding:"11px 24px",background:imgData?C.accent:C.surface2,color:imgData?"#fff":C.faint,border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:imgData?"pointer":"not-allowed"}}>
          {uploading?"登録中...":"📦 登録する"}
        </button>
      </div>

      {/* 登録済み一覧 - マスターのみ表示 */}
      {isMaster&&<div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:20}}>
        <h4 style={{fontSize:13,fontWeight:700,color:C.muted,marginBottom:10}}>登録済み ({qrItems.length}件)</h4>
        <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:220,overflowY:"auto"}}>
          {qrItems.map(item=>(
            <div key={item.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:C.surface2,borderRadius:10,border:`1px solid ${C.border}`}}>
              <img src={item.imageData} style={{width:40,height:40,objectFit:"contain",borderRadius:6,background:"#fff",padding:2}}/>
              <div style={{flex:1,minWidth:0}}>
                <p style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.label}</p>
                {item.category&&<p style={{fontSize:10,color:C.accent}}>{item.category}</p>}
                <p style={{fontSize:10,color:C.muted}}>{tsToStr(item.uploadedAt)}</p>
              </div>
              <span style={{fontSize:11,fontWeight:600,padding:"2px 9px",borderRadius:20,background:item.status==="read"?C.greenDim:C.surface,color:item.status==="read"?C.green:C.muted,border:`1px solid ${item.status==="read"?C.greenBorder:C.border}`,whiteSpace:"nowrap"}}>{item.status==="read"?"✅ 済":"⏳ 未"}</span>
            </div>
          ))}
        </div>
      </div>}
    </div>
  );
}

function QRList({ items, user, isMaster, onSelect, onDelete, onRelease, readOnly=false, members=[], onShip=null, soldImageMap={} }) {
  const [filterCat,    setFilterCat]    = useState("すべて");
  const [filterMember, setFilterMember] = useState("すべて");
  const cats = ["すべて",...new Set(items.map(i=>i.category).filter(Boolean))].sort();
  const memberNames = ["すべて",...new Set(items.map(i=>i.assignedTo||i.registeredBy).filter(Boolean))].sort();
  const filtered = items
    .filter(i=>filterCat==="すべて"||i.category===filterCat)
    .filter(i=>filterMember==="すべて"||(i.assignedTo===filterMember||i.registeredBy===filterMember));
  const [editId,    setEditId]    = useState(null);
  const [editLabel, setEditLabel] = useState("");
  const [editCat,   setEditCat]   = useState("");
  const [editMember,setEditMember]= useState("");

  async function saveEdit(itemId) {
    await updateDoc(doc(db,"qr_items",itemId),{
      label:   editLabel.trim()||"QR",
      category:editCat.trim()||"未分類",
      assignedMember: editMember||null,
    });
    setEditId(null);
  }

  if (!items.length) return <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:40,textAlign:"center"}}><p style={{color:C.muted}}>該当するQRコードはありません</p></div>;
  return (
    <div>
      {/* マスター編集モーダル */}
      {editId&&isMaster&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div onClick={e=>e.stopPropagation()} style={{background:C.surface,borderRadius:20,padding:24,width:"100%",maxWidth:400,border:`1px solid ${C.border}`,boxShadow:"0 24px 64px rgba(0,0,0,0.6)"}}>
            <h3 style={{fontSize:16,fontWeight:700,marginBottom:16}}>✏️ QRコードを編集</h3>
            <div style={{marginBottom:12}}>
              <label style={labelS}>ラベル名</label>
              <input value={editLabel} onChange={e=>setEditLabel(e.target.value)} style={inputS} placeholder="例: 荷物001"/>
            </div>
            <div style={{marginBottom:12}}>
              <label style={labelS}>カテゴリ</label>
              <input value={editCat} onChange={e=>setEditCat(e.target.value)} style={inputS} placeholder="例: ゆうパケットポスト"/>
              <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:6}}>
                {SHIPPING_METHODS.map(m=>(
                  <button key={m.id} type="button" onClick={()=>setEditCat(m.name)} style={{padding:"3px 10px",fontSize:11,border:`1px solid ${editCat===m.name?m.color:C.border}`,borderRadius:20,background:editCat===m.name?m.color+"20":C.surface2,color:editCat===m.name?m.color:C.muted,display:"flex",alignItems:"center",gap:4,cursor:"pointer"}}>
                    <span>{m.icon}</span>{m.name}
                  </button>
                ))}
              </div>
            </div>
            <div style={{marginBottom:16}}>
              <label style={labelS}>使用メンバー指定（任意）</label>
              <select value={editMember} onChange={e=>setEditMember(e.target.value)} style={inputS}>
                <option value="">指定なし（全員が使用可）</option>
                {members.filter(m=>m.role==="member").map(m=>(
                  <option key={m.id} value={m.name}>{m.name}</option>
                ))}
              </select>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button type="button" onClick={()=>setEditId(null)} style={{flex:1,padding:"11px",background:C.surface2,border:`1px solid ${C.border}`,borderRadius:10,fontSize:14,color:C.muted,cursor:"pointer"}}>キャンセル</button>
              <button type="button" onClick={()=>saveEdit(editId)} style={{flex:2,padding:"11px",background:C.accent,color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer"}}>保存する</button>
            </div>
          </div>
        </div>
      )}
      {/* カテゴリフィルター */}
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
        {cats.map(c=>(
          <button key={c} onClick={()=>setFilterCat(c)} style={{padding:"4px 12px",fontSize:11,border:`1px solid ${filterCat===c?C.accent:C.border}`,borderRadius:20,background:filterCat===c?C.accentDim:C.surface2,color:filterCat===c?C.accent:C.muted,fontWeight:filterCat===c?700:400}}>
            {c} {c!=="すべて"&&`(${items.filter(i=>i.category===c).length})`}
          </button>
        ))}
      </div>
      {/* メンバーフィルター */}
      {memberNames.length>1&&(
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
          {memberNames.map(m=>(
            <button key={m} onClick={()=>setFilterMember(m)} style={{padding:"3px 10px",fontSize:11,border:`1px solid ${filterMember===m?C.green:C.border}`,borderRadius:20,background:filterMember===m?C.greenDim:C.surface2,color:filterMember===m?C.green:C.muted,fontWeight:filterMember===m?700:400,display:"flex",alignItems:"center",gap:3}}>
              {m!=="すべて"&&"👤"} {m}
            </button>
          ))}
        </div>
      )}
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {filtered.map(item=>{
        const isLockedByOther=item.lockedBy&&item.lockedBy!==user?.name;
        const isLockedByMe=item.lockedBy===user?.name;
        return (
          <div key={item.id} style={{background:C.surface,borderRadius:14,border:`1px solid ${isLockedByOther?C.redBorder:isLockedByMe?C.orangeBorder:C.border}`,padding:16,opacity:isLockedByOther?0.6:1,transition:"opacity 0.2s"}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <ZoomableImage src={item.imageData} style={{width:52,height:52,objectFit:"contain",borderRadius:8,background:"#fff",padding:3,flexShrink:0}} label={item.label}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:2}}>
                  <p style={{fontWeight:700,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.label}</p>
                  {item.category&&<span style={{fontSize:10,fontWeight:600,padding:"1px 7px",borderRadius:20,background:C.accentDim,color:C.accent,border:`1px solid ${C.accentBorder}`,whiteSpace:"nowrap",flexShrink:0}}>{item.category}</span>}
                  {item.assignedMember&&isMaster&&<span style={{fontSize:10,fontWeight:600,padding:"1px 7px",borderRadius:20,background:C.purpleDim,color:C.purple,border:`1px solid ${C.purpleBorder}`,whiteSpace:"nowrap",flexShrink:0}}>👤 {item.assignedMember}</span>}
                </div>
                <p style={{fontSize:11,color:C.muted}}>{tsToStr(item.uploadedAt)}</p>
                {isLockedByOther&&<p style={{fontSize:11,color:C.red,marginTop:2}}>🔒 {item.lockedBy} が使用中</p>}
                {isLockedByMe&&<p style={{fontSize:11,color:C.orange,marginTop:2}}>✏️ あなたが選択中</p>}
                {item.status==="read"&&item.formData?.memberName&&<p style={{fontSize:11,color:C.green,marginTop:2}}>✅ {item.formData.memberName} が読み込み済</p>}
              {item.status==="read"&&soldImageMap[item.id]&&(
                <div style={{marginTop:6}}>
                  <ZoomableImage src={soldImageMap[item.id]} style={{maxHeight:60,maxWidth:120,borderRadius:6,objectFit:"contain",background:C.surface2}} label="売れた商品"/>
                </div>
              )}
                {item.registeredBy&&isMaster&&item.registeredRole!=="master"&&<p style={{fontSize:10,color:C.faint,marginTop:1}}>登録: {item.registeredBy}</p>}
                {isMaster&&item.assignedTo&&<p style={{fontSize:10,color:C.green,marginTop:1}}>👤 {item.assignedTo} 専用</p>}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>
                {!readOnly&&onSelect&&<button onClick={()=>onSelect(item)} disabled={isLockedByOther} style={{padding:"7px 14px",background:isLockedByOther?C.surface2:isLockedByMe?C.orangeDim:C.accentDim,color:isLockedByOther?C.faint:isLockedByMe?C.orange:C.accent,border:`1px solid ${isLockedByOther?C.border:isLockedByMe?C.orangeBorder:C.accentBorder}`,borderRadius:8,fontSize:12,fontWeight:700,cursor:isLockedByOther?"not-allowed":"pointer"}}>
                  {isLockedByMe?"再開":"選択"}
                </button>}
                {isMaster&&!readOnly&&isLockedByOther&&<button onClick={()=>onRelease(item)} style={{padding:"5px 10px",background:C.orangeDim,color:C.orange,border:`1px solid ${C.orangeBorder}`,borderRadius:8,fontSize:11}}>🔓 解除</button>}
                {isMaster&&item.status==="unread"&&(
                  <button
                    type="button"
                    onClick={(e)=>{
                      e.stopPropagation();
                      setEditId(item.id);
                      setEditLabel(item.label||"");
                      setEditCat(item.category||"");
                      setEditMember(item.assignedMember||"");
                    }}
                    style={{padding:"5px 10px",background:C.accentDim,color:C.accent,border:`1px solid ${C.accentBorder}`,borderRadius:8,fontSize:11,cursor:"pointer"}}
                  >✏️ 編集</button>
                )}
                {isMaster&&item.status==="read"&&onShip&&(
                  <button
                    type="button"
                    onClick={(e)=>{e.stopPropagation();onShip(item);}}
                    style={{padding:"5px 10px",background:C.greenDim,color:C.green,border:`1px solid ${C.greenBorder}`,borderRadius:8,fontSize:11,fontWeight:700,cursor:"pointer"}}
                  >🚚 発送完了</button>
                )}
                {(isMaster||(item.registeredBy===user?.name&&item.status==="unread"))&&(
                  <button onClick={()=>onDelete(item)} style={{padding:"5px 10px",background:C.redDim,color:C.red,border:`1px solid ${C.redBorder}`,borderRadius:8,fontSize:11}}>
                    {isMaster?"🗑":"🗑"}
                  </button>
                )}
              </div>
            </div>
            {item.formData&&(
              <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${C.border}`,display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {[["商品名",item.formData.productName],["個数",item.formData.quantity],["ジャンル",item.formData.genre],["金額",item.formData.amount?`¥${Number(item.formData.amount).toLocaleString()}`:""]].map(([k,v])=>v&&(
                  <div key={k} style={{background:C.surface2,borderRadius:8,padding:"6px 10px",border:`1px solid ${C.border}`}}>
                    <p style={{fontSize:10,color:C.muted,marginBottom:2}}>{k}</p><p style={{fontSize:13,fontWeight:600}}>{v}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

function ShippedList({ items, soldImageMap={}, isMaster=false, members=[], onDelete=null }) {
  const [deleteId,    setDeleteId]    = useState(null);
  const [pwInput,     setPwInput]     = useState("");
  const [pwError,     setPwError]     = useState("");
  const [deleting,    setDeleting]    = useState(false);

  // マスターのパスワード確認して削除
  async function confirmDelete(item) {
    const master = members.find(m=>m.role==="master");
    if (!master || pwInput !== master.password) {
      setPwError("パスワードが違います");
      return;
    }
    setDeleting(true);
    await onDelete(item);
    setDeleteId(null);
    setPwInput("");
    setPwError("");
    setDeleting(false);
  }

  if (!items.length) return (
    <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:40,textAlign:"center"}}>
      <p style={{color:C.muted}}>発送完了のQRコードはありません</p>
    </div>
  );

  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {/* パスワード確認モーダル */}
      {deleteId&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div onClick={e=>e.stopPropagation()} style={{background:C.surface,borderRadius:20,padding:24,width:"100%",maxWidth:380,border:`1px solid ${C.redBorder}`,boxShadow:"0 24px 64px rgba(0,0,0,0.6)"}}>
            <h3 style={{fontSize:16,fontWeight:700,marginBottom:8,color:C.red}}>🗑 発送完了データを削除</h3>
            <p style={{fontSize:13,color:C.muted,marginBottom:16}}>削除するにはマスターのパスワードを入力してください。</p>
            <div style={{marginBottom:8}}>
              <label style={labelS}>マスターパスワード</label>
              <input
                type="password"
                value={pwInput}
                onChange={e=>{setPwInput(e.target.value);setPwError("");}}
                onKeyDown={e=>e.key==="Enter"&&confirmDelete(items.find(i=>i.id===deleteId))}
                style={inputS}
                placeholder="パスワードを入力"
                autoFocus
              />
              {pwError&&<p style={{fontSize:12,color:C.red,marginTop:4}}>{pwError}</p>}
            </div>
            <div style={{display:"flex",gap:10,marginTop:16}}>
              <button
                type="button"
                onClick={()=>{setDeleteId(null);setPwInput("");setPwError("");}}
                style={{flex:1,padding:"11px",background:C.surface2,border:`1px solid ${C.border}`,borderRadius:10,fontSize:14,color:C.muted,cursor:"pointer"}}
              >キャンセル</button>
              <button
                type="button"
                onClick={()=>confirmDelete(items.find(i=>i.id===deleteId))}
                disabled={!pwInput||deleting}
                style={{flex:1,padding:"11px",background:pwInput?C.red:C.surface2,color:pwInput?"#fff":C.faint,border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:pwInput?"pointer":"not-allowed"}}
              >{deleting?"削除中...":"削除する"}</button>
            </div>
          </div>
        </div>
      )}

      {items.map(item=>(
        <div key={item.id} style={{background:C.surface,borderRadius:14,border:`1px solid ${C.greenBorder}`,padding:16}}>
          {/* ヘッダー */}
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
            <ZoomableImage src={item.imageData} style={{width:52,height:52,objectFit:"contain",borderRadius:8,background:"#fff",padding:3,flexShrink:0}} label={`QR: ${item.label}`}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:2}}>
                <p style={{fontWeight:700,fontSize:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.label}</p>
                {item.category&&<span style={{fontSize:10,fontWeight:600,padding:"1px 7px",borderRadius:20,background:C.accentDim,color:C.accent,border:`1px solid ${C.accentBorder}`,whiteSpace:"nowrap",flexShrink:0}}>{item.category}</span>}
              </div>
              <p style={{fontSize:11,color:C.green,fontWeight:600}}>🚚 発送完了</p>
            </div>
            {/* 削除ボタン（マスターのみ） */}
            {isMaster&&onDelete&&(
              <button
                type="button"
                onClick={()=>{setDeleteId(item.id);setPwInput("");setPwError("");}}
                style={{padding:"6px 12px",background:C.redDim,color:C.red,border:`1px solid ${C.redBorder}`,borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer",flexShrink:0}}
              >🗑 削除</button>
            )}
          </div>

          {/* 売れた商品画像 */}
          {soldImageMap[item.id]&&(
            <div style={{marginBottom:12}}>
              <p style={{fontSize:10,color:C.muted,marginBottom:4}}>売れた商品の画像（タップで拡大）</p>
              <ZoomableImage
                src={soldImageMap[item.id]}
                style={{maxWidth:"100%",maxHeight:140,borderRadius:8,objectFit:"contain",background:C.surface2,display:"block"}}
                label="売れた商品"
              />
            </div>
          )}

          {/* タイムライン */}
          <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12,background:C.surface2,borderRadius:10,padding:"10px 12px",border:`1px solid ${C.border}`}}>
            <p style={{fontSize:10,color:C.muted,fontWeight:700,marginBottom:2}}>タイムライン</p>
            {[
              {icon:"🛒",label:"購入された日時",       val:item.formData?.datetime||"—",  color:C.text},
              {icon:"✅",label:"読み込み済になった日時", val:tsToStr(item.readAt)||"—",     color:C.accent},
              {icon:"🚚",label:"発送完了になった日時",   val:tsToStr(item.shippedAt)||"—",  color:C.green},
            ].map((t,i,arr)=>(
              <div key={t.icon}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:16,flexShrink:0}}>{t.icon}</span>
                  <div>
                    <p style={{fontSize:10,color:C.muted}}>{t.label}</p>
                    <p style={{fontSize:12,fontWeight:600,color:t.color}}>{t.val}</p>
                  </div>
                </div>
                {i<arr.length-1&&<div style={{width:2,height:10,background:C.border,marginLeft:8,marginTop:2}}/>}
              </div>
            ))}
          </div>

          {/* 商品情報 */}
          {item.formData&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {[
                ["商品名",  item.formData.productName],
                ["個数",    item.formData.quantity],
                ["ジャンル",item.formData.genre],
                ["金額",    item.formData.amount?`¥${Number(item.formData.amount).toLocaleString()}`:""],
                ["メンバー",item.formData.memberName],
              ].filter(([,v])=>v).map(([k,v])=>(
                <div key={k} style={{background:C.surface2,borderRadius:8,padding:"6px 10px",border:`1px solid ${C.border}`}}>
                  <p style={{fontSize:10,color:C.muted,marginBottom:2}}>{k}</p>
                  <p style={{fontSize:13,fontWeight:600}}>{v}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}


function QRReadList({ items, soldImageMap={} }) {
  if (!items.length) return (
    <div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:40,textAlign:"center"}}>
      <p style={{color:C.muted}}>まだ読み込み済みはありません</p>
    </div>
  );
  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {items.map(item=>(
        <div key={item.id} style={{background:C.surface,borderRadius:14,border:`1px solid ${C.greenBorder}`,padding:16}}>
          {/* ヘッダー */}
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
            <ZoomableImage src={item.imageData} style={{width:52,height:52,objectFit:"contain",borderRadius:8,background:"#fff",padding:3,flexShrink:0}} label={`QR: ${item.label}`}/>
            <div style={{flex:1}}>
              <p style={{fontWeight:700,fontSize:14}}>{item.label}</p>
              <p style={{fontSize:11,color:C.green,fontWeight:600}}>✅ 読み込み済: {tsToStr(item.readAt)}</p>
            </div>
          </div>
          {/* 売れた商品画像（sold_imagesコレクションから） */}
          {soldImageMap[item.id]&&(
            <div style={{marginBottom:10}}>
              <p style={{fontSize:10,color:C.muted,marginBottom:4}}>売れた商品の画像（タップで拡大）</p>
              <ZoomableImage
                src={soldImageMap[item.id]}
                style={{maxWidth:"100%",maxHeight:140,borderRadius:8,objectFit:"contain",background:C.surface2,display:"block"}}
                label="売れた商品"
              />
            </div>
          )}
          {/* 商品情報 */}
          {item.formData&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {[
                ["商品名",    item.formData.productName],
                ["売れた日時",item.formData.datetime],
                ["個数",      item.formData.quantity],
                ["ジャンル",  item.formData.genre],
                ["金額",      item.formData.amount?`¥${Number(item.formData.amount).toLocaleString()}`:""],
              ].filter(([,v])=>v).map(([k,v])=>(
                <div key={k} style={{background:C.surface2,borderRadius:8,padding:"6px 10px",border:`1px solid ${C.border}`}}>
                  <p style={{fontSize:10,color:C.muted,marginBottom:2}}>{k}</p>
                  <p style={{fontSize:13,fontWeight:600}}>{v}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}


function QRFormView({ item, user, onSave, onCancel, invItems=[], invHistory=[] }) {
  const [showQR,    setShowQR]    = useState(false);
  const [checked,   setChecked]   = useState(false);
  const [selItemId, setSelItemId] = useState("");
  const [soldImage, setSoldImage] = useState(null); // 売れた商品画像
  const [form, setForm] = useState({
    productName:"",
    datetime:new Date().toISOString().slice(0,16), // 売れた時間
    quantity:"",
    genre:"",
    memberName:user.name,
    amount:""
  });
  const fileRef = useRef();

  const selInvItem = invItems.find(i=>i.id===selItemId)||null;
  const shipMethod = selInvItem ? SHIPPING_METHODS.find(m=>m.id===selInvItem.shippingMethodId)||null : null;

  function handleItemSelect(id) {
    setSelItemId(id);
    const it = invItems.find(i=>i.id===id);
    if (!it) return;
    const today = new Date().toDateString();
    const recentMinus = invHistory.filter(h=>
      h.itemId===id && h.userId===user.id && h.delta<0 &&
      (h.createdAt?.toDate?h.createdAt.toDate().toDateString():new Date().toDateString())===today
    );
    const totalMinus = recentMinus.reduce((s,h)=>s+Math.abs(h.delta),0);
    const matchedGenre = GENRES.includes(it.category||"") ? it.category : (it.category?"その他":"");
    setForm(p=>({...p, productName:it.name, quantity:totalMinus||1, genre:matchedGenre}));
  }

  function handleSoldImage(e) {
    const file = e.target.files[0]; if(!file) return;
    const r = new FileReader();
    r.onload = async ev => {
      // プレビューはそのまま表示、保存時は圧縮する
      setSoldImage(ev.target.result);
    };
    r.readAsDataURL(file);
  }

  // 売れた画像があり全項目入力済みでQR表示可能
  const isComplete = form.productName&&form.datetime&&form.quantity&&form.genre&&form.amount&&soldImage;

  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <button onClick={onCancel} style={{padding:"7px 14px",background:C.surface2,border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,color:C.muted}}>← 戻る</button>
        <h2 style={{fontSize:16,fontWeight:700}}>{item.label}</h2>
      </div>
      <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:20}}>
        <h3 style={{fontSize:15,fontWeight:700,marginBottom:16}}>📋 情報入力</h3>

        {/* 在庫商品と紐付け */}
        {invItems.length>0&&(
          <div style={{marginBottom:14}}>
            <label style={labelS}>在庫から商品を選ぶ（任意）</label>
            <select value={selItemId} onChange={e=>handleItemSelect(e.target.value)} style={inputS}>
              <option value="">選択しない（手動入力）</option>
              {invItems.map(i=>{
                const sm=SHIPPING_METHODS.find(m=>m.id===i.shippingMethodId)||null;
                const qrCat=item.category||"";
                const methodMatch=!sm||!qrCat||sm.name===qrCat||!i.shippingMethodId;
                return (
                  <option key={i.id} value={i.id} disabled={!methodMatch}>
                    {i.name}（残{i.qty}{i.unit}）{sm?" — "+sm.name:""}
                    {!methodMatch?" ⚠️発送方法不一致":""}
                  </option>
                );
              })}
            </select>
            {shipMethod&&(
              <div style={{marginTop:6,display:"flex",alignItems:"center",gap:6,padding:"6px 12px",background:shipMethod.color+"18",borderRadius:8,border:"1px solid "+shipMethod.color+"40"}}>
                <span>{shipMethod.icon}</span>
                <span style={{fontSize:12,fontWeight:600,color:shipMethod.color}}>発送方法: {shipMethod.name}</span>
              </div>
            )}
          </div>
        )}

        {/* 売れた商品の画像（必須） */}
        <div style={{marginBottom:14}}>
          <label style={labelS}>売れた商品の画像 ★（必須）</label>
          <div
            onClick={()=>fileRef.current?.click()}
            style={{border:`2px dashed ${soldImage?C.greenBorder:C.border}`,borderRadius:12,padding:soldImage?8:24,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",background:soldImage?C.greenDim:C.surface2,minHeight:80,position:"relative"}}
          >
            {soldImage
              ?<img src={soldImage} style={{maxHeight:120,maxWidth:"100%",borderRadius:8,display:"block",margin:"0 auto"}}/>
              :<div style={{textAlign:"center"}}>
                <div style={{fontSize:28,marginBottom:4}}>📸</div>
                <p style={{color:C.muted,fontSize:12}}>売れた商品の画像をタップして追加</p>
                <p style={{color:C.red,fontSize:11,marginTop:2}}>※ 画像がないとQRコードを表示できません</p>
              </div>
            }
          </div>
          <input ref={fileRef} type="file" accept="image/*" onChange={handleSoldImage} style={{display:"none"}}/>
          {soldImage&&<button onClick={()=>setSoldImage(null)} style={{marginTop:6,padding:"4px 12px",background:C.redDim,color:C.red,border:`1px solid ${C.redBorder}`,borderRadius:8,fontSize:11,cursor:"pointer"}}>画像を削除</button>}
        </div>

        {/* フォーム入力 */}
        {[
          {key:"productName",label:"商品名",type:"text",ph:"例: Tシャツ 白 M"},
          {key:"datetime",label:"売れた年月日時 ★",type:"datetime-local"},
          {key:"quantity",label:"個数",type:"number",ph:"例: 1"},
          {key:"memberName",label:"メンバー名",type:"text"},
          {key:"amount",label:"金額（円）",type:"number",ph:"例: 3000"}
        ].map(f=>(
          <Fg key={f.key} label={f.label}>
            <input
              type={f.type}
              value={form[f.key]}
              onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))}
              style={inputS}
              placeholder={f.ph}
              readOnly={f.key==="memberName"}
            />
          </Fg>
        ))}

        {/* ジャンル */}
        <div style={{marginBottom:16}}>
          <label style={labelS}>ジャンル</label>
          {selInvItem?.category&&!GENRES.includes(selInvItem.category)&&(
            <p style={{fontSize:11,color:C.muted,marginBottom:4}}>商品カテゴリ「{selInvItem.category}」→「その他」として設定</p>
          )}
          <select value={form.genre} onChange={e=>setForm(p=>({...p,genre:e.target.value}))} style={inputS}>
            <option value="">選択してください</option>
            {GENRES.map(g=><option key={g}>{g}</option>)}
          </select>
        </div>

        {/* QR表示ボタン */}
        {!soldImage&&(
          <div style={{padding:"10px 14px",background:C.redDim,border:`1px solid ${C.redBorder}`,borderRadius:10,marginBottom:14}}>
            <p style={{fontSize:12,color:C.red,fontWeight:600}}>📸 先に売れた商品の画像を追加してください</p>
          </div>
        )}
        <button
          onClick={()=>setShowQR(!showQR)}
          disabled={!isComplete}
          style={{padding:"10px 20px",background:isComplete?C.accentDim:C.surface2,color:isComplete?C.accent:C.faint,border:`1px solid ${isComplete?C.accentBorder:C.border}`,borderRadius:10,fontSize:14,fontWeight:700,cursor:isComplete?"pointer":"not-allowed",marginBottom:16}}
        >
          {showQR?"🙈 QRを隠す":"🔍 QRコードを表示"}
        </button>

        {showQR&&isComplete&&(
          <div style={{marginBottom:16}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",padding:20,background:"#fff",borderRadius:14,border:`1px solid ${C.border}`}}>
              <ZoomableImage src={item.imageData} style={{width:200,height:200,objectFit:"contain"}} label={item.label}/>
              <p style={{color:"#555",fontSize:12,marginTop:8,marginBottom:10}}>スキャンしてください</p>
              <p style={{fontSize:11,color:C.muted,marginTop:4}}>タップで拡大表示</p>
            </div>
          </div>
        )}

        {/* 読み込みチェック */}
        <div
          style={{display:"flex",alignItems:"center",gap:10,padding:14,background:C.surface2,borderRadius:10,marginBottom:16,border:`1px solid ${C.border}`,cursor:"pointer"}}
          onClick={()=>setChecked(!checked)}
        >
          <input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)} style={{width:18,height:18,accentColor:C.accent,cursor:"pointer"}}/>
          <label style={{color:C.text,fontSize:14,cursor:"pointer",fontWeight:checked?600:400}}>読み込みチェック完了</label>
        </div>

        <button
          onClick={()=>onSave({...form, soldImage, linkedItemId:selItemId||null})}
          disabled={!checked||!isComplete}
          style={{width:"100%",padding:"13px",background:checked&&isComplete?C.green:C.surface2,color:checked&&isComplete?"#fff":C.faint,border:"none",borderRadius:10,fontSize:15,fontWeight:700,cursor:checked&&isComplete?"pointer":"not-allowed",transition:"all 0.2s"}}
        >
          💾 保存して完了
        </button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════
// 💰 SALES APP
// ═══════════════════════════════════════════════════════════════════
function SalesApp({ qrItems, members, user, isMaster }) {
  const [period, setPeriod] = useState("all");
  const [selMember, setSelMember] = useState("all");
  const readItems = qrItems.filter(i => i.status==="read" && i.formData);

  function filterByPeriod(items) {
    if (period==="all") return items;
    const now = new Date();
    return items.filter(i => {
      const d = i.readAt?.toDate ? i.readAt.toDate() : new Date(i.readAt||0);
      if (period==="today") return d.toDateString()===now.toDateString();
      if (period==="month") return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
      return true;
    });
  }

  const filtered = filterByPeriod(readItems).filter(i =>
    selMember==="all" || i.formData?.memberName===selMember
  );

  // メンバーは自分のデータのみ
  const displayItems = isMaster ? filtered : filtered.filter(i => i.formData?.memberName===user.name);

  const memberNames = [...new Set(readItems.map(i=>i.formData?.memberName).filter(Boolean))];

  // メンバー別集計
  const memberStats = memberNames.map(name => {
    const items = filterByPeriod(readItems).filter(i=>i.formData?.memberName===name);
    const total = items.reduce((s,i)=>s+Number(i.formData?.amount||0),0);
    return {name, count:items.length, total};
  }).sort((a,b)=>b.total-a.total);

  const grandTotal = displayItems.reduce((s,i)=>s+Number(i.formData?.amount||0),0);

  function exportAll() {
    exportToExcel(displayItems.map(i=>({
      label:i.label,
      productName:i.formData.productName,
      datetime:i.formData.datetime,
      quantity:i.formData.quantity,
      genre:i.formData.genre,
      memberName:i.formData.memberName,
      amount:i.formData.amount,
      readAt:tsToStr(i.readAt)
    })), `売上データ_${new Date().toLocaleDateString("ja-JP").replace(/\//g,"-")}.csv`);
  }

  return (
    <div style={{animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <h2 style={{fontSize:16,fontWeight:700}}>💰 売上集計</h2>
        <button onClick={exportAll} style={{padding:"8px 16px",background:C.green,color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700}}>📥 Excelダウンロード</button>
      </div>

      {/* フィルター */}
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        <div style={{display:"flex",gap:2,background:C.surface,borderRadius:10,padding:3,border:`1px solid ${C.border}`}}>
          {[{id:"all",label:"全期間"},{id:"month",label:"今月"},{id:"today",label:"今日"}].map(p=>(
            <button key={p.id} onClick={()=>setPeriod(p.id)} style={{padding:"5px 12px",borderRadius:7,border:"none",background:period===p.id?C.accent:"transparent",color:period===p.id?"#fff":C.muted,fontSize:12,fontWeight:period===p.id?700:400}}>
              {p.label}
            </button>
          ))}
        </div>
        {isMaster&&<select value={selMember} onChange={e=>setSelMember(e.target.value)} style={{...inputS,width:"auto"}}>
          <option value="all">全メンバー</option>
          {memberNames.map(n=><option key={n} value={n}>{n}</option>)}
        </select>}
      </div>

      {/* 合計カード */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
        <div style={{background:C.surface,borderRadius:14,padding:16,border:`1px solid ${C.greenBorder}`}}>
          <p style={{fontSize:11,color:C.muted,marginBottom:4}}>合計金額</p>
          <p style={{fontSize:28,fontWeight:700,color:C.green,fontFamily:"'Sora',sans-serif"}}>¥{grandTotal.toLocaleString()}</p>
        </div>
        <div style={{background:C.surface,borderRadius:14,padding:16,border:`1px solid ${C.border}`}}>
          <p style={{fontSize:11,color:C.muted,marginBottom:4}}>件数</p>
          <p style={{fontSize:28,fontWeight:700,fontFamily:"'Sora',sans-serif"}}>{displayItems.length}<span style={{fontSize:14,color:C.muted,fontWeight:400}}> 件</span></p>
        </div>
      </div>

      {/* メンバー別集計（マスターのみ） */}
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

      {/* 明細一覧 */}
      <h3 style={{fontSize:14,fontWeight:700,marginBottom:10,color:C.muted}}>明細一覧</h3>
      {displayItems.length===0
        ?<div style={{background:C.surface,borderRadius:14,border:`1px solid ${C.border}`,padding:40,textAlign:"center"}}><p style={{color:C.muted}}>データがありません</p></div>
        :<div style={{background:C.surface,borderRadius:12,border:`1px solid ${C.border}`,overflow:"hidden"}}><div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead><tr style={{background:C.surface2}}>
              {["読込日時","ラベル","商品名","個数","ジャンル",...(isMaster?["メンバー"]:[]),"金額"].map((h,i)=>(
                <th key={i} style={{padding:"9px 12px",textAlign:"left",fontSize:10,fontWeight:700,color:C.muted,whiteSpace:"nowrap"}}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {displayItems.map((item,i)=>(
                <tr key={item.id} style={{borderTop:`1px solid ${C.border}`,background:i%2===0?C.surface:`${C.surface2}80`}}>
                  <td style={{padding:"9px 12px",color:C.muted,fontSize:10,whiteSpace:"nowrap"}}>{tsToStr(item.readAt)}</td>
                  <td style={{padding:"9px 12px",fontWeight:600,maxWidth:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.label}</td>
                  <td style={{padding:"9px 12px",maxWidth:100,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.formData?.productName}</td>
                  <td style={{padding:"9px 12px"}}>{item.formData?.quantity}</td>
                  <td style={{padding:"9px 12px",color:C.muted}}>{item.formData?.genre}</td>
                  {isMaster&&<td style={{padding:"9px 12px",color:C.accent,fontWeight:600}}>{item.formData?.memberName}</td>}
                  <td style={{padding:"9px 12px",fontWeight:700,color:C.green,whiteSpace:"nowrap"}}>¥{Number(item.formData?.amount||0).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      }
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════
function Overlay({ children, onClose }) {
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(4px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:C.surface,borderRadius:20,padding:24,width:"100%",maxWidth:460,maxHeight:"92vh",overflowY:"auto",animation:"pop 0.2s ease",boxShadow:"0 24px 64px rgba(0,0,0,0.6)",border:`1px solid ${C.border}`}}>
        {children}
      </div>
    </div>
  );
}

function Fg({ label, children }) {
  return <div style={{marginBottom:12}}><label style={labelS}>{label}</label>{children}</div>;
}
