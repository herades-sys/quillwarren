// GM symbols + cartography. Run after the furniture toolkit + storage helper blocks.
const G={amp:0.12,step:2};
const ink=(s,pts,o={})=>s.shape(pts,{fill:INK,sw:DET,...G,...o});
const pap=(s,pts)=>s.fill(pts,{fill:PAPER,amp:0.05,step:1.5});
function badge(s){s.shape(circ(50,50,41,48),{fill:PAPER,sw:OUT,amp:0.3,step:3});}
function shield(s){const p=[];for(let x=14;x<=86;x+=8)p.push([x,13]);for(let y=21;y<=50;y+=8)p.push([86,y]);
 for(let k=1;k<=8;k++){const t=k/8;p.push([(1-t)**2*86+2*t*(1-t)*86+t*t*50,(1-t)**2*50+2*t*(1-t)*82+t*t*92]);}
 for(let k=7;k>=1;k--){const t=k/8;p.push([100-((1-t)**2*86+2*t*(1-t)*86+t*t*50),(1-t)**2*50+2*t*(1-t)*82+t*t*92]);}
 for(let y=50;y>=21;y-=8)p.push([14,y]);s.shape(p,{fill:PAPER,sw:OUT,amp:0.3,step:3});}
function slash(p0,p1,bow,w){const dx=p1[0]-p0[0],dy=p1[1]-p0[1],l=Math.hypot(dx,dy),nx=-dy/l,ny=dx/l,A=[],B=[];
 for(let k=0;k<=14;k++){const t=k/14,b=bow*Math.sin(Math.PI*t),hw=w*Math.sin(Math.PI*t)**0.7,c=[p0[0]+dx*t+nx*b,p0[1]+dy*t+ny*b];A.push([c[0]+nx*hw,c[1]+ny*hw]);B.unshift([c[0]-nx*hw,c[1]-ny*hw]);}return[...A,...B.slice(1,-1)];}
function concave(x0,y0,x1,y1,R){const p=[],arc=(cx,cy,a0,a1)=>{for(let k=0;k<=6;k++){const a=(a0+(a1-a0)*k/6)*Math.PI/180;p.push([cx+R*Math.cos(a),cy+R*Math.sin(a)]);}};
 arc(x1,y0,180,90);arc(x1,y1,270,180);arc(x0,y1,0,-90);arc(x0,y0,90,0);return p;}
const S={};
S['trap']=()=>{const s=new Sheet(1,1,401);shield(s);const E=(a,cy)=>[50+27*Math.cos(a*Math.PI/180),cy+16*Math.sin(a*Math.PI/180)];
 for(const[a0,a1,cy,dir,xs]of[[195,345,46,1,[34,45,56,67]],[15,165,50,-1,[39.5,50.5,61.5]]]){const arc=[];for(let k=0;k<=12;k++)arc.push(E(a0+(a1-a0)*k/12,cy));ink(s,band(arc,3.6));
  for(const x of xs){const a=Math.acos((x-50)/27)*180/Math.PI,y=cy+(dir>0?-1:1)*16*Math.sin(a*Math.PI/180)+dir*2;ink(s,[[x-4,y],[x,y+dir*11],[x+4,y]],{amp:0.03,step:1.2});}}
 for(const x of[22,78])ink(s,circ(x,48,4.4,14));ink(s,band(seg2([50,68],[50,80],2),2.6));return s;};
S['treasure']=()=>{const s=new Sheet(1,1,402);badge(s);
 s.shape(rrect(31,48,38,12,5),{sw:DET,...G});s.shape(rrect(31,58,38,17,2),{sw:DET,...G});
 for(const x of[36,59])s.shape(rrect(x,47,5,29,1),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 s.shape(rrect(46,56,8,9,1.5),{fill:SHADE,sw:DET,amp:0.05,step:1.5});s.dot(50,60,1.4);
 for(const[a,b]of[[[38,18],[62,40]],[[62,18],[38,40]]])ink(s,band(seg2(a,b,4),4.2));return s;};
S['danger']=()=>{const s=new Sheet(1,1,403);shield(s);
 ink(s,circ(50,40,19,40));ink(s,rrect(39,50,22,17,4));
 for(const x of[42.5,57.5])pap(s,ell(x,42,5,6));pap(s,[[50,49],[47.4,55],[52.6,55]]);
 for(const x of[45.5,50,54.5])s.poly([[x-1,60],[x+1,60],[x+1,66],[x-1,66]],PAPER);return s;};
S['encounter']=()=>{const s=new Sheet(1,1,404);shield(s);
 for(let k=0;k<3;k++)ink(s,slash([42+13*k,20+k*2],[28+13*k,72-k*3],2.5,4.6),{amp:0.05,step:1.5});return s;};
S['npc']=()=>{const s=new Sheet(1,1,405);badge(s);
 ink(s,circ(50,27,8.5,24));ink(s,[[35,62],[35,50],[40,42.5],[47,39.5],[53,39.5],[60,42.5],[65,50],[65,62],[58,63],[42,63]]);
 for(const[a,b]of[[[45,62],[44,79]],[[55,62],[56,79]]])ink(s,band(seg2(a,b,3),4));return s;};
S['entrance']=()=>{const s=new Sheet(1,1,406);badge(s);ink(s,[[50,17],[72,45],[58.5,45],[58.5,80],[41.5,80],[41.5,45],[28,45]],{amp:0.1});return s;};
S['stairs-up']=()=>{const s=new Sheet(1,1,407);badge(s);for(const y of[30,50])ink(s,band([[28,y+18],[50,y],[72,y+18]],5.5));return s;};
S['stairs-down']=()=>{const s=new Sheet(1,1,408);badge(s);for(const y of[32,52])ink(s,band([[28,y],[50,y+18],[72,y]],5.5));return s;};
S['light']=()=>{const s=new Sheet(1,1,409);badge(s);ink(s,circ(50,50,11.5,30));
 for(let k=0;k<8;k++){const a=(k*45-90)*Math.PI/180,R=k%2?26:31,w=0.19;ink(s,[[50+17*Math.cos(a-w),50+17*Math.sin(a-w)],[50+R*Math.cos(a),50+R*Math.sin(a)],[50+17*Math.cos(a+w),50+17*Math.sin(a+w)]],{amp:0.03,step:1.2});}return s;};
S['water']=()=>{const s=new Sheet(1,1,410);badge(s);const c=[50,58],r=18,p=[[50,20]];
 for(let a=-28.3;a<=208.3;a+=8)p.push([c[0]+r*Math.cos(a*Math.PI/180),c[1]+r*Math.sin(a*Math.PI/180)]);ink(s,p,{amp:0.08});
 const g=[];for(let a=110;a<=165;a+=6)g.push([c[0]+11*Math.cos(a*Math.PI/180),c[1]+11*Math.sin(a*Math.PI/180)]);pap(s,band(g,2));return s;};
S['note']=()=>{const s=new Sheet(1,1,411);badge(s);const R=p=>rot(p,50,50,38);
 ink(s,R(rrect(38,17,24,11,4)));ink(s,R(rrect(44,27,12,15,1)));ink(s,R(rrect(33,41,34,9,3)));ink(s,R(band(seg2([50,50],[50,82],4),1.8)),{amp:0.03,step:1.2});return s;};
S['locked']=()=>{const s=new Sheet(1,1,412);badge(s);const arc=[[37,50],[37,44]];for(let a=180;a<=360;a+=15)arc.push([50+13*Math.cos(a*Math.PI/180),40+13*Math.sin(a*Math.PI/180)]);arc.push([63,44],[63,50]);
 ink(s,band(arc,4));ink(s,rrect(30,47,40,31,5));pap(s,circ(50,58,4.5,14));s.poly([[48,60],[52,60],[53.5,70],[46.5,70]],PAPER);return s;};
S['key']=()=>{const s=new Sheet(1,1,413);badge(s);const R=p=>rot(p,50,50,-35);
 ink(s,R(circ(28,50,11.5,30)));ink(s,R(band(seg2([38,50],[78,50],5),3.6)));ink(s,R(rrect(63,50,7,12,1)));ink(s,R(rrect(72,50,6,9,1)));pap(s,R(circ(28,50,4.8,14)));return s;};
S['portal']=()=>{const s=new Sheet(1,1,414),T=1.75*6.2832,p=[];for(let t=0;t<=T;t+=0.18){const r=5+25*t/T;p.push([50+r*Math.cos(t+1),50+r*Math.sin(t+1)]);}badge(s);ink(s,band(p,3.4),{amp:0.06,step:1.8});return s;};
S['compass-rose']=()=>{const s=new Sheet(3,3,415),C=150,P=(r,deg)=>[C+r*Math.cos(deg*Math.PI/180),C+r*Math.sin(deg*Math.PI/180)];
 const[ring,out]=s.fo(circ(C,C,132),{fill:SHADE,amp:0.3,step:4});
 for(let k=0;k<32;k+=2){const a0=k*11.25-90,a1=a0+11.25,q=[];for(let j=0;j<=3;j++)q.push(P(131,a0+(a1-a0)*j/3));for(let j=3;j>=0;j--)q.push(P(121,a0+(a1-a0)*j/3));s.poly(q,PAPER);}
 s.shape(circ(C,C,120),{sw:DET,amp:0.2,step:4});s.shape(circ(C,C,60),{fill:NONE,sw:DET,amp:0.2,step:4});out();
 const point=(deg,R,base,dark)=>{s.shape([P(R,deg),P(base,deg-45),[C,C]],{fill:dark,sw:DET,amp:0.1,step:3});s.shape([P(R,deg),P(base,deg+45),[C,C]],{sw:DET,amp:0.1,step:3});};
 for(const d of[-45,45,135,225])point(d,84,15,SHADE);for(const d of[0,90,180])point(d,112,21,SHADE);
 const N=pts=>pts.map(([x,y])=>[C+x,C+y]);
 s.shape(N([[0,-142],[-20,-100],[-9,-102],[-14.8,-14.8],[0,0]]),{fill:INK,sw:DET,amp:0.1,step:3});
 s.shape(N([[0,-142],[20,-100],[9,-102],[14.8,-14.8],[0,0]]),{sw:DET,amp:0.1,step:3});
 s.shape(circ(C,C,9,20),{sw:DET,amp:0.05,step:1.5});return s;};
S['scale-bar']=()=>{const s=new Sheet(5,1,416);const[bar,out]=s.fo(rrect(50,40,400,20,1),{amp:0.2,step:4});
 for(let k=0;k<5;k++)if(k%2===0)s.poly([[50+80*k,40],[130+80*k,40],[130+80*k,60],[50+80*k,60]],INK);
 for(let k=1;k<5;k++)s.line([50+80*k,30],[50+80*k,40],DET,0.1);
 for(const x of[50,450])s.line([x,24],[x+0.3,76],OUT,0.1);out();return s;};
S['title-cartouche']=()=>{const s=new Sheet(8,2,417),yT=x=>24+8*((x-400)/300)**2,yB=x=>152+8*((x-400)/300)**2;
 for(const m of[1,-1]){const X=x=>m>0?x:800-x;
  s.shape([[18,56],[132,56],[132,172],[18,172],[48,114]].map(([x,y])=>[X(x),y]),{fill:SHADE,amp:0.4,step:4});
  s.shape([[100,160],[132,160],[132,172]].map(([x,y])=>[X(x),y]),{fill:SHADE,sw:DET,amp:0.1,step:2});}
 const top=[],bot=[],iT=[],iB=[];for(let x=100;x<=700;x+=20){top.push([x,yT(x)]);bot.unshift([x,yB(x)]);}
 for(let x=114;x<=686;x+=22){iT.push([x,yT(x)+12]);iB.unshift([x,yB(x)-12]);}
 const[pan,out]=s.fo([...top,...bot],{amp:0.5,step:5});s.shape([...iT,...iB],{fill:NONE,sw:DET,amp:0.3,step:5});out();return s;};
S['legend-frame']=()=>{const s=new Sheet(4,6,418);const[f,out]=s.fo(concave(14,14,386,586,22),{fill:SHADE,amp:0.4,step:5});
 s.shape(rrect(34,34,332,532,2),{sw:DET,amp:0.3,step:5});s.shape(rrect(44,44,312,512,1.5),{fill:NONE,sw:DET,amp:0.3,step:5});
 for(const[x,y]of[[200,24],[200,576],[24,300],[376,300]])s.shape([[x,y-9],[x+9,y],[x,y+9],[x-9,y]],{sw:DET,amp:0.05,step:2});out();return s;};
S['room-badge']=()=>{const s=new Sheet(1,1,419);const[f,out]=s.fo(concave(18,18,82,82,10),{fill:SHADE,amp:0.25,step:3});
 s.shape(rrect(27,27,46,46,2),{sw:DET,amp:0.15,step:3});out();return s;};

const SMETA=[
 ['symbols','trap','Trap Marker',1,1,['trap','bear-trap','hazard','marker','gm']],
 ['symbols','treasure','Treasure Marker',1,1,['treasure','x','chest','loot','marker','gm']],
 ['symbols','danger','Danger Marker',1,1,['danger','skull','deadly','marker','gm']],
 ['symbols','encounter','Encounter Marker',1,1,['encounter','claws','monster','combat','marker','gm']],
 ['symbols','npc','NPC Marker',1,1,['npc','figure','person','character','marker','gm']],
 ['symbols','entrance','Entrance Marker',1,1,['entrance','arrow','start','north','marker','gm']],
 ['symbols','stairs-up','Stairs Up Marker',1,1,['stairs','up','level','chevron','marker','gm']],
 ['symbols','stairs-down','Stairs Down Marker',1,1,['stairs','down','level','chevron','marker','gm']],
 ['symbols','light','Light Marker',1,1,['light','sun','bright','illumination','marker','gm']],
 ['symbols','water','Water Marker',1,1,['water','drop','well','spring','marker','gm']],
 ['symbols','note','Note Marker',1,1,['note','pin','pushpin','clue','marker','gm']],
 ['symbols','locked','Locked Marker',1,1,['locked','padlock','door','secured','marker','gm']],
 ['symbols','key','Key Marker',1,1,['key','unlock','item','clue','marker','gm']],
 ['symbols','portal','Portal Marker',1,1,['portal','spiral','teleport','magic','marker','gm']],
 ['cartography','compass-rose','Compass Rose',3,3,['compass','rose','north','direction','map','cartography']],
 ['cartography','scale-bar','Scale Bar',5,1,['scale','bar','distance','measure','map','cartography']],
 ['cartography','title-cartouche','Title Cartouche',8,2,['title','cartouche','banner','scroll','map','cartography']],
 ['cartography','legend-frame','Legend Frame',4,6,['legend','frame','key','border','map','cartography']],
 ['cartography','room-badge','Room Number Badge',1,1,['room','number','badge','label','map','cartography']]];
const sin={},srep={};
for(const[cat,id,,w,h]of SMETA){const s=S[id]();if(s.W!==w*100||s.H!==h*100)throw id+' size';const svg=s.svg();srep[id]=s.bad.length?s.bad.slice(0,3):0;
 const cols=[...new Set(svg.match(/#[0-9A-Fa-f]{6}/g))].filter(c=>![INK,PAPER,SHADE].includes(c));if(cols.length)srep[id]={cols};
 await saveFile(`${cat}/${id}.svg`,svg);sin[id]=s.els;}
for(const cat of['symbols','cartography']){const list=SMETA.filter(m=>m[0]===cat);let x=100;const H=Math.max(...list.map(m=>m[4]));const CH=(H+2)*100,base=(H+1)*100;const Wd=100+list.reduce((a,m)=>a+(m[3]+1)*100,0);
 let grid='';for(let gx=100;gx<Wd;gx+=100)grid+=`M${gx} 0V${CH}`;for(let gy=100;gy<CH;gy+=100)grid+=`M0 ${gy}H${Wd}`;
 let card=`<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${CH}" viewBox="0 0 ${Wd} ${CH}">\n  <rect width="${Wd}" height="${CH}" fill="#F0ECE0"/>\n  <path d="${grid}" fill="none" stroke="#DDD6C3" stroke-width="1.5"/>\n`;
 for(const[,id,,w,h]of list){card+=`  <svg x="${x}" y="${base-h*100}" width="${w*100}" height="${h*100}" viewBox="0 0 ${w*100} ${h*100}">\n`+sin[id].map(e=>'  '+e).join('\n')+`\n  </svg>\n  <text x="${x+w*50}" y="${base+36}" text-anchor="middle" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20" fill="#4A4336">${id}</text>\n`;x+=(w+1)*100;}
 await saveFile(`overview/${cat}.svg`,card+'</svg>\n');}
const sman=JSON.parse(await readFile('manifest.json')).filter(e=>e.category!=='symbols'&&e.category!=='cartography');
const sall=[...sman,...SMETA.map(([category,id,name,w,h,tags])=>({id,name,category,w,h,tags,blocks:'none'}))];
const sids=sall.map(e=>e.id);if(new Set(sids).size!==sids.length)throw 'duplicate id '+sids.filter((x,i)=>sids.indexOf(x)!==i);
await saveFile('manifest.json','[\n'+sall.map(e=>'  '+JSON.stringify(e).replace(/,"/g,', "').replace(/":/g,'": ')).join(',\n')+'\n]\n');
log(JSON.stringify(srep));
