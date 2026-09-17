import { Pose } from "./assets/pose.js";

let pose = null, streaming = false, calibRef = null, autoCalTimer = null;
let sensDeg = 12, alertInterval = 30, soundOn = true;
let xp = 0, level = 1, streakSec = 0, bestStreak = 0, totalSec = 0;
let nudgeCnt = 0, lastAlertT = 0, goodSec = 0;
let combo = 0, bestCombo = 0, energy = 100;
let stream = null, timerInterval = null, _lastLandmarks = null;

const $ = id => document.getElementById(id);
const vid = $("vid"), cv = $("cv"), ctx = cv.getContext("2d");
const dot = $("dot"), stTxt = $("stTxt"), btnStart = $("btnStart");
const btnCal = $("btnCal"), btnStop = $("btnStop"), hint = $("hint");
const alertBar = $("alertBar");
const mCva = $("mCva"), mShoul = $("mShoul"), mTrunk = $("mTrunk"), mElbow = $("mElbow");
const lvlBadge = $("lvlBadge"), lvlTitle = $("lvlTitle"), xpTxt = $("xpTxt"), timerDisp = $("timerDisp");
const sGood = $("sGood"), sNudge = $("sNudge"), sTotal = $("sTotal"), sStreak = $("sStreak");
const scoreVal = $("scoreVal"), comboBig = $("comboBig"), comboFloat = $("comboFloat");
const energyFill = $("energyFill"), energyMini = $("energyMini"), toast = $("toast");
const tPrivacy = $("tPrivacy"), tSound = $("tSound");
const sSens = $("sSens"), sVal = $("sVal"), sInt = $("sInt"), iVal = $("iVal");

const LEVEL_TITLES = ["见习坐姿官","坐姿学徒","端正新手","挺直能手","坐姿达人","平衡高手","稳坐专家","不倒大师","坐姿宗师","不倒王者"];
const COMBO_BADGES = {10:"初露锋芒",30:"渐入佳境",60:"稳如泰山",100:"不倒传说"};

function angle(a,b,c){
  const va=a.x-b.x,va2=a.y-b.y,vb=c.x-b.x,vb2=c.y-b.y;
  const cos=(va*vb+va2*vb2)/(Math.sqrt(va*va+va2*va2)*Math.sqrt(vb*vb+vb2*vb2));
  return Math.acos(Math.min(1,Math.max(-1,cos)))*180/Math.PI;
}

function detectMetrics(lm){
  const nose=lm[0], lsh=lm[11], rsh=lm[12], lp=lm[23], rp=lm[24];
  const lelbow=lm[13], reelbow=lm[14], lwrist=lm[15], rwrist=lm[16];
  const shMid={x:(lsh.x+rsh.x)/2, y:(lsh.y+rsh.y)/2};
  const hipMid={x:(lp.x+rp.x)/2, y:(lp.y+rp.y)/2};
  const cvAngle = angle(nose, shMid, hipMid);
  const shoulAngle = Math.abs(lsh.y - rsh.y) * 200;
  const trunkAngle = angle(lsh, shMid, hipMid);
  const lElbow = angle(lsh, lelbow, lwrist);
  const rElbow = angle(rsh, reelbow, rwrist);
  return { cvAngle, shoulAngle, trunkAngle, elbowAngle: (lElbow+rElbow)/2 };
}

function calcScore(m){
  let s=100;
  s -= Math.max(0, m.cvAngle-15)*2;
  s -= Math.max(0, m.shoulAngle-5)*3;
  s -= Math.max(0, m.trunkAngle-20)*1.5;
  s -= Math.max(0,Math.abs(m.elbowAngle-100))*0.5;
  return Math.max(0,Math.min(100,Math.round(s)));
}

function isGood(m){
  if(!calibRef) return m.cvAngle < 20 && m.trunkAngle < 25;
  const d1=Math.abs(m.cvAngle-calibRef.cvAngle), d2=Math.abs(m.trunkAngle-calibRef.trunkAngle);
  return d1 < sensDeg && d2 < sensDeg*1.5;
}

function playBeep(freq=440,dur=0.2,vol=0.15){
  if(!soundOn) return;
  try {
    const ac = new (window.AudioContext||window.webkitAudioContext)();
    const o=ac.createOscillator(), g=ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.frequency.value=freq; o.type="sine"; g.gain.value=vol;
    o.start(); g.gain.exponentialRampToValueAtTime(0.01, ac.currentTime+dur);
    o.stop(ac.currentTime+dur);
  } catch(e){}
}

function playChime(){
  if(!soundOn) return;
  try{
    const ac=new (window.AudioContext||window.webkitAudioContext)();
    [523,659,784].forEach((f,i)=>{
      const o=ac.createOscillator(), g=ac.createGain();
      o.connect(g); g.connect(ac.destination);
      o.frequency.value=f; o.type="triangle";
      const t=ac.currentTime+i*0.08;
      g.gain.setValueAtTime(0.0001,t);
      g.gain.exponentialRampToValueAtTime(0.14,t+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001,t+0.12);
      o.start(t); o.stop(t+0.14);
    });
  }catch(e){}
}

function showToast(msg){
  toast.textContent=msg; toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t=setTimeout(()=>toast.classList.remove("show"),1900);
}

function showComboFloat(){
  comboFloat.textContent="连击 "+combo+"!";
  comboFloat.classList.add("show");
  clearTimeout(showComboFloat._t);
  showComboFloat._t=setTimeout(()=>comboFloat.classList.remove("show"),550);
}

function setLevel(){
  const idx=Math.min(level,LEVEL_TITLES.length)-1;
  lvlBadge.textContent="Lv."+level;
  lvlTitle.textContent=LEVEL_TITLES[idx];
}

function drawSkeleton(lm){
  ctx.clearRect(0,0,cv.width,cv.height);
  const conns=[[0,1],[0,2],[1,3],[2,4],[1,5],[2,6],[5,6],[1,7],[2,8],[7,9],[8,10],[5,11],[6,12],[11,12],[11,13],[12,14],[13,15],[14,16]];
  lm.forEach(p=>{
    if(p.visibility>0.5){
      ctx.beginPath(); ctx.arc(p.x*cv.width,p.y*cv.height,3,0,2*Math.PI);
      ctx.fillStyle="#64dcff"; ctx.fill();
    }
  });
  conns.forEach(([a,b])=>{
    const pa=lm[a], pb=lm[b];
    if(pa.visibility>0.5&&pb.visibility>0.5){
      ctx.beginPath(); ctx.moveTo(pa.x*cv.width,pa.y*cv.height);
      ctx.lineTo(pb.x*cv.width,pb.y*cv.height);
      ctx.strokeStyle="#a855f7"; ctx.lineWidth=2; ctx.stroke();
    }
  });
}

function updateUI(m,score,good){
  const setM=(el,v,thr)=>{el.textContent=Math.round(v)+"°"; el.className="meter-val "+(v<=thr[0]?"g":v<=thr[1]?"w":"b")};
  setM(mCva,m.cvAngle,[15,25]);
  setM(mShoul,m.shoulAngle,[5,10]);
  setM(mTrunk,m.trunkAngle,[20,35]);
  setM(mElbow,m.elbowAngle,[85,115]);
  scoreVal.textContent=score;
  scoreVal.style.color=score>=70?"#4ade80":score>=40?"#fbbf24":"#f87171";
  energy=score;
  energyFill.style.width=score+"%";
  energyMini.style.width=score+"%";
  alertBar.style.display=(!good&&Date.now()-lastAlertT>alertInterval*1000)?"block":"none";
}

function addXP(){
  if(!calibRef) return;
  const mult = 1 + Math.floor(combo/10);
  xp += 1*mult;
  const need = level*100;
  while(xp>=need){ xp-=need; level++; setLevel(); showToast("升级啦！"+LEVEL_TITLES[Math.min(level,LEVEL_TITLES.length)-1]); playChime(); }
  xpTxt.textContent=Math.round(xp)+"/"+(level*100)+" XP";
}

function startTimer(){
  if(timerInterval) return;
  timerInterval = setInterval(()=>{
    if(!streaming) return;
    totalSec++;
    const m = detectMetrics(_lastLandmarks||[]);
    const g = isGood(m);
    if(g){
      goodSec++; streakSec++; if(streakSec>bestStreak)bestStreak=streakSec;
      combo++; if(combo>bestCombo)bestCombo=combo;
      if(COMBO_BADGES[combo]){ showToast(combo+" 连击 · "+COMBO_BADGES[combo]); playChime(); }
      else if(combo%5===0) showComboFloat();
    } else {
      streakSec=0;
    }
    comboBig.textContent="连击 "+combo;
    sStreak.textContent=bestCombo;
    addXP();
    const mins=Math.floor(totalSec/60), secs=totalSec%60;
    timerDisp.textContent=String(mins).padStart(2,"0")+":"+String(secs).padStart(2,"0");
    sTotal.textContent=mins+"分";
    sGood.textContent=totalSec?Math.round(goodSec/totalSec*100)+"%":"0%";
    sNudge.textContent=nudgeCnt;
  },1000);
}

function stopTimer(){if(timerInterval){clearInterval(timerInterval);timerInterval=null}}

function onResults(results){
  if(!streaming) return;
  if(results.poseLandmarks && results.poseLandmarks.length>0){
    _lastLandmarks = results.poseLandmarks;
    if(!calibRef && !autoCalTimer){
      hint.textContent="🤖 AI 正在记住你的标准坐姿…"; hint.classList.add("show");
      autoCalTimer = setTimeout(()=>{
        if(_lastLandmarks && !calibRef){
          calibRef = detectMetrics(_lastLandmarks);
          hint.textContent="✅ 已记住！坐歪了连击会断，坐直攒能量～（点「重设」可改）";
          hint.classList.add("show"); setTimeout(()=>hint.classList.remove("show"),3500);
        }
      },3000);
    }
    const m = detectMetrics(results.poseLandmarks);
    const g = isGood(m), s = calcScore(m);
    updateUI(m,s,g);
    drawSkeleton(results.poseLandmarks);
    if(!g){
      if(combo>0){ combo=0; comboBig.textContent="连击 0"; }
      if(Date.now()-lastAlertT>alertInterval*1000){
        lastAlertT=Date.now(); nudgeCnt++; playBeep(440,0.2,0.15);
      }
    }
  }
}

async function startCamera(){
  try {
    stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:/user/,width:{ideal:640},height:{ideal:480}}});
    vid.srcObject = stream; vid.play();
    hint.textContent="🤖 AI 模型加载中，请稍候…"; hint.classList.add("show");
    pose = new Pose({locateFile:(f)=>"./assets/"+f});
    pose.setOptions({modelComplexity:1,smoothLandmarks:true,minDetectionConfidence:0.5,minTrackingConfidence:0.5});
    pose.onResults(onResults);
    streaming = true;
    dot.className="dot on"; stTxt.textContent="闯关中";
    btnStart.style.display="none"; btnCal.style.display="block"; btnStop.style.display="block";
    hint.classList.remove("show");
    startTimer();
  } catch(e){ alert("无法访问摄像头: "+e.message); }
}

function stopCamera(){
  streaming=false;
  if(autoCalTimer){clearTimeout(autoCalTimer);autoCalTimer=null;}
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
  dot.className="dot off"; stTxt.textContent="未启动";
  btnStart.style.display="block"; btnCal.style.display="none"; btnStop.style.display="none";
  hint.classList.add("show"); stopTimer();
  scoreVal.textContent="--";
  combo=0; comboBig.textContent="连击 0";
  energyFill.style.width="100%"; energyMini.style.width="100%";
  [mCva,mShoul,mTrunk,mElbow].forEach(e=>{e.textContent="--°";e.className="meter-val"});
  _lastLandmarks=null;
}

btnStart.addEventListener("click",startCamera);
btnStop.addEventListener("click",stopCamera);
btnCal.addEventListener("click",()=>{
  if(_lastLandmarks){calibRef=detectMetrics(_lastLandmarks);
    hint.textContent="✅ 已重设！AI 记住了当前标准坐姿";
    hint.classList.add("show"); setTimeout(()=>hint.classList.remove("show"),3000);
  } else { alert("请先开启摄像头并坐好"); }
});

sSens.addEventListener("input",e=>{sensDeg=+e.target.value;sVal.textContent=sensDeg});
sInt.addEventListener("input",e=>{alertInterval=+e.target.value;iVal.textContent=alertInterval});
tPrivacy.addEventListener("click",()=>{
  vid.classList.toggle("privacy-blur");
  tPrivacy.classList.toggle("on");
});
tSound.addEventListener("click",()=>{
  soundOn=!soundOn; tSound.classList.toggle("on");
});

document.addEventListener("keydown",e=>{
  if(e.key==="c"||e.key==="C") btnCal.click();
  if(e.key==="s"||e.key==="S") streaming?stopCamera():startCamera();
});

console.log("坐姿闯关王 v0.2 已加载");
