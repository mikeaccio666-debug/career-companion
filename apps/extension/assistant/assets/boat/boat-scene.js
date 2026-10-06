import * as THREE from 'three';

// All geometry, lighting and fallback artwork are local. No loaders or requests.
const instances = new WeakMap();
const SVG_NS = 'http://www.w3.org/2000/svg';
function fallbackArt(compact = false) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', compact ? '66 26 213 202' : '0 0 360 270');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'display:block;width:100%;height:100%';
  const shapes = [
    ['ellipse', {cx:180,cy:218,rx:95,ry:16,fill:'#A8C0DC',opacity:'.25'}],
    ['rect', {x:62,y:188,width:236,height:40,rx:20,fill:'#D5E5F3'}],
    ['path', {d:'M104 159 Q140 125 153 78 Q163 124 160 158 Z',fill:'#FFFEF9',stroke:'#A8C0DC','stroke-width':1.5}],
    ['path', {d:'M174 157 Q178 106 163 39 Q238 73 249 146 Z',fill:'#FFFEF9',stroke:'#A8C0DC','stroke-width':1.5}],
    ['path', {d:'M85 172 Q183 181 267 158 Q244 211 188 213 Q123 208 85 172Z',fill:'#FFFEF9',stroke:'#A8C0DC','stroke-width':1.5}],
    ['path', {d:'M94 173 Q184 182 257 163',fill:'none',stroke:'#0A1128','stroke-width':3,'stroke-linecap':'round'}],
    ['circle', {cx:239,cy:181,r:3,fill:'#FF9D4D'}]
  ];
  for (const [tag, attrs] of (compact ? shapes.slice(2) : shapes)) { const n=document.createElementNS(SVG_NS,tag); for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v)); svg.append(n); }
  return svg;
}
function silhouette(kind) {
  const s = new THREE.Shape();
  if(kind==='main') {
    s.moveTo(.06,.69); s.bezierCurveTo(.12,1.38,-.02,2.09,-.14,2.60);
    s.bezierCurveTo(.54,2.34,1.09,1.60,1.18,.86); s.quadraticCurveTo(.67,.75,.06,.69);
  } else if(kind==='jib') {
    s.moveTo(-1.04,.65);s.bezierCurveTo(-.61,1.07,-.38,1.55,-.28,1.99);
    s.bezierCurveTo(-.19,1.61,-.16,1.12,-.18,.68);s.quadraticCurveTo(-.60,.63,-1.04,.65);
  } else {
    s.moveTo(-1.38,.46);s.bezierCurveTo(-.51,.38,.68,.42,1.44,.73);
    s.bezierCurveTo(1.13,-.07,.43,-.35,-.22,-.19);s.bezierCurveTo(-.72,-.10,-1.13,.15,-1.38,.46);
  }
  return s;
}
function solid(shape,depth,bevel,mat) {
  const geo=new THREE.ExtrudeGeometry(shape,{depth,steps:1,curveSegments:28,bevelEnabled:true,bevelThickness:bevel,bevelSize:bevel,bevelSegments:4});
  geo.translate(0,0,-depth/2);
  const m=new THREE.Mesh(geo,mat);return m;
}
function roundedSquare(w,h,r) {
  const s=new THREE.Shape(),x=-w/2,y=-h/2;
  s.moveTo(x+r,y);s.lineTo(x+w-r,y);s.quadraticCurveTo(x+w,y,x+w,y+r);s.lineTo(x+w,y+h-r);s.quadraticCurveTo(x+w,y+h,x+w-r,y+h);s.lineTo(x+r,y+h);s.quadraticCurveTo(x,y+h,x,y+h-r);s.lineTo(x,y+r);s.quadraticCurveTo(x,y,x+r,y);return s;
}
function shadowTexture() {
  const n=64,data=new Uint8Array(n*n*4);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const radius=Math.hypot((x+.5-n/2)/(n/2),(y+.5-n/2)/(n/2));
    const i=(y*n+x)*4;data[i]=37;data[i+1]=57;data[i+2]=87;data[i+3]=Math.round(70*Math.pow(Math.max(0,1-radius),2));
  }
  const t=new THREE.DataTexture(data,n,n);t.needsUpdate=true;t.magFilter=THREE.LinearFilter;t.minFilter=THREE.LinearFilter;return t;
}
/** Mount into a host with explicit dimensions. The returned handle is idempotent. */
export function mountBoatScene(container,{reducedMotion=false,compact=false}={}) {
  if(!container || container.nodeType!==1)throw new TypeError('mountBoatScene requires a DOM element');
  instances.get(container)?.destroy();
  const root=document.createElement('div');
  root.style.cssText='width:100%;height:100%;position:relative;overflow:hidden;isolation:isolate;background:transparent;border-radius:inherit';
  root.setAttribute('role','img');root.setAttribute('aria-label','Argo 双帆陶瓷小船');
  root.dataset.argoBoat='initializing';container.append(root);
  let renderer,scene,camera,boat,stage,ro,io,texture;
  let destroyed=false,failed=false,paused=false,inView=true,isCompact=Boolean(compact),raf=0,lastFrame=0,elapsed=0,renderTime=0;
  let width=0,height=0;
  const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  const motionOff=()=>Boolean(reducedMotion)||media.matches;
  const stop=()=>{cancelAnimationFrame(raf);raf=0;lastFrame=0;};
  function releaseGPU(){
    const geos=new Set(),mats=new Set();
    scene?.traverse(o=>{if(o.geometry)geos.add(o.geometry);if(o.material)for(const m of [].concat(o.material))mats.add(m);});
    geos.forEach(g=>g.dispose());mats.forEach(m=>m.dispose());texture?.dispose();renderer?.dispose();
  }
  function fail(reason){
    if(destroyed||failed)return;failed=true;stop();
    releaseGPU();renderer?.domElement.remove();root.append(fallbackArt(isCompact));
    root.dataset.argoBoat='fallback';root.dataset.fallbackReason=reason;
    root.setAttribute('aria-label','Argo 双帆小船（静态备用图形）');
    container.dispatchEvent(new CustomEvent('argo-boat-fallback',{detail:{reason}}));
  }
  function draw(){
    if(destroyed||failed||!renderer||!width||!height)return;
    try{renderer.render(scene,camera);root.dataset.argoBoat='webgl';}catch{fail('render-failed');}
  }
  function allowed(){return !destroyed&&!failed&&!paused&&!motionOff()&&!document.hidden&&inView&&width>0&&height>0&&!isCompact;}
  function tick(now){
    raf=0;if(!allowed()){lastFrame=0;return;}
    if(!lastFrame)lastFrame=now;
    if(now-renderTime>=1000/30){
      elapsed+=Math.min((now-lastFrame)/1000,.08);lastFrame=now;renderTime=now;
      boat.position.y=.08+Math.sin(elapsed*.8)*.035;
      boat.rotation.z=Math.sin(elapsed*.58)*.018;
      boat.rotation.y=-.12+Math.sin(elapsed*.43)*.035;
      draw();
    }
    if(allowed())raf=requestAnimationFrame(tick);
  }
  function reconcile(){stop();if(allowed())raf=requestAnimationFrame(tick);}
  function resize(){
    if(destroyed||failed||!renderer)return;
    width=container.clientWidth;height=container.clientHeight;
    if(width>0&&height>0){
      const aspect=width/height;const span=isCompact?3.55:4.50;
      const vertical=Math.max(span,3.8/aspect);
      camera.left=-vertical*aspect/2;camera.right=vertical*aspect/2;camera.top=vertical/2;camera.bottom=-vertical/2;
      camera.updateProjectionMatrix();renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,isCompact?2:1.5));renderer.setSize(width,height,false);draw();
    }
    reconcile();
  }
  function setCompact(value){
    if(destroyed)return;isCompact=Boolean(value);root.dataset.compact=String(isCompact);
    if(failed){root.replaceChildren(fallbackArt(isCompact));return;}
    if(boat){stage.visible=!isCompact;boat.position.y=.08;boat.rotation.set(0,isCompact?-.06:-.12,0);camera.position.set(isCompact?2:3.4,isCompact?2.3:3.5,9);camera.lookAt(0,isCompact?1.15:1.0,0);}
    resize();
  }
  function changeMotion(){
    if(motionOff()&&boat){boat.position.y=.08;boat.rotation.z=0;boat.rotation.y=isCompact?-.06:-.12;draw();}reconcile();
  }
  function lost(e){e.preventDefault();fail('context-lost');}
  const api={setCompact,pause(){if(destroyed)return;paused=true;reconcile();},resume(){if(destroyed)return;paused=false;reconcile();},destroy(){
    if(destroyed)return;destroyed=true;stop();ro?.disconnect();io?.disconnect();
    document.removeEventListener('visibilitychange',reconcile);window.removeEventListener('resize',resize);media.removeEventListener('change',changeMotion);
    renderer?.domElement.removeEventListener('webglcontextlost',lost);if(!failed)releaseGPU();renderer?.forceContextLoss();root.remove();instances.delete(container);
  }};
  instances.set(container,api);
  try{
    renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power',failIfMajorPerformanceCaveat:false});
    renderer.setClearColor(0x000000,0);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.18;
    renderer.domElement.style.cssText='display:block;width:100%;height:100%;';renderer.domElement.setAttribute('aria-hidden','true');root.append(renderer.domElement);
    renderer.domElement.addEventListener('webglcontextlost',lost);
    scene=new THREE.Scene();camera=new THREE.OrthographicCamera(-3,3,2,-2,.1,30);
    scene.add(new THREE.HemisphereLight(0xf3f7ff,0xa8b5d0,2.5));
    const key=new THREE.DirectionalLight(0xfff5e7,3.8);key.position.set(-3,6,6);scene.add(key);
    const rim=new THREE.DirectionalLight(0xb3b8ea,1.35);rim.position.set(4,2,-3);scene.add(rim);
    const orange=new THREE.PointLight(0xff9d4d,.7,8,2);orange.position.set(-2,1,2);scene.add(orange);
    const ceramic=new THREE.MeshPhysicalMaterial({color:0xfffdf3,roughness:.32,metalness:0,clearcoat:.35,clearcoatRoughness:.28});
    const coolCeramic=new THREE.MeshPhysicalMaterial({color:0xecf2f5,roughness:.4,clearcoat:.28});
    const navy=new THREE.MeshStandardMaterial({color:0x0a1128,roughness:.48});
    const amber=new THREE.MeshStandardMaterial({color:0xff9d4d,roughness:.36});
    boat=new THREE.Group();scene.add(boat);
    boat.add(solid(silhouette('main'),.075,.04,ceramic));
    const jib=solid(silhouette('jib'),.065,.038,coolCeramic);jib.position.z=.035;boat.add(jib);
    boat.add(solid(silhouette('hull'),.52,.10,ceramic));
    // Thin navy gunwale follows the reference's rising bow; no heavy outline.
    const gunwale=new THREE.CubicBezierCurve3(new THREE.Vector3(-1.28,.46,.36),new THREE.Vector3(-.42,.39,.36),new THREE.Vector3(.62,.43,.36),new THREE.Vector3(1.35,.70,.32));
    boat.add(new THREE.Mesh(new THREE.TubeGeometry(gunwale,48,.017,8,false),navy));
    const badge=new THREE.Mesh(new THREE.SphereGeometry(.041,12,8),amber);badge.scale.z=.24;badge.position.set(.96,.29,.371);boat.add(badge);
    stage=new THREE.Group();scene.add(stage);
    const base=solid(roundedSquare(3.9,2.3,.42),.17,.10,new THREE.MeshPhysicalMaterial({color:0xd4e5f3,roughness:.23,metalness:.04,clearcoat:.6,clearcoatRoughness:.2}));
    base.rotation.x=-Math.PI/2;base.position.y=-.54;stage.add(base);
    const top=solid(roundedSquare(3.72,2.12,.37),.024,.035,new THREE.MeshPhysicalMaterial({color:0xe2edf7,roughness:.36,clearcoat:.5}));top.rotation.x=-Math.PI/2;top.position.y=-.40;stage.add(top);
    texture=shadowTexture();
    for(const [y,sx,sz,opacity] of [[-.348,3.1,1.55,1],[-.76,4.7,2.8,.65]]){
      const shadow=new THREE.Mesh(new THREE.PlaneGeometry(sx,sz),new THREE.MeshBasicMaterial({map:texture,transparent:true,opacity,depthWrite:false}));shadow.rotation.x=-Math.PI/2;shadow.position.y=y;stage.add(shadow);
    }
    const wakeMat=new THREE.MeshStandardMaterial({color:0xa8c0dc,transparent:true,opacity:.37,roughness:.6});
    for(const z of [.66,-.55]){
      const line=new THREE.CubicBezierCurve3(new THREE.Vector3(-1.13,-.34,z),new THREE.Vector3(-.46,-.34,z+.22),new THREE.Vector3(.15,-.34,z-.13),new THREE.Vector3(.88,-.34,z+.03));
      stage.add(new THREE.Mesh(new THREE.TubeGeometry(line,30,.009,6,false),wakeMat));
    }
    setCompact(isCompact);
    ro=new ResizeObserver(resize);ro.observe(container);
    if('IntersectionObserver'in window){io=new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;reconcile();});io.observe(container);}
    document.addEventListener('visibilitychange',reconcile);window.addEventListener('resize',resize);media.addEventListener('change',changeMotion);
  }catch{fail('webgl-unavailable');}
  return api;
}
if(typeof window!=='undefined')window.mountArgoBoatScene=mountBoatScene;
