const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { user: null, googleAuthEnabled: false, antivirus: null, mods: [], servers: [], skins: [], activePage: 'inicio', activeServer: null, socket: null, mirror: false, tool: 'brush', drawing: false, history: [], worldDb: null };

function toast(message) {
  const node = $('#toast'); node.textContent = message; node.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 3000);
}
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function api(url, options = {}) {
  const response = await fetch(url, options);
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || data || `Error ${response.status}`);
  return data;
}
function authRequired() {
  if (state.user) return true;
  toast('Inicia sesión con Google para continuar.');
  if (state.googleAuthEnabled) window.location.href = window.MCREDHUB ? '/auth/google?client=android' : '/auth/google';
  else toast('El inicio con Google debe configurarse en el servidor. Consulta README.md.');
  return false;
}
function setUser(user) {
  state.user = user;
  const button = $('#authButton'); const badge = $('#userBadge');
  if (user) {
    button.classList.add('hidden'); badge.classList.remove('hidden');
    badge.innerHTML = `${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="">` : '<span class="avatar-fallback">●</span>'}<span>${escapeHtml(user.name)}</span><button type="button" id="logoutButton">Salir</button>`;
    $('#logoutButton').addEventListener('click', async e => { e.stopPropagation(); try { await api('/auth/logout', { method:'POST' }); setUser(null); toast('Sesión cerrada.'); if (state.socket) state.socket.disconnect(); } catch (err) { toast(err.message); } });
  } else { button.classList.remove('hidden'); badge.classList.add('hidden'); badge.innerHTML = ''; }
  $('#chatLoginNotice').classList.toggle('hidden', Boolean(user));
  $('#settingsAuth').textContent = user ? `Sesión: ${user.name}` : 'Iniciar sesión';
}
function navigate(page) {
  if (!$('#page-' + page)) page = 'inicio';
  state.activePage = page;
  $$('.page').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $$('[data-page-link]').forEach(el => el.classList.toggle('active', el.dataset.pageLink === page));
  if (page === 'chat') renderChatServers();
  window.scrollTo({ top:0, behavior:'smooth' });
}
$$('[data-page-link]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.pageLink)));
$$('[data-go]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.go)));
$('#authButton').addEventListener('click', () => authRequired());
$('#settingsAuth').addEventListener('click', () => { if (!state.user) authRequired(); });

async function init() {
  try {
    const [config, me] = await Promise.all([api('/api/config'), api('/api/me')]);
    state.googleAuthEnabled = config.googleAuthEnabled;
    state.antivirus = config.antivirus || null;
    const avText = $('#antivirusStatus'); const avPill = $('#antivirusPill');
    if (avText && avPill) {
      const avReady = Boolean(state.antivirus?.ready);
      avText.textContent = avReady ? 'ClamAV y sus firmas están disponibles. Los archivos subidos se analizan antes de guardarse.' : (state.antivirus?.required === false ? 'ClamAV no está listo y el análisis obligatorio está desactivado. No publiques archivos desde este servidor.' : 'ClamAV o sus firmas no están listos. Las subidas permanecen bloqueadas.');
      avPill.textContent = avReady ? 'PROTECCIÓN ACTIVA' : 'NO CONFIGURADO';
      avPill.style.background = avReady ? '#1d3328' : '#48202a'; avPill.style.color = avReady ? '#80d6a1' : '#ff8792';
    }
    setUser(me.user);
    $('#connectionStatus').textContent = 'El servidor web respondió correctamente. El catálogo se consulta en línea.';
    $('#connectionPill').textContent = 'CONECTADO';
  } catch (err) {
    $('#connectionStatus').textContent = 'No se pudo conectar con el servidor. Comprueba que el proyecto esté desplegado y en ejecución.';
    $('#connectionPill').textContent = 'SIN CONEXIÓN'; $('#connectionPill').style.background = '#48202a'; $('#connectionPill').style.color = '#ff8792';
  }
  await Promise.all([loadMods(), loadServers(), loadSkins()]);
  await initWorldStore();
  initSkinEditor();
  if (window.io) initSocket();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const params = new URLSearchParams(location.search);
  if (params.get('auth') === 'failed') toast('No se pudo iniciar sesión con Google.');
  if (params.get('auth') === 'not-configured') toast('Google aún no está configurado.');
}

// MODS
const modSymbol = category => ({Addon:'✧',Texturas:'▧',Comportamiento:'⚙',Mapa:'⌖',Herramientas:'⌘',Otro:'▦'}[category] || '▦');
function modCard(mod) {
  return `<article class="mod-card"><div class="mod-art" ${mod.coverUrl ? `style="background-image:linear-gradient(#0004,#0006),url('${escapeHtml(mod.coverUrl)}');background-size:cover;background-position:center"` : ''}><span class="mod-tag">${escapeHtml(mod.category)}</span>${mod.coverUrl ? '' : `<span class="mod-symbol">${modSymbol(mod.category)}</span>`}</div><div class="mod-body"><h3>${escapeHtml(mod.title)}</h3><p>${escapeHtml(mod.description)}</p><div class="meta-row"><span>Bedrock ${escapeHtml(mod.version)}</span><span>${mod.file_size ? formatBytes(mod.file_size) : 'Enlace externo'}</span><span>${new Date(mod.created_at).toLocaleDateString('es')}</span></div><div class="mod-footer"><span class="mod-author">Por ${escapeHtml(mod.author)}</span><a class="download-mini" href="${escapeHtml(mod.downloadUrl)}">Descargar ↓</a></div></div></article>`;
}
function renderMods() {
  const list = state.mods;
  const markup = list.length ? list.map(modCard).join('') : '<div class="empty-card">Aún no hay mods publicados. Sé el primero en compartir uno con la comunidad.</div>';
  $('#modList').innerHTML = markup;
  $('#homeMods').innerHTML = list.slice(0,3).length ? list.slice(0,3).map(modCard).join('') : '<div class="empty-card">El catálogo está listo para recibir sus primeras publicaciones.</div>';
  $('#statMods').textContent = String(list.length);
}
async function loadMods() {
  try {
    const params = new URLSearchParams({ q:$('#modSearch')?.value || '', version:$('#modVersion')?.value || '', category:$('#modCategory')?.value || '', sort:$('#modSort')?.value || 'recent' });
    const result = await api('/api/mods?' + params.toString()); state.mods = result.mods || []; renderMods();
  } catch (err) { $('#modList').innerHTML = `<div class="empty-card">No se pudo cargar el catálogo: ${escapeHtml(err.message)}</div>`; }
}
let modSearchTimer;
['modSearch','modVersion','modCategory','modSort'].forEach(id => $('#' + id).addEventListener(id === 'modSearch' ? 'input' : 'change', () => { clearTimeout(modSearchTimer); modSearchTimer = setTimeout(loadMods, 200); }));
$('#showModForm').addEventListener('click', () => $('#modForm').classList.remove('hidden'));
$('#hideModForm').addEventListener('click', () => $('#modForm').classList.add('hidden'));
$('#modForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget; const data = new FormData(form); const message = $('#modFormMessage'); message.textContent = 'Publicando…';
  try { await api('/api/mods', { method:'POST', body:data }); form.reset(); message.textContent = '¡Publicación creada!'; await loadMods(); toast('Mod publicado correctamente.'); }
  catch (err) { message.textContent = err.message; }
});

// WORLD BACKUPS: kept in IndexedDB on this browser/device, not uploaded to the site.
function initWorldStore() {
  return new Promise(resolve => {
    if (!('indexedDB' in window)) { $('#worldList').innerHTML = '<div class="empty-card">Este navegador no permite guardar copias localmente.</div>'; return resolve(); }
    const request = indexedDB.open('mc-red-hub-worlds', 1);
    request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath:'id' }); };
    request.onsuccess = () => { state.worldDb = request.result; renderWorlds().finally(resolve); };
    request.onerror = () => { $('#worldList').innerHTML = '<div class="empty-card">No se pudo iniciar el almacenamiento local de copias.</div>'; resolve(); };
  });
}
function worldTransaction(mode, callback) {
  return new Promise((resolve,reject) => { const tx = state.worldDb.transaction('worlds', mode); const store = tx.objectStore('worlds'); const result = callback(store); tx.oncomplete = () => resolve(result?.result); tx.onerror = () => reject(tx.error); });
}
async function getAllWorlds() { return new Promise((resolve,reject) => { const req = state.worldDb.transaction('worlds').objectStore('worlds').getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
$('#worldInput').addEventListener('change', async event => {
  const files = [...event.target.files]; if (!state.worldDb) return toast('El almacenamiento local no está disponible.');
  for (const file of files) {
    const ext = file.name.toLowerCase().split('.').pop(); if (!['mcworld','zip'].includes(ext)) { toast('Solo se aceptan archivos .mcworld y .zip.'); continue; }
    if (file.size > 1024 * 1024 * 1024) { toast('El archivo supera 1 GB y no se guardó.'); continue; }
    await worldTransaction('readwrite', store => store.put({ id:crypto.randomUUID(), name:file.name.replace(/\.(mcworld|zip)$/i,''), fileName:file.name, type:ext, size:file.size, addedAt:new Date().toISOString(), blob:file }));
  }
  event.target.value = ''; await renderWorlds(); toast('Copia guardada en este navegador.');
});
function formatBytes(bytes) { if (!bytes) return '0 MB'; const units=['B','KB','MB','GB']; const i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),3); return `${(bytes/Math.pow(1024,i)).toFixed(i>1?1:0)} ${units[i]}`; }
async function renderWorlds() {
  if (!state.worldDb) return;
  const worlds = (await getAllWorlds()).sort((a,b)=>b.addedAt.localeCompare(a.addedAt));
  $('#worldCount').textContent = worlds.length; $('#worldSize').textContent = formatBytes(worlds.reduce((sum,w)=>sum+w.size,0));
  $('#worldList').innerHTML = worlds.length ? worlds.map(w => `<div class="world-item"><div class="world-icon">▣</div><div class="world-info"><b>${escapeHtml(w.name)}</b><small>${escapeHtml(w.fileName)} · ${formatBytes(w.size)} · ${new Date(w.addedAt).toLocaleDateString('es')}</small></div><div class="world-actions"><button data-world-download="${w.id}">Descargar</button><button data-world-delete="${w.id}">Eliminar</button></div></div>`).join('') : '<div class="empty-card">Todavía no has guardado copias. Importa tu primer .mcworld o .zip.</div>';
  $$('[data-world-download]').forEach(btn => btn.addEventListener('click', async () => { const w=(await getAllWorlds()).find(x=>x.id===btn.dataset.worldDownload); if (w) downloadBlob(w.blob,w.fileName); }));
  $$('[data-world-delete]').forEach(btn => btn.addEventListener('click', async () => { if (!confirm('¿Eliminar esta copia de este navegador?')) return; await worldTransaction('readwrite',s=>s.delete(btn.dataset.worldDelete)); renderWorlds(); }));
}
function downloadBlob(blob,name) { const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500); }

// SKIN 3D LAB: modelo giratorio y textura UV Bedrock 64x64.
const canvas = $('#skinCanvas'); let ctx, currentColor = '#b72b35', skinSnapshot = null;
const paletteColors = ['#191919','#ffffff','#b72b35','#ea6a36','#f3c64e','#6c9c54','#3a9a9f','#4287c8','#4441a5','#7046a3','#bd6ca4','#e8a1a9','#70412e','#ae8054','#e1c49a','#f0d7b7','#373b42','#777e8a','#b6bbc4','#f0f1f4','#7e1421','#d52638','#f35a69','#ff9ca4'];
let skinRotX=-7, skinRotY=-25, skinZoom=1.8, skinDragging=false, skinDragStart=null, skinTextureFrame=0, skinPointers=new Map(), pinchStartDistance=0, pinchStartZoom=1;
const skinPixel=4;
const skinParts = [
  {id:'head',x:64,y:0,w:8,h:8,d:8,base:{front:[8,8,8,8],back:[24,8,8,8],right:[0,8,8,8],left:[16,8,8,8],top:[8,0,8,8],bottom:[16,0,8,8]},outer:{front:[40,8,8,8],back:[56,8,8,8],right:[32,8,8,8],left:[48,8,8,8],top:[40,0,8,8],bottom:[48,0,8,8]}},
  {id:'body',x:64,y:32,w:8,h:12,d:4,base:{front:[20,20,8,12],back:[32,20,8,12],right:[16,20,4,12],left:[28,20,4,12],top:[20,16,8,4],bottom:[28,16,8,4]},outer:{front:[20,36,8,12],back:[32,36,8,12],right:[16,36,4,12],left:[28,36,4,12],top:[20,32,8,4],bottom:[28,32,8,4]}},
  {id:'right-arm',x:48,y:32,w:4,h:12,d:4,base:{front:[44,20,4,12],back:[52,20,4,12],right:[40,20,4,12],left:[48,20,4,12],top:[44,16,4,4],bottom:[48,16,4,4]},outer:{front:[44,36,4,12],back:[52,36,4,12],right:[40,36,4,12],left:[48,36,4,12],top:[44,32,4,4],bottom:[48,32,4,4]}},
  {id:'left-arm',x:96,y:32,w:4,h:12,d:4,base:{front:[36,52,4,12],back:[44,52,4,12],right:[32,52,4,12],left:[40,52,4,12],top:[36,48,4,4],bottom:[40,48,4,4]},outer:{front:[52,52,4,12],back:[60,52,4,12],right:[48,52,4,12],left:[56,52,4,12],top:[52,48,4,4],bottom:[56,48,4,4]}},
  {id:'right-leg',x:64,y:80,w:4,h:12,d:4,base:{front:[4,20,4,12],back:[12,20,4,12],right:[0,20,4,12],left:[8,20,4,12],top:[4,16,4,4],bottom:[8,16,4,4]},outer:{front:[4,36,4,12],back:[12,36,4,12],right:[0,36,4,12],left:[8,36,4,12],top:[4,32,4,4],bottom:[8,32,4,4]}},
  {id:'left-leg',x:80,y:80,w:4,h:12,d:4,base:{front:[20,52,4,12],back:[28,52,4,12],right:[16,52,4,12],left:[24,52,4,12],top:[20,48,4,4],bottom:[24,48,4,4]},outer:{front:[4,52,4,12],back:[12,52,4,12],right:[0,52,4,12],left:[8,52,4,12],top:[4,48,4,4],bottom:[8,48,4,4]}}
];
function buildSkinPart(part, outer=false){
  const layer=outer?'outer':'base', rects=part[layer]; if(!rects)return '';
  const inflate=outer?0.45:0, w=(part.w+inflate)*skinPixel,h=(part.h+inflate)*skinPixel,d=(part.d+inflate)*skinPixel;
  const ox=outer?inflate*skinPixel/2:0, oy=outer?inflate*skinPixel/2:0;
  const faces=[
    ['front',w,h,0,0,`translateZ(${d/2}px)`],['back',w,h,0,0,`rotateY(180deg) translateZ(${d/2}px)`],
    ['right',d,h,(w-d)/2,0,`rotateY(90deg) translateZ(${w/2}px)`],['left',d,h,(w-d)/2,0,`rotateY(-90deg) translateZ(${w/2}px)`],
    ['top',w,d,0,(h-d)/2,`rotateX(90deg) translateZ(${h/2}px)`],['bottom',w,d,0,(h-d)/2,`rotateX(-90deg) translateZ(${h/2}px)`]
  ];
  const html=faces.map(([face,fw,fh,left,top,transform])=>{const r=rects[face];return `<div class="skin3d-face" data-part="${part.id}" data-layer="${layer}" data-face="${face}" style="width:${fw}px;height:${fh}px;left:${left+ox}px;top:${top+oy}px;transform:${transform};background-position:${-r[0]*skinPixel}px ${-r[1]*skinPixel}px"></div>`;}).join('');
  return `<div class="skin3d-part ${outer?'outer-layer':''}" data-part-wrap="${part.id}" style="left:${part.x-ox}px;top:${part.y-oy}px;width:${w}px;height:${h}px">${html}</div>`;
}
function createSkinModel(){
  const model=$('#skin3dModel'); if(!model)return;
  model.innerHTML=skinParts.map(p=>buildSkinPart(p,false)+buildSkinPart(p,true)).join('');
  model.querySelectorAll('.skin3d-face').forEach(face=>{face.style.backgroundSize='256px 256px';});
  applySkinModelTransform(); refreshSkinModelTexture();
}
function applySkinModelTransform(){const model=$('#skin3dModel');if(model)model.style.transform=`rotateX(${skinRotX}deg) rotateY(${skinRotY}deg) scale(${skinZoom})`;}
function refreshSkinModelTexture(){
  if(!ctx)return; const tiny=document.createElement('canvas');tiny.width=64;tiny.height=64;const tctx=tiny.getContext('2d');tctx.imageSmoothingEnabled=false;tctx.drawImage(canvas,0,0,64,64);const url=`url("${tiny.toDataURL('image/png')}")`;
  $$('.skin3d-face').forEach(face=>{face.style.backgroundImage=url;});
}
function scheduleSkinModelTexture(){if(skinTextureFrame)return;skinTextureFrame=requestAnimationFrame(()=>{skinTextureFrame=0;refreshSkinModelTexture();});}
function seedDefaultSkin(){
  ctx.clearRect(0,0,512,512);
  const rect=(x,y,w,h,c)=>{ctx.fillStyle=c;ctx.fillRect(x*8,y*8,w*8,h*8);};
  // Cabeza y piel
  [[8,8,8,8],[24,8,8,8],[0,8,8,8],[16,8,8,8],[8,0,8,8],[16,0,8,8]].forEach(r=>rect(...r,'#d7a276'));
  rect(8,0,8,4,'#39251e');rect(0,8,8,2,'#39251e');rect(8,8,8,2,'#39251e');rect(24,8,8,8,'#39251e');
  // Camisa roja
  [[20,20,8,12],[32,20,8,12],[16,20,4,12],[28,20,4,12],[20,16,8,4],[28,16,8,4]].forEach(r=>rect(...r,'#a91f34'));
  // Brazos y manos
  [[44,20,4,7],[52,20,4,7],[40,20,4,7],[48,20,4,7],[36,52,4,7],[44,52,4,7],[32,52,4,7],[40,52,4,7]].forEach(r=>rect(...r,'#a91f34'));
  [[44,27,4,5],[52,27,4,5],[40,27,4,5],[48,27,4,5],[36,59,4,5],[44,59,4,5],[32,59,4,5],[40,59,4,5]].forEach(r=>rect(...r,'#d7a276'));
  // Pantalones oscuros
  [[4,20,4,12],[12,20,4,12],[0,20,4,12],[8,20,4,12],[20,52,4,12],[28,52,4,12],[16,52,4,12],[24,52,4,12]].forEach(r=>rect(...r,'#252b3a'));
  scheduleSkinModelTexture();
}
function initSkinEditor() {
  if(!canvas)return; ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.imageSmoothingEnabled=false;seedDefaultSkin();
  const palette=$('#palette');palette.innerHTML=paletteColors.map(color=>`<button type="button" style="background:${color}" data-color="${color}" title="${color}"></button>`).join('');
  $$('[data-color]',palette).forEach(b=>b.addEventListener('click',()=>setSkinColor(b.dataset.color)));
  $('#skinColor').addEventListener('input',e=>setSkinColor(e.target.value));
  $$('.skin-tool[data-tool]').forEach(button=>button.addEventListener('click',()=>{state.tool=button.dataset.tool;$$('.skin-tool[data-tool]').forEach(b=>b.classList.toggle('active',b===button));}));
  $('#mirrorTool').addEventListener('click',()=>{state.mirror=!state.mirror;$('#mirrorTool').classList.toggle('active',state.mirror);toast(state.mirror?'Simetría activada':'Simetría desactivada');});
  $('#undoSkin').addEventListener('click',undoSkin);$('#clearSkin').addEventListener('click',()=>{pushSkinHistory();ctx.clearRect(0,0,512,512);scheduleSkinModelTexture();});
  canvas.addEventListener('pointerdown',skinPointerDown);canvas.addEventListener('pointermove',skinPointerMove);window.addEventListener('pointerup',()=>{state.drawing=false;scheduleSkinModelTexture();});
  $('#loadSkinFile').addEventListener('click',()=>$('#skinFileInput').click());$('#skinFileInput').addEventListener('change',loadSkinFile);
  $('#downloadSkin').addEventListener('click',downloadEditedSkin);$('#publishSkin').addEventListener('click',publishSkin);
  createSkinModel();initSkin3DControls();pushSkinHistory();
}
function initSkin3DControls(){
  const stage=$('#skin3dStage');
  const setZoom=value=>{skinZoom=Math.max(1.1,Math.min(2.5,value));$('#skinZoom').value=skinZoom;applySkinModelTransform();};
  stage.addEventListener('pointerdown',e=>{
    if(e.target.closest('button,label,input'))return;
    stage.setPointerCapture(e.pointerId);skinPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(skinPointers.size===2){const pts=[...skinPointers.values()];pinchStartDistance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y));pinchStartZoom=skinZoom;skinDragging=false;skinDragStart=null;}
    else{skinDragging=true;skinDragStart={x:e.clientX,y:e.clientY,rx:skinRotX,ry:skinRotY};}
  });
  stage.addEventListener('pointermove',e=>{
    if(!skinPointers.has(e.pointerId))return;skinPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(skinPointers.size>=2){const pts=[...skinPointers.values()];const distance=Math.max(1,Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y));setZoom(pinchStartZoom*distance/pinchStartDistance);return;}
    if(!skinDragging||!skinDragStart)return;skinRotY=skinDragStart.ry+(e.clientX-skinDragStart.x)*.65;skinRotX=Math.max(-55,Math.min(55,skinDragStart.rx-(e.clientY-skinDragStart.y)*.45));applySkinModelTransform();
  });
  const stop=e=>{skinPointers.delete(e.pointerId);if(skinPointers.size===1){const remaining=[...skinPointers.values()][0];skinDragging=true;skinDragStart={x:remaining.x,y:remaining.y,rx:skinRotX,ry:skinRotY};}else if(!skinPointers.size){skinDragging=false;skinDragStart=null;}};
  stage.addEventListener('pointerup',stop);stage.addEventListener('pointercancel',stop);stage.addEventListener('lostpointercapture',stop);
  stage.addEventListener('wheel',e=>{e.preventDefault();setZoom(skinZoom+(e.deltaY<0?.1:-.1));},{passive:false});
  $('#skinZoom').addEventListener('input',e=>{skinZoom=Number(e.target.value);applySkinModelTransform();});
  $$('[data-skin-view]').forEach(button=>button.addEventListener('click',()=>{const view=button.dataset.skinView;skinRotX=-7;skinRotY=view==='front'?0:view==='side'?90:180;$$('[data-skin-view]').forEach(b=>b.classList.toggle('active',b===button));applySkinModelTransform();}));
  $('#skinLayerToggle').addEventListener('change',e=>{$$('.skin3d-part.outer-layer').forEach(part=>part.style.display=e.target.checked?'block':'none');});
}
function setSkinColor(color){currentColor=color;$('#skinColor').value=color;$('#colorHex').textContent=color.toUpperCase();}
function pushSkinHistory(){if(!ctx)return;state.history.push(ctx.getImageData(0,0,512,512));if(state.history.length>25)state.history.shift();}
function undoSkin(){if(state.history.length<2)return toast('No hay más cambios para deshacer.');state.history.pop();ctx.putImageData(state.history[state.history.length-1],0,0);scheduleSkinModelTexture();}
function pixelFromEvent(event){const rect=canvas.getBoundingClientRect();return {x:Math.min(63,Math.max(0,Math.floor((event.clientX-rect.left)/rect.width*64))),y:Math.min(63,Math.max(0,Math.floor((event.clientY-rect.top)/rect.height*64)))};}
function paintPixel(x,y){const paint=px=>{if(state.tool==='eraser')ctx.clearRect(px*8,y*8,8,8);else{ctx.fillStyle=currentColor;ctx.fillRect(px*8,y*8,8,8);}};paint(x);if(state.mirror&&x!==63-x)paint(63-x);scheduleSkinModelTexture();}
function skinPointerDown(event){event.preventDefault();if(state.tool==='fill'){pushSkinHistory();const p=pixelFromEvent(event);floodFill(p.x,p.y,currentColor);return;}state.drawing=true;canvas.setPointerCapture(event.pointerId);pushSkinHistory();const p=pixelFromEvent(event);paintPixel(p.x,p.y);}
function skinPointerMove(event){if(!state.drawing)return;const p=pixelFromEvent(event);paintPixel(p.x,p.y);}
function floodFill(x,y,color){const image=ctx.getImageData(0,0,512,512),d=image.data;const idx=(x,y)=>(y*8*512+x*8)*4;const start=idx(x,y);const target=[d[start],d[start+1],d[start+2],d[start+3]],replacement=[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16),255];if(target.every((v,i)=>v===replacement[i]))return;const stack=[[x,y]],seen=new Set();while(stack.length){const [px,py]=stack.pop();if(px<0||px>63||py<0||py>63)continue;const key=py*64+px;if(seen.has(key))continue;seen.add(key);const pos=idx(px,py);let match=true;for(let c=0;c<4;c++)if(d[pos+c]!==target[c])match=false;if(!match)continue;for(let dy=0;dy<8;dy++)for(let dx=0;dx<8;dx++)for(let c=0;c<4;c++)d[pos+(dy*512+dx)*4+c]=replacement[c];stack.push([px+1,py],[px-1,py],[px,py+1],[px,py-1]);}ctx.putImageData(image,0,0);scheduleSkinModelTexture();}
function loadSkinFile(event){const file=event.target.files?.[0];if(!file)return;if(file.type!=='image/png'){toast('Selecciona una imagen PNG.');event.target.value='';return;}const img=new Image();const objectUrl=URL.createObjectURL(file);img.onload=()=>{if(!((img.naturalWidth===64&&img.naturalHeight===32)||(img.naturalWidth===64&&img.naturalHeight===64))){URL.revokeObjectURL(objectUrl);toast('La skin debe medir 64×64 o 64×32 píxeles.');return;}pushSkinHistory();ctx.clearRect(0,0,512,512);ctx.imageSmoothingEnabled=false;ctx.drawImage(img,0,0,512,img.naturalHeight===32?256:512);URL.revokeObjectURL(objectUrl);scheduleSkinModelTexture();toast('Skin cargada en el modelo 3D.');};img.onerror=()=>{URL.revokeObjectURL(objectUrl);toast('No se pudo abrir el PNG.');};img.src=objectUrl;event.target.value='';}
function exportSkinBlob(){const small=document.createElement('canvas');small.width=64;small.height=64;const sctx=small.getContext('2d');sctx.imageSmoothingEnabled=false;sctx.drawImage(canvas,0,0,64,64);return new Promise(resolve=>small.toBlob(resolve,'image/png'));}
async function downloadEditedSkin(){const blob=await exportSkinBlob();downloadBlob(blob,'mi-skin-bedrock.png');}
async function publishSkin(){if(!authRequired())return;const name=$('#skinName').value.trim()||'Skin de la comunidad',blob=await exportSkinBlob(),file=new File([blob],'skin.png',{type:'image/png'}),data=new FormData();data.append('name',name);data.append('file',file);$('#skinMessage').textContent='Analizando y subiendo skin…';try{await api('/api/skins',{method:'POST',body:data});$('#skinMessage').textContent='¡Tu skin se publicó!';toast('Skin compartida con la comunidad.');await loadSkins();}catch(err){$('#skinMessage').textContent=err.message;}}
async function loadSkins(){try{const result=await api('/api/skins');state.skins=result.skins||[];$('#statSkins').textContent=state.skins.length;$('#skinGalleryCount').textContent=`${state.skins.length} skins`;$('#skinGallery').innerHTML=state.skins.length?state.skins.map(s=>`<article class="skin-card"><div class="skin-preview"><img src="${escapeHtml(s.imageUrl)}" alt="Skin ${escapeHtml(s.name)}" loading="lazy"></div><b>${escapeHtml(s.name)}</b><small>Por ${escapeHtml(s.author)}</small><div class="skin-card-actions"><button data-skin-edit="${s.id}">Abrir en editor</button><button data-skin-download="${s.id}" style="margin-top:6px">Descargar PNG ↓</button></div></article>`).join(''):'<div class="empty-card">Todavía no hay skins publicadas. ¡Sé el primero!</div>';
  $$('[data-skin-edit]').forEach(btn=>btn.addEventListener('click',()=>loadSkinIntoEditor(btn.dataset.skinEdit)));$$('[data-skin-download]').forEach(btn=>btn.addEventListener('click',()=>{const skin=state.skins.find(x=>x.id===btn.dataset.skinDownload);if(skin)window.location.href=skin.downloadUrl;}));
}catch(err){$('#skinGallery').innerHTML=`<div class="empty-card">No se pudo cargar la galería: ${escapeHtml(err.message)}</div>`;}}
async function loadSkinIntoEditor(id){const skin=state.skins.find(x=>x.id===id);if(!skin)return;const img=new Image();img.onload=()=>{pushSkinHistory();ctx.clearRect(0,0,512,512);ctx.imageSmoothingEnabled=false;ctx.drawImage(img,0,0,512,512);$('#skinName').value=skin.name+' (copia)';scheduleSkinModelTexture();$('#skinUvDetails').open=true;navigate('skins');toast('Skin abierta en el editor 3D.');};img.onerror=()=>toast('No se pudo abrir esta skin.');img.src=skin.imageUrl;}

// SERVERS + CREATOR CHAT
function renderServers(){const q=$('#serverSearch').value.toLowerCase();const version=$('#serverVersion').value.toLowerCase();const filtered=state.servers.filter(s=>(`${s.name} ${s.description} ${s.creator}`.toLowerCase().includes(q))&&(!version||s.version.toLowerCase().includes(version)));
  $('#serverList').innerHTML=filtered.length?filtered.map(s=>`<article class="server-card"><div class="server-top"><div style="display:flex;gap:11px;align-items:center"><div class="server-icon">⌘</div><div><h3>${escapeHtml(s.name)}</h3><small style="color:#89909a;font-size:9px">${escapeHtml(s.address)} : ${s.port}</small></div></div><span class="bedrock-tag">BEDROCK</span></div><p class="server-desc">${escapeHtml(s.description)}</p><div class="server-data"><span>Versión ${escapeHtml(s.version)}</span><span>Puerto ${s.port}</span></div><div class="server-requirements"><b>Requisitos:</b> ${escapeHtml(s.requirements||'El creador no indicó requisitos.')}</div><div class="server-footer"><span class="server-creator">Creador: ${escapeHtml(s.creator)}</span><div class="server-buttons"><button data-copy-server="${s.id}">Copiar IP</button><button class="chat-open" data-chat-server="${s.id}">Chat ↗</button></div></div></article>`).join(''):'<div class="empty-card">No hay servidores que coincidan con tu búsqueda. Puedes publicar el primero.</div>';
  $('#statServers').textContent=String(state.servers.length);
  $$('[data-copy-server]').forEach(btn=>btn.addEventListener('click',async()=>{const s=state.servers.find(x=>x.id===btn.dataset.copyServer);if(!s)return;try{await navigator.clipboard.writeText(`${s.address}:${s.port}`);toast('Dirección copiada.');}catch{toast(`${s.address}:${s.port}`);}}));
  $$('[data-chat-server]').forEach(btn=>btn.addEventListener('click',()=>openChat(btn.dataset.chatServer)));
  renderChatServers();
}
async function loadServers(){try{const result=await api('/api/servers');state.servers=result.servers||[];renderServers();}catch(err){$('#serverList').innerHTML=`<div class="empty-card">No se pudieron cargar los servidores: ${escapeHtml(err.message)}</div>`;}}
$('#serverSearch').addEventListener('input',renderServers);$('#serverVersion').addEventListener('change',renderServers);
$('#showServerForm').addEventListener('click',()=>{if(authRequired())$('#serverForm').classList.remove('hidden');});$('#hideServerForm').addEventListener('click',()=>$('#serverForm').classList.add('hidden'));
$('#serverForm').addEventListener('submit',async event=>{event.preventDefault();if(!authRequired())return;const data=Object.fromEntries(new FormData(event.currentTarget).entries());$('#serverFormMessage').textContent='Publicando…';try{await api('/api/servers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});event.currentTarget.reset();$('#serverFormMessage').textContent='Servidor publicado.';await loadServers();toast('Servidor agregado.');}catch(err){$('#serverFormMessage').textContent=err.message;}});
function renderChatServers(){if(!state.servers.length){$('#chatServerList').innerHTML='No hay servidores publicados todavía.';return;}$('#chatServerList').innerHTML=state.servers.map(s=>`<button data-chat-pick="${s.id}" class="${state.activeServer===s.id?'active':''}">${escapeHtml(s.name)}<small>Por ${escapeHtml(s.creator)}</small></button>`).join('');$$('[data-chat-pick]').forEach(b=>b.addEventListener('click',()=>openChat(b.dataset.chatPick)));}
function openChat(id){if(!authRequired())return;const s=state.servers.find(x=>x.id===id);if(!s)return;state.activeServer=id;navigate('chat');$('#chatTitle').textContent=s.name;$('#chatSubtitle').textContent=`Chat de la comunidad · Creador: ${s.creator}`;renderChatServers();$('#chatMessages').innerHTML='<div class="chat-placeholder">Conectando al canal…</div>';$('#chatInput').disabled=false;$('#chatForm button').disabled=false;if(state.socket?.connected)state.socket.emit('chat:join',id);else toast('El servicio de chat no está disponible en este momento.');}
function initSocket(){state.socket=window.io({transports:['websocket','polling']});state.socket.on('connect',()=>{if(state.activeServer&&state.user)state.socket.emit('chat:join',state.activeServer);});state.socket.on('connect_error',err=>{if(state.user)toast(err.message||'No se pudo conectar al chat.');});state.socket.on('chat:history',messages=>renderMessages(messages));state.socket.on('chat:message',message=>appendMessage(message));state.socket.on('chat:error',message=>toast(message));}
function renderMessages(messages){$('#chatMessages').innerHTML=messages.length?messages.map(messageMarkup).join(''):'<div class="chat-placeholder">Todavía no hay mensajes. ¡Saluda a la comunidad!</div>';$('#chatMessages').scrollTop=$('#chatMessages').scrollHeight;}
function messageMarkup(m){const mine=state.user&&m.userId===state.user.id;const time=new Date(m.createdAt).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'});return `<div class="chat-message ${mine?'mine':''}"><div class="message-head">${escapeHtml(m.userName)} ${m.isCreator?'<span class="creator-mark">CREADOR</span>':''}<small>${time}</small></div><p>${escapeHtml(m.text)}</p></div>`;}
function appendMessage(m){const box=$('#chatMessages');if(box.querySelector('.chat-placeholder'))box.innerHTML='';box.insertAdjacentHTML('beforeend',messageMarkup(m));box.scrollTop=box.scrollHeight;}
$('#chatForm').addEventListener('submit',event=>{event.preventDefault();if(!authRequired()||!state.activeServer)return;const input=$('#chatInput');const text=input.value.trim();if(!text)return;if(!state.socket?.connected)return toast('No hay conexión con el chat.');state.socket.emit('chat:message',{serverId:state.activeServer,text});input.value='';});

window.completeNativeGoogleLogin = async function(ticket){
  try { const result=await api('/auth/native/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})}); setUser(result.user); if(state.socket){state.socket.disconnect();state.socket=null;} initSocket(); toast('Cuenta de Google conectada correctamente.'); }
  catch(err){ toast('No se pudo validar la sesión de Google: '+err.message); }
};

init();
