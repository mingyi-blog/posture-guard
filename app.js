import { Pose } from "./assets/pose.js";

let pose = null, streaming = false, calibRef = null;
let sensDeg = 12, alertInterval = 30, soundOn = true;
let xp = 0, level = 1, streakSec = 0, bestStreak = 0, totalSec = 0;
let nudgeCnt = 0, lastAlertT = 0, goodSec = 0;
let stream = null, timerInterval = null, _lastLandmarks = null;

const $ = id => document.getElementById(id);
const vid = $("vid"), cv = $("cv"), ctx = cv.getContext("2d");
const dot = $("dot"), stTxt = $("stTxt"), btnStart = $("btnStart");
const btnCal = $("btnCal"), btnStop = $("btnStop"), hint = $("hint");
const alertBar = $("alertBar");
const mCva = $("mCva"), mShoul = $("mShoul"), mTrunk = $("mTrunk"), mElbow = $("mElbow");
const lvlBadge = $("lvlBadge"), xpsTxt = $("xpsTxt"), timerDisp = $("timerDisp");
const sGood = $("sGood"), sNudge = $("sNudge"), sTotal = $("sTotal"), sStreak = $("sStreak");
const scoreVal = $("scoreVal");
const tPrivacy = $("tPrivacy"), tSound = $("tSound");
const sSens = $("s Sens"), sVal = $("sVal"), sInt = $("sInt"), iVal = $("iVal");

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

function playBeep(){
  if(!soundOn) return;
  try {
    const ac = new (window.AudioContext||window.webkitAudioContext)();
    const o=ac.createOscillator(), g=ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.frequency.value=880; o.type="sine"; g.gain.value=0.2;
    o.start(); g.gain.exponentialRampToValueAtTime(0.01, ac.currentTime+0.15);
    o.stop(ac.currentTime+0.15);
  } catch(e){}
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
  alertBar.style.display=(!good&&Date.now()-lastAlertT>alertInterval*1000)?"block":"none";
}

function addXP(dt){
  if(!calibRef) return;
  xp += dt;
  const need = level*100;
  while(xp>=need){xp-=need;level++;}
  lvlBadge.textContent="Lv."+level;
  xpsTxt.textContent=Math.round(xp)+"/"+need+" XP";
}

function startTimer(){
  if(timerInterval) return;
  timerInterval = setInterval(()=>{
    if(!streaming||!calibRef) return;
    totalSec++;
    const m = detectMetrics(_lastLandmarks||[]);
    const g = isGood(m);
    if(g){goodSec++;streakSec++;if(streakSec>bestStreak)bestStreak=streakSec}else{streakSec=0}
    addXP(1);
    const mins=Math.floor(totalSec/60), secs=totalSec%60;
    timerDisp.textContent=String(mins).padStart(2,"0")+":"+String(secs).padStart(2,"0");
    sTotal.textContent=mins+"分"; sStreak.textContent=bestStreak+"分";
    sGood.textContent=totalSec?Math.round(goodSec/totalSec*100)+"%":"0%";
    sNudge.textContent=nudgeCnt;
  },1000);
}

function stopTimer(){if(timerInterval){clearInterval(timerInterval);timerInterval=null}}

function onResults(results){
  if(!streaming) return;
  if(results.poseLandmarks && results.poseLandmarks.length>0){
    _lastLandmarks = results.poseLandmarks;
    const m = detectMetrics(results.poseLandmarks);
    const g = isGood(m), s = calcScore(m);
    updateUI(m,s,g);
    drawSkeleton(results.poseLandmarks);
    if(!g && Date.now()-lastAlertT>alertInterval*1000){
      lastAlertT=Date.now(); nudgeCnt++; playBeep();
    }
  }
}

async function startCamera(){
  try {
    stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:/user/,width:{ideal:640},height:{ideal:480}}});
    vid.srcObject = stream; vid.play();
    pose = new Pose({locateFile:(f)=>"./assets/"+f});
    pose.setOptions({modelComplexity:1,smoothLandmarks:true,minDetectionConfidence:0.5,minTrackingConfidence:0.5});
    pose.onResults(onResults);
    streaming = true;
    dot.className="dot on"; stTxt.textContent="监测中";
    btnStart.style.display="none"; btnCal.style.display="block"; btnStop.style.display="block";
    hint.classList.remove("show");
    startTimer();
  } catch(e){ alert("无法访问摄像头: "+e.message); }
}

function stopCamera(){
  streaming=false;
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
  dot.className="dot off"; stTxt.textContent="未启动";
  btnStart.style.display="block"; btnCal.style.display="none"; btnStop.style.display="none";
  hint.classList.add("show"); stopTimer();
  scoreVal.textContent="--";
  [mCva,mShoul,mTrunk,mElbow].forEach(e=>{e.textContent="--°";e.className="meter-val"});
  _lastLandmarks=null;
}

btnStart.addEventListener("click",startCamera);
btnStop.addEventListener("click",stopCamera);
btnCal.addEventListener("click",()=>{
  if(_lastLandmarks){calibRef=detectMetrics(_lastLandmarks);
    hint.textContent="✅ 已校准! AI 记住了你的标准坐姿";
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

console.log("坐姿卫士 v0.1 MVP 已加载");
