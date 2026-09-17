import { Pose } from "./assets/pose.js";

let pose = null, streaming = false, calibRef = null, autoCalTimer = null, firstResult = true;
let sensDeg = 14, alertInterval = 30, soundOn = true;
let xp = 0, level = 1, streakSec = 0, bestStreak = 0, totalSec = 0;
let nudgeCnt = 0, lastAlertT = 0, goodSec = 0;
let combo = 0, bestCombo = 0, energy = 100, badCount = 0;
let stream = null, timerInterval = null, _lastLandmarks = null;

const $ = id => document.getElementById(id);
const vid = $("vid"), cv = $("cv"), ctx = cv.getContext("2d");
const loading = $("loading"), alertBar = $("alertBar"), comboBig = $("comboBig");
const lvlBadge = $("lvlBadge"), lvlTitle = $("lvlTitle"), scoreVal = $("scoreVal"), xpTxt = $("xpTxt"), timerDisp = $("timerDisp");
const mCva = $("mCva"), mShoul = $("mShoul"), mTrunk = $("mTrunk"), mElbow = $("mElbow");
const sGood = $("sGood"), sNudge = $("sNudge"), sTotal = $("sTotal"), sStreak = $("sStreak");
const energyFill = $("energyFill"), toast = $("toast");
const btnStart = $("btnStart"), btnCal = $("btnCal"), btnStop = $("btnStop");
const tPrivacy = $("tPrivacy"), tSound = $("tSound");
const sSens = $("sSens"), sVal = $("sVal"), sInt = $("sInt"), iVal = $("iVal");

const LEVEL_TITLES = ["见习坐姿官","坐姿学徒","端正新手","挺直能手","坐姿达人","平衡高手","稳坐专家","不倒大师","坐姿宗师","不倒王者"];
const COMBO_BADGES = {10:"初露锋芒",30:"渐入佳境",60:"稳如泰山",100:"不倒传说"};

function angle(a,b,c){
  const va=a.x-b.x, va2=a.y-b.y, vb=c.x-b.x, vb2=c.y-b.y;
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
  return { cvAngle, shoulAngle, trunkAngle, elbowAngle:(lElbow+rElbow)/2 };
}

function calcScore(m){
  let s=100;
  s -= Math.max(0, m.cvAngle-15)*1.8;
  s -= Math.max(0, m.shoulAngle-5)*2.6;
  s -= Math.max(0, m.trunkAngle-20)*1.3;
  s -= Math.max(0, Math.abs(m.elbowAngle-100))*0.4;
  return Math.max(0, Math.min(100, Math.round(s)));
}

function isGood(m){
  if(!calibRef) return m.cvAngle < 22 && m.trunkAngle < 28;
  const d1=Math.abs(m.cvAngle-calibRef.cvAngle), d2=Math.abs(m.trunkAngle-calibRef.trunkAngle);
  return d1 < sensDeg && d2 < sensDeg*1.6;
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
      ctx.beginPath(); ctx.arc(p.x*cv.width,p.y*cv.height,3.5,0,2*Math.PI);
      ctx.fillStyle="#34d399"; ctx.fill();
    }
  });
  conns.forEach(([a,b])=>{
    const pa=lm[a], pb=lm[b];
    if(pa.visibility>0.5&&pb.visibility>0.5){
      ctx.beginPath(); ctx.moveTo(pa.x*cv.width,pa.y*cv.height);
      ctx.lineTo(pb.x*cv.width,pb.y*cv.height);
      ctx.strokeStyle="#38bdf8"; ctx.lineWidth=3; ctx.stroke();
    }
  });
}

function updateUI(m,score,good){
  const setM=(el,v,thr)=>{el.textContent=Math.round(v)+"°"; el.className="mv "+(v<=thr[0]?"g":v<=thr[1]?"w":"b")};
  setM(mCva,m.cvAngle,[15,25]);
  setM(mShoul,m.shoulAngle,[5,10]);
  setM(mTrunk,m.trunkAngle,[20,35]);
  setM(mElbow,m.elbowAngle,[85,115]);
  scoreVal.textContent=score;
  scoreVal.style.color=score>=70?"#059669":score>=40?"#d97706":"#f43f5e";
  energy=score;
  energyFill.style.width=score+"%";
  energyFill.classList.toggle("low", score<40);
  alertBar.style.display=(!good&&badCount>=2&&Date.now()-lastAlertT>alertInterval*1000)?"block":"none";
}

function addXP(){
  if(!calibRef) return;
  const mult = 1 + Math.floor(combo/10);
  xp += 1*mult;
  const need = level*100;
  while(xp>=need){ xp-=need; level++; setLevel(); showToast("升级啦！"+LEVEL_TITLES[Math.min(level,LEVEL_TITLES.length)-1]); playChime(); }
}

function startTimer(){
  if(timerInterval) return;
  timerInterval = setInterval(()=>{
    if(!streaming || !_lastLandmarks) return;
    const m = detectMetrics(_lastLandmarks);
    const g = isGood(m);
    if(g){
      badCount=0;
      goodSec++; streakSec++; if(streakSec>bestStreak)bestStreak=streakSec;
      combo++; if(combo>bestCombo)bestCombo=combo;
      if(COMBO_BADGES[combo]){ showToast(combo+" 连击 · "+COMBO_BADGES[combo]); playChime(); }
      else if(combo%5===0){ showComboFloat(); }
      comboBig.textContent="连击 "+combo;
      comboBig.classList.add("show","pop");
      setTimeout(()=>comboBig.classList.remove("pop"),350);
      addXP();
    } else {
      badCount++;
      streakSec=0;
      if(badCount>=2){
        if(combo>0){ combo=0; comboBig.textContent="连击 0"; comboBig.classList.remove("show"); }
        if(Date.now()-lastAlertT>alertInterval*1000){ lastAlertT=Date.now(); nudgeCnt++; playBeep(440,0.2,0.15); }
      }
    }
    const mins=Math.floor(totalSec/60), secs=totalSec%60;
    timerDisp.textContent=String(mins).padStart(2,"0")+":"+String(secs).padStart(2,"0");
    sStreak.textContent=bestCombo;
    sTotal.textContent=mins+"分";
    sGood.textContent=totalSec?Math.round(goodSec/totalSec*100)+"%":"0%";
    sNudge.textContent=nudgeCnt;
    totalSec++;
  },1000);
}

function stopTimer(){ if(timerInterval){ clearInterval(timerInterval); timerInterval=null; } }

function showComboFloat(){
  comboBig.classList.remove("pop"); void comboBig.offsetWidth; comboBig.classList.add("pop");
}

function onResults(results){
  if(!streaming) return;
  if(firstResult){ firstResult=false; loading.classList.add("hide"); }
  if(results.poseLandmarks && results.poseLandmarks.length>0){
    _lastLandmarks = results.poseLandmarks;
    if(!calibRef && !autoCalTimer){
      autoCalTimer = setTimeout(()=>{
        if(_lastLandmarks && !calibRef){
          calibRef = detectMetrics(_lastLandmarks);
          showToast("已记住你的标准坐姿，开始闯关！");
        }
      },3000);
    }
    const m = detectMetrics(results.poseLandmarks);
    const g = isGood(m), s = calcScore(m);
    updateUI(m,s,g);
    drawSkeleton(results.poseLandmarks);
  }
}

async function startCamera(){
  try {
    stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:/user/,width:{ideal:640},height:{ideal:480}}});
    vid.srcObject = stream; vid.play();
    vid.addEventListener("loadedmetadata",()=>{ cv.width=vid.videoWidth||640; cv.height=vid.videoHeight||480; });
    loading.classList.remove("hide");
    pose = new Pose({locateFile:(f)=>"./assets/"+f});
    pose.setOptions({modelComplexity:1,smoothLandmarks:true,minDetectionConfidence:0.5,minTrackingConfidence:0.5});
    pose.onResults(onResults);
    streaming = true;
    btnStart.style.display="none"; btnCal.style.display="block"; btnStop.style.display="block";
    firstResult = true;
    startTimer();
  } catch(e){ alert("无法访问摄像头："+e.message); }
}

function stopCamera(){
  streaming=false;
  if(autoCalTimer){clearTimeout(autoCalTimer);autoCalTimer=null;}
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
  btnStart.style.display="block"; btnCal.style.display="none"; btnStop.style.display="none";
  stopTimer();
  loading.classList.add("hide");
  scoreVal.textContent="--";
  combo=0; comboBig.textContent="连击 0"; comboBig.classList.remove("show");
  energyFill.style.width="100%"; energyFill.classList.remove("low");
  badCount=0;
  [mCva,mShoul,mTrunk,mElbow].forEach(e=>{e.textContent="--°";e.className="mv"});
  _lastLandmarks=null;
  alertBar.style.display="none";
}

btnStart.addEventListener("click",startCamera);
btnStop.addEventListener("click",stopCamera);
btnCal.addEventListener("click",()=>{
  if(_lastLandmarks){ calibRef=detectMetrics(_lastLandmarks); showToast("已重设标准坐姿"); }
  else { alert("请先开启摄像头并坐好"); }
});

sSens.addEventListener("input",e=>{sensDeg=+e.target.value;sVal.textContent=sensDeg});
sInt.addEventListener("input",e=>{alertInterval=+e.target.value;iVal.textContent=alertInterval});
tPrivacy.addEventListener("click",()=>{ vid.classList.toggle("privacy-blur"); tPrivacy.classList.toggle("on"); });
tSound.addEventListener("click",()=>{ soundOn=!soundOn; tSound.classList.toggle("on"); });

document.addEventListener("keydown",e=>{
  if(e.key==="c"||e.key==="C") btnCal.click();
  if(e.key==="s"||e.key==="S") streaming?stopCamera():startCamera();
});

console.log("坐姿闯关王 已加载");
