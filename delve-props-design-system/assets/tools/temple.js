// Temple batch. Run after the toolkit half of tools/furniture.js plus the helpers block of tools/storage.js.
function stub(s,x,y,r=7){const q=r*0.85;s.shape(rrect(x-q,y-q,2*q,2*q,3),{fill:SHADE,sw:DET,amp:0.1,step:1.8});s.shape(circ(x,y,r*0.5,12),{sw:DET,amp:0.05,step:1.5});}
function bowl(s,x,y,r){s.shape(circ(x,y,r),{sw:DET,amp:0.15,step:2});s.shape(circ(x+0.4,y+0.3,r*0.66),{fill:SHADE,sw:DET,amp:0.12,step:2});}
function goblet(s,x,y,deg){const[M,M1]=mk(x,y,deg);s.shape(circ(x,y,9,16),{sw:DET,amp:0.1,step:2});s.shape(circ(x,y,5.6,12),{fill:SHADE,sw:DET,amp:0.05,step:1.5});}
function figureTop(s,cx,cy,k){s.shape(circ(cx,cy-2*k,12*k),{fill:SHADE,sw:DET,amp:0.15,step:2});s.shape(ell(cx,cy+2.5*k,8.5*k,7*k),{sw:DET,amp:0.1,step:1.8});}
const T={};
T['altar']=()=>{const s=new Sheet(2,1,51);
 const[st,out]=s.fo(rrect(14,16,172,60,3));
 s.seam([58,4],[58.5,96],st);s.seam([142,4],[141.5,96],st);
 s.line([24,60],[38,66],TEX,0.2,0.6);s.line([160,26],[172,32],TEX,0.2,-0.5);
 out();
 s.shape(rrect(74,12,52,74,2),{fill:SHADE,sw:DET,amp:0.3,step:3});
 s.line([88,24],[87,56],TEX,0.2,0.8);s.line([112,50],[114,78],TEX,0.2,-0.8);
 bowl(s,100,42,12);stub(s,34,36);stub(s,166,38);stub(s,46,56,6);
 return s;};
T['altar-grand']=()=>{const s=new Sheet(3,2,52),u=(a,b)=>s.pen.u(a,b);
 s.shape(rrect(40,124,220,64,3),{fill:SHADE});s.line([70,168],[86,176],TEX,0.2,0.6);s.line([214,160],[228,170],TEX,0.2,-0.5);
 const[pl,pout]=s.fo(rrect(12,10,276,132,4));
 for(const x of[56,244])s.seam([x,4],[x+u(-.5,.5),196],pl);
 s.seam([4,76],[56,76.5],pl);s.seam([244,70],[296,70.5],pl);
 s.line([26,112],[40,124],TEX,0.2,0.6);s.line([256,30],[266,44],TEX,0.2,-0.6);
 pout();
 s.shape(rrect(66,22,168,82,4),{fill:SHADE});
 for(const[x,y]of[[66,22],[222,22],[66,92],[222,92]])s.shape(rrect(x+1,y+1,10,10,2),{sw:DET,amp:0.05,step:1.5});
 const top=s.shape(rrect(78,32,144,62,3),{sw:DET,amp:0.35});
 s.shape(rrect(86,39,128,48,2),{fill:NONE,sw:TEX,amp:0.2,step:4});
 bowl(s,150,60,13);goblet(s,112,64,0);stub(s,98,46,6.5);stub(s,202,46,6.5);
 for(const[x,y]of[[190,70],[198,64],[196,76]])coin(s,x,y,4);
 s.shape(rrect(126,108,48,20,4),{fill:SHADE,sw:DET,amp:0.2,step:2.5});
 s.shape(rot(ell(143,118,11,6),143,118,-8),{sw:DET,amp:0.1,step:2});s.shape(circ(163,117,5.5,12),{sw:DET,amp:0.05,step:1.5});
 candleC(s,30,30,200);candleC(s,270,30,-20);
 return s;};
T['statue-large']=()=>{const s=new Sheet(2,2,53);
 s.shape(circ(100,100,86),{fill:SHADE,amp:0.6});
 const[top,out]=s.fo(circ(100,100,76),{amp:0.5});
 s.line([46,138],[58,154],TEX,0.2,0.8);s.line([140,50],[154,62],TEX,0.2,-0.6);out();
 s.shape([[70,96],[80,84],[100,80],[120,84],[130,96],[136,118],[132,138],[116,148],[100,150],[84,148],[68,138],[64,118]],{fill:SHADE,amp:0.4,step:4});
 s.stroke([[86,122],[84,136],[86,146]],TEX,0.2,4);s.stroke([[116,118],[118,134],[116,146]],TEX,0.2,4);
 for(const sx of[-1,1]){const p=[[100+sx*18,98],[100+sx*40,95],[100+sx*60,92]];s.shape(band(p,6.5),{amp:0.2,step:3});s.shape(ell(100+sx*66,92,7,6),{sw:DET,amp:0.1,step:2});}
 s.shape(ell(100,100,24,13),{amp:0.3,step:3});
 figureTop(s,100,94,1.1);
 return s;};
T['sarcophagus']=()=>{const s=new Sheet(1,2,54);
 s.shape(rrect(14,8,72,184,6),{fill:SHADE});
 for(const[x,y]of[[15,9],[75,9],[15,181],[75,181]])s.shape(rrect(x+1,y+1,8,8,2),{sw:DET,amp:0.05,step:1.5});
 s.shape(rrect(22,18,56,164,5),{sw:DET,amp:0.35});
 s.shape([[40,44],[60,44],[64,70],[62,120],[58,160],[50,170],[42,160],[38,120],[36,70]],{fill:SHADE,sw:DET,amp:0.25,step:3});
 s.stroke([[46,126],[45,154]],TEX,0.15,4);s.stroke([[55,110],[56,140]],TEX,0.15,4);
 s.shape(ell(50,84,9,7),{sw:DET,amp:0.1,step:2});
 s.shape(ell(50,32,10,11),{sw:DET,amp:0.15,step:2});
 return s;};
T['coffin']=()=>{const s=new Sheet(1,2,55),u=(a,b)=>s.pen.u(a,b),P=[[38,12],[62,12],[80,52],[68,188],[32,188],[20,52]];
 for(const y of[92,146])for(const sx of[-1,1]){const ex=sx<0?20+(y-52)/136*12:80-(y-52)/136*12,o=ex+sx*6;
  s.shape([[ex-sx*2,y-6],[o,y-5],[o,y+5],[ex-sx*2,y+6]],{fill:SHADE,sw:DET,amp:0.1,step:2});s.poly([[ex+sx*2.8-1,y-3],[ex+sx*2.8+1,y-3],[ex+sx*2.8+1,y+3],[ex+sx*2.8-1,y+3]],INK);}
 const[b,out]=s.fo(P,{amp:0.5,step:4});
 for(const x of[40.5,59.5])s.seam([x+u(-.4,.4),4],[x+u(-.4,.4),196],b);
 for(const[x,a,c]of[[30,64,82],[50,30,48],[49,110,130],[70,70,88],[31,140,158],[50,160,176]])s.grain([x,a],[x+u(-.5,.5),c]);
 for(const[x,y]of[[40,19],[60,19],[30,54],[70,54],[37,180],[63,180]])s.dot(x,y,1.4);
 out();return s;};
T['tombstone']=()=>{const s=new Sheet(1,1,56);
 s.shape(rrect(26,38,48,54,20),{fill:SHADE});
 s.line([40,56],[46,62],TEX,0.15,0.4);s.line([56,72],[64,76],TEX,0.15,-0.4);s.line([38,80],[46,84],TEX,0.15,0.3);
 s.shape(rrect(16,14,68,20,3),{fill:SHADE});
 s.shape(rrect(22,10,56,16,7),{amp:0.3,step:3});
 s.line([34,17],[46,18],TEX,0.1,0.3);
 return s;};
T['font']=()=>{const s=new Sheet(1,1,57),oct=[];for(let k=0;k<8;k++){const a=(22.5+45*k)*Math.PI/180;oct.push([50+42*Math.cos(a),50+42*Math.sin(a)]);}
 s.shape(oct,{fill:SHADE,amp:0.4,step:4});
 const[rim,out]=s.fo(circ(50,50,33),{amp:0.4});s.line([22,40],[26,30],TEX,0.15,0.4);s.line([70,76],[78,68],TEX,0.15,-0.4);out();
 s.shape(circ(50,50,23.5),{fill:SHADE,sw:DET,amp:0.3});
 s.stroke([[42,44],[50,41],[58,43]],TEX,0.1,3);
 return s;};
T['lectern']=()=>{const s=new Sheet(1,1,58);
 s.shape(rrect(30,62,40,26,8),{fill:SHADE});
 const R=p=>rot(p,50,44,-3);
 const[top,out]=s.fo(R(rrect(20,20,60,44,3)),{amp:0.4});
 s.grain(...R([[26,58],[40,58.5]]));out();
 s.shape(R(band(seg2([22,66],[78,66],6),3.4)),{fill:SHADE,sw:DET,amp:0.1,step:2});
 s.shape(R(rrect(25,24,50,36,2)),{fill:SHADE,sw:DET,amp:0.2,step:3});
 s.shape(R([[28,27],[38,25.5],[50,28],[50,58],[38,56],[28,57]]),{sw:DET,amp:0.15,step:2.5});
 s.shape(R([[50,28],[62,25.5],[72,27],[72,57],[62,56],[50,58]]),{sw:DET,amp:0.15,step:2.5});
 return s;};
T['summoning-circle']=()=>{const s=new Sheet(3,3,59),C=150,u=(a,b)=>s.pen.u(a,b);
 s.shape(circ(C,C,124),{fill:SHADE,amp:0.6,step:5});
 s.shape(circ(C,C,112),{sw:DET,amp:0.4,step:5});
 s.shape(circ(C,C,86),{fill:SHADE,sw:DET,amp:0.35,step:5});
 s.shape(circ(C,C,77),{sw:DET,amp:0.3,step:5});
 const pts=[...Array(5)].map((_,k)=>{const a=(-90+72*k)*Math.PI/180;return[C+77*Math.cos(a),C+77*Math.sin(a)];});
 for(let k=0;k<5;k++)s.line(pts[k],pts[(k+2)%5],DET,0.3);
 s.shape(circ(C,C,13),{fill:SHADE,sw:DET,amp:0.15,step:2});
 for(let k=0;k<10;k++){const a=(-72+36*k)*Math.PI/180,x=C+99*Math.cos(a),y=C+99*Math.sin(a),g=k%3,deg=-72+36*k+90;
  if(g===0)s.shape(rot([[x,y-6.5],[x+4.5,y],[x,y+6.5],[x-4.5,y]],x,y,deg),{fill:SHADE,sw:DET,amp:0.05,step:1.5});
  else if(g===1)s.shape(rot([[x,y-5.5],[x+5.5,y+4],[x-5.5,y+4]],x,y,deg),{sw:DET,amp:0.05,step:1.5});
  else for(const[dx,dy]of[[0,-4],[3.8,2.6],[-3.8,2.6]]){const p=rot([[x+dx,y+dy]],x,y,deg)[0];s.dot(p[0],p[1],1.6);}}
 for(let k=0;k<5;k++){const a=(-90+72*k)*Math.PI/180;stub(s,C+134*Math.cos(a),C+134*Math.sin(a),8);}
 return s;};
T['rune']=()=>{const s=new Sheet(1,1,60);
 s.shape([[50,14],[86,50],[50,86],[14,50]],{fill:SHADE,sw:DET,amp:0.2,step:3});
 s.shape([[50,26],[74,50],[50,74],[26,50]],{sw:DET,amp:0.15,step:3});
 const c=[];for(let k=0;k<3;k++){const a=(-90+120*k)*Math.PI/180,b=a+Math.PI/3;c.push([50+13*Math.cos(a),52+13*Math.sin(a)],[50+5*Math.cos(b),52+5*Math.sin(b)]);}
 s.shape(c,{fill:SHADE,sw:DET,amp:0.05,step:1.5});
 return s;};
T['obelisk']=()=>{const s=new Sheet(1,1,61);
 s.shape(rrect(12,12,76,76,3),{fill:SHADE});
 s.line([18,70],[24,80],TEX,0.15,0.4);s.line([76,20],[82,28],TEX,0.15,-0.4);
 const[sh,out]=s.fo(rrect(25,25,50,50,1.5),{amp:0.3,step:3});
 s.shape(rrect(31,31,38,38,1),{fill:NONE,sw:DET,amp:0.15,step:3});out();
 s.shape(rrect(40,40,20,20,1),{fill:SHADE,sw:DET,amp:0.1,step:2});
 return s;};
T['orb-pedestal']=()=>{const s=new Sheet(1,1,62),oct=[];for(let k=0;k<8;k++){const a=(22.5+45*k)*Math.PI/180;oct.push([50+34*Math.cos(a),50+34*Math.sin(a)]);}
 s.shape(oct,{fill:SHADE,amp:0.3,step:3});
 const[t,out]=s.fo(circ(50,50,25),{amp:0.3});s.line([30,62],[36,70],TEX,0.1,0.3);out();
 s.shape(circ(50,50,15.5),{fill:SHADE,sw:DET,amp:0.12,step:2});
 for(const a of[30,150,270]){const r=a*Math.PI/180;s.shape(ell(50+16*Math.cos(r),50+16*Math.sin(r),3.8,3.8),{sw:DET,amp:0.03,step:1.2});}
 return s;};
T['idol']=()=>{const s=new Sheet(1,1,63);
 s.shape(rrect(24,14,52,50,4),{fill:SHADE});
 for(const sx of[-1,1])s.shape(ell(50+sx*20,46,7.5,6.5),{sw:DET,amp:0.1,step:2});
 s.shape(ell(50,42,19,18),{amp:0.3,step:3});
 s.shape(band([[36,30],[43,25.5],[50,24.5],[57,25.5],[64,30]],4.2),{fill:SHADE,sw:DET,amp:0.08,step:2});
 s.line([43,46],[48,47],TEX,0.05);s.line([52,47],[57,46],TEX,0.05);
 bowl(s,50,79,9);stub(s,24,78,6.5);stub(s,77,77,6.5);
 for(const[x,y]of[[36,88],[64,89],[15,60],[85,57]])coin(s,x,y,3.8,SHADE);
 return s;};

const RENAME={'statue-plinth':'_ref/statue.svg'};
const TMETA=[
 ['altar','Stone Altar',2,1,['altar','stone','cloth','candles','bowl','temple','shrine'],'movement'],
 ['altar-grand','Grand Altar on Step',3,2,['altar','grand','step','offerings','candles','temple','cathedral'],'movement'],
 ['statue-plinth','Statue on Plinth',1,1,['statue','plinth','stone','human','monument','temple'],'sight'],
 ['statue-large','Large Robed Statue',2,2,['statue','large','robed','figure','stone','temple','monument'],'sight'],
 ['sarcophagus','Carved Sarcophagus',1,2,['sarcophagus','effigy','tomb','stone','crypt','burial'],'movement'],
 ['coffin','Wooden Coffin',1,2,['coffin','wood','burial','crypt','undead','funeral'],'movement'],
 ['tombstone','Tombstone with Grave',1,1,['tombstone','grave','mound','stone','graveyard','burial'],'movement'],
 ['font','Stone Font',1,1,['font','basin','water','stone','temple','holy'],'movement'],
 ['lectern','Lectern with Tome',1,1,['lectern','tome','book','temple','library','wood'],'movement'],
 ['summoning-circle','Summoning Circle',3,3,['circle','summoning','magic','ritual','candles','arcane','floor'],'none'],
 ['rune','Floor Rune',1,1,['rune','glyph','magic','trap','arcane','floor'],'none'],
 ['obelisk','Obelisk',1,1,['obelisk','stone','monument','carved','ancient','temple'],'sight'],
 ['orb-pedestal','Orb on Pedestal',1,1,['orb','crystal','pedestal','magic','scrying','temple'],'movement'],
 ['idol','Idol with Offerings',1,1,['idol','statue','offerings','shrine','jungle','temple'],'movement']];
const tin={},trep={};
for(const[id,,w,h]of TMETA){let svg,els;
 if(RENAME[id]){const raw=await readFile(RENAME[id]);els=raw.replace(/<metadata>[\s\S]*?<\/metadata>/,'').split('\n').filter(l=>/^\s*<(path|polygon|circle|rect|ellipse|line|polyline)\b/.test(l)).map(l=>l.trim().replace(/><\/(path|polygon|circle|rect|ellipse|line|polyline)>$/,'/>'));
  svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${w*100}" height="${h*100}" viewBox="0 0 ${w*100} ${h*100}">\n`+els.map(e=>'  '+e).join('\n')+'\n</svg>\n';trep[id]={copied:els.length};}
 else{const s=T[id]();if(s.W!==w*100||s.H!==h*100)throw id+' size';svg=s.svg();els=s.els;trep[id]={bad:s.bad.slice(0,3)};}
 const cols=[...new Set(svg.match(/#[0-9A-Fa-f]{6}/g))].filter(c=>![INK,PAPER,SHADE].includes(c));
 const widths=[...new Set(svg.match(/stroke-width="[^"]+"/g))].filter(x=>!/"(4|2|1\.5)"/.test(x));
 if(cols.length||widths.length)trep[id].problem={cols,widths};
 await saveFile(`temple/${id}.svg`,svg);tin[id]=els;}
{let x=100;const H=Math.max(...TMETA.map(m=>m[3]));const CH=(H+2)*100,base=(H+1)*100;const W=100+TMETA.reduce((a,m)=>a+(m[2]+1)*100,0);
 let grid='';for(let gx=100;gx<W;gx+=100)grid+=`M${gx} 0V${CH}`;for(let gy=100;gy<CH;gy+=100)grid+=`M0 ${gy}H${W}`;
 let card=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${CH}" viewBox="0 0 ${W} ${CH}">\n  <rect width="${W}" height="${CH}" fill="#F0ECE0"/>\n  <path d="${grid}" fill="none" stroke="#DDD6C3" stroke-width="1.5"/>\n`;
 for(const[id,,w,h]of TMETA){card+=`  <svg x="${x}" y="${base-h*100}" width="${w*100}" height="${h*100}" viewBox="0 0 ${w*100} ${h*100}">\n`+tin[id].map(e=>'  '+e).join('\n')+`\n  </svg>\n  <text x="${x+w*50}" y="${base+36}" text-anchor="middle" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="20" fill="#4A4336">${id}</text>\n`;x+=(w+1)*100;}
 await saveFile('overview/temple.svg',card+'</svg>\n');}
const tman=JSON.parse(await readFile('manifest.json')).filter(e=>e.category!=='temple');
const tall=[...tman,...TMETA.map(([id,name,w,h,tags,blocks])=>({id,name,category:'temple',w,h,tags,blocks}))];
const tids=tall.map(e=>e.id);if(new Set(tids).size!==tids.length)throw 'duplicate id';
await saveFile('manifest.json','[\n'+tall.map(e=>'  '+JSON.stringify(e).replace(/,"/g,', "').replace(/":/g,'": ')).join(',\n')+'\n]\n');
log(JSON.stringify(trep));
