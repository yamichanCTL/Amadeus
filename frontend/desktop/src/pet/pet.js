import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MouthController, MOUTH_SHAPES } from '../avatar/mouthController';
import { disposeAvatarScene, frameAvatar, normalizeAvatarScene } from '../avatar/localAvatarScene';
import { watchLocalAvatar } from '../services/localAvatar';
import './pet.css';

const $ = id => document.getElementById(id);
const desktop = window.desktopPet || {
  setInteractive(){}, dragStart(){}, dragMove(){}, dragEnd(){}, moveBy(){}, command(){}, onState(){}, onAudioFrame(){},
};
const canvas = $('petCanvas');
const mouth = new MouthController();
let incomingAudioFrame = null;
canvas.dataset.loaded = 'false';
canvas.dataset.voiced = 'false';
canvas.dataset.mouth = '0';
canvas.dataset.morphCount = '0';
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.6;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, .05, 100);
camera.position.set(0, 1.25, 3.10);
camera.lookAt(0, 1.02, 0);
scene.add(new THREE.HemisphereLight(0xd6e0ff, 0x594665, 2.1));
const key = new THREE.DirectionalLight(0xffe9ef, 3.2); key.position.set(-2, 3, 3); scene.add(key);
const rim = new THREE.DirectionalLight(0xba9aff, 2.2); rim.position.set(2, 2, -2); scene.add(rim);
const holder = new THREE.Group(); scene.add(holder);
const bones = {}, baseQuat = {}, morphMeshes = [], skinnedMeshes = [];
let skeletonRoots = [];
let ready = false, blinkAt = 2.6, pointerX = 0;
let model = null, modelGeneration = 0, loadedRevision, disposed = false, animationFrame = 0;
let modelBounds = { width:1, height:1.64, depth:.5 };
let conversationStatus = 'idle', conversationEmotion = 'neutral', lastGestureId = '', lastReply = '', lastError = '';
let current = null, dragging = false, toastTimer = 0, scaleTarget = 1;
const queue = [];
const clock = new THREE.Clock();
const clamp = THREE.MathUtils.clamp;
const smooth = t => t * t * (3 - 2 * t);
const durations = { greet:2.2, wave:2.0, come_closer:1.5, step_back:1.5, step_left:1.45, step_right:1.45, turn_left:1.3, turn_right:1.3, dance:3.4, reset:1.3, rest:.2 };
const movement = new Set(['come_closer', 'step_back', 'step_left', 'step_right']);
const AXIS_X = new THREE.Vector3(1,0,0), AXIS_Y = new THREE.Vector3(0,1,0), AXIS_Z = new THREE.Vector3(0,0,1);

function toast(message, duration=3200) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), duration);
}
function setMorph(name, value) {
  for (const mesh of morphMeshes) {
    const index = mesh.morphTargetDictionary?.[name];
    if (index !== undefined) mesh.morphTargetInfluences[index] = clamp(value, 0, 1);
  }
}
function resetBonePose() { for (const [name, bone] of Object.entries(bones)) bone.quaternion.copy(baseQuat[name]); }
function boneRotate(name, axis, radians) {
  const bone = bones[name]; if (!bone) return;
  bone.quaternion.copy(baseQuat[name]).multiply(new THREE.Quaternion().setFromAxisAngle(axis, radians));
}
function boneRotateWorld(name, worldAxis, radians) {
  const bone = bones[name]; if (!bone) return;
  const parentWorld = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  const localAxis = worldAxis.clone().applyQuaternion(parentWorld).normalize();
  bone.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(localAxis, radians)).multiply(baseQuat[name]);
}

function clearModel() {
  ready = false;
  window.__petReady = false;
  if (model) disposeAvatarScene(model);
  model = null;
  morphMeshes.length = 0; skinnedMeshes.length = 0; skeletonRoots = [];
  for (const name of Object.keys(bones)) { delete bones[name]; delete baseQuat[name]; }
  queue.length = 0; current = null; scaleTarget = 1;
  holder.position.set(0,0,0); holder.rotation.set(0,0,0); holder.scale.setScalar(1);
  mouth.clear(); incomingAudioFrame = null;
  canvas.dataset.loaded = 'false'; canvas.dataset.morphCount = '0';
  canvas.dataset.mouth = '0'; canvas.dataset.voiced = 'false';
  window.__petStats = { bones:0, morphs:0, meshes:0 };
  desktop.setInteractive(false);
}
async function loadLocalModel(status) {
  if (disposed || loadedRevision === status.revision && model) return;
  loadedRevision = status.revision;
  const generation = ++modelGeneration;
  clearModel();
  if (!status.available) {
    toast(status.error || '请在 Amadeus 设置中导入本地 GLB 模型。', 5000);
    return;
  }
  try {
    const bytes = await desktop.localAvatarRead();
    if (disposed || generation !== modelGeneration) return;
    if (!bytes) throw new Error('模型不存在，请在设置中重新导入。');
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    if (disposed || generation !== modelGeneration) { disposeAvatarScene(gltf.scene); return; }
    try { modelBounds = normalizeAvatarScene(gltf.scene); }
    catch (error) { disposeAvatarScene(gltf.scene); throw error; }
    model = gltf.scene;
    holder.add(model);
    const knownRig = Boolean(model.getObjectByName('頭'));
    model.traverse(obj => {
      if (!obj.isMesh) return;
      if (obj.isSkinnedMesh) skinnedMeshes.push(obj);
      if (obj.morphTargetDictionary) morphMeshes.push(obj);
      if (!knownRig) return;
      for (const mat of (Array.isArray(obj.material) ? obj.material : [obj.material])) {
        if (!mat) continue;
        mat.side = THREE.DoubleSide;
        if (mat.name.includes('后发+') || mat.name.includes('前发+')) { mat.transparent = true; mat.depthWrite = false; }
        else { mat.transparent = false; mat.alphaTest = .08; mat.depthWrite = true; }
        mat.needsUpdate = true;
      }
    });
    for (const bone of skinnedMeshes[0]?.skeleton.bones || []) {
      bones[bone.name] = bone; baseQuat[bone.name] = bone.quaternion.clone();
    }
    const allBones = new Set(skinnedMeshes[0]?.skeleton.bones || []);
    skeletonRoots = [...allBones].filter(b => !allBones.has(b.parent));
    frameAvatar(camera, modelBounds);
    ready = true; window.__petReady = true;
    window.__petStats = { bones:Object.keys(bones).length, morphs:Object.keys(morphMeshes[0]?.morphTargetDictionary || {}).length,
      meshes:skinnedMeshes.length, name:status.name, revision:status.revision };
    canvas.dataset.loaded = 'true'; canvas.dataset.morphCount = String(window.__petStats.morphs);
    $('toast').classList.add('hidden');
  } catch (error) {
    if (!disposed && generation === modelGeneration) toast(`本地模型载入失败：${String(error.message || error).slice(0,120)}`, 8000);
  }
}
const unwatchAvatar = desktop.localAvatarStatus
  ? watchLocalAvatar(desktop, status => { void loadLocalModel(status); })
  : () => {};

function enqueue(actions) {
  if (actions.includes('rest')) { queue.length = 0; current = null; return; }
  for (const action of actions) if (durations[action]) queue.push(action);
  startNext(clock.elapsedTime);
}
function startNext(now) {
  if (current || !queue.length) return;
  const type = queue.shift();
  current = { type, started:now, duration:durations[type], x:holder.position.x, z:holder.position.z, yaw:holder.rotation.y, scale:holder.scale.x, walked:0 };
}
function updateAction(now) {
  if (!current) { startNext(now); return { type:'idle', t:0, active:false }; }
  const a = current;
  const t = clamp((now-a.started)/a.duration,0,1), u = smooth(t);
  if (a.type === 'come_closer') scaleTarget = THREE.MathUtils.lerp(a.scale, Math.min(1.18,a.scale+.12), u);
  if (a.type === 'step_back') scaleTarget = THREE.MathUtils.lerp(a.scale, Math.max(.85,a.scale-.11), u);
  if (a.type === 'turn_left') holder.rotation.y = THREE.MathUtils.lerp(a.yaw,a.yaw+.58,u);
  if (a.type === 'turn_right') holder.rotation.y = THREE.MathUtils.lerp(a.yaw,a.yaw-.58,u);
  if (a.type === 'step_left' || a.type === 'step_right') {
    const target = Math.round((a.type === 'step_left' ? -110 : 110) * u);
    desktop.moveBy(target-a.walked,0); a.walked = target;
  }
  if (a.type === 'reset') {
    scaleTarget = THREE.MathUtils.lerp(a.scale,1,u);
    holder.rotation.y = THREE.MathUtils.lerp(a.yaw,0,u);
  }
  if (t >= 1) { current = null; startNext(now); }
  return { type:a.type, t, active:true };
}
function render() {
  if (disposed) return;
  animationFrame = requestAnimationFrame(render);
  const now = clock.getElapsedTime();
  const {type,t,active} = updateAction(now);
  holder.scale.setScalar(scaleTarget);
  if (ready) {
    resetBonePose();
    const gait = active && movement.has(type) ? Math.sin(now*12)*Math.sin(Math.PI*t) : 0;
    const wave = active && (type==='greet'||type==='wave') ? Math.sin(Math.PI*t) : 0;
    const dance = active && type==='dance' ? Math.sin(Math.PI*t) : 0;
    const listening = conversationStatus === 'listening' || conversationStatus === 'transcribing';
    const thinking = conversationStatus === 'thinking' || conversationStatus === 'responding';
    boneRotate('上半身',AXIS_X,Math.sin(now*1.7)*.025+gait*.035+dance*.08*Math.sin(now*5)+(listening?-.025:0));
    boneRotate('頭',AXIS_Y,pointerX*.12+(active&&type==='greet'?.08*Math.sin(now*5):0)+(thinking?.08*Math.sin(now*2.1):0));
    boneRotateWorld('腕R',AXIS_Z,.88-wave*1.93-dance*.55*(1+Math.sin(now*5))-gait*.16);
    boneRotateWorld('腕L',AXIS_Z,-.88+dance*.45*(1-Math.sin(now*5))+gait*.16);
    boneRotate('足DL',AXIS_X,gait*.21);
    boneRotate('足DR',AXIS_X,-gait*.21);
    if (now > blinkAt+.22) blinkAt = now+2.8+Math.random()*2.2;
    setMorph('まばたき',now>=blinkAt?Math.sin(Math.PI*clamp((now-blinkAt)/.22,0,1)):0);
    setMorph('にこり',Math.max(wave*.55+dance*.3,conversationEmotion==='happy'?.4:0));
    const pose = mouth.sample();
    for (const [vowel, name] of Object.entries(MOUTH_SHAPES)) setMorph(name,pose.weights[vowel]);
    const actualMouth = Object.fromEntries(Object.entries(MOUTH_SHAPES).map(([vowel,name])=>{
      const mesh = morphMeshes[0], index = mesh?.morphTargetDictionary?.[name];
      return [vowel,index===undefined?0:mesh.morphTargetInfluences?.[index]||0];
    }));
    const mouthMax = Math.max(...Object.values(actualMouth));
    canvas.dataset.voiced = String(pose.voiced);
    canvas.dataset.mouth = String(mouthMax);
    canvas.dataset.mouthWeights = JSON.stringify(actualMouth);
    if (window.__petStats) Object.assign(window.__petStats, {
      actualMouth,mouthMax,voiced:pose.voiced,
      audioEpoch:pose.epoch, incomingAudioFrame,
    });
    for (const root of skeletonRoots) root.updateMatrixWorld(true);
  }
  renderer.render(scene,camera);
}
render();

function resize() {
  renderer.setSize(innerWidth,innerHeight,false);
  camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
  frameAvatar(camera, modelBounds);
}
addEventListener('resize',resize); resize();
addEventListener('beforeunload', () => {
  disposed = true; modelGeneration += 1; unwatchAvatar();
  cancelAnimationFrame(animationFrame); clearTimeout(toastTimer);
  if (model) disposeAvatarScene(model);
  renderer.dispose(); renderer.forceContextLoss();
});

const gl = renderer.getContext(), pixel = new Uint8Array(4);
function hitModel(x,y) {
  if (!ready || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return false;
  const px = Math.floor(x*canvas.width/innerWidth);
  const py = Math.floor((innerHeight-y)*canvas.height/innerHeight);
  gl.readPixels(px,py,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
  return pixel[3] > 32;
}
window.__petPick = hitModel;
function isPanelTarget(target) { return !!target.closest?.('#chatPanel'); }
function updateHit(event) {
  const overModel = hitModel(event.clientX,event.clientY);
  const interactive = dragging || overModel || isPanelTarget(event.target);
  desktop.setInteractive(interactive);
  pointerX = overModel ? clamp((event.clientX/innerWidth-.5)*2,-1,1) : 0;
  return overModel;
}
addEventListener('mousemove',event => { updateHit(event); if (dragging) desktop.dragMove(); });
addEventListener('mouseleave',() => { if (!dragging) desktop.setInteractive(false); pointerX=0; });
addEventListener('mousedown',event => {
  if (event.button===0 && !isPanelTarget(event.target) && hitModel(event.clientX,event.clientY)) {
    dragging=true; desktop.setInteractive(true); desktop.dragStart(); event.preventDefault();
  }
});
addEventListener('mouseup',event => { if (event.button===0 && dragging) { dragging=false; desktop.dragEnd(); updateHit(event); } });
addEventListener('dblclick',event => { if (!isPanelTarget(event.target) && hitModel(event.clientX,event.clientY)) enqueue(['wave']); });
addEventListener('contextmenu',event => {
  if (hitModel(event.clientX,event.clientY) || isPanelTarget(event.target)) {
    event.preventDefault(); openChat();
  }
});

function openChat() { $('chatPanel').classList.remove('hidden'); desktop.setInteractive(true); $('promptInput').focus(); }
function closeChat() { $('chatPanel').classList.add('hidden'); $('promptInput').blur(); desktop.setInteractive(false); }
$('closeChat').addEventListener('click',closeChat);
addEventListener('keydown',event => { if (event.key==='Escape') closeChat(); });
function appendMessage(kind,message) {
  const el=document.createElement('div'); el.className=`message ${kind}`; el.textContent=message;
  $('chatLog').append(el); $('chatLog').scrollTop=$('chatLog').scrollHeight;
}
function submit(message) {
  if (!message.trim()) return;
  appendMessage('user',message.trim()); $('promptInput').value='';
  desktop.command('text',message.trim());
}
$('promptForm').addEventListener('submit',event=>{event.preventDefault();submit($('promptInput').value);});
$('voiceButton').addEventListener('click',()=>desktop.command('voice'));
$('openButton').addEventListener('click',()=>desktop.command('open'));
desktop.onState?.(state=>{
  conversationStatus=state.status||'idle';
  conversationEmotion=state.emotion||'neutral';
  if (state.error && state.error!==lastError) { lastError=state.error; toast(state.error,5500); }
  if (!state.error) lastError='';
  if (state.gestureId && state.gestureId!==lastGestureId && state.gesture && state.gesture!=='none') {
    lastGestureId=state.gestureId;
    enqueue([state.gesture]);
  }
  if (state.reply && state.reply!==lastReply) {
    lastReply=state.reply;
    appendMessage('aemeath',state.reply);
    toast(state.reply,5000);
  }
});

desktop.onAudioFrame?.(frame=>{
  if (mouth.push(frame)) incomingAudioFrame = frame;
});
